import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isBaselinePolicyVersion, runBaselines } from './baselines.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { redactSecrets } from './config.js';
import { verifyAttemptOrdering } from './attemptProvenance.js';
import { armDigest, decisionFingerprint } from './fireArtifact.js';
import { assertFireArtifact, fireArtifactV1Schema } from './fireArtifactProducer.js';
import { validateResponseText } from './schema.js';
import { instantMs } from './time.js';
import { MARKET_ORDINAL } from './fireArtifact.js';
import type { AttemptTiming } from './attemptProvenance.js';
import type { FireArtifactV1 } from './fireArtifactProducer.js';
import type { ArmSpec, GameBundle, MarketKey, ProviderName, SlateBundle } from './types.js';

/**
 * The fire-artifact WRITE path (SPEC-line-open-evidence-model.md §4/§5): serialize a
 * PRODUCED, brand-authenticated `FireArtifactV1` to its durable, redaction-safe,
 * byte-reproducible on-disk form, and re-verify a persisted artifact ENTIRELY from
 * its own bytes.
 *
 * The producer brand is gone once bytes are parsed back, by design — so the durable
 * evidence must be self-verifying. `verifyFireArtifactReplay` re-derives every
 * recomputable digest AND re-checks every persisted bijection / identity / timing
 * relation the producer enforced, from the reloaded value alone, reusing the
 * canonical owners (`validateResponseText`, `decisionFingerprint`,
 * `verifyAttemptOrdering`, `runBaselines`). It is NOT the entry/model/coverage
 * verifier — external odds-history V1/V2 admission, approved-reported-model / family
 * collision, coverage, close, and CLV stay a later phase; a replay-consistent
 * artifact may still be marked entry-invalid there.
 *
 * Redaction is a FIELD-LEVEL fail-closed check, never a lossy sweep over the
 * serialized string (which both misses JSON-escaped configured values and, since the
 * body/arm hashes are computed over the pre-serialization graph, would silently
 * persist digest-drifted evidence). The write boundary authenticates the producer
 * origin, refuses any unredacted configured value, and runs the complete replay on
 * the exact final bytes — creating no file if anything fails.
 *
 * Pure serialization + a thin `node:fs` write. No store, watcher, provider, close,
 * CLV, scoring, coverage, or runtime wiring; the path/naming convention and the call
 * site are the runtime slice's.
 */

// Tier-0 pins one repair per arm (§2 constants), and the fire artifact's
// `orderedAttempts` structurally carry at most an initial + one repair, so the
// standalone replay bounds repairs at 1 without re-reading the manifest.
const MAX_REPAIR_ATTEMPTS_PER_ARM = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const byCanonicalOrder = (a: MarketKey, b: MarketKey): number => MARKET_ORDINAL[a] - MARKET_ORDINAL[b];

/** The present markets on a retained request game, canonical order (bundle
 *  `runLine` is the `spread` MarketKey). */
function presentMarkets(game: GameBundle): MarketKey[] {
  const scope: MarketKey[] = [];
  if (game.markets.moneyline != null) scope.push('moneyline');
  if (game.markets.runLine != null) scope.push('spread');
  if (game.markets.total != null) scope.push('total');
  return scope.sort(byCanonicalOrder);
}

function sameMarkets(a: readonly MarketKey[], b: readonly MarketKey[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort(byCanonicalOrder);
  const sb = [...b].sort(byCanonicalOrder);
  return sa.every((m, i) => m === sb[i]);
}

/** Recursively assert no string leaf carries a CONFIGURED credential value. This is
 *  field-level (pre-JSON-escape), so a value whose serialized form would be escaped
 *  is still caught, and it never modifies the graph — a match throws (fail closed)
 *  rather than rewriting digest-bound bytes. The message names the path, never the
 *  value. */
function assertRedactionClean(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (redactSecrets(value) !== value) {
      throw new Error(`fire artifact carries an unredacted configured credential at ${path}`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertRedactionClean(v, `${path}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertRedactionClean(v, path === '' ? k : `${path}.${k}`);
  }
}

// ---------------------------------------------------------------------------
// serialize / parse
// ---------------------------------------------------------------------------

/**
 * The durable on-disk bytes of a fire artifact: the canonical serialization of a
 * genuine PRODUCED artifact. Authenticates the producer brand and asserts the graph
 * is redaction-clean BEFORE emitting bytes; a forged/copied artifact or an
 * unredacted configured credential throws (no lossy sweep, no digest drift).
 * Deterministic — canonical key order, no volatile field.
 */
export function serializeFireArtifactV1(artifact: FireArtifactV1): string {
  assertFireArtifact(artifact);
  assertRedactionClean(artifact, '');
  return canonicalize(artifact);
}

/**
 * Parse persisted bytes back into a strictly-validated fire artifact. Fails closed
 * on malformed JSON (`JSON.parse` throws) or any schema violation. Does NOT register
 * the value in the producer brand — a persisted artifact is authenticated by strict
 * schema + `verifyFireArtifactReplay`, never by in-process producer identity.
 */
export function parseFireArtifactV1(bytes: string): FireArtifactV1 {
  return fireArtifactV1Schema.parse(JSON.parse(bytes));
}

// ---------------------------------------------------------------------------
// Digest + accepted-body replay
// ---------------------------------------------------------------------------

function identityArm(participantId: string, provider: string, requestedModelId: string): ArmSpec {
  // credentialEnvVar is unused by validateResponseText (it checks the response's
  // echoed cohort/participant/model/bundle, not credentials).
  return { participantId, provider: provider as ProviderName, requestedModelId, credentialEnvVar: '' };
}

/**
 * Recompute the artifact's digest + accepted-body self-consistency and return every
 * disagreement (empty = consistent):
 * - `requestSha256` / `gameSha256` / `slateSha256` recompute from the retained
 *   one-game request preimage;
 * - each attempt's `responseSha256` equals `sha256Hex(persistedResponseBody)` (or both null);
 * - `acceptedResponseDigest` links to exactly the one accepted attempt (valid arm) or
 *   is null (every other outcome);
 * - the accepted retained body re-validates against the retained request / cohort /
 *   participant-model identity / scoped market set, and its decision fingerprint
 *   re-derives to exactly the carried `acceptedDecisionFingerprint`;
 * - each arm's `armDigest` recomputes from its ten-field domain (after the above).
 */
export function recomputeFireArtifactDigests(artifact: FireArtifactV1): string[] {
  const violations: string[] = [];
  // The schema infers per-market-optional markets as `Block | undefined`; the runtime
  // value carries omitted keys (canonicalize/JSON drop undefined), so it is a genuine
  // SlateBundle — the same bridge the scorer uses to reconstruct archived slates.
  const bundle = artifact.requestBundle as unknown as SlateBundle;
  const canonicalRequest = canonicalize(bundle);
  if (sha256Hex(canonicalRequest) !== artifact.requestSha256) {
    violations.push('requestSha256 does not recompute from the retained request bundle');
  }
  if (sha256Hex(canonicalRequest) !== artifact.slateSha256) {
    violations.push('slateSha256 does not recompute from the one-game retained request preimage');
  }
  const game = bundle.games[0];
  if (game === undefined || sha256Hex(canonicalize(game)) !== artifact.gameSha256) {
    violations.push('gameSha256 does not recompute from the retained request game');
  }

  for (const arm of artifact.arms) {
    const who = arm.expectedArmIdentity.participantId;
    for (const attempt of arm.orderedAttempts) {
      if (attempt.persistedResponseBody === null) {
        if (attempt.responseSha256 !== null) {
          violations.push(`arm ${who} attempt ${attempt.attemptNumber} has a responseSha256 with no body`);
        }
      } else if (attempt.responseSha256 !== sha256Hex(attempt.persistedResponseBody)) {
        violations.push(`arm ${who} attempt ${attempt.attemptNumber} responseSha256 does not match its persisted body`);
      }
    }

    const accepted = arm.orderedAttempts.filter((a) => a.acceptedAt !== null);
    if (arm.terminalOutcome === 'valid') {
      if (accepted.length !== 1) {
        violations.push(`valid arm ${who} must have exactly one accepted attempt, found ${accepted.length}`);
      } else {
        const acceptedAttempt = accepted[0]!;
        if (arm.acceptedResponseDigest !== acceptedAttempt.responseSha256) {
          violations.push(`arm ${who} acceptedResponseDigest is not the accepted attempt's responseSha256`);
        }
        const body = acceptedAttempt.persistedResponseBody;
        if (body === null) {
          violations.push(`valid arm ${who} accepted attempt has no retained body`);
        } else if (arm.acceptedDecisionFingerprint === null) {
          violations.push(`valid arm ${who} is missing an acceptedDecisionFingerprint`);
        } else {
          const spec = identityArm(who, arm.expectedArmIdentity.provider, arm.expectedArmIdentity.requestedModelId);
          const { parsed, errors } = validateResponseText(body, bundle, artifact.requestSha256, spec, artifact.cohortId);
          if (parsed === null || errors.length > 0) {
            violations.push(`arm ${who} accepted body does not re-validate: ${errors[0] ?? 'unparseable'}`);
          } else if (canonicalize(decisionFingerprint(parsed)) !== canonicalize(arm.acceptedDecisionFingerprint)) {
            violations.push(`arm ${who} acceptedDecisionFingerprint does not re-derive from the retained accepted body`);
          }
        }
      }
    } else {
      if (accepted.length !== 0) violations.push(`non-valid arm ${who} carries an accepted attempt`);
      if (arm.acceptedResponseDigest !== null) violations.push(`non-valid arm ${who} carries an acceptedResponseDigest`);
      if (arm.acceptedDecisionFingerprint !== null) violations.push(`non-valid arm ${who} carries an acceptedDecisionFingerprint`);
    }

    const recomputed = armDigest({
      cohortId: artifact.cohortId,
      fireId: artifact.fireId,
      runId: artifact.runId,
      participantId: who,
      requestSha256: artifact.requestSha256,
      expectedArmIdentity: arm.expectedArmIdentity,
      orderedAttempts: arm.orderedAttempts,
      terminalOutcome: arm.terminalOutcome,
      acceptedResponseDigestOrNull: arm.acceptedResponseDigest,
      acceptedDecisionFingerprintOrNull: arm.acceptedDecisionFingerprint,
    });
    if (recomputed !== arm.armDigest) {
      violations.push(`arm ${who} armDigest does not recompute from its persisted domain`);
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Persisted relational replay
// ---------------------------------------------------------------------------

/**
 * Re-validate every persisted bijection / identity / timing relation the producer
 * enforced, from the reloaded value alone (empty = consistent): top-level ↔ request
 * identity + timing aliases; the scope bijection across scopedMarkets / present
 * request markets / market evidence / claims / valid-arm decisions / baselines;
 * per-market-evidence identity, coherence and claim linkage; the roster ↔ arm ↔
 * publication bijections; per-arm canonical attempt numbering + causal timing
 * (reusing `verifyAttemptOrdering`); and deterministic baseline rederivation.
 */
export function verifyFireArtifactRelations(artifact: FireArtifactV1): string[] {
  const violations: string[] = [];
  const bundle = artifact.requestBundle as unknown as SlateBundle;

  if (bundle.games.length !== 1) {
    violations.push(`retained request bundle must carry exactly one game, found ${bundle.games.length}`);
    return violations; // downstream game-bound checks are meaningless without it
  }
  const game = bundle.games[0]!;
  const scope = presentMarkets(game);

  // Top-level ↔ request identity + timing aliases.
  if (artifact.gameId !== game.gameId) violations.push('gameId does not equal the retained request game id');
  if (artifact.sport !== game.league) violations.push('sport does not equal the retained request game league');
  if (artifact.preparedSnapshotTs !== bundle.bundleTimestamp) violations.push('preparedSnapshotTs does not equal requestBundle.bundleTimestamp');
  if (artifact.scheduledAtAtFire !== bundle.cutoffAt) violations.push('scheduledAtAtFire does not equal requestBundle.cutoffAt');
  if (bundle.cutoffAt !== game.scheduledStartUtc) violations.push('requestBundle.cutoffAt does not equal game.scheduledStartUtc');
  if (!sameMarkets(artifact.scopedMarkets, scope)) violations.push('scopedMarkets do not equal the present retained-request markets');

  // Scope bijection across every carrier. The claim linkage is the sole per-market
  // `marketEvidence[].claim` (bound below), so there is no separate top-level
  // claims[] to cross-check.
  if (!sameMarkets(artifact.marketEvidence.map((m) => m.market), scope)) violations.push('market evidence markets do not equal the scope');

  // Per-market-evidence internal identity / coherence / linkage.
  const detectedMs = safe(() => instantMs(artifact.detectedAt));
  for (const me of artifact.marketEvidence) {
    if (me.detectedAt !== artifact.detectedAt) violations.push(`market ${me.market} detectedAt does not equal the fire detectedAt`);
    if (me.opener.jsonodds_id !== artifact.gameId || me.opener.market !== me.market) violations.push(`market ${me.market} opener identity does not bind to (game, market)`);
    if (me.asOf.jsonodds_id !== artifact.gameId || me.asOf.market !== me.market) violations.push(`market ${me.market} as-of identity does not bind to (game, market)`);
    if (me.opener.captured_at_ms !== safe(() => instantMs(me.opener.captured_at))) violations.push(`market ${me.market} opener captured_at_ms is not the coherent derivation of captured_at`);
    if (me.asOf.captured_at_ms !== safe(() => instantMs(me.asOf.captured_at))) violations.push(`market ${me.market} as-of captured_at_ms is not the coherent derivation of captured_at`);
    if (detectedMs !== undefined && me.openerAgeMs !== detectedMs - me.opener.captured_at_ms) violations.push(`market ${me.market} openerAgeMs is not detectedAt - opener.captured_at`);
    if (me.claim.cohortId !== artifact.cohortId || me.claim.fireId !== artifact.fireId || me.claim.gameId !== artifact.gameId || me.claim.market !== me.market) {
      violations.push(`market ${me.market} claim does not bind to (cohortId, fireId, gameId, market)`);
    }
  }

  // Roster ↔ arm ↔ publication bijections.
  if (artifact.publication.cohortId !== artifact.cohortId) violations.push('publication cohortId does not equal the artifact cohortId');
  if (artifact.arms.length !== artifact.expectedArmIdentities.length) violations.push('arm count does not equal expected-identity count');
  const armIds = artifact.arms.map((a) => a.expectedArmIdentity.participantId);
  if (new Set(armIds).size !== armIds.length) violations.push('duplicate arm participantId in the persisted arms');
  const n = Math.min(artifact.arms.length, artifact.expectedArmIdentities.length);
  for (let i = 0; i < n; i += 1) {
    if (canonicalize(artifact.arms[i]!.expectedArmIdentity) !== canonicalize(artifact.expectedArmIdentities[i]!)) {
      violations.push(`arm ${i} identity does not equal expectedArmIdentities[${i}]`);
    }
  }

  // Per-arm canonical attempt numbering + causal timing.
  for (const arm of artifact.arms) {
    const who = arm.expectedArmIdentity.participantId;
    if (arm.orderedAttempts.length === 0) {
      // A zero-attempt arm. Only THREE outcomes can legitimately have no sent attempt (B3), and the
      // zero-attempt rule is a BIDIRECTIONAL, outcome-aware contract keyed on the persisted
      // terminalOutcome:
      //   - a send-time gate refusal (`cutoff_missed` via the initial-dispatch gate, or
      //     `dispatch_lag_exceeded`) discarded a real reading without sending, so
      //     `initialRequestStartedAt` MUST be present — a missing one is a silent deletion;
      //   - a pre-clock `credential_missing` never took a reading, so it MUST be absent — a spurious
      //     one is a fabrication.
      // EVERY other outcome (`valid`, `invalid_schema`, `timeout`, `rate_limited`, `provider_error`)
      // is a SENT outcome per Tier-0: it MUST retain its substantiating attempt, so a zero-attempt
      // form is structurally-impossible / forged evidence — reject it (never replay-clean).
      const isSendTimeGateRefusal =
        arm.terminalOutcome === 'cutoff_missed' || arm.terminalOutcome === 'dispatch_lag_exceeded';
      if (isSendTimeGateRefusal) {
        if (arm.initialRequestStartedAt === null) {
          violations.push(`arm ${who} is a never-sent ${arm.terminalOutcome} but has a null initialRequestStartedAt`);
        }
      } else if (arm.terminalOutcome === 'credential_missing') {
        if (arm.initialRequestStartedAt !== null) {
          violations.push(`arm ${who} has no attempts and is not a send-time gate refusal but a non-null initialRequestStartedAt`);
        }
      } else {
        violations.push(
          `arm ${who} has terminalOutcome ${arm.terminalOutcome} but no attempts — a sent outcome must retain its substantiating attempt`,
        );
      }
      continue;
    }
    if (arm.initialRequestStartedAt === null) {
      violations.push(`arm ${who} has sent attempts but a null initialRequestStartedAt`);
    } else {
      const timing: AttemptTiming[] = arm.orderedAttempts.map((a) => ({
        attemptNumber: a.attemptNumber,
        kind: a.kind,
        requestStartedAt: a.requestStartedAt,
        requestReceivedAt: a.requestReceivedAt,
        acceptedAt: a.acceptedAt,
      }));
      for (const v of verifyAttemptOrdering(timing, arm.initialRequestStartedAt, MAX_REPAIR_ATTEMPTS_PER_ARM)) {
        violations.push(`arm ${who} attempt ordering: ${v}`);
      }
    }
    // Canonical numbering: the persisted attempts are exactly [1=initial] or
    // [1=initial, 2=repair]; verifyAttemptOrdering allows any strictly-increasing
    // numbering, so pin the contiguous-from-one shape here.
    arm.orderedAttempts.forEach((a, i) => {
      const expectedKind = i === 0 ? 'initial' : 'repair';
      if (a.attemptNumber !== i + 1 || a.kind !== expectedKind) {
        violations.push(`arm ${who} attempt at index ${i} is not canonically numbered/kinded (${a.attemptNumber}/${a.kind})`);
      }
    });
    // A valid arm's decisions cover exactly the scope.
    if (arm.terminalOutcome === 'valid' && arm.acceptedDecisionFingerprint !== null) {
      if (!sameMarkets(arm.acceptedDecisionFingerprint.map((e) => e.market), scope)) {
        violations.push(`arm ${who} decision markets do not equal the scope`);
      }
    }
  }

  // Deterministic baseline rederivation from the retained request + pinned version.
  if (!isBaselinePolicyVersion(artifact.baselinePolicyVersion)) {
    violations.push(`unknown baselinePolicyVersion "${artifact.baselinePolicyVersion}"`);
  } else {
    const rederived = safe(() => canonicalize(runBaselines(bundle, artifact.baselinePolicyVersion as never)));
    if (rederived === undefined || rederived !== canonicalize(artifact.baselineDecisions)) {
      violations.push('baseline decisions do not rederive from the retained request and pinned policy version');
    }
    if (!sameMarkets([...new Set(artifact.baselineDecisions.map((d) => d.market))], scope)) {
      violations.push('baseline decision markets do not equal the scope');
    }
  }

  return violations;
}

/** Guarded derivation: a throwing helper yields `undefined` (its own typed violation
 *  is raised by the check that reads it), never an escape. */
function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * The complete persisted-artifact replay: the digest/accepted-body closure plus the
 * relational closure. A persisted artifact is self-consistent iff this is empty.
 */
export function verifyFireArtifactReplay(artifact: FireArtifactV1): string[] {
  return [...recomputeFireArtifactDigests(artifact), ...verifyFireArtifactRelations(artifact)];
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

/**
 * Write a fire artifact to disk as one canonical, redaction-safe JSON file. The full
 * boundary: authenticate the producer origin, serialize (redaction-clean), STRICT
 * PARSE the exact final bytes, run the COMPLETE replay on the parsed value, and
 * refuse (creating no file) on any violation — only then create the parent directory
 * and write the bytes. The caller chooses `filePath` (the naming convention is a
 * runtime concern).
 */
export function writeFireArtifactV1(filePath: string, artifact: FireArtifactV1): void {
  assertFireArtifact(artifact); // capture + authenticate before any field read
  const bytes = serializeFireArtifactV1(artifact); // asserts brand + redaction-clean
  const parsed = parseFireArtifactV1(bytes); // the EXACT final bytes strict-parse
  const violations = verifyFireArtifactReplay(parsed);
  if (violations.length > 0) {
    throw new Error(`refusing to write a fire artifact that fails replay: ${violations[0]}`);
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, bytes, 'utf8');
}
