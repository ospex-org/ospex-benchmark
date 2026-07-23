import { assertBootedCohort } from './cohortBoot.js';
import { projectPreparedFires } from './lineOpenProject.js';
import { runOneFire } from './lineOpenSpine.js';
import type { BootedCohort } from './cohortBoot.js';
import type {
  DiscoverFn,
  MarketEvidenceRead,
  ReadMarketEvidenceFn,
} from './lineOpenRead.js';
import type { CandidateOutcome } from './lineOpenProject.js';
import type { ClaimPort } from './lineOpenClaim.js';
import type { PublicationVerified } from './manifestPublication.js';
import type {
  ArtifactInstaller,
  LineOpenAdmissionParameters,
  LineOpenFireOutcome,
  LineOpenRunOptions,
} from './lineOpenSpine.js';
import type { MarketKey, ProviderAdapter } from './types.js';

/**
 * The per-tick cohort runner loop (SPEC-line-open-speculation-runner.md §3–§4;
 * SPEC-line-open-evidence-model.md §4/§5): the single orchestrator that chains the
 * already-merged line-open primitives into ONE tick — discover the fire candidates,
 * read each candidate's opener evidence, project the ordered prepared fires + their
 * per-candidate dispositions, then run each fire end to end through the composition
 * spine under the manifest's per-tick dispatch budget.
 *
 * NON-ACTIVATING: every real seam — discovery, the per-market opener read, the claim
 * port, the provider adapters, and the durable artifact sink — is INJECTED. This module
 * imports no real fetcher, store, adapter, filesystem, network, or ambient clock; it
 * composes injected seams only. `assertBootedCohort` is its own fail-closed gate;
 * everything downstream (`projectPreparedFires` / `runOneFire`) authenticates its own
 * brands. A rehearsal claim port (never admits, mints no permit) makes the whole tick
 * report-only: every fire returns `NotAdmitted` and installs no artifact.
 */

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface CohortTickInput {
  readonly booted: BootedCohort;
  readonly publication: PublicationVerified;
  /** Enumerate the fire candidates for the booted cohort from the current-odds snapshot. */
  readonly discover: DiscoverFn;
  /** Read one `(gameId, market)` pair's full opener evidence. */
  readonly readMarketEvidence: ReadMarketEvidenceFn;
  readonly claimPort: ClaimPort;
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly sink: ArtifactInstaller;
  readonly runOptions: LineOpenRunOptions;
  readonly admission: LineOpenAdmissionParameters;
  /** ONE injected clock for the tick; also drives `projectPreparedFires`'s detection/seal reads. */
  readonly now: () => number;
  /** Optional observability hook, called once per attempted fire. */
  readonly onStatus?: (line: string) => void;
}

/**
 * One attempted fire's terminal outcome for the tick: its identity plus the FULL typed outcome
 * the composition spine returned. The whole `LineOpenFireOutcome` is retained (not just its
 * `kind`) so nothing load-bearing is erased at this boundary: a `NotAdmitted.outcome` still
 * distinguishes a retryable `Defer(reason)` from a terminal `Skip(reason)` from a loud
 * `Fault(reason)` from a rehearsal `WouldAdmit`, and still carries a `Skip(replayed_pending)`'s
 * detached recovery capability; an `Installed.completion` still distinguishes `settled` from
 * `unsettled(reason)` (which an activation consumer must escalate). The outcome is kept BY
 * REFERENCE — it is already produced and frozen/branded by the spine's own owners, and is never
 * re-frozen into its branded graph here.
 */
export interface FireOutcomeSummary {
  readonly fireId: string;
  readonly gameId: string;
  readonly market: MarketKey;
  readonly outcome: LineOpenFireOutcome;
}

/**
 * The frozen result of one tick: how many candidates discovery found, the per-candidate
 * dispositions passed through from the projector (one per discovered candidate), the
 * per-fire outcome summaries for exactly the fires that were ATTEMPTED (never the ones the
 * dispatch budget stopped short of), and the count of newly-admitted (`Installed`) fires.
 */
export interface CohortTickResult {
  readonly discoveredCount: number;
  readonly dispositions: readonly CandidateOutcome[];
  readonly fireOutcomes: readonly FireOutcomeSummary[];
  readonly admittedCount: number;
}

/** A one-line observability description carrying the discriminating outcome info — the outcome
 *  kind plus a `NotAdmitted` claim reason or an `Installed` completion status — not just `kind`. */
function describeOutcome(outcome: LineOpenFireOutcome): string {
  if (outcome.kind === 'Installed') {
    return outcome.completion.status === 'settled'
      ? 'Installed/settled'
      : `Installed/unsettled(${outcome.completion.reason})`;
  }
  const claim = outcome.outcome;
  return 'reason' in claim ? `NotAdmitted/${claim.kind}(${claim.reason})` : `NotAdmitted/${claim.kind}`;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/**
 * Run one dry-run cohort tick over injected seams.
 *
 * This is a SERIAL dry-run tick: fires are dispatched one at a time, each awaited fully
 * before the next begins. Non-serial launch — launching a fire task on admit without
 * awaiting the prior fire's model batch, and the invariant that a slow first fire must not
 * strand a second capacity-authorized fire — is DELIBERATELY DEFERRED to a separate later
 * hardening slice; it is a live-scale concern, and the serial loop is correct for a
 * single-process dry run with mock adapters. Send-time V-lag / windowEnd gates on the initial
 * request are now enforced at the spine — `runOneFire` gates each initial send on first pitch /
 * windowEnd / V-lag, in addition to the first-pitch cutoff via `cutoffAt` — so this loop adds no
 * dispatch gate of its own.
 */
export async function runCohortTick(input: CohortTickInput): Promise<CohortTickResult> {
  const {
    booted,
    publication,
    discover,
    readMarketEvidence,
    claimPort,
    adapters,
    sink,
    runOptions,
    admission,
    now,
    onStatus,
  } = input;

  // (1) Fail closed on the booted cohort before anything reads a manifest field. Every
  //     downstream stage (`projectPreparedFires`, `runOneFire`) authenticates its own brands.
  assertBootedCohort(booted);

  // (2) Discover the fire candidates from the current-odds snapshot.
  const discovery = await discover(booted);

  // (3) Read every candidate's opener evidence concurrently, keyed `${gameId}::${market}`
  //     to match the projector's evidence lookup. A read FAULT (a rejecting read) is a
  //     source-integrity fault per the read owner's contract: it propagates and fails the
  //     tick loudly. An EMPTY completed read (`historyRows: []`) is normal — the projector
  //     maps it to an `opener_not_visible` defer.
  const evidenceEntries = await Promise.all(
    discovery.candidates.map(async (candidate): Promise<readonly [string, MarketEvidenceRead]> => {
      const read = await readMarketEvidence(booted, candidate.gameId, candidate.market);
      return [`${candidate.gameId}::${candidate.market}`, read];
    }),
  );
  const evidence = new Map<string, MarketEvidenceRead>(evidenceEntries);

  // (4) Project the ordered prepared fires + a disposition for EVERY discovered candidate.
  const { fires, dispositions } = projectPreparedFires({ discovery, booted, publication, evidence, now });

  // (5) Serial, admit-counted dispatch loop. Iterate fires in projection order; stop once
  //     the manifest's per-tick budget of newly-admitted dispatches is reached. Only an
  //     `Installed` outcome consumes the budget — a `NotAdmitted` (all_claimed / defer /
  //     refused / rehearsal) is recorded but never counted, so a leading all_claimed fire
  //     does not strand a later admittable one under the cap.
  const maxDispatchesPerTick = booted.manifest.constants.maxDispatchesPerTick;
  const fireOutcomes: FireOutcomeSummary[] = [];
  let admittedCount = 0;
  for (const fire of fires) {
    if (admittedCount >= maxDispatchesPerTick) break;
    const outcome = await runOneFire({ snapshot: fire, adapters, claimPort, sink, runOptions, admission });
    // Single-market fires: the fire's sole proposed market is `proposedMarkets[0]`. The full typed
    // outcome is retained by reference and the summary is only SHALLOW-frozen — `deepFreeze` would
    // re-traverse the spine's already-frozen/branded outcome graph (artifact / permit / any
    // pending-replay recovery capability), which this boundary must not touch.
    const summary: FireOutcomeSummary = Object.freeze({
      fireId: fire.fireId,
      gameId: fire.prepared.gameId,
      market: fire.proposedMarkets[0]!,
      outcome,
    });
    fireOutcomes.push(summary);
    if (outcome.kind === 'Installed') admittedCount += 1;
    onStatus?.(`fire ${summary.fireId} (${summary.gameId} ${summary.market}): ${describeOutcome(outcome)}`);
  }

  // Shallow-freeze only: each summary is already frozen above, `dispositions` is already deep-frozen
  // by `projectPreparedFires`, and every retained `outcome` stays frozen/branded by its own owner —
  // so the wrapper never re-traverses those graphs.
  return Object.freeze({
    discoveredCount: discovery.candidates.length,
    dispositions,
    fireOutcomes: Object.freeze(fireOutcomes),
    admittedCount,
  });
}
