import { canonicalize, sha256Hex } from './canonical.js';
import { assertBootedCohort } from './cohortBoot.js';
import { evaluateCandidate } from './detection.js';
import { expectedArmIdentity, MARKET_ORDINAL } from './fireArtifact.js';
import { deepFreeze } from './freeze.js';
import { assertPublicationVerified } from './manifestPublication.js';
import { prepareGameRequest } from './preparedRequest.js';
import { buildGameRequest } from './scopedRequest.js';
import { isParseableInstant } from './time.js';
import type { BootedCohort } from './cohortBoot.js';
import type { CandidateInput, CandidateVerdict } from './detection.js';
import type { ExpectedArmIdentityV1 } from './fireArtifact.js';
import type { PublicationVerified } from './manifestPublication.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { PreparedGameRequest } from './preparedRequest.js';
import type { GameBundle, MarketKey } from './types.js';

/**
 * The prepared-fire snapshot boundary (SPEC-line-open-evidence-model.md §3–§4):
 * turn one game's caller-supplied fire inputs into ONE synchronously-sealed,
 * runtime-authenticated, deeply-immutable, DETACHED value that every later fire
 * stage derives from. It is the single immutable representation of exactly what a
 * fire was prepared to dispatch — the exact request (through the existing prepared-
 * request owner), the authenticated cohort + publication, the proposed scope, the
 * per-market detection evidence, the fire timing, and the expected roster identity —
 * plus the derived fire/run identities and one non-circular preparation digest.
 *
 * It is PURE DATA. It holds no store, admission, permit, adapter, adapter map,
 * lifecycle, lease, clock, callback, or filesystem sink; it dispatches nothing and
 * produces no artifact. The claim/admission linkage and the roster→adapter dispatch
 * plan are owned by later stages; fireability (eligibility, cutoff, V-lag) stays the
 * detection loop's and the fire-artifact producer's concern. This boundary's sole
 * job is to seal COHERENT, immutable, detached evidence: once sealed, mutating the
 * caller's originals cannot change it, and only a genuine `sealPreparedFire` output
 * authenticates.
 *
 * Every authority object it captures is authenticated by unforgeable origin brand
 * (`assertBootedCohort`, `assertPublicationVerified`, and the branded
 * `prepareGameRequest`), and every recorded verdict is re-derived from the sealed
 * candidate and required to match. A structural contradiction (a mismatched game,
 * scope, or evidence binding) fails the seal — it never brands an internally
 * inconsistent object.
 */

// ---------------------------------------------------------------------------
// Internal, domain-separated constants. None is a caller argument.
// ---------------------------------------------------------------------------

const FIRE_ID_DOMAIN = 'line-open-fire-id-v1';
const RUN_ID_DOMAIN = 'line-open-run-id-v1';
const DIGEST_DOMAIN = 'line-open-prepared-fire-digest-v1';

/** The known market keys a proposal may name (moneyline, spread, total). */
const KNOWN_MARKETS: readonly MarketKey[] = ['moneyline', 'spread', 'total'];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PreparedFireError extends Error {
  readonly violations: readonly string[];
  constructor(violations: readonly string[]) {
    super(`invalid prepared fire: ${violations.join('; ')}`);
    this.name = 'PreparedFireError';
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One proposed market's caller-supplied detection evidence (no claim linkage — the
 *  at-most-once claim key is bound by the admission stage, not here). */
export interface PreparedMarketEvidenceInput {
  candidateInput: CandidateInput;
  verdict: CandidateVerdict;
  historyRows: readonly TwoSidedHistoryRow[];
  /** `null` = unbounded live read; a nonnegative safe integer = frozen watermark. */
  historyWatermark: number | null;
}

export interface SealPreparedFireInput {
  /** The frozen scoped game; the request is built from it through the shared owner. */
  game: GameBundle;
  slug: string;
  slateDate: string;
  bundleTimestamp: string;
  /** MUST be a genuine `cohortBoot` output (authenticated by brand). */
  booted: BootedCohort;
  /** MUST be a genuine `checkPublication` output for the booted cohort. */
  publication: PublicationVerified;
  /** The fire's single detection instant; every candidate must carry it. */
  detectedAt: string;
  /** When the scoped bundle was projected (may follow `detectedAt`). */
  bundleBuiltAt: string;
  /** The proposed scope — validated as a nonempty unique subset of the known market
   *  keys, and required to equal the request's actual present-market scope. */
  proposedMarkets: readonly MarketKey[];
  /** Exactly one entry per proposed market — no more, no fewer. */
  perMarket: readonly PreparedMarketEvidenceInput[];
}

// ---------------------------------------------------------------------------
// The sealed snapshot
// ---------------------------------------------------------------------------

export interface PreparedMarketEvidence {
  readonly market: MarketKey;
  readonly candidateInput: CandidateInput;
  readonly verdict: CandidateVerdict;
  readonly historyRows: readonly TwoSidedHistoryRow[];
  readonly historyWatermark: number | null;
}

export interface PreparedFireSnapshot {
  /** Derived from the preparation digest (internal domain); never caller-supplied. */
  readonly fireId: string;
  /** Domain-separated digest of `fireId`; never equals it; never caller-supplied. */
  readonly runId: string;
  /** The non-circular digest of the sealed plain evidence (the durable binding the
   *  admission stage recomputes via `fireId`). Never caller-supplied. */
  readonly preparedSnapshotDigest: string;
  /** The genuine, branded, deep-frozen prepared request (retained by identity). */
  readonly prepared: PreparedGameRequest;
  /** The genuine, branded, deep-frozen booted cohort (retained by identity). */
  readonly booted: BootedCohort;
  /** The genuine, branded, deep-frozen verified publication (retained by identity). */
  readonly publication: PublicationVerified;
  readonly detectedAt: string;
  readonly bundleBuiltAt: string;
  /** Canonical-order proposed scope (== the request's present-market scope). */
  readonly proposedMarkets: readonly MarketKey[];
  /** Per-market evidence in canonical market order; detached + deep-frozen. */
  readonly perMarket: readonly PreparedMarketEvidence[];
  /** Expected roster identity derived ONLY from the authenticated cohort manifest. */
  readonly expectedArmIdentities: readonly ExpectedArmIdentityV1[];
}

// ---------------------------------------------------------------------------
// Runtime origin brand. A PreparedFireSnapshot's TypeScript type is erased at
// runtime, so a direct caller could forge the shape (or cast a raw object) and hand
// an unsealed fire straight to a later stage. This module-private WeakSet is
// populated ONLY by sealPreparedFire below, so membership is unforgeable runtime
// PROOF that a value actually came through the seal — the type alone is not a guard.
// ---------------------------------------------------------------------------

const preparedFireSnapshots = new WeakSet<PreparedFireSnapshot>();

/** Throw unless `snapshot` was produced by `sealPreparedFire`. A stage that trusts
 *  the sealed authority calls this; a forged or structurally-copied value is
 *  rejected even though the TypeScript type would let one through. */
export function assertPreparedFireSnapshot(snapshot: PreparedFireSnapshot): void {
  if (!preparedFireSnapshots.has(snapshot)) {
    throw new PreparedFireError([
      'prepared fire snapshot was not produced by sealPreparedFire (forged or substituted)',
    ]);
  }
}

// ---------------------------------------------------------------------------
// Identity derivation (internal-domain, non-circular)
// ---------------------------------------------------------------------------

/** Canonical-order market set (moneyline < spread < total). */
function canonicalMarkets(markets: readonly MarketKey[]): MarketKey[] {
  return [...markets].sort((a, b) => MARKET_ORDINAL[a] - MARKET_ORDINAL[b]);
}

/**
 * The fire identity — a domain-separated digest of exactly the five caller-state
 * operands: the cohort, the game, the canonical proposed market set, the detection
 * instant, and the internally-computed preparation digest. Canonical-order-insensitive
 * on the market set; every operand is load-bearing.
 */
export function deriveFireId(input: {
  cohortId: string;
  gameId: string;
  proposedMarkets: readonly MarketKey[];
  detectedAt: string;
  preparedSnapshotDigest: string;
}): string {
  // The proposed market set is runtime-validated HERE, at the exported identity
  // owner (through the SAME single validator `sealPreparedFire` uses), so a direct
  // caller cannot derive an id from an empty / duplicate / unknown-market scope. The
  // sort runs through the runtime-frozen `MARKET_ORDINAL`, so the id is stable
  // against ambient registry mutation.
  const { canonical, violations } = checkProposedMarkets(input.proposedMarkets);
  if (violations.length > 0) throw new PreparedFireError(violations);
  return sha256Hex(
    canonicalize({
      domain: FIRE_ID_DOMAIN,
      cohortId: input.cohortId,
      gameId: input.gameId,
      proposedMarkets: canonical,
      detectedAt: input.detectedAt,
      preparedSnapshotDigest: input.preparedSnapshotDigest,
    }),
  );
}

/** The one-game run id: a separate internal-domain digest of the fire id (never
 *  ad-hoc random, never equal to the fire id). */
export function deriveRunId(fireId: string): string {
  return sha256Hex(canonicalize({ domain: RUN_ID_DOMAIN, fireId }));
}

// ---------------------------------------------------------------------------
// The preparation digest (one explicit, domain-separated, non-circular preimage)
// ---------------------------------------------------------------------------

interface DigestParts {
  cohortId: string;
  publication: PublicationVerified;
  prepared: PreparedGameRequest;
  proposedMarkets: readonly MarketKey[];
  detectedAt: string;
  bundleBuiltAt: string;
  perMarket: readonly PreparedMarketEvidence[];
  expectedArmIdentities: readonly ExpectedArmIdentityV1[];
}

/**
 * The exact canonical preimage of `preparedSnapshotDigest`: a plain-data projection
 * of every authority-bearing sealed field and NOTHING derived from it. It excludes
 * `preparedSnapshotDigest` itself, `fireId`/`runId`, and any function / Map / Set
 * (every projected value is plain JSON). This preimage shape is the committed
 * contract — a test recomputes it independently rather than calling this helper.
 */
function preparedSnapshotDigestPreimage(parts: DigestParts): unknown {
  return {
    domain: DIGEST_DOMAIN,
    cohortId: parts.cohortId,
    publication: {
      publication: parts.publication.publication,
      committerTimestamp: parts.publication.committerTimestamp,
      cohortId: parts.publication.cohortId,
    },
    prepared: {
      gameId: parts.prepared.gameId,
      slug: parts.prepared.slug,
      requestBundle: parts.prepared.requestBundle,
      requestSha256: parts.prepared.requestSha256,
      gameSha256: parts.prepared.gameSha256,
      cutoffAt: parts.prepared.cutoffAt,
    },
    proposedMarkets: [...parts.proposedMarkets],
    detectedAt: parts.detectedAt,
    bundleBuiltAt: parts.bundleBuiltAt,
    perMarket: parts.perMarket.map((m) => ({
      market: m.market,
      candidateInput: m.candidateInput,
      verdict: m.verdict,
      historyRows: m.historyRows,
      historyWatermark: m.historyWatermark,
    })),
    expectedArmIdentities: parts.expectedArmIdentities.map((a) => ({
      participantId: a.participantId,
      provider: a.provider,
      requestedModelId: a.requestedModelId,
      approvedReportedModelIds: [...a.approvedReportedModelIds],
    })),
  };
}

function computePreparedSnapshotDigest(parts: DigestParts): string {
  return sha256Hex(canonicalize(preparedSnapshotDigestPreimage(parts)));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The present-market scope of the request's one game, canonical order. The bundle
 *  stores the run line under `markets.runLine`; it is the `spread` MarketKey. */
function requestScope(game: GameBundle): MarketKey[] {
  const scope: MarketKey[] = [];
  if (game.markets.moneyline != null) scope.push('moneyline');
  if (game.markets.runLine != null) scope.push('spread');
  if (game.markets.total != null) scope.push('total');
  return canonicalMarkets(scope);
}

/** Sorted-sequence equality of two market sets. */
function marketsEqual(a: readonly MarketKey[], b: readonly MarketKey[]): boolean {
  const sa = canonicalMarkets(a);
  const sb = canonicalMarkets(b);
  return sa.length === sb.length && sa.every((m, i) => m === sb[i]);
}

/**
 * Validate the proposed scope (nonempty, unique, known keys) and return it in
 * canonical order together with any violations. The ONE runtime rule with a single
 * source of truth: the exported `deriveFireId` calls this and THROWS on any
 * violation, while `sealPreparedFire` calls it and ACCUMULATES — so the identity
 * owner and the sealer can never diverge on which market scopes are admissible.
 */
function checkProposedMarkets(markets: readonly MarketKey[]): { canonical: MarketKey[]; violations: string[] } {
  const violations: string[] = [];
  if (!Array.isArray(markets) || markets.length === 0) {
    violations.push('proposedMarkets must be a nonempty array');
    return { canonical: [], violations };
  }
  const known = new Set<MarketKey>(KNOWN_MARKETS);
  const seen = new Set<MarketKey>();
  for (const m of markets) {
    if (!known.has(m)) violations.push(`unknown proposed market: ${String(m)}`);
    else if (seen.has(m)) violations.push(`duplicate proposed market: ${m}`);
    else seen.add(m);
  }
  return { canonical: canonicalMarkets([...seen]), violations };
}

// ---------------------------------------------------------------------------
// The seal
// ---------------------------------------------------------------------------

/** One per-market entry captured (materialized) exactly once from the caller: plain,
 *  detached data that validation, the digest, and the returned snapshot all share. */
interface CapturedMarketEvidence {
  candidateInput: CandidateInput;
  verdict: CandidateVerdict;
  historyRows: TwoSidedHistoryRow[];
  historyWatermark: number | null;
}

/**
 * Seal one prepared fire. Synchronous and fail-closed: it authenticates the trust
 * roots, builds + authenticates the exact request through the existing owner, and
 * validates full relational coherence, throwing `PreparedFireError` (carrying every
 * reason) on any violation. On success it returns a detached, deeply-frozen, brand-
 * authenticated `PreparedFireSnapshot`.
 */
export function sealPreparedFire(input: SealPreparedFireInput): PreparedFireSnapshot {
  // Capture EVERY caller-owned property exactly once into a local. A property accessor
  // can return a different value on each read, so authenticating or validating one read
  // and then re-reading the caller property for the digest or the returned snapshot
  // would let a swapping getter substitute an unauthenticated authority, invalid timing,
  // or wrong evidence into a branded snapshot. Every step below operates on these
  // locals; `input.*` and caller entry fields are never re-read.
  const booted = input.booted;
  const publication = input.publication;
  const detectedAt = input.detectedAt;
  const bundleBuiltAt = input.bundleBuiltAt;
  const game = input.game;
  const slug = input.slug;
  const slateDate = input.slateDate;
  const bundleTimestamp = input.bundleTimestamp;
  const proposedMarketsRaw = input.proposedMarkets;
  const perMarketRaw = input.perMarket;

  // (1) Authenticate the captured trust roots by unforgeable origin brand. Once these
  //     pass, each is a genuine, deep-frozen owner output, so its later field reads are
  //     stable; the publication must have been verified for THIS cohort.
  assertBootedCohort(booted);
  assertPublicationVerified(publication);
  if (publication.cohortId !== booted.cohortId) {
    throw new PreparedFireError([
      `publication was verified for cohort ${publication.cohortId}, not this cohort ${booted.cohortId}`,
    ]);
  }
  const cohortId = booted.cohortId;

  // (2) Build + authenticate the exact request through the existing owner exactly
  //     once (never a second hash owner): buildGameRequest wraps the frozen game,
  //     prepareGameRequest strict-validates, derives the hashes, deep-freezes, and
  //     brands. A malformed request is its own typed rejection (PreparedRequestError).
  const prepared = prepareGameRequest(buildGameRequest(game, slug, slateDate, bundleTimestamp));
  const gameId = prepared.gameId;

  const violations: string[] = [];

  // (3) Fire timing: offset-qualified instants (the prepared-request owner stays
  //     authoritative for request/quote timing; these are the detection/projection
  //     instants this snapshot introduces).
  if (!isParseableInstant(detectedAt)) {
    violations.push(`detectedAt "${detectedAt}" is not an offset-qualified instant`);
  }
  if (!isParseableInstant(bundleBuiltAt)) {
    violations.push(`bundleBuiltAt "${bundleBuiltAt}" is not an offset-qualified instant`);
  }

  // (4) Proposed scope: a nonempty unique subset of the known market keys, stored in
  //     canonical order, and EQUAL to the request's actual present-market scope.
  const { canonical: proposed, violations: scopeViolations } = checkProposedMarkets(proposedMarketsRaw);
  violations.push(...scopeViolations);
  const scope = requestScope(prepared.game);
  if (proposed.length > 0 && !marketsEqual(proposed, scope)) {
    violations.push(`proposed markets [${proposed.join(',')}] != request scope [${scope.join(',')}]`);
  }

  // (5) Per-market evidence: exactly one entry per proposed market, each bound to the
  //     fire's (gameId, market); the recorded verdict must equal a fresh, detached
  //     re-derivation; every candidate carries the one detection instant; the history
  //     rows and watermark bind to the same (gameId, market). Evidence is detached
  //     (cloned) and re-derived, never aliased to a caller object.
  // Materialize each per-market entry's evidence ONCE: structuredClone reads the outer
  // collection, each entry, and each entry field a single time and yields plain,
  // detached data. Validation, the digest, and the returned snapshot then all bind the
  // SAME captured value, so a swapping getter cannot substitute post-check evidence.
  const capturedPerMarket: CapturedMarketEvidence[] = Array.from(perMarketRaw, (entry) => ({
    candidateInput: structuredClone(entry.candidateInput),
    verdict: structuredClone(entry.verdict),
    historyRows: structuredClone([...entry.historyRows]),
    historyWatermark: entry.historyWatermark,
  }));

  const proposedSet = new Set<MarketKey>(proposed);
  const byMarket = new Map<MarketKey, CapturedMarketEvidence>();
  for (const entry of capturedPerMarket) {
    const m = entry.candidateInput.market;
    if (!proposedSet.has(m)) {
      violations.push(`per-market evidence market "${m}" is not a proposed market`);
      continue;
    }
    if (byMarket.has(m)) {
      violations.push(`duplicate per-market evidence for market "${m}"`);
      continue;
    }
    byMarket.set(m, entry);
  }
  for (const m of proposed) {
    if (!byMarket.has(m)) violations.push(`missing per-market evidence for market "${m}"`);
  }

  const sealedPerMarket: PreparedMarketEvidence[] = [];
  for (const m of proposed) {
    const entry = byMarket.get(m);
    if (entry === undefined) continue; // missing — already flagged
    // Every check + the retained value use the SAME captured clone (never a re-read).
    const candidateInput = entry.candidateInput;
    if (candidateInput.gameId !== gameId) {
      violations.push(`candidate gameId ${candidateInput.gameId} != fire gameId ${gameId} (market ${m})`);
    }
    if (candidateInput.market !== m) {
      violations.push(`candidate market ${candidateInput.market} != evidence market ${m}`);
    }
    if (candidateInput.detectedAt !== detectedAt) {
      violations.push(
        `candidate (${gameId}, ${m}) detectedAt ${candidateInput.detectedAt} != fire detectedAt ${detectedAt}`,
      );
    }
    for (const row of entry.historyRows) {
      if (row.jsonodds_id !== gameId || row.market !== m) {
        violations.push(`history row (${row.jsonodds_id}, ${row.market}) does not bind to fire (${gameId}, ${m})`);
      }
    }
    if (
      entry.historyWatermark !== null &&
      !(Number.isSafeInteger(entry.historyWatermark) && entry.historyWatermark >= 0)
    ) {
      violations.push(`history watermark for (${gameId}, ${m}) must be null or a nonnegative safe integer`);
    }
    // Re-derive the verdict from the captured candidate and require the recorded one to
    // equal it canonically — the exact detection the fire was prepared under. A caller/
    // evidence-integrity bug throws out of evaluateCandidate; that is a rejection here.
    let reVerdict: CandidateVerdict;
    try {
      reVerdict = evaluateCandidate(candidateInput);
    } catch (error) {
      violations.push(
        `candidate (${gameId}, ${m}) re-evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (canonicalize(reVerdict) !== canonicalize(entry.verdict)) {
      violations.push(`recorded verdict for (${gameId}, ${m}) does not match its re-derivation`);
      continue;
    }
    // The captured clones are retained as-is (already detached); the whole snapshot is
    // recursively deep-frozen at return (step 8) — that recursion is the single
    // load-bearing immutability lock over this nested evidence.
    sealedPerMarket.push({
      market: m,
      candidateInput,
      verdict: reVerdict, // detached + deep-frozen by evaluateCandidate
      historyRows: entry.historyRows,
      historyWatermark: entry.historyWatermark,
    });
  }

  // (6) Expected roster identity — derived ONLY from the authenticated cohort manifest
  //     (never a second caller-supplied roster); each entry detached + deep-frozen.
  const expectedArmIdentities = booted.manifest.expectedArmRoster.map(expectedArmIdentity);

  if (violations.length > 0) throw new PreparedFireError(violations);

  // (7) One non-circular preparation digest over the sealed plain evidence, then the
  //     domain-separated fire + run identities derived FROM that digest. Callers
  //     supply none of the three derived identities.
  const preparedSnapshotDigest = computePreparedSnapshotDigest({
    cohortId,
    publication,
    prepared,
    proposedMarkets: proposed,
    detectedAt,
    bundleBuiltAt,
    perMarket: sealedPerMarket,
    expectedArmIdentities,
  });
  const fireId = deriveFireId({
    cohortId,
    gameId,
    proposedMarkets: proposed,
    detectedAt,
    preparedSnapshotDigest,
  });
  const runId = deriveRunId(fireId);

  // (8) Assemble the detached, deeply immutable, runtime-authenticated snapshot. The
  //     already-branded + deep-frozen booted / publication / prepared values are
  //     retained by identity; every other field is a captured, cloned, plain value.
  const snapshot: PreparedFireSnapshot = deepFreeze({
    fireId,
    runId,
    preparedSnapshotDigest,
    prepared,
    booted,
    publication,
    detectedAt,
    bundleBuiltAt,
    proposedMarkets: proposed,
    perMarket: sealedPerMarket,
    expectedArmIdentities,
  });
  preparedFireSnapshots.add(snapshot);
  return snapshot;
}
