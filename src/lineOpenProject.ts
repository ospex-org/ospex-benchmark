import { assertBootedCohort } from './cohortBoot.js';
import { buildGameBundle } from './bundle.js';
import { evaluateCandidate } from './detection.js';
import { MARKET_ORDINAL } from './fireArtifact.js';
import { deepFreeze } from './freeze.js';
import { assertDiscoverySnapshot, assertDiscoverySnapshotFor } from './lineOpenRead.js';
import { reconcileAsOfVsCurrent } from './lineOpenReconcile.js';
import { assertPublicationVerified } from './manifestPublication.js';
import { isMarketPolicyVersion } from './marketPolicy.js';
import { firstTwoSided } from './oddsHistory.js';
import { sealPreparedFire } from './preparedFire.js';
import { easternCalendarDay } from './slateDate.js';
import { instantMs } from './time.js';
import type { BootedCohort } from './cohortBoot.js';
import type { CandidateInput, CandidateState, CandidateVerdict } from './detection.js';
import type { DiscoverySnapshot, MarketEvidenceRead } from './lineOpenRead.js';
import type { PublicationVerified } from './manifestPublication.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { PreparedFireSnapshot } from './preparedFire.js';
import type { CurrentOddsRow, GamesEndpointRow, MarketKey } from './types.js';

/**
 * The line-open PREPARE / RECONCILE / ORDER / SEAL projector
 * (SPEC-line-open-evidence-model.md §3–§4; SPEC-line-open-speculation-runner.md §3):
 * turn one authenticated discovery snapshot + pre-read per-market evidence into an
 * ordered set of single-market prepared fires plus a disposition for EVERY discovered
 * candidate. Pure, synchronous, I/O-free, and NON-ACTIVATING: no store, admission,
 * permit, claim, dispatch, adapter, provider, sink, filesystem, network, scheduler,
 * or clock beyond the injected `now`. It evaluates and seals; nothing else.
 *
 * Activation-first single-market scope: it emits ONE single-market
 * `PreparedFireSnapshot` per reconcile-accepted candidate (`proposedMarkets` is
 * always a singleton), so downstream admission can only produce a terminal
 * all-claimed or a full one-key retention — a strict retained subset is impossible.
 * Game-level co-arrival grouping and retained-scope projection are a later stage's
 * concern.
 *
 * Determinism / permutation invariance: the projection runs in two phases after ONE
 * shared detection clock read. Phase A evaluates every candidate (no per-fire clock,
 * no seal) and collects the accepted work. Phase B sorts the accepted work by its own
 * candidate key, and ONLY THEN reads a per-fire clock, builds the bundle, and seals —
 * so clock assignment, fire content, and output order are all independent of the
 * discovery/current-odds input order.
 */

/** A candidate deferred to a later tick — the transient `candidateDisposition`
 *  defers plus the two projector-owned defers (`quote_moved`, `snapshot_stale`). */
export type DeferReason =
  | 'opener_not_visible'
  | 'detected_before_window'
  | 'clock_skew_defer'
  | 'quote_moved'
  | 'snapshot_stale';

/** A candidate that can never cleanly enter — the terminal `candidateDisposition`
 *  rejects. */
export type RejectReason =
  | 'not_enabled'
  | 'detected_after_window'
  | 'opener_before_window'
  | 'opener_after_window'
  | 'clock_skew_fault'
  | 'stale_entry';

/**
 * The disposition of one discovered candidate — a discriminated union so a reader
 * switches on `outcome` and a `reason` is present exactly when the outcome carries
 * one. `quote_moved` / `snapshot_stale` appear only on `defer`; `prepared` carries
 * no reason. Every element is `Readonly` and deep-frozen.
 */
export type CandidateOutcome =
  | Readonly<{ gameId: string; market: MarketKey; outcome: 'prepared' }>
  | Readonly<{ gameId: string; market: MarketKey; outcome: 'defer'; reason: DeferReason }>
  | Readonly<{ gameId: string; market: MarketKey; outcome: 'reject'; reason: RejectReason }>;

export interface ProjectPreparedFiresInput {
  readonly discovery: DiscoverySnapshot;
  readonly booted: BootedCohort;
  readonly publication: PublicationVerified;
  /** Pre-read per-market evidence, keyed `${gameId}::${market}`. */
  readonly evidence: ReadonlyMap<string, MarketEvidenceRead>;
  /** Injected clock; ONE invocation-level detection read + one fresh read per fire. */
  readonly now: () => number;
}

/**
 * The exhaustive classification of every NON-eligible candidate state to its
 * outcome + reason, mirroring `detection.ts`'s `DISPOSITION_BY_STATE` (the `defer`
 * entries are exactly its transient states, `reject` its terminal ones). `eligible`
 * is deliberately EXCLUDED — it is always further resolved to `prepared` /
 * `snapshot_stale` / `quote_moved` — so a `Record<Exclude<CandidateState,
 * 'eligible'>, …>` makes an accidental eligible classification a compile error.
 */
const OUTCOME_BY_STATE: Record<
  Exclude<CandidateState, 'eligible'>,
  { outcome: 'defer'; reason: DeferReason } | { outcome: 'reject'; reason: RejectReason }
> = {
  opener_not_visible: { outcome: 'defer', reason: 'opener_not_visible' },
  detected_before_window: { outcome: 'defer', reason: 'detected_before_window' },
  clock_skew_defer: { outcome: 'defer', reason: 'clock_skew_defer' },
  not_enabled: { outcome: 'reject', reason: 'not_enabled' },
  detected_after_window: { outcome: 'reject', reason: 'detected_after_window' },
  opener_before_window: { outcome: 'reject', reason: 'opener_before_window' },
  opener_after_window: { outcome: 'reject', reason: 'opener_after_window' },
  clock_skew_fault: { outcome: 'reject', reason: 'clock_skew_fault' },
  stale_entry: { outcome: 'reject', reason: 'stale_entry' },
};

/** The complete, detached, deep-frozen evidence snapshot for one candidate,
 *  captured before the first clock callback so the caller can never mutate it
 *  underneath the projection. */
interface CapturedEvidence {
  readonly gameId: string;
  readonly market: MarketKey;
  readonly historyRows: readonly TwoSidedHistoryRow[];
  readonly historyWatermark: number | null;
  readonly readCompletedAt: string;
}

/** One reconcile-accepted candidate awaiting the canonical order + seal in phase B. */
interface AcceptedWork {
  readonly game: GamesEndpointRow;
  readonly gameId: string;
  readonly market: MarketKey;
  readonly retainedRow: CurrentOddsRow;
  readonly captured: CapturedEvidence;
  readonly candidateInput: CandidateInput;
  readonly verdict: CandidateVerdict;
  /** The candidate's own opener — the primary order key. */
  readonly opener: TwoSidedHistoryRow;
}

/** The exact retained current-odds row for `(gameId, market)`, by pair key (never
 *  by position). */
function findRetainedRow(
  rows: readonly CurrentOddsRow[],
  gameId: string,
  market: MarketKey,
): CurrentOddsRow | undefined {
  return rows.find((r) => r.jsonodds_id === gameId && r.market === market);
}

/** Total order over accepted work: `(opener.captured_at_ms, opener.id, gameId,
 *  MARKET_ORDINAL)`. A rejected/deferred sibling collects no accepted work, so it
 *  can never shift an accepted fire's position. */
function compareAccepted(a: AcceptedWork, b: AcceptedWork): number {
  if (a.opener.captured_at_ms !== b.opener.captured_at_ms) {
    return a.opener.captured_at_ms < b.opener.captured_at_ms ? -1 : 1;
  }
  if (a.opener.id !== b.opener.id) return a.opener.id < b.opener.id ? -1 : 1;
  if (a.gameId !== b.gameId) return a.gameId < b.gameId ? -1 : 1;
  return MARKET_ORDINAL[a.market] - MARKET_ORDINAL[b.market];
}

/** Total order over dispositions: `(gameId, MARKET_ORDINAL)` — permutation-invariant. */
function compareOutcome(a: CandidateOutcome, b: CandidateOutcome): number {
  if (a.gameId !== b.gameId) return a.gameId < b.gameId ? -1 : 1;
  return MARKET_ORDINAL[a.market] - MARKET_ORDINAL[b.market];
}

/**
 * Project the prepared fires and per-candidate dispositions for one authenticated
 * discovery snapshot. Throws (fail-closed integrity) on a crossed/forged root, a
 * missing or pair-misbound evidence entry, a regressed detection clock, a
 * bundle-built instant before detection, or a builder refusal of an accepted
 * candidate. Returns a deep-frozen, ordered result.
 */
export function projectPreparedFires(input: ProjectPreparedFiresInput): {
  readonly fires: readonly PreparedFireSnapshot[];
  readonly dispositions: readonly CandidateOutcome[];
} {
  const { discovery, booted, publication, evidence, now } = input;

  // (1) Authenticate + bind ALL roots — even when zero fires will be produced.
  assertBootedCohort(booted);
  assertDiscoverySnapshot(discovery);
  assertDiscoverySnapshotFor(discovery, booted);
  assertPublicationVerified(publication);
  if (publication.cohortId !== booted.cohortId) {
    throw new Error(
      `publication was verified for cohort ${publication.cohortId}, not this cohort ${booted.cohortId}`,
    );
  }

  // Manifest-derived free operands (all validated at boot; the policy version is
  // narrowed here defensively so a corrupt cast could never reach the policy table).
  const { manifest } = booted;
  const marketPolicyVersion = manifest.marketPolicyVersion;
  if (!isMarketPolicyVersion(marketPolicyVersion)) {
    throw new Error(`manifest marketPolicyVersion ${marketPolicyVersion} is not a known market policy version`);
  }
  const { windowStart, windowEnd, sportAllowList } = manifest;
  const { cleanEntryWindowMs, maxClockSkewMs, freshFireMs } = manifest.constants;
  const gamesById = new Map<string, GamesEndpointRow>(discovery.games.map((g) => [g.gameId, g]));

  // (2) Capture + DETACH the COMPLETE evidence value for each candidate BEFORE the
  //     first now(). A ReadonlyMap is not runtime-immutable and the caller's read
  //     objects/rows are mutable, so an injected now() running after capture could
  //     otherwise mutate the source evidence (map membership, a read field, or a
  //     nested history row); structuredClone + deepFreeze severs every such alias.
  const capturedByKey = new Map<string, CapturedEvidence>();
  for (const candidate of discovery.candidates) {
    const key = `${candidate.gameId}::${candidate.market}`;
    const supplied = evidence.get(key);
    if (supplied === undefined) {
      throw new Error(`no market evidence supplied for candidate (${candidate.gameId}, ${candidate.market})`);
    }
    const captured: CapturedEvidence = deepFreeze(
      structuredClone({
        gameId: supplied.gameId,
        market: supplied.market,
        historyRows: supplied.historyRows,
        historyWatermark: supplied.historyWatermark,
        readCompletedAt: supplied.readCompletedAt,
      }),
    );
    if (captured.gameId !== candidate.gameId || captured.market !== candidate.market) {
      throw new Error(
        `market evidence (${captured.gameId}, ${captured.market}) does not bind to candidate (${candidate.gameId}, ${candidate.market})`,
      );
    }
    capturedByKey.set(key, captured);
  }

  // (3) ONE detection clock read supplies BOTH the detection instant and the V1b delta.
  const detectedAtMs = now();
  const detectedAt = new Date(detectedAtMs).toISOString();
  const delta = detectedAtMs - instantMs(discovery.fetchCompletedAt);
  // (4) delta < 0 is an integrity fault (the monotone same-clock contract, mirroring
  //     clock_skew_fault); delta > freshFireMs is a stale snapshot (otherwise-eligible
  //     candidates defer); equality at the boundary is fresh.
  if (delta < 0) {
    throw new Error(
      `detection instant precedes discovery completion by ${-delta}ms (monotone same-clock contract violated)`,
    );
  }
  const snapshotStale = delta > freshFireMs;

  // (5) Phase A — evaluate only. No per-fire clock read, no seal.
  const dispositions: CandidateOutcome[] = [];
  const accepted: AcceptedWork[] = [];
  for (const candidate of discovery.candidates) {
    const gameId = candidate.gameId;
    const market = candidate.market;
    const key = `${gameId}::${market}`;
    const captured = capturedByKey.get(key);
    if (captured === undefined) {
      throw new Error(`captured evidence missing for candidate (${gameId}, ${market})`); // populated above
    }
    // Sport is joined from the game row (case-exact); a missing game row is a
    // defensive integrity fault (discovery guarantees the join, so it cannot happen
    // via a genuine snapshot).
    const game = gamesById.get(gameId);
    if (game === undefined) {
      throw new Error(`candidate (${gameId}, ${market}) has no game row in the discovery snapshot`);
    }
    const opener = firstTwoSided(captured.historyRows, captured.historyWatermark ?? undefined);
    const candidateInput: CandidateInput = {
      gameId,
      sport: game.sport,
      market,
      sportAllowList,
      marketPolicyVersion,
      opener,
      detectedAt,
      windowStart,
      windowEnd,
      cleanEntryWindowMs,
      maxClockSkewMs,
    };
    const verdict = evaluateCandidate(candidateInput);

    // Candidate-level truth precedes snapshot freshness: a terminal/transient
    // candidate outcome (e.g. not_enabled) is preserved even on a stale snapshot.
    if (verdict.state !== 'eligible') {
      dispositions.push(deepFreeze<CandidateOutcome>({ gameId, market, ...OUTCOME_BY_STATE[verdict.state] }));
      continue;
    }
    // Eligible but the shared snapshot is stale — defer (no fire).
    if (snapshotStale) {
      dispositions.push(deepFreeze<CandidateOutcome>({ gameId, market, outcome: 'defer', reason: 'snapshot_stale' }));
      continue;
    }
    // Eligible + fresh — reconcile the as-of history quote against the EXACT retained
    // current-odds row (by pair key). A moved quote is a transient defer.
    const retainedRow = findRetainedRow(discovery.oddsRows, gameId, market);
    if (retainedRow === undefined) {
      throw new Error(`no retained current_odds row for candidate (${gameId}, ${market})`);
    }
    const accept = reconcileAsOfVsCurrent({
      gameId,
      market,
      historyRows: captured.historyRows,
      historyWatermark: captured.historyWatermark,
      detectedAt,
      current: retainedRow,
    });
    if (!accept) {
      dispositions.push(deepFreeze<CandidateOutcome>({ gameId, market, outcome: 'defer', reason: 'quote_moved' }));
      continue;
    }
    // Accepted — collect for the canonical order + seal in phase B (`verdict.opener`
    // is present: an eligible verdict always carries its opener).
    accepted.push({ game, gameId, market, retainedRow, captured, candidateInput, verdict, opener: verdict.opener });
  }

  // (6) Phase B — canonical accepted-work order, THEN per-fire clock / build / seal.
  accepted.sort(compareAccepted);
  const fires: PreparedFireSnapshot[] = [];
  for (const work of accepted) {
    // Assemble the single-market bundle at the DISCOVERY instant (not a fresh clock),
    // exactly as the discovery buildability filter did, so the fire content is stable.
    const built = buildGameBundle(
      work.game,
      new Map<string, CurrentOddsRow>([[work.market, work.retainedRow]]),
      instantMs(discovery.fetchCompletedAt),
      [work.market],
    );
    if ('reason' in built) {
      throw new Error(
        `bundle build refused an accepted candidate (${work.gameId}, ${work.market}): ${built.reason}`,
      );
    }
    const gameBundle = built.bundle;
    // A fresh per-fire clock read for bundleBuiltAt; it must be >= the detection
    // instant (equality is valid — adjacent Date.now() reads may return the same ms).
    const bundleBuiltAt = new Date(now()).toISOString();
    if (instantMs(bundleBuiltAt) < detectedAtMs) {
      throw new Error(
        `bundle-built instant precedes the detection instant for (${work.gameId}, ${work.market})`,
      );
    }
    const slug = work.game.slug || work.game.gameId;
    const slateDate = easternCalendarDay(work.game.matchTime);
    const snapshot = sealPreparedFire({
      game: gameBundle,
      slug,
      slateDate,
      bundleTimestamp: discovery.fetchCompletedAt,
      booted,
      publication,
      detectedAt,
      bundleBuiltAt,
      proposedMarkets: [work.market],
      perMarket: [
        {
          candidateInput: work.candidateInput,
          verdict: work.verdict,
          historyRows: work.captured.historyRows,
          historyWatermark: work.captured.historyWatermark,
        },
      ],
    });
    fires.push(snapshot);
    dispositions.push(deepFreeze<CandidateOutcome>({ gameId: work.gameId, market: work.market, outcome: 'prepared' }));
  }

  // (7) Order dispositions deterministically, then freeze the output graph.
  dispositions.sort(compareOutcome);
  return { fires: deepFreeze(fires), dispositions: deepFreeze(dispositions) };
}
