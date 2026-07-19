import { z } from 'zod';
import { canonicalize, sha256Hex } from './canonical.js';
import { deepFreeze } from './freeze.js';
import { runBaselines } from './baselines.js';
import { evaluateCandidate } from './detection.js';
import {
  armDigest,
  armEvidenceSchemaV1,
  decisionFingerprint,
  expectedArmIdentity,
  expectedArmIdentitySchemaV1,
  MARKET_ORDINAL,
  toPersistedAttempts,
} from './fireArtifact.js';
import { cohortId as deriveCohortId } from './manifest.js';
import { manifestPublicationV1Schema } from './manifestPublication.js';
import { asOfQuote, firstTwoSided } from './oddsHistory.js';
import { assertRunEnvelope } from './runner.js';
import type { ArmEvidenceV1, ExpectedArmIdentityV1 } from './fireArtifact.js';
import type { BootedCohort } from './cohortBoot.js';
import type { CandidateInput, CandidateVerdict } from './detection.js';
import type { PublicationVerified } from './manifestPublication.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { RunEnvelope } from './runner.js';
import type { ArmGameResult, GameBundle, MarketKey } from './types.js';

/**
 * The fire-artifact PRODUCER (SPEC-line-open-evidence-model.md §4/§5): assemble the
 * single, deeply-immutable, publication-verifiable record of ONE fire — one game,
 * one `fireId`, a 1–3-market scope — from an authenticated dispatched-evidence
 * envelope and the trusted internal fire context. It composes the arm-integrity
 * core (`./fireArtifact.ts`, §5) with the top-level scope / opener-and-as-of /
 * baseline / roster / claim evidence, enforcing the §4/§5/§6 bijections and
 * cardinality invariants so the producer can never emit an artifact its own
 * verifier would reject.
 *
 * The producer RE-DERIVES every recomputable quantity (bundle hashes, the detection
 * verdict, the opener, the as-of quote, the scoped baselines, the per-arm digest)
 * rather than trusting a supplied value, and fails closed on any disagreement.
 * Pure and I/O-free: no store, watcher, provider, close-capture, CLV, scoring, or
 * filesystem write — those are separate slices. Nullable fields use explicit
 * `null` (never `undefined`, which `canonicalize` drops).
 */

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const nonEmpty = z.string().min(1);
const marketKeySchema = z.enum(['moneyline', 'spread', 'total']);
const safeInt = z.number().int().safe();
const nonnegSafeInt = z.number().int().safe().nonnegative();

// ---------------------------------------------------------------------------
// Persisted odds_history row: exactly the validated TwoSidedHistoryRow fields
// (§4 "row identity and the exact opening quote"), projected clean so no source
// passthrough column (sportspage_id, created_at, ...) leaks into the evidence.
// ---------------------------------------------------------------------------

const persistedHistoryRowSchemaV1 = z
  .object({
    id: z.number().int().safe().positive(),
    jsonodds_id: nonEmpty,
    market: marketKeySchema,
    source: z.literal('jsonodds'),
    line: z.number().nullable(),
    away_odds_american: safeInt,
    away_odds_decimal: z.number(),
    home_odds_american: safeInt,
    home_odds_decimal: z.number(),
    captured_at: nonEmpty,
    captured_at_ms: safeInt,
  })
  .strict();
export type PersistedHistoryRowV1 = z.infer<typeof persistedHistoryRowSchemaV1>;

/** The read mode the as-of derivation ran under: unbounded live detection, or a
 *  frozen scoring watermark (`id <= watermark`). Persisted so the scorer knows
 *  which bound reproduced the opener/as-of rows. */
const historyReadModeSchemaV1 = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('live-unbounded') }).strict(),
  z.object({ mode: z.literal('frozen-watermark'), watermark: nonnegSafeInt }).strict(),
]);
export type HistoryReadModeV1 = z.infer<typeof historyReadModeSchemaV1>;

/** The at-most-once claim key bound to this fire (§4 claim/completion linkage):
 *  `(cohortId, fireId, gameId, market)`. The key rejects a duplicate fire; the
 *  `fireId` binds this scoped claim to this completed artifact. */
const claimReferenceSchemaV1 = z
  .object({
    cohortId: sha256Schema,
    fireId: nonEmpty,
    gameId: nonEmpty,
    market: marketKeySchema,
  })
  .strict();
export type ClaimReferenceV1 = z.infer<typeof claimReferenceSchemaV1>;

/** Per-scoped-market entry verification evidence (§4/§5-V1/V2): the opener
 *  (first two-sided appearance, for the age gate) and the as-of quote at
 *  `detectedAt` (the price the model saw), each a detached full row, plus the
 *  read mode and the market's claim key. */
const marketFireEvidenceSchemaV1 = z
  .object({
    market: marketKeySchema,
    detectedAt: nonEmpty,
    openerAgeMs: nonnegSafeInt,
    opener: persistedHistoryRowSchemaV1,
    asOf: persistedHistoryRowSchemaV1,
    historyReadMode: historyReadModeSchemaV1,
    claim: claimReferenceSchemaV1,
  })
  .strict();
export type MarketFireEvidenceV1 = z.infer<typeof marketFireEvidenceSchemaV1>;

/** A deterministic baseline decision derived from the scoped bundle (§4). */
const baselineDecisionSchemaV1 = z
  .object({
    participantId: nonEmpty,
    policyVersion: nonEmpty,
    gameId: nonEmpty,
    market: marketKeySchema,
    selection: nonEmpty,
    line: z.number().nullable(),
    observedDecimal: z.number(),
    track: z.literal('common-cutoff'),
  })
  .strict();

/** The verified public-Git precommitment record persisted in every fire (§2). */
const publicationVerifiedSchemaV1 = z
  .object({
    publication: manifestPublicationV1Schema,
    committerTimestamp: nonEmpty,
  })
  .strict();

/**
 * The complete fire artifact (§4). Strict: an unknown field fails parse, so the
 * producer's own output is validated against the exact contract the scorer reads.
 */
export const fireArtifactV1Schema = z
  .object({
    artifactSchemaVersion: z.literal(1),

    // Cohort identity + public precommitment (§4 a / §2).
    cohortId: sha256Schema,
    publication: publicationVerifiedSchemaV1,

    // Fire identity + scope (§4 b).
    fireId: nonEmpty,
    runId: nonEmpty,
    gameId: nonEmpty,
    sport: nonEmpty,
    scopedMarkets: z.array(marketKeySchema).min(1).max(3),

    // Fire timing (§4).
    preparedSnapshotTs: nonEmpty,
    detectedAt: nonEmpty,
    bundleBuiltAt: nonEmpty,
    scheduledAtAtFire: nonEmpty,

    // Scoped bundle bytes/hashes (§4).
    requestSha256: sha256Schema,
    gameSha256: sha256Schema,
    slateSha256: sha256Schema,

    // Per-market opener/as-of evidence (§4).
    marketEvidence: z.array(marketFireEvidenceSchemaV1).min(1).max(3),

    // Expected-arm roster/config identity + one terminal outcome per arm (§4/§5).
    expectedArmIdentities: z.array(expectedArmIdentitySchemaV1).min(1),
    arms: z.array(armEvidenceSchemaV1).min(1),

    // Deterministic baselines from the same scoped bundle (§4).
    baselinePolicyVersion: nonEmpty,
    baselineDecisions: z.array(baselineDecisionSchemaV1),

    // Claim/completion linkage (§4).
    claims: z.array(claimReferenceSchemaV1).min(1).max(3),
  })
  .strict();

export type FireArtifactV1 = z.infer<typeof fireArtifactV1Schema>;

// ---------------------------------------------------------------------------
// Fire context: the trusted internal inputs the producer reconciles (never
// invents). Everything recomputable here is RE-DERIVED and cross-checked.
// ---------------------------------------------------------------------------

/** One scoped market's detection + history context. */
export interface MarketFireContextV1 {
  /** The exact detection input the runner recorded — RE-EVALUATED here. */
  candidateInput: CandidateInput;
  /** The verdict the runner recorded — must match the pure re-derivation. */
  verdict: CandidateVerdict;
  /** This `(jsonodds_id, market)` pair's `source=jsonodds` history rows. */
  historyRows: readonly TwoSidedHistoryRow[];
  /** `null` = unbounded live read; a number = frozen scoring watermark. */
  historyWatermark: number | null;
  /** The at-most-once claim key for this scoped market. */
  claim: ClaimReferenceV1;
}

export interface FireContext {
  booted: BootedCohort;
  fireId: string;
  runId: string;
  /** The verified public-Git precommitment record (§2). */
  publication: PublicationVerified;
  /** When the scoped bundle was projected (§3 step 6); may follow `detectedAt`. */
  bundleBuiltAt: string;
  /** One entry per scoped market — exactly the scope, no more, no fewer. */
  perMarket: readonly MarketFireContextV1[];
}

// ---------------------------------------------------------------------------
// Producer brand: membership in this WeakSet is unforgeable proof a value came
// through buildFireArtifact (same pattern as sealDispatch / runSlate / prepared).
// ---------------------------------------------------------------------------

const fireArtifacts = new WeakSet<FireArtifactV1>();

/** Throw unless `artifact` was produced by `buildFireArtifact`. */
export function assertFireArtifact(artifact: FireArtifactV1): void {
  if (!fireArtifacts.has(artifact)) {
    throw new Error('fire artifact was not produced by buildFireArtifact (forged or substituted)');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const byCanonicalOrder = (a: MarketKey, b: MarketKey): number => MARKET_ORDINAL[a] - MARKET_ORDINAL[b];

/**
 * The scoped market set (§4 "cardinality derives from the scoped market set"):
 * the markets PRESENT on the dispatched game, in canonical `(gameId, market)`
 * order. The bundle stores the run line under `markets.runLine`; it is the
 * `spread` `MarketKey` everywhere else (detection, baselines, decisions), so the
 * mapping is applied here once.
 */
function scopeOf(game: GameBundle): MarketKey[] {
  const scope: MarketKey[] = [];
  if (game.markets.moneyline != null) scope.push('moneyline');
  if (game.markets.runLine != null) scope.push('spread');
  if (game.markets.total != null) scope.push('total');
  return scope.sort(byCanonicalOrder);
}

/** Whether two market sets are equal as sorted canonical sequences. */
function marketsEqual(a: readonly MarketKey[], b: readonly MarketKey[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort(byCanonicalOrder);
  const sb = [...b].sort(byCanonicalOrder);
  return sa.every((m, i) => m === sb[i]);
}

/** Project a validated history row to the persisted 11-field shape (no passthrough). */
function projectRow(row: TwoSidedHistoryRow): PersistedHistoryRowV1 {
  return {
    id: row.id,
    jsonodds_id: row.jsonodds_id,
    market: row.market,
    source: row.source,
    line: row.line,
    away_odds_american: row.away_odds_american,
    away_odds_decimal: row.away_odds_decimal,
    home_odds_american: row.home_odds_american,
    home_odds_decimal: row.home_odds_decimal,
    captured_at: row.captured_at,
    captured_at_ms: row.captured_at_ms,
  };
}

interface FireIdentity {
  cohortId: string;
  fireId: string;
  runId: string;
  requestSha256: string;
  scope: readonly MarketKey[];
}

/**
 * Assemble ONE expected arm's evidence (§5): its persisted attempts, the sole
 * V-lag operand (`initialRequestStartedAt`), the accepted response digest and
 * decision fingerprint for a `valid` arm, and the recomputable `armDigest`. The
 * §5 cardinality invariants are enforced here — a `valid` arm has exactly one
 * accepted attempt and one decision per scoped market; every other outcome has
 * zero accepted attempts and no decision.
 */
function buildArmEvidence(
  result: ArmGameResult,
  identity: ExpectedArmIdentityV1,
  fire: FireIdentity,
): ArmEvidenceV1 {
  if (result.requestSha256 !== fire.requestSha256) {
    throw new Error(`arm ${identity.participantId} was dispatched on a different request than the fire`);
  }
  const orderedAttempts = toPersistedAttempts(result);
  // The initial attempt's request-start is the SOLE V-lag operand, kept distinct
  // from each attempt's own requestStartedAt; `null` when the initial was unsent.
  const initialRequestStartedAt = result.attempt.requestAt;
  const acceptedAttempts = orderedAttempts.filter((a) => a.acceptedAt !== null);
  const isValid = result.outcome === 'valid';
  if (isValid) {
    if (result.parsed === null) {
      throw new Error(`valid arm ${identity.participantId} carries no parsed response`);
    }
    if (acceptedAttempts.length !== 1) {
      throw new Error(
        `valid arm ${identity.participantId} must have exactly one accepted attempt, found ${acceptedAttempts.length}`,
      );
    }
  } else {
    if (result.parsed !== null) {
      throw new Error(`non-valid arm ${identity.participantId} carries a parsed response`);
    }
    if (acceptedAttempts.length !== 0) {
      throw new Error(`non-valid arm ${identity.participantId} carries an accepted attempt`);
    }
  }
  const acceptedResponseDigest = isValid ? acceptedAttempts[0]!.responseSha256 : null;
  if (isValid && acceptedResponseDigest === null) {
    throw new Error(`valid arm ${identity.participantId} accepted attempt has no response digest`);
  }
  const acceptedDecisionFingerprint = isValid && result.parsed !== null ? decisionFingerprint(result.parsed) : null;
  if (acceptedDecisionFingerprint !== null) {
    // §5: one valid response has exactly one decision per scoped market.
    const decisionMarkets = acceptedDecisionFingerprint.map((e) => e.market);
    if (new Set(decisionMarkets).size !== decisionMarkets.length) {
      throw new Error(`valid arm ${identity.participantId} has more than one decision for a market`);
    }
    if (!marketsEqual(decisionMarkets, fire.scope)) {
      throw new Error(
        `valid arm ${identity.participantId} decisions [${[...decisionMarkets].sort(byCanonicalOrder).join(',')}] != scope [${[...fire.scope].join(',')}]`,
      );
    }
  }
  const digest = armDigest({
    cohortId: fire.cohortId,
    fireId: fire.fireId,
    runId: fire.runId,
    participantId: identity.participantId,
    requestSha256: fire.requestSha256,
    expectedArmIdentity: identity,
    orderedAttempts,
    terminalOutcome: result.outcome,
    acceptedResponseDigestOrNull: acceptedResponseDigest,
    acceptedDecisionFingerprintOrNull: acceptedDecisionFingerprint,
  });
  return {
    expectedArmIdentity: identity,
    terminalOutcome: result.outcome,
    initialRequestStartedAt,
    orderedAttempts,
    acceptedResponseDigest,
    acceptedDecisionFingerprint,
    armDigest: digest,
  };
}

// ---------------------------------------------------------------------------
// The producer
// ---------------------------------------------------------------------------

/**
 * Build the fire artifact for ONE fire from an authenticated run envelope and the
 * trusted fire context. Fails closed on any structural, identity, binding,
 * bijection, or cardinality violation; returns a deeply-frozen, branded,
 * strict-schema-validated `FireArtifactV1`.
 */
export function buildFireArtifact(env: RunEnvelope, ctx: FireContext): FireArtifactV1 {
  // (1) Authenticate the branded run envelope — a forged/substituted wrapper is
  //     rejected before any evidence is read.
  assertRunEnvelope(env);

  // (2) A fire is exactly ONE game (1–3 scoped markets); the dispatched grid is
  //     that game × the expected roster.
  const prepared = env.snapshot.prepared;
  if (prepared.length !== 1) {
    throw new Error(`a fire artifact requires exactly one dispatched game, found ${prepared.length}`);
  }
  const p = prepared[0]!;
  const game = p.game;
  const gameId = p.gameId;
  if (env.snapshot.slate.games.length !== 1) {
    throw new Error(
      `a fire's sealed slate must carry exactly one game, found ${env.snapshot.slate.games.length}`,
    );
  }

  // (3) Cohort identity: the envelope dispatch cohortId, the booted cohortId, and
  //     the cohortId re-derived from the manifest bytes must all agree — binding
  //     the artifact identity to the authenticated manifest.
  const cohortId = ctx.booted.cohortId;
  if (env.dispatch.cohortId !== cohortId) {
    throw new Error(`envelope dispatch cohortId ${env.dispatch.cohortId} != booted cohortId ${cohortId}`);
  }
  if (deriveCohortId(ctx.booted.manifest) !== cohortId) {
    throw new Error('booted cohortId does not match the cohortId derived from the manifest bytes');
  }

  // (4) Scope: the present markets on the dispatched game, canonical order.
  const scope = scopeOf(game);
  if (scope.length === 0) {
    throw new Error('dispatched game supplies no known market');
  }

  // (5) Fire-level bundle identity + hashes, re-derived (recomputable evidence).
  const requestSha256 = sha256Hex(canonicalize(p.requestBundle));
  const gameSha256 = sha256Hex(canonicalize(game));
  const slateSha256 = sha256Hex(canonicalize(env.snapshot.slate));
  if (requestSha256 !== p.requestSha256) throw new Error('recomputed requestSha256 != sealed requestSha256');
  if (gameSha256 !== p.gameSha256) throw new Error('recomputed gameSha256 != sealed gameSha256');
  if (slateSha256 !== env.snapshot.slateSha256) throw new Error('recomputed slateSha256 != sealed slateSha256');
  const scheduledAtAtFire = p.cutoffAt;
  const preparedSnapshotTs = env.snapshot.slate.bundleTimestamp;

  // (6) Per-market evidence + gates. Exactly one context entry per scoped market.
  const ctxMarkets = ctx.perMarket.map((m) => m.candidateInput.market);
  if (new Set(ctxMarkets).size !== ctxMarkets.length) {
    throw new Error('fire context carries duplicate per-market entries');
  }
  if (!marketsEqual(ctxMarkets, scope)) {
    throw new Error(
      `fire context markets [${[...ctxMarkets].sort(byCanonicalOrder).join(',')}] != scope [${scope.join(',')}]`,
    );
  }

  const marketEvidence: MarketFireEvidenceV1[] = [];
  const detectedAts = new Set<string>();
  const sports = new Set<string>();
  for (const market of scope) {
    const mc = ctx.perMarket.find((m) => m.candidateInput.market === market)!;
    const ci = mc.candidateInput;
    if (ci.gameId !== gameId) {
      throw new Error(`candidate gameId ${ci.gameId} != fire gameId ${gameId} (market ${market})`);
    }
    // Re-derive the detection verdict from the SAME input the runner recorded and
    // require it eligible; the carried verdict must equal the pure re-derivation
    // (a runner/context divergence fails closed). evaluateCandidate itself
    // fail-closes on an opener that is not this candidate's own.
    const reVerdict = evaluateCandidate(ci);
    if (reVerdict.state !== 'eligible') {
      throw new Error(`candidate (${gameId}, ${market}) re-evaluates to ${reVerdict.state}, not eligible`);
    }
    if (canonicalize(reVerdict) !== canonicalize(mc.verdict)) {
      throw new Error(`recorded verdict for (${gameId}, ${market}) does not match its re-derivation`);
    }
    const opener = reVerdict.opener;
    if (opener.jsonodds_id !== gameId || opener.market !== market) {
      throw new Error(`opener (${opener.jsonodds_id}, ${opener.market}) does not bind to fire (${gameId}, ${market})`);
    }
    // The opener must be the firstTwoSided of the SAME history rows the as-of
    // derives from — so the whole per-market quote evidence is recomputable from
    // one source, under the recorded read mode.
    const watermark = mc.historyWatermark === null ? undefined : mc.historyWatermark;
    const derivedOpener = firstTwoSided(mc.historyRows, watermark);
    if (derivedOpener === undefined || canonicalize(projectRow(derivedOpener)) !== canonicalize(projectRow(opener))) {
      throw new Error(`opener for (${gameId}, ${market}) is not the firstTwoSided of the supplied history`);
    }
    // As-of quote at detectedAt (the price the model saw, §5-V1). asOfQuote
    // fail-closes on a mixed-pair rows array.
    const asOf = asOfQuote(mc.historyRows, ci.detectedAt, watermark);
    if (asOf === undefined) {
      throw new Error(`no as-of quote at ${ci.detectedAt} for (${gameId}, ${market})`);
    }
    if (asOf.jsonodds_id !== gameId || asOf.market !== market) {
      throw new Error(`as-of row (${asOf.jsonodds_id}, ${asOf.market}) does not bind to fire (${gameId}, ${market})`);
    }
    // Claim key linkage: (cohortId, fireId, gameId, market).
    const claim = mc.claim;
    if (
      claim.cohortId !== cohortId ||
      claim.fireId !== ctx.fireId ||
      claim.gameId !== gameId ||
      claim.market !== market
    ) {
      throw new Error(`claim reference does not bind to fire (${cohortId}, ${ctx.fireId}, ${gameId}, ${market})`);
    }
    detectedAts.add(ci.detectedAt);
    sports.add(ci.sport);
    marketEvidence.push({
      market,
      detectedAt: ci.detectedAt,
      openerAgeMs: reVerdict.openerAgeMs,
      opener: projectRow(opener),
      asOf: projectRow(asOf),
      historyReadMode:
        mc.historyWatermark === null
          ? { mode: 'live-unbounded' }
          : { mode: 'frozen-watermark', watermark: mc.historyWatermark },
      claim: { cohortId, fireId: ctx.fireId, gameId, market },
    });
  }
  // One fire = one prepared snapshot = one detection instant; one game = one sport.
  if (detectedAts.size !== 1) {
    throw new Error(`a fire's scoped markets must share one detection instant, found ${detectedAts.size}`);
  }
  if (sports.size !== 1) {
    throw new Error(`a fire's scoped markets must share one sport, found ${sports.size}`);
  }
  const detectedAt = [...detectedAts][0]!;
  const sport = [...sports][0]!;

  // (7) Roster + arms (§4/§5 roster bijection; one terminal outcome per expected arm).
  const roster = ctx.booted.manifest.expectedArmRoster;
  const rosterIds = roster.map((e) => e.participantId);
  const rosterSet = new Set(rosterIds);
  if (rosterSet.size !== rosterIds.length) {
    throw new Error('manifest expected-arm roster carries a duplicate participantId');
  }
  if (env.expectedArms.length !== rosterIds.length || env.expectedArms.some((id) => !rosterSet.has(id))) {
    throw new Error('dispatched roster does not equal the manifest expected-arm roster');
  }
  if (env.results.length !== rosterIds.length) {
    throw new Error(`fire has ${env.results.length} arm results, expected ${rosterIds.length}`);
  }
  const resultByArm = new Map<string, ArmGameResult>();
  for (const r of env.results) {
    if (r.gameId !== gameId) {
      throw new Error(`arm result for ${r.arm.participantId} is on game ${r.gameId}, not ${gameId}`);
    }
    if (!rosterSet.has(r.arm.participantId)) {
      throw new Error(`unexpected arm result: ${r.arm.participantId}`);
    }
    if (resultByArm.has(r.arm.participantId)) {
      throw new Error(`duplicate arm result: ${r.arm.participantId}`);
    }
    resultByArm.set(r.arm.participantId, r);
  }

  const fire: FireIdentity = { cohortId, fireId: ctx.fireId, runId: ctx.runId, requestSha256, scope };
  const expectedArmIdentities: ExpectedArmIdentityV1[] = [];
  const arms: ArmEvidenceV1[] = [];
  for (const entry of roster) {
    const identity = expectedArmIdentity(entry);
    const result = resultByArm.get(entry.participantId)!; // present: sets equal & sized
    // Arm-family binding: the dispatched arm's provider + requested model must
    // match the manifest identity (model-drift / family-collision guard, §5).
    if (result.arm.provider !== entry.provider || result.arm.requestedModelId !== entry.requestedModelId) {
      throw new Error(
        `arm ${entry.participantId} dispatched as ${result.arm.provider}/${result.arm.requestedModelId}, ` +
          `manifest expects ${entry.provider}/${entry.requestedModelId}`,
      );
    }
    expectedArmIdentities.push(identity);
    arms.push(buildArmEvidence(result, identity, fire));
  }

  // (8) Deterministic baselines from the SAME sealed slate + envelope-carried
  //     policy; the pinned manifest baseline policy must match, and the distinct
  //     baseline markets must equal the scope, all on this game.
  if (env.baselinePolicyVersion !== ctx.booted.manifest.baselinePolicyVersion) {
    throw new Error(
      `envelope baselinePolicyVersion ${env.baselinePolicyVersion} != manifest ${ctx.booted.manifest.baselinePolicyVersion}`,
    );
  }
  const baselineDecisions = runBaselines(env.snapshot.slate, env.baselinePolicyVersion);
  const baselineMarkets = [...new Set(baselineDecisions.map((d) => d.market))];
  if (!marketsEqual(baselineMarkets, scope)) {
    throw new Error(
      `baseline markets [${[...baselineMarkets].sort(byCanonicalOrder).join(',')}] != scope [${scope.join(',')}]`,
    );
  }
  for (const d of baselineDecisions) {
    if (d.gameId !== gameId) throw new Error(`baseline decision on game ${d.gameId}, not ${gameId}`);
    if (d.policyVersion !== env.baselinePolicyVersion) {
      throw new Error(`baseline policyVersion ${d.policyVersion} != ${env.baselinePolicyVersion}`);
    }
  }

  const claims = marketEvidence.map((m) => m.claim);

  // (9) Assemble, strict-parse (fail-closed: the producer must not emit what its
  //     own verifier rejects), deep-freeze, and brand.
  const validated = fireArtifactV1Schema.parse({
    artifactSchemaVersion: 1,
    cohortId,
    publication: ctx.publication,
    fireId: ctx.fireId,
    runId: ctx.runId,
    gameId,
    sport,
    scopedMarkets: scope,
    preparedSnapshotTs,
    detectedAt,
    bundleBuiltAt: ctx.bundleBuiltAt,
    scheduledAtAtFire,
    requestSha256,
    gameSha256,
    slateSha256,
    marketEvidence,
    expectedArmIdentities,
    arms,
    baselinePolicyVersion: env.baselinePolicyVersion,
    baselineDecisions,
    claims,
  });
  const frozen = deepFreeze(validated);
  fireArtifacts.add(frozen);
  return frozen;
}
