import { sha256Hex } from './canonical.js';
import { redactSecrets } from './config.js';
import {
  CONFIGURATION_DIGEST_VERSION,
  canonicalConfigurationText,
  configurationSha256,
  configurationViolations,
} from './participantConfiguration.js';
import { PROJECTION_SCALES, quantizeForProjection } from './projectionNumeric.js';
import { isParseableInstant } from './time.js';
import type { ParticipantConfiguration } from './participantConfiguration.js';
import type { MarketKey } from './types.js';
import type { StoreQuery } from './store/atomicStore.js';

/**
 * The publisher for the benchmark SERVING PROJECTION — nine `benchmark_*` tables
 * that carry forecasts and their scored results while they are still relevant,
 * rather than only after settlement through a reviewed evidence PR.
 *
 * Deliberately NOT part of the atomic store. That contract, its schema and its
 * conformance suite govern admitted money and stay untouched here; this port
 * writes a read-only projection that no admit / lease / complete path reads, on
 * a DIFFERENT database reached with a DIFFERENT credential. It is under `src/`
 * rather than `src/store/` for that reason: every adapter in `src/store/` speaks
 * to the `store.` schema on STORE_DATABASE_URL, and none of this does.
 *
 * ── THREE PROPERTIES THAT ARE NOT NEGOTIABLE ─────────────────────────────────
 *
 * 1. IT CANNOT HALT A RUN. Every method resolves to a typed outcome and none of
 *    them throws — a benchmark night must never be lost because a projection was
 *    unavailable — an advisory layer never gates the work. This INVERTS the house
 *    convention: `SqlCampaignAuthorizationPort` rejects on a driver failure, and
 *    a test pins that it does, because a money-path adapter must fail loud. The
 *    two are different on purpose. Fail-soft is only safe here because nothing
 *    downstream authorizes anything on the result.
 *
 * 2. IT ONLY EVER APPENDS. The scoped writer login holds SELECT and INSERT and
 *    no mutating verb on any of the nine tables, so a sealed forecast cannot be
 *    rewritten and a published pick can be neither edited nor retracted — not by
 *    policy but because the privilege is absent. An UPDATE or DELETE from here
 *    comes back 42501, which is the intended signal and not a bug to route
 *    around. That is also why every conflict clause below is DO NOTHING: a
 *    DO UPDATE raises even when the SET list looks harmless.
 *
 * 3. IT HOLDS NO SURROGATE KEY. Rows are addressed by their natural keys and
 *    PostgreSQL resolves the `bigint` identities inside the statement. Nothing
 *    here reads `currval()` or `lastval()` — the identity sequences are revoked
 *    from every role, so both raise 42501 (measured), and a fail-soft caller
 *    would turn that into permanently missing reveal and score rows rather than
 *    an error anyone sees.
 *
 * ── CALL ORDER, WHICH IS PART OF THE CONTRACT ────────────────────────────────
 * For a participant that makes a provider call:
 *
 *     await publishAttempt(...)          // once per (participant, game, ordinal)
 *     await sealDecision(...)            // once per market on that call
 *
 * The attempt is a FIRST-CLASS write, not a side effect of sealing. That matters
 * for two reasons the schema is explicit about. A refused, timed-out or non-final
 * call produces an attempt row and NO decisions, and that row is the opportunity
 * denominator — without a way to write it alone, a failed arm would be absent
 * from the coverage it is supposed to occupy, and every rate derived from it
 * would be computed against successes only. And a repaired arm has TWO attempt
 * rows (ordinal 0, then the deterministic format repair at ordinal 1) while its
 * decision cites one of them; a seal that also inserted the attempt could only
 * ever write whichever ordinal it was handed.
 *
 * Awaiting the attempt before the seals is also what makes sealing the markets of
 * one call CONCURRENTLY safe. Measured: with the attempt written inside the seal,
 * three markets sealed with `Promise.all` reliably landed ONE — the losers' ON
 * CONFLICT skipped the insert while their snapshot, taken before the winner
 * committed, could not yet see the row. Publishing the attempt first removes the
 * contention entirely, because by then the row is committed and visible to all
 * three.
 *
 * ── WHAT THE PUBLISHER REFUSES, AND WHY IT IS NOT THE PRODUCER'S JOB ─────────
 * Three things it will not persist, each of which reached a `published` decision
 * before the check existed, and each of which corrupts a figure a reader derives
 * rather than merely storing something odd:
 *
 *   a decision citing an attempt that was never SENT, or whose outcome is not
 *   one that yields decisions — the attempt row exists to keep a FAILED arm in
 *   the opportunity denominator, so a decision hanging off it turns that
 *   denominator into a numerator and scores a call that never happened;
 *
 *   a decision on a market the call did not cover — `supplied_markets` IS the
 *   per-market eligible count, so this scores a pick against an opportunity
 *   that did not exist;
 *
 *   a parent whose stored facts DISAGREE with what the caller supplied. Every
 *   parent is insert-once, so the first write fixes them and a later one is
 *   absorbed silently. That is how a participant written as a model can be
 *   sealed against as a baseline: the client-side pairing check reads what the
 *   CALLER said, and only a comparison against the stored row sees the rest.
 *
 * ── WHY EACH WRITE IS ONE STATEMENT ──────────────────────────────────────────
 * A write has to land the run, the participant, the cohort roster and its own row
 * together: the child carries composite foreign keys to all of them, and a roster
 * row written in a separate failed transaction would silently cost every decision
 * of that run. A single statement gives that atomically, because referential
 * checks fire at end-of-statement rather than per-CTE — measured on PostgreSQL
 * 17.10 against the real schema, including that a refused write leaves no partial
 * run or participant row behind. It also needs no pinned connection, so the plain
 * `StoreQuery` seam is sufficient and a caller cannot break atomicity by handing
 * over a Pool instead of a Client.
 *
 * ── WHY ONE JSONB PARAMETER RATHER THAN POSITIONAL ONES ──────────────────────
 * An attempt carries about forty values. At that width `$37` is unreviewable and
 * a single inserted column silently shifts everything after it into the wrong
 * field. Passing one jsonb payload and unpacking it with `jsonb_to_record` names
 * the JSON-to-record hop at both ends. The cost is that an absent key becomes
 * NULL and an unknown key is dropped, both silently (measured). Two things close
 * that: every nullable column is a REQUIRED field typed `T | null` on the input
 * interfaces, so omitting one is a compile error rather than a NULL; and a unit
 * test cross-checks each statement's record declaration against the keys its
 * payload builder emits, in both directions.
 *
 * The record-to-INSERT hop inside each statement is still positional, and no
 * string test can see a swap of two same-typed columns there. The conformance
 * suite covers it by writing a row whose every column carries a value unique to
 * that column and reading the whole row back.
 *
 * Instants cross as the STRING the producer wrote: a JS `Date` truncates to
 * milliseconds, and microsecond precision was measured surviving the jsonb hop
 * intact. Numerics cross as JSON numbers and are therefore float64-bounded before
 * they reach here — which is exact for every column width in this schema, but is
 * a property of the inputs rather than something this module restores.
 */

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** Why a payload was refused before it reached the database. */
export type InvalidInputReason =
  | 'malformed_identifier'
  | 'malformed_digest'
  | 'malformed_instant'
  | 'malformed_date'
  | 'malformed_wallet'
  | 'market_out_of_domain'
  | 'network_out_of_domain'
  | 'participant_kind_out_of_domain'
  | 'lab_id_on_non_model'
  | 'model_without_configuration'
  | 'configuration_on_non_model'
  | 'malformed_configuration'
  | 'model_without_attempt'
  | 'attempt_ordinal_out_of_range'
  | 'supplied_markets_malformed'
  | 'number_out_of_range'
  | 'unsent_attempt_has_response'
  | 'refusal_reason_mismatch'
  | 'not_a_boolean';

/**
 * The result of one publish. Every branch is inspectable and none is authorizing,
 * because nothing downstream may act on a projection write.
 *
 * `published`      a row was written.
 * `duplicate`      this row's natural key was already present, so it was not
 *                  written again. The same statement may still have inserted a
 *                  run, participant or roster row alongside it — those are
 *                  shared parents and their creation is not this row's news.
 * `contradiction`  a row with this natural key already exists and DISAGREES with
 *                  what was supplied, on a field that is a commitment — the
 *                  forecast digest, or the wallet a fill is joined through.
 *                  Nothing was overwritten (the writer holds no UPDATE) and
 *                  nothing was written: the whole statement is suppressed, so a
 *                  contradiction leaves the projection exactly as it was.
 *                  Reported ahead of the other branches because it is the one
 *                  integrity failure a projection of commitments exists to make
 *                  visible.
 * `attempt_not_eligible`
 *                  the cited provider call EXISTS but could not have produced
 *                  this forecast — it was never sent, its outcome is not one
 *                  that yields decisions, or the market is not among the ones
 *                  it covered. Distinct from `parent_missing` because
 *                  "you published the wrong attempt" and "you published none"
 *                  are different producer bugs. Nothing was written.
 * `parent_missing` the row this one hangs off was not visible to the statement,
 *                  so nothing was inserted — and that now includes the shared
 *                  identity rows, which an earlier build committed while saying
 *                  it had not. Reported rather than swallowed: an
 *                  `insert ... select` over an empty source affects zero rows and
 *                  raises nothing at all. For a seal it means the attempt was
 *                  never published — see the call order above.
 * `invalid_input`  refused here, before the database, with a typed reason.
 * `refused`        the database rejected it. `sqlstate` is the standard
 *                  five-character code and `constraint`, when the server named
 *                  one, is an identifier from this schema. `detail` is the
 *                  server's own message, credential-redacted and length-bounded;
 *                  it CAN quote the offending value, so it is diagnostic text and
 *                  not something to render publicly.
 * `unavailable`    the database could not be reached, or failed without a
 *                  SQLSTATE. Transient by assumption; the caller retries or
 *                  drops it, and either way the run continues.
 * `disabled`       no credential is configured, so there is no projection to
 *                  write to. The default state, and not an error.
 */
export type PublishOutcome =
  | { readonly outcome: 'published' }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'contradiction'; readonly field: string }
  | { readonly outcome: 'parent_missing' }
  | { readonly outcome: 'attempt_not_eligible'; readonly reason: AttemptIneligibleReason }
  | { readonly outcome: 'invalid_input'; readonly reason: InvalidInputReason; readonly field: string }
  | { readonly outcome: 'refused'; readonly sqlstate: string; readonly constraint: string | null; readonly detail: string }
  | { readonly outcome: 'unavailable'; readonly detail: string }
  | { readonly outcome: 'disabled' };

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Why a cited provider call cannot carry the forecast being sealed.
 *
 * `unlabelled` is not one of the three real reasons: it is what the statement
 * reports when its own reason list is shorter than its predicate list, so the
 * row that fired has no name. It exists because the alternative is worse —
 * `unnest` pads the shorter array with NULLs, and an unnamed row that is simply
 * dropped turns a refused seal into a silent one. See the note above the drift
 * statements.
 */
export type AttemptIneligibleReason =
  | 'unsent'
  | 'outcome_not_accepted'
  | 'market_not_supplied'
  | 'unlabelled';

/**
 * The attempt outcomes that yield decisions.
 *
 * This mirrors the producer's own rule — records are emitted only for an arm
 * whose call came back valid — and it is a real coupling, kept deliberate and
 * greppable rather than implicit. The projection's schema puts no CHECK on
 * `outcome`, so the database cannot enforce it and this is the only place that
 * can. If the producer ever accepts a second outcome, add it HERE: the failure
 * mode otherwise is every decision from that outcome reporting
 * `attempt_not_eligible`, which is loud and systematic rather than silent.
 */
export const ACCEPTED_ATTEMPT_OUTCOMES: readonly string[] = Object.freeze(['valid']);

/** The two networks the projection's `network` enum admits. */
export type NetworkKey = 'polygon' | 'amoy';

/** Participant kinds the projection admits. */
export type ParticipantKind = 'model' | 'baseline' | 'maker' | 'human';

/**
 * Where this row came from in the canonical NDJSON. Recorded on every table so a
 * projected row can be diffed against its origin — and if the two ever disagree,
 * the artifact wins. Both are nullable because a row may be published before its
 * artifact is sealed.
 */
export interface SourceRef {
  readonly sourcePath: string | null;
  readonly sourceSha256: string | null;
}

/**
 * One execution of the runner.
 *
 * ⚠ `runId` must be STABLE for a (cohort, participant, game) that may be sealed
 *   across more than one process. A decision's foreign key cites its attempt's
 *   run, and an attempt is unique on (cohort, participant, game, ordinal) — so
 *   once a game has been sealed under run A, a later run B cannot add the
 *   remaining markets for it: every such seal is refused 23503 and, because this
 *   port is fail-soft, the loss is quiet. Minting a fresh id per process is fine
 *   for a slate sealed in one pass and wrong for one resumed after a crash.
 */
export interface RunFacts {
  readonly runId: string;
  readonly cohortId: string;
  readonly slateDate: string;
  readonly network: NetworkKey;
  readonly deploymentRound: string;
  readonly startedAt: string;
  readonly bundleSha256: string | null;
  readonly planSha256: string | null;
  readonly promptScaffoldSha256: string | null;
  readonly promptScaffoldVersion: string | null;
  readonly responseSchemaVersion: number | null;
  readonly baselinePolicyVersion: string | null;
  readonly priceVersion: string | null;
  readonly benchmarkCommit: string | null;
  readonly executionPolicy: string | null;
}

/**
 * Durable participant identity — WHICH ENTRANT this is.
 *
 * The database indexes models uniquely on `(lab_id, model_id, configuration)`
 * with NULLS NOT DISTINCT, so these three ARE the competitor: two models from
 * one lab are two entrants, and one model at two reasoning levels is two
 * entrants. `participantId` is the durable key those rows are addressed by, and
 * carries no structure — do not parse a configuration out of it.
 *
 * ⚠ THE PAIR IS KIND-DEPENDENT IN BOTH DIRECTIONS, and the database enforces
 *   both halves. A `kind='model'` row must declare `modelId` AND `configuration`;
 *   every other kind must declare NEITHER. Supplying one of the two, or
 *   attaching either to a control, is refused here before it reaches a CHECK.
 */
export interface ParticipantFacts {
  readonly participantId: string;
  readonly kind: ParticipantKind;
  readonly labId: string | null;
  readonly displayName: string;
  /** The exact model string this entrant requests. NULL on every non-model. */
  readonly modelId: string | null;
  /**
   * The settings it competes under, in the lab's own vocabulary and never
   * normalised. `{}` is a real value — "sets no knobs" — and is hashed and
   * compared like any other. NULL on every non-model.
   *
   * The digest and its version are DERIVED here rather than supplied: they are
   * a function of this value, and a caller that passes both can pass two that
   * disagree. See `identityPayload`.
   */
  readonly configuration: ParticipantConfiguration | null;
}

/**
 * The per-cohort binding: which wallet an entrant signed with.
 *
 * ⚠ FIRST WRITE WINS, and there is no second chance. The roster row is created by
 *   whichever attempt or seal reaches it first and the writer holds no UPDATE, so
 *   a `walletAddress` supplied later is not stored — it is reported as a
 *   `contradiction` and the original stands. The wallet is the join key from a
 *   forecast to its on-chain fill, so bind it before the first write for that
 *   participant or the join is dead for the whole cohort.
 *
 * It once also carried an `arm_id`, the version-scoped model string. That column
 * is gone: it was a second copy of an identity the participant row now holds
 * properly, and a second copy is a thing that can disagree.
 */
export interface RosterFacts {
  readonly walletAddress: string | null;
}

/**
 * One provider call: (cohort, participant, game, ordinal). ALL provider telemetry
 * belongs here and never on a decision — one call yields one to three market
 * forecasts, so per-decision telemetry over-counts by the market multiplier.
 *
 * Ordinal 0 is the initial call and 1 the deterministic format repair. Both are
 * separate rows; coverage denominators pin ordinal 0, so a repaired arm must
 * publish both rather than only the accepted one.
 *
 * `billableSearchCount` and `reasoningTokens` are `null` for UNKNOWN, never zero;
 * two providers report no search counter at all and "did not search" is not an
 * allowed reading of its absence.
 */
export interface AttemptFacts {
  readonly attemptOrdinal: number;
  readonly suppliedMarkets: readonly MarketKey[];
  readonly sent: boolean;
  readonly outcome: string;
  readonly requestedModelId: string | null;
  readonly reportedModelId: string | null;
  readonly providerResponseId: string | null;
  readonly httpStatus: number | null;
  readonly providerStopReason: string | null;
  readonly turnCompleted: boolean | null;
  readonly validationErrors: readonly string[] | null;
  readonly requestAt: string | null;
  readonly responseAt: string | null;
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly billableOutputTokens: number | null;
  readonly billableSearchCount: number | null;
  readonly searchEvidenceStatus: string | null;
  readonly costUsd: number | null;
  readonly priceVersion: string | null;
}

/** One provider call, with the identity needed to place it. Publish this whether
 *  or not the call produced any forecast — that is the whole point of the row. */
export interface ArmAttempt {
  readonly run: RunFacts;
  readonly participant: ParticipantFacts;
  readonly roster: RosterFacts;
  readonly gameId: string;
  readonly facts: AttemptFacts;
  readonly source: SourceRef;
}

/**
 * A forecast at SEAL time: identity and digests, and nothing of the pick itself.
 *
 * The pick lands in a separate table, so the schema CAN hold a sealed forecast
 * back. This publisher deliberately does not: it writes both, with the run.
 * Keeping picks secret was never a requirement here, and the reasoning is
 * recorded once, beside `ProjectionClock` in servingProjection.ts, rather than
 * restated at each site that could imply otherwise.
 *
 * `attemptOrdinal` names the already-published provider call this forecast came
 * from, or is null for a deterministic baseline that made none. A participant of
 * kind `model` must cite one: the foreign key is MATCH SIMPLE, so a NULL would
 * satisfy it and the row would then read as a baseline whose telemetry never
 * existed. That pairing is refused client-side.
 *
 * ⚠ `forecastDigest` is supplied, not derived — this port takes the value and
 *   checks only its shape. Compute it with `forecastDigest()` from `schema.ts`,
 *   which is `sha256Hex(canonicalize(projectionFingerprint(f)))` and the only
 *   composition that can be recomputed from the later reveal. Note the
 *   PROJECTION fingerprint, not the raw one: the reveal columns hold fixed
 *   scale, so a digest over unrounded floats cannot be reproduced from what
 *   this table publishes. See projectionNumeric.ts. A digest arrived at any other way still
 *   passes the hex check here and still stores; it is simply unverifiable
 *   forever after, with no runtime signal that anything is wrong. Note in
 *   particular that `decisionFingerprint()` in `fireArtifact.ts` carries the same
 *   facts in a different SHAPE and hashes differently.
 */
export interface DecisionSeal {
  readonly run: RunFacts;
  readonly participant: ParticipantFacts;
  readonly roster: RosterFacts;
  readonly gameId: string;
  readonly attemptOrdinal: number | null;
  readonly market: MarketKey;
  readonly sealedAt: string;
  readonly forecastDigest: string;
  readonly rationaleDigest: string | null;
  readonly bundleSha256: string | null;
  readonly responseSchemaVersion: number | null;
  readonly contestId: string | null;
  readonly speculationId: string | null;
  readonly source: SourceRef;
}

/** Addresses one sealed decision by its natural key. The surrogate id stays in
 *  the database; nothing out here ever learns it. */
export interface DecisionRef {
  readonly cohortId: string;
  readonly participantId: string;
  readonly gameId: string;
  readonly market: MarketKey;
}

/**
 * The forecast itself, published once. `sealedAt` is deliberately NOT an input —
 * the statement copies it from the parent row, so the displayed chronology cannot
 * drift from the commitment it belongs to.
 *
 * A NULL axis means ABSENT (a pre-v2 record), never zero.
 */
export interface DecisionReveal {
  readonly decision: DecisionRef;
  readonly revealedAt: string;
  readonly selection: string;
  readonly line: number | null;
  readonly observedDecimal: number | null;
  readonly probWin: number | null;
  readonly probPush: number | null;
  readonly probLoss: number | null;
  readonly confidence: number | null;
  readonly wouldAbstain: boolean | null;
  readonly selectedForExecution: boolean | null;
  readonly reasonCode: string | null;
  readonly axisValuation: number | null;
  readonly axisTrend: number | null;
  readonly axisConsensus: number | null;
  readonly axisNews: number | null;
  readonly axisSoftness: number | null;
  readonly primaryAxis: string | null;
  readonly primaryExpectation: string | null;
  readonly source: SourceRef;
}

/**
 * Model-authored prose. WITHHELD: the key ospex-core-api holds has no privilege
 * of any kind on this table, so publishing it later is a GRANT plus an endpoint,
 * reviewed on its own terms. It is free text that can name an odds provider or a
 * sportsbook, which is exactly why it is not served today.
 */
export interface DecisionRationale {
  readonly decision: DecisionRef;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
  readonly source: SourceRef;
}

/** One scored forecast under one scoring policy version. Both CLV metrics are
 *  carried side by side because a read path must never show one alone. */
export interface DecisionScore {
  readonly decision: DecisionRef;
  /**
   * The run the scored artifact says it scored. The decision is resolved by its
   * natural key alone, so without this the score would attach to whatever
   * decision that key resolves to — including one from a DIFFERENT execution of
   * the same slate, whose entry prices the CLV was never computed against. The
   * statement compares it against the stored decision's `run_id` and reports a
   * disagreement as a contradiction rather than landing the row.
   */
  readonly runId: string;
  /**
   * The run label, stamped on every scored record by the scorer and carried
   * onto every published row, so a read path can decide leaderboard
   * eligibility later without republishing — the rows are insert-once, so a
   * label that does not land with the row can never land at all.
   */
  readonly label: string;
  readonly scoringPolicyVersion: string;
  readonly economicClvPct: number | null;
  readonly marginAdjustedClvPct: number | null;
  readonly devigMethod: string | null;
  readonly ladderVersion: string | null;
  readonly ladderParamVersion: string | null;
  readonly refused: boolean;
  readonly refusalReason: string | null;
  readonly scheduleChanged: boolean | null;
  readonly heldOutOfPrimary: boolean | null;
  readonly closeDecimalSelected: number | null;
  readonly closeDecimalOpposing: number | null;
  readonly closeLine: number | null;
  readonly lineMovementFavorable: number | null;
  readonly scoredAt: string;
  readonly source: SourceRef;
}

/** Coverage and the publication brake for one (cohort, scoring policy version).
 *  `rankingAllowed` false means the sample does not support a ranking at all. */
export interface ScoringRun {
  readonly cohortId: string;
  readonly scoringPolicyVersion: string;
  readonly eligible: number;
  readonly scored: number;
  readonly refused: number;
  readonly scheduleHeldOut: number;
  readonly refusalReasons: Readonly<Record<string, number>>;
  readonly rankingAllowed: boolean;
  readonly rankingReason: string;
  readonly costPerPickComparable: boolean | null;
  readonly benchmarkCommit: string | null;
  readonly scoredAt: string;
  readonly source: SourceRef;
}

/**
 * A one-connection transaction. Structurally the house `StoreTransactor`, so
 * `pgStoreTransactor(pool)` satisfies it; declared here so this module still
 * imports nothing from the campaign store.
 */
export interface ServingTransactor {
  transaction<T>(fn: (query: StoreQuery) => Promise<T>): Promise<T>;
}

/**
 * What the publisher needs to reach its database.
 *
 * The transactor is REQUIRED rather than optional, and that is the point. A seal
 * and an attempt must take an advisory lock and then read in a FRESH snapshot,
 * which needs two commands on one pinned connection. Optional would mean a
 * caller could silently get the weaker guarantee — the shape this module had
 * when a concurrent contradiction was reported while its child row had already
 * been committed.
 */
export interface ServingStoreDeps {
  readonly query: StoreQuery;
  readonly transactor: ServingTransactor;
}

/** What the runner calls. Narrow on purpose: a projection has no reads. */
export interface BenchmarkServingPort {
  publishAttempt(attempt: ArmAttempt): Promise<PublishOutcome>;
  sealDecision(seal: DecisionSeal): Promise<PublishOutcome>;
  revealDecision(reveal: DecisionReveal): Promise<PublishOutcome>;
  publishRationale(rationale: DecisionRationale): Promise<PublishOutcome>;
  publishScore(score: DecisionScore): Promise<PublishOutcome>;
  publishScoringRun(run: ScoringRun): Promise<PublishOutcome>;
}

// ---------------------------------------------------------------------------
// Client-side validation — fail closed BEFORE the database
// ---------------------------------------------------------------------------
//
// Mirrors the schema's CHECK constraints rather than trusting them. A malformed
// value that reaches the driver comes back as a raw exception this adapter would
// have to classify as `refused`, which reads like a schema disagreement; caught
// here it is a typed `invalid_input` naming the field. It also keeps a bad digest
// away from a `::jsonb` cast, where the failure would be 22P02 with no field name.

const SHA256_HEX = /^[0-9a-f]{64}$/;
const WALLET = /^0x[0-9a-f]{40}$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUL = String.fromCharCode(0);

const MARKETS: readonly MarketKey[] = ['moneyline', 'spread', 'total'];
const NETWORKS: readonly NetworkKey[] = ['polygon', 'amoy'];
const KINDS: readonly ParticipantKind[] = ['model', 'baseline', 'maker', 'human'];
const AXES: readonly string[] = ['valuation', 'trend', 'consensus', 'news', 'softness'];

/** A refusal carrying the field that caused it, so a caller can fix the producer
 *  rather than bisect a payload. */
class Refusal {
  constructor(readonly reason: InvalidInputReason, readonly field: string) {}
}

const refuse = (reason: InvalidInputReason, field: string): never => {
  throw new Refusal(reason, field);
};

/** Non-empty and free of a NUL — PostgreSQL `text` cannot hold one, and a NUL
 *  inside a jsonb parameter is a raw 22P05 rather than a typed refusal. */
function id(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes(NUL)) {
    refuse('malformed_identifier', field);
  }
  return value;
}

/** Optional text. Redacted, because the NDJSON writer redacts every line it
 *  emits and a direct database write would otherwise bypass that chokepoint. */
function text(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.includes(NUL)) refuse('malformed_identifier', field);
  return redactSecrets(value);
}

function requiredText(value: string, field: string): string {
  return text(id(value, field), field) as string;
}

function digest(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (!SHA256_HEX.test(value)) refuse('malformed_digest', field);
  return value;
}

function requiredDigest(value: string, field: string): string {
  if (!SHA256_HEX.test(value)) refuse('malformed_digest', field);
  return value;
}

/**
 * An instant, kept as the STRING the producer wrote. Parsing to a Date and back
 * would truncate to milliseconds; a reveal compares its `revealed_at` against a
 * copied `sealed_at` in a CHECK, so the two have to agree to the microsecond.
 */
function instant(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !isParseableInstant(value)) refuse('malformed_instant', field);
  return value;
}

function requiredInstant(value: string, field: string): string {
  return instant(value, field) as string;
}

/**
 * A plain calendar date. Checked properly rather than by shape alone: a value
 * like `2026-13-45` matches any reasonable regex and reaches the server as a
 * 22008, which arrives as a `refused` quoting the offending value instead of a
 * typed refusal naming the field.
 */
function calendarDate(value: string, field: string): string {
  const parts = typeof value === 'string' ? CALENDAR_DATE.exec(value) : null;
  if (parts === null) refuse('malformed_date', field);
  const year = Number(parts![1]);
  const month = Number(parts![2]);
  const day = Number(parts![3]);
  if (month < 1 || month > 12 || day < 1) refuse('malformed_date', field);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > lengths[month - 1]!) refuse('malformed_date', field);
  return value;
}

/**
 * A boolean, checked rather than trusted. Every boolean column was previously
 * passed through raw, so a runtime value of the wrong type — `1n`, measured —
 * reached `JSON.stringify` and threw a TypeError straight out of a port whose
 * headline promise is that it never throws.
 */
function bool(value: boolean | null, field: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== 'boolean') refuse('not_a_boolean', field);
  return value;
}

/** The largest value a PostgreSQL `integer` column holds. Bounded here so an
 *  oversized count is a typed refusal naming the field, not a 22003 from the
 *  driver quoting the value back. */
const INT4_MAX = 2_147_483_647;

/** A validated numeric at the projection's scale; null passes through. */
function scaled(value: number | null, scale: number): number | null {
  return value === null ? null : quantizeForProjection(value, scale);
}

function num(value: number | null, field: string, min?: number, max?: number): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) refuse('number_out_of_range', field);
  if (min !== undefined && value < min) refuse('number_out_of_range', field);
  if (max !== undefined && value > max) refuse('number_out_of_range', field);
  return value;
}

function int(value: number | null, field: string, min?: number, max = INT4_MAX): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) refuse('number_out_of_range', field);
  return num(value, field, min, max);
}

/** A probability or confidence: the column is numeric(9,8) with a 0..1 CHECK. */
const unit = (value: number | null, field: string): number | null => num(value, field, 0, 1);

/** An analysis axis: 1..5, or null for ABSENT. */
const axis = (value: number | null, field: string): number | null => int(value, field, 1, 5);

function market(value: MarketKey, field: string): MarketKey {
  if (!MARKETS.includes(value)) refuse('market_out_of_domain', field);
  return value;
}

function decisionRef(ref: DecisionRef, prefix: string): Record<string, unknown> {
  return {
    cohort_id: id(ref.cohortId, `${prefix}.cohortId`),
    participant_id: id(ref.participantId, `${prefix}.participantId`),
    game_id: id(ref.gameId, `${prefix}.gameId`),
    market: market(ref.market, `${prefix}.market`),
  };
}

function source(ref: SourceRef, prefix: string): Record<string, unknown> {
  return {
    source_path: text(ref.sourcePath, `${prefix}.sourcePath`),
    source_sha256: digest(ref.sourceSha256, `${prefix}.sourceSha256`),
  };
}

/**
 * Mirrors the attempt table's market bound: one to three entries, from the market
 * domain, no duplicates. This array is the stated source of the per-market
 * eligible denominator, so a malformed one silently corrupts coverage and every
 * ranking derived from it.
 */
function suppliedMarkets(values: readonly MarketKey[], field: string): MarketKey[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 3) {
    refuse('supplied_markets_malformed', field);
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (!MARKETS.includes(value)) refuse('supplied_markets_malformed', field);
    if (seen.has(value)) refuse('supplied_markets_malformed', field);
    seen.add(value);
  }
  return [...values];
}

/**
 * The identity every statement shares: the run, the participant and the roster
 * binding. Emitted with identical key names by both write paths, so one set of
 * CTEs serves both.
 *
 * ── THE CONFIGURATION CROSSES AS ITS CANONICAL TEXT, NOT AS AN OBJECT ────────
 * `configuration_canonical` is a JSON STRING holding the RFC 8785 bytes, and
 * every statement casts it with `::jsonb`. So what PostgreSQL parses is exactly
 * what was hashed, rather than whatever a second serializer happened to emit —
 * the digest is the entrant's identity, and a reader recomputing it from the
 * stored row has to arrive back at the same value.
 *
 * The digest and its version are derived here from that same text. Taking them
 * as inputs would let a caller supply a configuration and a digest that disagree,
 * and the row is insert-once: the wrong one would be permanent.
 */
function identityPayload(
  run: RunFacts,
  participant: ParticipantFacts,
  roster: RosterFacts,
): Record<string, unknown> {
  if (!NETWORKS.includes(run.network)) refuse('network_out_of_domain', 'run.network');
  if (!KINDS.includes(participant.kind)) refuse('participant_kind_out_of_domain', 'participant.kind');
  // A leaderboard grouped by lab must never bucket a deterministic control under
  // a vendor. The converse is deliberately allowed: a model with no lab id is
  // legitimate, and refusing it would drop a real participant for no benefit.
  if (participant.kind !== 'model' && participant.labId !== null) {
    refuse('lab_id_on_non_model', 'participant.labId');
  }
  if (roster.walletAddress !== null && !WALLET.test(roster.walletAddress)) {
    refuse('malformed_wallet', 'roster.walletAddress');
  }
  return {
    ...configurationPayload(participant),
    run_id: id(run.runId, 'run.runId'),
    cohort_id: id(run.cohortId, 'run.cohortId'),
    slate_date: calendarDate(run.slateDate, 'run.slateDate'),
    network: run.network,
    deployment_round: id(run.deploymentRound, 'run.deploymentRound'),
    started_at: requiredInstant(run.startedAt, 'run.startedAt'),
    run_bundle_sha256: digest(run.bundleSha256, 'run.bundleSha256'),
    plan_sha256: digest(run.planSha256, 'run.planSha256'),
    prompt_scaffold_sha256: digest(run.promptScaffoldSha256, 'run.promptScaffoldSha256'),
    prompt_scaffold_version: text(run.promptScaffoldVersion, 'run.promptScaffoldVersion'),
    run_response_schema_version: int(run.responseSchemaVersion, 'run.responseSchemaVersion', 0, 32767),
    baseline_policy_version: text(run.baselinePolicyVersion, 'run.baselinePolicyVersion'),
    run_price_version: text(run.priceVersion, 'run.priceVersion'),
    benchmark_commit: text(run.benchmarkCommit, 'run.benchmarkCommit'),
    execution_policy: text(run.executionPolicy, 'run.executionPolicy'),
    participant_id: id(participant.participantId, 'participant.participantId'),
    kind: participant.kind,
    lab_id: text(participant.labId, 'participant.labId'),
    display_name: requiredText(participant.displayName, 'participant.displayName'),
    wallet_address: roster.walletAddress,
  };
}

/**
 * The four identity columns, from the two facts that determine them.
 *
 * The kind rule is an equivalence and is checked in BOTH directions, because the
 * database checks it in both: a model declares a model and a configuration, and
 * anything else declares neither. Half of the pair is the interesting failure —
 * a model row carrying a `modelId` and a null configuration satisfies "it has a
 * model" and is still a permanently dimensionless entrant.
 */
function configurationPayload(participant: ParticipantFacts): Record<string, unknown> {
  const declared = participant.modelId !== null || participant.configuration !== null;

  if (participant.kind !== 'model') {
    if (declared) refuse('configuration_on_non_model', 'participant.modelId');
    return {
      model_id: null,
      configuration_canonical: null,
      configuration_sha256: null,
      configuration_digest_version: null,
    };
  }

  if (participant.modelId === null || participant.configuration === null) {
    refuse('model_without_configuration', 'participant.configuration');
  }
  // The same grammar the artifact stamp is held to. Refused here rather than
  // left to the database because the database can only answer with a 22P02 or a
  // CHECK name, neither of which says which key was wrong.
  //
  // ⚠ THE LAB AND MODEL ARE PASSED IN, and that is what makes the database's
  //   own bound unreachable rather than merely unlikely. The entrant-key CHECK
  //   counts `octet_length(lab_id) + octet_length(model_id) +
  //   octet_length(configuration::text)` against 1024, and the third term is
  //   PostgreSQL's OWN rendering, which is longer than the canonical text this
  //   module hashes — jsonb writes ": " and ", " where RFC 8785 writes ":" and
  //   ",", so it costs one byte per key and one per separator.
  //
  //   Measured on PostgreSQL 17.10, densest shapes first: an array of
  //   single-character elements expands 1.493x (507 canonical -> 757 rendered),
  //   which is the worst case and approaches 1.5 asymptotically; many tiny
  //   pairs 1.251x; a long string 1.002x. So 512 canonical bytes can never
  //   render past 768, and with the identifier pair bounded at 128 the whole
  //   key is under 896. Without this argument the identifiers are unbounded
  //   here and the CHECK is reachable — as a named 23514, not silently, but
  //   reachable.
  const violations = configurationViolations(participant.configuration, {
    labId: participant.labId ?? undefined,
    modelId: participant.modelId ?? undefined,
  });
  if (violations.length > 0) refuse('malformed_configuration', `participant.${violations[0]!}`);

  const configuration = participant.configuration as ParticipantConfiguration;
  return {
    model_id: requiredText(participant.modelId as string, 'participant.modelId'),
    configuration_canonical: canonicalConfigurationText(configuration),
    configuration_sha256: configurationSha256(configuration),
    configuration_digest_version: CONFIGURATION_DIGEST_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Payload builders — one per statement, keys matching its record declaration
// ---------------------------------------------------------------------------

function attemptPayload(attempt: ArmAttempt): Record<string, unknown> {
  const f = attempt.facts;
  if (f.attemptOrdinal !== 0 && f.attemptOrdinal !== 1) {
    refuse('attempt_ordinal_out_of_range', 'facts.attemptOrdinal');
  }
  // An attempt that never reached the provider has no provider response to
  // describe — and it still occupies the opportunity denominator.
  if (!f.sent &&
      (f.providerResponseId !== null || f.httpStatus !== null ||
       f.providerStopReason !== null || f.turnCompleted !== null ||
       f.responseAt !== null || f.latencyMs !== null)) {
    refuse('unsent_attempt_has_response', 'facts.sent');
  }
  return {
    ...identityPayload(attempt.run, attempt.participant, attempt.roster),
    game_id: id(attempt.gameId, 'gameId'),
    attempt_ordinal: f.attemptOrdinal,
    supplied_markets: suppliedMarkets(f.suppliedMarkets, 'facts.suppliedMarkets'),
    sent: bool(f.sent, 'facts.sent') as boolean,
    attempt_outcome: requiredText(f.outcome, 'facts.outcome'),
    requested_model_id: text(f.requestedModelId, 'facts.requestedModelId'),
    reported_model_id: text(f.reportedModelId, 'facts.reportedModelId'),
    provider_response_id: text(f.providerResponseId, 'facts.providerResponseId'),
    http_status: int(f.httpStatus, 'facts.httpStatus', 0, 2147483647),
    provider_stop_reason: text(f.providerStopReason, 'facts.providerStopReason'),
    turn_completed: bool(f.turnCompleted, 'facts.turnCompleted'),
    validation_errors: f.validationErrors === null
      ? null
      : f.validationErrors.map((e, i) => text(e, `facts.validationErrors[${i}]`)),
    request_at: instant(f.requestAt, 'facts.requestAt'),
    response_at: instant(f.responseAt, 'facts.responseAt'),
    latency_ms: int(f.latencyMs, 'facts.latencyMs', 0),
    input_tokens: int(f.inputTokens, 'facts.inputTokens', 0),
    output_tokens: int(f.outputTokens, 'facts.outputTokens', 0),
    reasoning_tokens: int(f.reasoningTokens, 'facts.reasoningTokens', 0),
    billable_output_tokens: int(f.billableOutputTokens, 'facts.billableOutputTokens', 0),
    billable_search_count: int(f.billableSearchCount, 'facts.billableSearchCount', 0),
    search_evidence_status: text(f.searchEvidenceStatus, 'facts.searchEvidenceStatus'),
    cost_usd: num(f.costUsd, 'facts.costUsd', 0),
    attempt_price_version: text(f.priceVersion, 'facts.priceVersion'),
    ...source(attempt.source, 'source'),
  };
}

function sealPayload(seal: DecisionSeal): Record<string, unknown> {
  // A model forecast came from a provider call, so it must cite one. The foreign
  // key is MATCH SIMPLE: a NULL satisfies it, and the row would then be
  // indistinguishable from a baseline that made no call.
  if (seal.participant.kind === 'model' && seal.attemptOrdinal === null) {
    refuse('model_without_attempt', 'attemptOrdinal');
  }
  if (seal.attemptOrdinal !== null && seal.attemptOrdinal !== 0 && seal.attemptOrdinal !== 1) {
    refuse('attempt_ordinal_out_of_range', 'attemptOrdinal');
  }
  return {
    ...identityPayload(seal.run, seal.participant, seal.roster),
    game_id: id(seal.gameId, 'gameId'),
    has_attempt: seal.attemptOrdinal !== null,
    attempt_ordinal: seal.attemptOrdinal,
    accepted_outcomes: [...ACCEPTED_ATTEMPT_OUTCOMES],
    market: market(seal.market, 'market'),
    contest_id: text(seal.contestId, 'contestId'),
    speculation_id: text(seal.speculationId, 'speculationId'),
    sealed_at: requiredInstant(seal.sealedAt, 'sealedAt'),
    forecast_digest: requiredDigest(seal.forecastDigest, 'forecastDigest'),
    rationale_digest: digest(seal.rationaleDigest, 'rationaleDigest'),
    decision_bundle_sha256: digest(seal.bundleSha256, 'bundleSha256'),
    decision_response_schema_version: int(seal.responseSchemaVersion, 'responseSchemaVersion', 0, 32767),
    ...source(seal.source, 'source'),
  };
}

function revealPayload(reveal: DecisionReveal): Record<string, unknown> {
  if (reveal.primaryAxis !== null && !AXES.includes(reveal.primaryAxis)) {
    refuse('malformed_identifier', 'primaryAxis');
  }
  return {
    ...decisionRef(reveal.decision, 'decision'),
    revealed_at: requiredInstant(reveal.revealedAt, 'revealedAt'),
    selection: requiredText(reveal.selection, 'selection'),
    // Quantised to the column's own scale before it is sent, so PostgreSQL
    // never rounds and the stored value is byte-for-byte what the seal
    // committed to. `forecastDigest()` hashes the same quantisation through the
    // same module; that shared step is the only reason a reveal can be checked
    // against its seal at all. See projectionNumeric.ts.
    line: scaled(num(reveal.line, 'line'), PROJECTION_SCALES.line),
    observed_decimal: scaled(
      num(reveal.observedDecimal, 'observedDecimal', 0),
      PROJECTION_SCALES.observedDecimal
    ),
    prob_win: scaled(unit(reveal.probWin, 'probWin'), PROJECTION_SCALES.probability),
    prob_push: scaled(unit(reveal.probPush, 'probPush'), PROJECTION_SCALES.probability),
    prob_loss: scaled(unit(reveal.probLoss, 'probLoss'), PROJECTION_SCALES.probability),
    confidence: scaled(unit(reveal.confidence, 'confidence'), PROJECTION_SCALES.confidence),
    would_abstain: bool(reveal.wouldAbstain, 'wouldAbstain'),
    selected_for_execution: bool(reveal.selectedForExecution, 'selectedForExecution'),
    reason_code: text(reveal.reasonCode, 'reasonCode'),
    axis_valuation: axis(reveal.axisValuation, 'axisValuation'),
    axis_trend: axis(reveal.axisTrend, 'axisTrend'),
    axis_consensus: axis(reveal.axisConsensus, 'axisConsensus'),
    axis_news: axis(reveal.axisNews, 'axisNews'),
    axis_softness: axis(reveal.axisSoftness, 'axisSoftness'),
    primary_axis: reveal.primaryAxis,
    primary_expectation: text(reveal.primaryExpectation, 'primaryExpectation'),
    ...source(reveal.source, 'source'),
  };
}

function rationalePayload(rationale: DecisionRationale): Record<string, unknown> {
  // Redacted FIRST, then hashed, so the digest describes the bytes the table
  // keeps. Hashing the caller's input instead would commit to a preimage the
  // row does not hold, which is the one thing a reader cannot check.
  const prose = requiredText(rationale.rationale, 'rationale');
  return {
    ...decisionRef(rationale.decision, 'decision'),
    rationale: prose,
    rationale_digest: sha256Hex(prose),
    evidence_refs: rationale.evidenceRefs.map((r, i) => text(r, `evidenceRefs[${i}]`)),
    ...source(rationale.source, 'source'),
  };
}

function scorePayload(score: DecisionScore): Record<string, unknown> {
  // The schema's refusal rule is an equivalence in both directions: a refusal
  // must carry a reason AND a reason implies refusal.
  if (score.refused !== (score.refusalReason !== null)) {
    refuse('refusal_reason_mismatch', 'refused');
  }
  return {
    ...decisionRef(score.decision, 'decision'),
    run_id: id(score.runId, 'runId'),
    label: requiredText(score.label, 'label'),
    scoring_policy_version: requiredText(score.scoringPolicyVersion, 'scoringPolicyVersion'),
    economic_clv_pct: num(score.economicClvPct, 'economicClvPct'),
    margin_adjusted_clv_pct: num(score.marginAdjustedClvPct, 'marginAdjustedClvPct'),
    devig_method: text(score.devigMethod, 'devigMethod'),
    ladder_version: text(score.ladderVersion, 'ladderVersion'),
    ladder_param_version: text(score.ladderParamVersion, 'ladderParamVersion'),
    refused: bool(score.refused, 'refused') as boolean,
    refusal_reason: text(score.refusalReason, 'refusalReason'),
    schedule_changed: bool(score.scheduleChanged, 'scheduleChanged'),
    held_out_of_primary: bool(score.heldOutOfPrimary, 'heldOutOfPrimary'),
    close_decimal_selected: num(score.closeDecimalSelected, 'closeDecimalSelected', 0),
    close_decimal_opposing: num(score.closeDecimalOpposing, 'closeDecimalOpposing', 0),
    close_line: num(score.closeLine, 'closeLine'),
    line_movement_favorable: num(score.lineMovementFavorable, 'lineMovementFavorable'),
    scored_at: requiredInstant(score.scoredAt, 'scoredAt'),
    ...source(score.source, 'source'),
  };
}

function scoringRunPayload(run: ScoringRun): Record<string, unknown> {
  const reasons: Record<string, number> = {};
  for (const [key, value] of Object.entries(run.refusalReasons)) {
    reasons[requiredText(key, 'refusalReasons.key')] = int(value, `refusalReasons.${key}`, 0) as number;
  }
  return {
    cohort_id: id(run.cohortId, 'cohortId'),
    scoring_policy_version: requiredText(run.scoringPolicyVersion, 'scoringPolicyVersion'),
    eligible: int(run.eligible, 'eligible', 0),
    scored: int(run.scored, 'scored', 0),
    refused: int(run.refused, 'refused', 0),
    schedule_held_out: int(run.scheduleHeldOut, 'scheduleHeldOut', 0),
    // The OBJECT, not a serialization of it. The whole payload is stringified
    // once on the way out; stringifying this too would store a jsonb STRING whose
    // content happens to be JSON, and `refusal_reasons ->> 'no_close'` would then
    // return nothing with no error anywhere.
    refusal_reasons: reasons,
    ranking_allowed: bool(run.rankingAllowed, 'rankingAllowed') as boolean,
    ranking_reason: requiredText(run.rankingReason, 'rankingReason'),
    cost_per_pick_comparable: bool(run.costPerPickComparable, 'costPerPickComparable'),
    benchmark_commit: text(run.benchmarkCommit, 'benchmarkCommit'),
    scored_at: requiredInstant(run.scoredAt, 'scoredAt'),
    ...source(run.source, 'source'),
  };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------
//
// Each is ONE statement, so it is one transaction with no client-side bracketing.
// Each reports three things: whether an existing row CONTRADICTS what was
// supplied, whether the parent this row hangs off was visible, and whether a row
// was inserted. All three are needed — an `insert ... select` over an empty
// source inserts nothing, raises nothing and returns success, so a row count
// alone cannot tell a duplicate from a miss.

/**
 * DURABLE-FACT DRIFT.
 *
 * Every parent here is insert-once and the writer holds no UPDATE, so the first
 * write of a run, a participant or a roster row fixes its facts forever. A
 * second write supplying DIFFERENT facts is absorbed by `on conflict do nothing`
 * and the caller is told `published`. That is how a participant first written as
 * `kind = 'model'` can later be sealed against as a baseline: the client-side
 * `model_without_attempt` guard checks what the CALLER said, and the stored row
 * says otherwise. Measured — the decision landed with `attempt_id` NULL under a
 * participant PostgreSQL still calls a model.
 *
 * So every fact the caller supplies for a parent is compared against the stored
 * one, and any disagreement both BLOCKS the write and is reported.
 *
 * The comparison reads the statement's own snapshot, which on its own cannot see
 * a concurrent writer that has not committed yet. That is why a seal and an
 * attempt take an advisory lock as a separate command first: the write then runs
 * as a SECOND command and gets a snapshot that already contains whatever the
 * previous lock holder committed. See LOCK_SQL. An earlier build tried to close
 * this with a post-write re-read instead, which could relabel the outcome but
 * could not un-commit the child it had already written.
 */
const RUN_DRIFT = `
  select coalesce(t.f, 'drift.unlabelled') as f
    from public.benchmark_runs r, input,
         lateral unnest(
           array['run.network','run.deploymentRound','run.slateDate','run.startedAt',
                 'run.bundleSha256','run.planSha256',
                 'run.promptScaffoldSha256','run.promptScaffoldVersion',
                 'run.responseSchemaVersion','run.baselinePolicyVersion',
                 'run.priceVersion','run.benchmarkCommit','run.executionPolicy'],
           array[r.network                  is distinct from input.network,
                 r.deployment_round         is distinct from input.deployment_round,
                 r.slate_date               is distinct from input.slate_date,
                 r.started_at               is distinct from input.started_at,
                 r.bundle_sha256            is distinct from input.run_bundle_sha256,
                 r.plan_sha256              is distinct from input.plan_sha256,
                 r.prompt_scaffold_sha256   is distinct from input.prompt_scaffold_sha256,
                 r.prompt_scaffold_version  is distinct from input.prompt_scaffold_version,
                 r.response_schema_version  is distinct from input.run_response_schema_version,
                 r.baseline_policy_version  is distinct from input.baseline_policy_version,
                 r.price_version            is distinct from input.run_price_version,
                 r.benchmark_commit         is distinct from input.benchmark_commit,
                 r.execution_policy         is distinct from input.execution_policy]
         ) as t(f, differs)
   where r.run_id = input.run_id and coalesce(t.differs, true)`;

/**
 * ⚠ THE TWO ARRAYS IN EVERY `unnest` BELOW MUST BE THE SAME LENGTH.
 *
 * `unnest(array[names], array[flags])` pads the shorter one with NULLs, and
 * both directions of a mismatch were wrong before this. A flag with no name
 * gave a differing row whose label was NULL, which `min(f)` dropped: no
 * contradiction reported while the gate suppressed the write, so a refusal
 * read as a duplicate. A name with no flag gave `differs = NULL`, which the
 * WHERE filtered out, so that field was never compared again.
 *
 * Three things close it. `coalesce(t.f, ...)` labels the first case so `min()`
 * keeps it. `coalesce(t.differs, true)` fails the second CLOSED, which is loud
 * rather than silent — every later write for that parent is reported as a
 * contradiction until the arrays are fixed. And `drift_rows` decides the
 * outcome from the COUNT rather than from the label. `servingStore.test.ts`
 * also parses these statements and requires each pair to match in length.
 */
const PARTICIPANT_DRIFT = `
  select coalesce(t.f, 'drift.unlabelled') as f
    from public.benchmark_participants p, input,
         lateral unnest(
           array['participant.kind','participant.labId','participant.displayName',
                 'participant.modelId','participant.configuration',
                 'participant.configurationSha256','participant.configurationDigestVersion'],
           array[p.kind         is distinct from input.kind,
                 p.lab_id       is distinct from input.lab_id,
                 p.display_name is distinct from input.display_name,
                 p.model_id     is distinct from input.model_id,
                 -- jsonb equality is semantic, so this compares the CONFIGURATION
                 -- rather than a rendering of it: key order and whitespace cannot
                 -- make an entrant look like a different one.
                 p.configuration is distinct from input.configuration_canonical::jsonb,
                 p.configuration_sha256 is distinct from input.configuration_sha256,
                 p.configuration_digest_version
                   is distinct from input.configuration_digest_version]
         ) as t(f, differs)
   where p.participant_id = input.participant_id and coalesce(t.differs, true)`;

const ROSTER_DRIFT = `
  select coalesce(t.f, 'drift.unlabelled') as f
    from public.benchmark_cohort_participants c, input,
         lateral unnest(
           array['roster.walletAddress'],
           array[c.wallet_address is distinct from input.wallet_address]
         ) as t(f, differs)
   where c.cohort_id = input.cohort_id
     and c.participant_id = input.participant_id and coalesce(t.differs, true)`;

const IDENTITY_DRIFT = `${RUN_DRIFT}\n  union all${PARTICIPANT_DRIFT}\n  union all${ROSTER_DRIFT}`;

/**
 * The run, participant and roster rows every write shares.
 *
 * Each insert is guarded three ways. `not exists` skips the speculative insert
 * once the parent is committed and visible, which is every write after the
 * first — an optimisation, not the correctness mechanism (the retry in `publish`
 * is that, and removing this guard reddens only a string test). `gate.ok` is the
 * correctness part: it suppresses every insert when a durable fact disagrees or
 * the child cannot land, so a refused write leaves NO residue. Without it,
 * `parent_missing` committed a run, a participant and a roster row while
 * reporting that nothing was inserted — and the roster it left behind was
 * immutable, so publishing the real attempt afterwards could only contradict it.
 */
const IDENTITY_CTES = `
gate as (
  select not exists (select 1 from drift) and exists (select 1 from child_ready) as ok
), run_ins as (
  insert into public.benchmark_runs
    (run_id, cohort_id, slate_date, network, deployment_round, started_at,
     bundle_sha256, plan_sha256, prompt_scaffold_sha256, prompt_scaffold_version,
     response_schema_version, baseline_policy_version, price_version,
     benchmark_commit, execution_policy, source_path, source_sha256)
  select run_id, cohort_id, slate_date, network, deployment_round, started_at,
         run_bundle_sha256, plan_sha256, prompt_scaffold_sha256, prompt_scaffold_version,
         run_response_schema_version, baseline_policy_version, run_price_version,
         benchmark_commit, execution_policy, source_path, source_sha256
    from input, gate
   where gate.ok
     and not exists (select 1 from public.benchmark_runs r where r.run_id = input.run_id)
  on conflict (run_id) do nothing
  returning 1
), participant_ins as (
  insert into public.benchmark_participants
    (participant_id, kind, lab_id, display_name, model_id, configuration,
     configuration_sha256, configuration_digest_version, source_path, source_sha256)
  -- The configuration is PARSED FROM THE CANONICAL TEXT that was hashed, so the
  -- stored jsonb and the digest beside it cannot describe different values.
  select participant_id, kind, lab_id, display_name, model_id,
         configuration_canonical::jsonb, configuration_sha256,
         configuration_digest_version, source_path, source_sha256
    from input, gate
   where gate.ok
     and not exists (select 1 from public.benchmark_participants p
                      where p.participant_id = input.participant_id)
  on conflict (participant_id) do nothing
  returning 1
), roster_ins as (
  insert into public.benchmark_cohort_participants
    (cohort_id, participant_id, network, wallet_address, source_path, source_sha256)
  select cohort_id, participant_id, network, wallet_address, source_path, source_sha256
    from input, gate
   where gate.ok
     and not exists (select 1 from public.benchmark_cohort_participants c
                      where c.cohort_id = input.cohort_id
                        and c.participant_id = input.participant_id)
  -- Targets the PRIMARY KEY rather than being a bare \`do nothing\`, which would
  -- also swallow the wallet bijection — the constraint that stops one wallet
  -- binding two participants in a cohort, and so stops a wallet acting as both
  -- maker and benchmark taker in the same run.
  on conflict (cohort_id, participant_id) do nothing
  returning 1
)`;

/**
 * SERIALISATION, and why one statement could not provide it.
 *
 * The drift comparison reads the stored parents, and inside a single statement
 * that read uses a snapshot taken before the statement began. A writer who
 * commits a conflicting parent in between is therefore invisible: the gate
 * passes, the child lands, and nothing checked afterwards can un-commit it.
 * Measured — a hundred conflicting-wallet races all reported `contradiction`,
 * and 58 of them had written their child anyway. Relabelling after the fact
 * cannot make "a contradiction writes nothing" true. Only ordering can.
 *
 * So both writes take this lock as their OWN command inside a transaction and
 * run the write as a SECOND command. Measured on PostgreSQL 17.10: a statement
 * issued after acquiring a contended advisory lock sees the row the previous
 * holder committed. That fresh snapshot is what makes the in-statement drift
 * check exact — and it is why the lock cannot be folded into the write as a CTE,
 * because a statement's snapshot predates its own wait.
 *
 * TWO KEYS, ALWAYS IN THIS ORDER. Run and roster rows are cohort-scoped, but
 * `benchmark_participants` is keyed by participant alone and shared across
 * cohorts, so a cohort-only lock would leave a first-write race on a participant
 * that two cohorts introduce at once. Every writer takes participant-then-cohort
 * in this one statement, so the acquisition order is identical everywhere and no
 * cycle can form.
 */
const LOCK_SQL = `
select pg_advisory_xact_lock(hashtext('ospex-benchmark/participant:' || $1::text)) as participant,
       pg_advisory_xact_lock(hashtext('ospex-benchmark/cohort:' || $2::text))      as cohort`;

const ATTEMPT_SQL = `
with input as (
  select * from jsonb_to_record($1::jsonb) as x(
    run_id text, cohort_id text, slate_date date, network public.network,
    deployment_round text, started_at timestamptz,
    run_bundle_sha256 text, plan_sha256 text, prompt_scaffold_sha256 text,
    prompt_scaffold_version text, run_response_schema_version smallint,
    baseline_policy_version text, run_price_version text, benchmark_commit text,
    execution_policy text,
    participant_id text, kind text, lab_id text, display_name text,
    model_id text, configuration_canonical text, configuration_sha256 text,
    configuration_digest_version smallint, wallet_address text,
    game_id text, attempt_ordinal smallint, supplied_markets text[], sent boolean,
    attempt_outcome text, requested_model_id text, reported_model_id text,
    provider_response_id text, http_status integer, provider_stop_reason text,
    turn_completed boolean, validation_errors text[], request_at timestamptz,
    response_at timestamptz, latency_ms integer, input_tokens integer,
    output_tokens integer, reasoning_tokens integer, billable_output_tokens integer,
    billable_search_count integer, search_evidence_status text,
    cost_usd numeric(18,6), attempt_price_version text,
    source_path text, source_sha256 text)
), drift as (${IDENTITY_DRIFT}
  union all
  -- The three attempt facts the seal's eligibility test reads. A replay that
  -- flips one of them would otherwise be absorbed while changing what the
  -- already-published decisions are entitled to cite.
  select coalesce(t.f, 'drift.unlabelled') as f
    from public.benchmark_arm_attempts a, input,
         lateral unnest(
           array['facts.sent','facts.outcome','facts.suppliedMarkets'],
           array[a.sent             is distinct from input.sent,
                 a.outcome          is distinct from input.attempt_outcome,
                 a.supplied_markets is distinct from input.supplied_markets]
         ) as t(f, differs)
   where a.cohort_id = input.cohort_id and a.participant_id = input.participant_id
     and a.game_id = input.game_id and a.attempt_ordinal = input.attempt_ordinal
     and coalesce(t.differs, true)
), child_ready as (
  -- An attempt has no parent to wait for; the CTE exists so the shared identity
  -- gate has the same shape in both statements.
  select 1 from input
), ${IDENTITY_CTES}, attempt_ins as (
  insert into public.benchmark_arm_attempts
    (cohort_id, participant_id, network, game_id, attempt_ordinal, run_id,
     deployment_round, supplied_markets, sent, outcome, requested_model_id,
     reported_model_id, provider_response_id, http_status, provider_stop_reason,
     turn_completed, validation_errors, request_at, response_at, latency_ms,
     input_tokens, output_tokens, reasoning_tokens, billable_output_tokens,
     billable_search_count, search_evidence_status, cost_usd, price_version,
     source_path, source_sha256)
  select cohort_id, participant_id, network, game_id, attempt_ordinal, run_id,
         deployment_round, supplied_markets, sent, attempt_outcome, requested_model_id,
         reported_model_id, provider_response_id, http_status, provider_stop_reason,
         turn_completed, validation_errors, request_at, response_at, latency_ms,
         input_tokens, output_tokens, reasoning_tokens, billable_output_tokens,
         billable_search_count, search_evidence_status, cost_usd, attempt_price_version,
         source_path, source_sha256
    from input, gate
   where gate.ok
  on conflict on constraint uq_benchmark_arm_attempt do nothing
  returning 1
)
select (select min(f) from drift)             as contradiction,
       (select count(*) from drift)::int      as drift_rows,
       null::text                             as ineligible_reason,
       -- An attempt has no parent row to find, so this reports the GATE: false
       -- when a durable fact disagrees, which is the state a bare literal 1
       -- reported as inserted=0-and-nothing-else, i.e. as a benign duplicate.
       (select gate.ok::int from gate)        as parent_found,
       (select count(*) from attempt_ins)::int as inserted`;

/**
 * A forecast at seal time. The attempt is resolved by its natural key and is NOT
 * written here — publish it first.
 *
 * ⚠ RESOLVING IT IS NOT ENOUGH: THE ATTEMPT MUST BE ONE THAT COULD HAVE PRODUCED
 *   THIS FORECAST. Three ways it might not be, all measured landing a published
 *   decision before this check existed:
 *
 *     sent = false            a call that never reached the provider cannot have
 *                             returned a pick. The schema keeps the row so a
 *                             failed arm stays in the denominator — citing it
 *                             turns that denominator into a numerator.
 *     outcome not accepted    only an accepted call yields decisions. A
 *                             timed-out or non-final arm scoring 1/1 is the
 *                             coverage figure inverted.
 *     market not supplied     a forecast on a market the frozen bundle never
 *                             offered. `supplied_markets` IS the per-market
 *                             eligible denominator, so this scores a pick
 *                             against an opportunity that did not exist.
 *
 *   Each is reported as `attempt_not_eligible` with the reason, distinct from
 *   `parent_missing`, because "you published the wrong attempt" and "you did not
 *   publish one" are different producer bugs.
 */
const SEAL_SQL = `
with input as (
  select * from jsonb_to_record($1::jsonb) as x(
    run_id text, cohort_id text, slate_date date, network public.network,
    deployment_round text, started_at timestamptz,
    run_bundle_sha256 text, plan_sha256 text, prompt_scaffold_sha256 text,
    prompt_scaffold_version text, run_response_schema_version smallint,
    baseline_policy_version text, run_price_version text, benchmark_commit text,
    execution_policy text,
    participant_id text, kind text, lab_id text, display_name text,
    model_id text, configuration_canonical text, configuration_sha256 text,
    configuration_digest_version smallint, wallet_address text,
    game_id text, has_attempt boolean, attempt_ordinal smallint,
    accepted_outcomes text[],
    market text, contest_id text, speculation_id text, sealed_at timestamptz,
    forecast_digest text, rationale_digest text, decision_bundle_sha256 text,
    decision_response_schema_version smallint,
    source_path text, source_sha256 text)
), cited as (
  select a.id, a.sent, a.outcome, a.supplied_markets
    from public.benchmark_arm_attempts a, input
   where input.has_attempt
     and a.cohort_id = input.cohort_id
     and a.participant_id = input.participant_id
     and a.game_id = input.game_id
     and a.attempt_ordinal = input.attempt_ordinal
), drift as (${IDENTITY_DRIFT}
  union all
  -- EVERY IMMUTABLE FACT OF THE SEAL, not just the forecast digest.
  --
  -- The seal is the commitment, the row is insert-once, and
  -- an ON CONFLICT DO NOTHING absorbs a second one silently unless something
  -- compares it. Measured with only the forecast digest compared: a replay
  -- carrying a different rationaleDigest came back duplicate, so the
  -- caller was told its write was a benign repeat while the stored row still
  -- committed to different prose. Every column below is part of what the
  -- seal promised, so every one of them is a contradiction when it moves.
  select coalesce(t.f, 'drift.unlabelled') as f
    from public.benchmark_decisions d, input,
         lateral unnest(
           array['seal.forecastDigest','seal.rationaleDigest','seal.sealedAt',
                 'seal.runId','seal.deploymentRound','seal.network',
                 'seal.contestId','seal.speculationId','seal.bundleSha256',
                 'seal.responseSchemaVersion','seal.attemptOrdinal'],
           array[d.forecast_digest  is distinct from input.forecast_digest,
                 d.rationale_digest is distinct from input.rationale_digest,
                 d.sealed_at        is distinct from input.sealed_at,
                 d.run_id           is distinct from input.run_id,
                 d.deployment_round is distinct from input.deployment_round,
                 d.network          is distinct from input.network,
                 d.contest_id       is distinct from input.contest_id,
                 d.speculation_id   is distinct from input.speculation_id,
                 d.bundle_sha256    is distinct from input.decision_bundle_sha256,
                 d.response_schema_version
                   is distinct from input.decision_response_schema_version,
                 -- The provider call it cites, compared as the id the insert
                 -- would resolve rather than as the ordinal supplied.
                 d.attempt_id       is distinct from (select id from cited)]
         ) as t(f, differs)
   where d.cohort_id = input.cohort_id and d.participant_id = input.participant_id
     and d.game_id = input.game_id and d.market = input.market
     and coalesce(t.differs, true)
), ineligible as (
  select coalesce(t.f, 'unlabelled') as f
    from cited, input,
         lateral unnest(
           array['unsent','outcome_not_accepted','market_not_supplied'],
           array[not cited.sent,
                 not (cited.outcome = any(input.accepted_outcomes)),
                 not (input.market = any(cited.supplied_markets))]
         ) as t(f, differs)
   where coalesce(t.differs, true)
), child_ready as (
  select cited.id from cited where not exists (select 1 from ineligible)
  union all
  select null::bigint from input where not input.has_attempt
), ${IDENTITY_CTES}, decision_ins as (
  insert into public.benchmark_decisions
    (cohort_id, participant_id, network, game_id, market, run_id, deployment_round,
     contest_id, speculation_id, attempt_id, sealed_at, forecast_digest,
     rationale_digest, bundle_sha256, response_schema_version, source_path, source_sha256)
  select input.cohort_id, input.participant_id, input.network, input.game_id, input.market,
         input.run_id, input.deployment_round, input.contest_id, input.speculation_id,
         child_ready.id, input.sealed_at, input.forecast_digest, input.rationale_digest,
         input.decision_bundle_sha256, input.decision_response_schema_version,
         input.source_path, input.source_sha256
    from input, child_ready, gate
   where gate.ok
  on conflict on constraint uq_benchmark_decision do nothing
  returning 1
)
select (select min(f) from drift)                as contradiction,
       (select count(*) from drift)::int         as drift_rows,
       (select min(f) from ineligible)           as ineligible_reason,
       -- gate.ok already conjoins "child_ready is non-empty", so this is the
       -- count it replaces AND the suppression the count could not see.
       (select gate.ok::int from gate)           as parent_found,
       (select count(*) from decision_ins)::int  as inserted`;

/**
 * The forecast, as an insert-once child. `sealed_at` is COPIED from the parent
 * inside the statement rather than supplied: the composite foreign key pins the
 * pair, and the chronology CHECK compares the two, so a caller cannot publish a
 * pick stamped before the commitment it belongs to.
 */
const REVEAL_SQL = `
with input as (
  select * from jsonb_to_record($1::jsonb) as x(
    cohort_id text, participant_id text, game_id text, market text,
    revealed_at timestamptz, selection text, line numeric(10,4),
    observed_decimal numeric(12,6), prob_win numeric(9,8), prob_push numeric(9,8),
    prob_loss numeric(9,8), confidence numeric(9,8), would_abstain boolean,
    selected_for_execution boolean, reason_code text,
    axis_valuation smallint, axis_trend smallint, axis_consensus smallint,
    axis_news smallint, axis_softness smallint, primary_axis text,
    primary_expectation text, source_path text, source_sha256 text)
), parent as (
  select d.id, d.sealed_at
    from public.benchmark_decisions d, input
   where d.cohort_id = input.cohort_id
     and d.participant_id = input.participant_id
     and d.game_id = input.game_id
     and d.market = input.market
), ins as (
  insert into public.benchmark_decision_reveals
    (decision_id, sealed_at, revealed_at, selection, line, observed_decimal,
     prob_win, prob_push, prob_loss, confidence, would_abstain,
     selected_for_execution, reason_code, axis_valuation, axis_trend,
     axis_consensus, axis_news, axis_softness, primary_axis, primary_expectation,
     source_path, source_sha256)
  select parent.id, parent.sealed_at, input.revealed_at, input.selection, input.line,
         input.observed_decimal, input.prob_win, input.prob_push, input.prob_loss,
         input.confidence, input.would_abstain, input.selected_for_execution,
         input.reason_code, input.axis_valuation, input.axis_trend, input.axis_consensus,
         input.axis_news, input.axis_softness, input.primary_axis, input.primary_expectation,
         input.source_path, input.source_sha256
    from parent, input
  on conflict (decision_id) do nothing
  returning 1
)
select null::text                          as contradiction,
       0                                   as drift_rows,
       null::text                          as ineligible_reason,
       (select count(*) from parent)::int  as parent_found,
       (select count(*) from ins)::int     as inserted`;

/**
 * The withheld prose, keyed to its decision the same way the reveal is.
 *
 * ⚠ IT MUST HASH TO THE DIGEST ITS SEAL COMMITTED TO. The whole claim about
 *   this table is that publishing the prose later is provably the original,
 *   and nothing checked it: the seal stored a digest and this statement
 *   inserted whatever text it was handed. Measured — a replacement rationale
 *   landed `published` under a digest of the prose it replaced, and the
 *   commitment was unverifiable from then on with nothing reporting it.
 *
 *   The digest compared here is derived by the payload builder from the bytes
 *   that will actually be STORED, after redaction, so what a reader can
 *   recompute from the table is what was checked. The seal's own digest comes
 *   from the artifact, which the writer already redacted, so the two agree —
 *   and if they ever do not, this reports it rather than storing the pair.
 */
const RATIONALE_SQL = `
with input as (
  select * from jsonb_to_record($1::jsonb) as x(
    cohort_id text, participant_id text, game_id text, market text,
    rationale text, rationale_digest text, evidence_refs text[],
    source_path text, source_sha256 text)
), parent as (
  select d.id, d.rationale_digest
    from public.benchmark_decisions d, input
   where d.cohort_id = input.cohort_id
     and d.participant_id = input.participant_id
     and d.game_id = input.game_id
     and d.market = input.market
), drift as (
  -- A NULL stored digest is a seal that committed to having no rationale, so
  -- is distinct from is the right comparison in both directions.
  select 'rationale' as f
    from parent, input
   where parent.rationale_digest is distinct from input.rationale_digest
), ins as (
  insert into public.benchmark_decision_rationales
    (decision_id, rationale, evidence_refs, source_path, source_sha256)
  select parent.id, input.rationale, input.evidence_refs, input.source_path, input.source_sha256
    from parent, input
   where not exists (select 1 from drift)
  on conflict (decision_id) do nothing
  returning 1
)
select (select min(f) from drift)          as contradiction,
       (select count(*) from drift)::int   as drift_rows,
       null::text                          as ineligible_reason,
       (select count(*) from parent)::int  as parent_found,
       (select count(*) from ins)::int     as inserted`;

/**
 * A scored forecast. Append-only in the strong sense: the unique key blocks a
 * duplicate insert for one policy version and the writer holds no UPDATE, so a
 * rescore under a NEW version adds a row beside the old one and never overwrites
 * it. `yarn score` rewrites its NDJSON in place under a gitignored `out/`, so
 * this is where a superseded score keeps a home.
 *
 * Two drift sources, and what each one binds:
 *
 *   run binding    the decision is resolved by its natural key, which says
 *                  nothing about WHICH execution of the slate it came from. A
 *                  scored artifact from a re-run of the same cohort carries CLV
 *                  computed against entry prices the stored decision never
 *                  committed to, and landing it would misattribute every value
 *                  on the row. The stored decision's run_id is the arbiter.
 *
 *   value drift    the conflict target is DO NOTHING, so without this a second
 *                  pass under the SAME policy version whose values disagree —
 *                  a close that arrived after an early scoring pass is the
 *                  realistic shape — would be absorbed as `duplicate`: a benign
 *                  repeat, when the stored row and the artifact in hand say
 *                  different things. An immutable fact that is not
 *                  drift-compared is absorbed silently.
 *
 * `scored_at`, `source_path` and `source_sha256` are deliberately OUTSIDE the
 * drift comparison. They describe the scoring PASS, not the score: re-running
 * `yarn score` over the same run file under the same policy produces identical
 * values with a fresh timestamp in a fresh file, and comparing pass provenance
 * would turn that legitimate recovery into a permanent contradiction — the one
 * republish path a fail-soft publisher cannot afford to close.
 */
const SCORE_SQL = `
with input as (
  select * from jsonb_to_record($1::jsonb) as x(
    cohort_id text, participant_id text, game_id text, market text,
    run_id text, label text,
    scoring_policy_version text, economic_clv_pct numeric(12,6),
    margin_adjusted_clv_pct numeric(12,6), devig_method text, ladder_version text,
    ladder_param_version text, refused boolean, refusal_reason text,
    schedule_changed boolean, held_out_of_primary boolean,
    close_decimal_selected numeric(12,6), close_decimal_opposing numeric(12,6),
    close_line numeric(10,4), line_movement_favorable numeric(10,4),
    scored_at timestamptz, source_path text, source_sha256 text)
), parent as (
  select d.id, d.run_id
    from public.benchmark_decisions d, input
   where d.cohort_id = input.cohort_id
     and d.participant_id = input.participant_id
     and d.game_id = input.game_id
     and d.market = input.market
), drift as (
  select 'score.runId' as f
    from parent, input
   where parent.run_id is distinct from input.run_id
  union all
  -- Scoped to the SAME policy version: a rescore under a new version is a new
  -- row beside the old one by design, and must not be judged against it. The
  -- numeric comparisons happen at the column scales because the record
  -- declaration above already applied them to the input.
  select coalesce(t.f, 'drift.unlabelled') as f
    from public.benchmark_scores s, parent, input,
         lateral unnest(
           array['score.label','score.economicClvPct','score.marginAdjustedClvPct',
                 'score.devigMethod','score.ladderVersion','score.ladderParamVersion',
                 'score.refused','score.refusalReason','score.scheduleChanged',
                 'score.heldOutOfPrimary','score.closeDecimalSelected',
                 'score.closeDecimalOpposing','score.closeLine',
                 'score.lineMovementFavorable'],
           array[s.label                   is distinct from input.label,
                 s.economic_clv_pct        is distinct from input.economic_clv_pct,
                 s.margin_adjusted_clv_pct is distinct from input.margin_adjusted_clv_pct,
                 s.devig_method            is distinct from input.devig_method,
                 s.ladder_version          is distinct from input.ladder_version,
                 s.ladder_param_version    is distinct from input.ladder_param_version,
                 s.refused                 is distinct from input.refused,
                 s.refusal_reason          is distinct from input.refusal_reason,
                 s.schedule_changed        is distinct from input.schedule_changed,
                 s.held_out_of_primary     is distinct from input.held_out_of_primary,
                 s.close_decimal_selected  is distinct from input.close_decimal_selected,
                 s.close_decimal_opposing  is distinct from input.close_decimal_opposing,
                 s.close_line              is distinct from input.close_line,
                 s.line_movement_favorable is distinct from input.line_movement_favorable]
         ) as t(f, differs)
   where s.decision_id = parent.id
     and s.scoring_policy_version = input.scoring_policy_version
     and coalesce(t.differs, true)
), ins as (
  insert into public.benchmark_scores
    (decision_id, label, scoring_policy_version, economic_clv_pct, margin_adjusted_clv_pct,
     devig_method, ladder_version, ladder_param_version, refused, refusal_reason,
     schedule_changed, held_out_of_primary, close_decimal_selected,
     close_decimal_opposing, close_line, line_movement_favorable, scored_at,
     source_path, source_sha256)
  select parent.id, input.label, input.scoring_policy_version, input.economic_clv_pct,
         input.margin_adjusted_clv_pct, input.devig_method, input.ladder_version,
         input.ladder_param_version, input.refused, input.refusal_reason,
         input.schedule_changed, input.held_out_of_primary, input.close_decimal_selected,
         input.close_decimal_opposing, input.close_line, input.line_movement_favorable,
         input.scored_at, input.source_path, input.source_sha256
    from parent, input
   where not exists (select 1 from drift)
  on conflict on constraint uq_benchmark_score_per_policy do nothing
  returning 1
)
select (select min(f) from drift)          as contradiction,
       (select count(*) from drift)::int   as drift_rows,
       null::text                          as ineligible_reason,
       (select count(*) from parent)::int  as parent_found,
       (select count(*) from ins)::int     as inserted`;

/**
 * Cohort-level coverage and the publication brake. It has no parent to find, so
 * `parent_found` is a literal 1 â€” the outcome mapping is shared with the others
 * and would otherwise read this as `parent_missing`. That literal stays correct
 * beside the drift CTE below, because `drift_rows` is read FIRST and a drift row
 * suppresses the write through its own `not exists` guard rather than through
 * `parent_found`.
 *
 * WHAT IS COMPARED, AND WHAT IS NOT. Inside: the eight facts the row asserts
 * about the cohort's scoring pass. Outside: the key itself, plus `scored_at`,
 * `source_path`, `source_sha256` and `benchmark_commit` â€” for the same reason
 * SCORE_SQL gives above, one step stronger. A scored artifact is DERIVED, so
 * re-running `yarn score` over the same run files regenerates it with a fresh
 * timestamp, in a fresh file, possibly from a newer build. All four move on a
 * legitimate recovery republish while the facts do not, and comparing them
 * would turn the one republish path a fail-soft publisher cannot afford to
 * close into a permanent contradiction.
 */
const SCORING_RUN_SQL = `
with input as (
  select * from jsonb_to_record($1::jsonb) as x(
    cohort_id text, scoring_policy_version text, eligible integer, scored integer,
    refused integer, schedule_held_out integer, refusal_reasons jsonb,
    ranking_allowed boolean, ranking_reason text, cost_per_pick_comparable boolean,
    benchmark_commit text, scored_at timestamptz, source_path text, source_sha256 text)
), drift as (
  -- The same DURABLE-FACT DRIFT rule as every other statement here, and this
  -- row needs it most: it is the PUBLICATION BRAKE, insert-once, with no
  -- UPDATE grant behind it. Measured on PostgreSQL 17.10 before this CTE
  -- existed: a republish flipping ranking_allowed from false to true reported
  -- "duplicate", i.e. success, and the stored row still said false. The lever
  -- the operator was pulling did nothing and said so in no way.
  --
  -- It is also what makes an INCOMPLETE aggregation loud. The row is
  -- cohort-scalar while a scored artifact is per run file, so its counts are
  -- summed over a SET of artifacts the operator supplies; publishing over
  -- fourteen of a cohort's fifteen and then over all fifteen is a real
  -- mistake, and without this it reports success twice.
  select coalesce(t.f, 'drift.unlabelled') as f
    from public.benchmark_scoring_runs r, input,
         lateral unnest(
           array['scoringRun.eligible','scoringRun.scored','scoringRun.refused',
                 'scoringRun.scheduleHeldOut','scoringRun.refusalReasons',
                 'scoringRun.rankingAllowed','scoringRun.rankingReason',
                 'scoringRun.costPerPickComparable'],
           -- jsonb "is distinct from" compares by value, so a histogram whose
           -- keys were serialised in another order is NOT a disagreement.
           array[r.eligible                 is distinct from input.eligible,
                 r.scored                   is distinct from input.scored,
                 r.refused                  is distinct from input.refused,
                 r.schedule_held_out        is distinct from input.schedule_held_out,
                 r.refusal_reasons          is distinct from input.refusal_reasons,
                 r.ranking_allowed          is distinct from input.ranking_allowed,
                 r.ranking_reason           is distinct from input.ranking_reason,
                 r.cost_per_pick_comparable is distinct from input.cost_per_pick_comparable]
         ) as t(f, differs)
   where r.cohort_id = input.cohort_id
     and r.scoring_policy_version = input.scoring_policy_version
     and coalesce(t.differs, true)
), ins as (
  insert into public.benchmark_scoring_runs
    (cohort_id, scoring_policy_version, eligible, scored, refused, schedule_held_out,
     refusal_reasons, ranking_allowed, ranking_reason, cost_per_pick_comparable,
     benchmark_commit, scored_at, source_path, source_sha256)
  select cohort_id, scoring_policy_version, eligible, scored, refused, schedule_held_out,
         refusal_reasons, ranking_allowed, ranking_reason, cost_per_pick_comparable,
         benchmark_commit, scored_at, source_path, source_sha256
    from input
   where not exists (select 1 from drift)
  on conflict (cohort_id, scoring_policy_version) do nothing
  returning 1
)
select (select min(f) from drift)          as contradiction,
       (select count(*) from drift)::int   as drift_rows,
       null::text                          as ineligible_reason,
       1                                   as parent_found,
       (select count(*) from ins)::int     as inserted`;

/**
 * Every relation the projection is made of, in dependency order.
 *
 * One list, here beside the statements that name them, because two copies of it
 * drift and the drift is invisible: a table added to the schema and to one list
 * is a table the other list never checks.
 *
 * `benchmark_schema_capability` is included and is NOT written by anything here
 * — it is the schema's own claim about what it can hold, read by the publisher
 * before it opens. A caller that distinguishes the two should do it by asking
 * which tables the statements insert into, not by trimming this list.
 */
export const SERVING_TABLES: readonly string[] = Object.freeze([
  'benchmark_runs',
  'benchmark_participants',
  'benchmark_cohort_participants',
  'benchmark_arm_attempts',
  'benchmark_decisions',
  'benchmark_decision_reveals',
  'benchmark_decision_rationales',
  'benchmark_scores',
  'benchmark_scoring_runs',
  'benchmark_schema_capability',
]);

/** Every statement, exported so a test can hold each record declaration against
 *  the keys its payload builder emits — the drift the jsonb hop cannot detect. */
export const SERVING_STATEMENTS = Object.freeze({
  attempt: ATTEMPT_SQL,
  seal: SEAL_SQL,
  reveal: REVEAL_SQL,
  rationale: RATIONALE_SQL,
  score: SCORE_SQL,
  scoringRun: SCORING_RUN_SQL,
  lock: LOCK_SQL,
});

// ---------------------------------------------------------------------------
// Outcome mapping
// ---------------------------------------------------------------------------

/** A five-character SQLSTATE. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

const DETAIL_LIMIT = 300;

/**
 * Unique constraints whose only job is to make a shared parent row unique. A
 * 23505 on one of these under concurrency is a lost race, not a disagreement —
 * both writers wanted the identical row — so it is retried once, after which the
 * winner's row is committed and the `not exists` guard skips the insert.
 *
 * Deliberately an allowlist. uq_benchmark_cohort_wallet and the composite foreign
 * keys are integrity signals and must surface; retrying those would just refuse
 * twice and bury the reason.
 */
const RACEABLE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'benchmark_runs_pkey',
  'uq_benchmark_run_identity',
  'benchmark_participants_pkey',
  'benchmark_cohort_participants_pkey',
  'uq_benchmark_cohort_participant_network',
  'uq_benchmark_arm_attempt',
  'uq_benchmark_attempt_identity',
  'uq_benchmark_decision',
  'uq_benchmark_decision_seal',
]);

/** Serialization failure and deadlock: retryable by definition. */
const RACEABLE_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01']);

/**
 * SQLSTATE classes that mean the server could not serve this RIGHT NOW, rather
 * than that it rejected this row. Reported as `unavailable`, because the two
 * call for opposite responses: a refusal is a producer bug to fix, an outage is
 * a thing to retry or drop.
 *
 *   08  connection exception
 *   53  insufficient resources — including 53300 too_many_connections, which is
 *       not exotic here: the scoped role carries CONNECTION LIMIT 5 and a
 *       fan-out that ignores it gets this instead of a write. Measured while
 *       chasing what looked like concurrent data loss and was in fact a probe
 *       opening twelve connections against a limit of five.
 *   57  operator intervention (shutdown, admin cancel, statement timeout kin)
 *   58  system error
 */
const TRANSIENT_SQLSTATE_CLASSES: ReadonlySet<string> = new Set(['08', '53', '57', '58']);

function isLostRace(outcome: PublishOutcome): boolean {
  if (outcome.outcome !== 'refused') return false;
  if (RACEABLE_SQLSTATES.has(outcome.sqlstate)) return true;
  return outcome.sqlstate === '23505'
    && outcome.constraint !== null
    && RACEABLE_CONSTRAINTS.has(outcome.constraint);
}

/**
 * Fold a thrown value into an outcome without letting arbitrary text through
 * unredacted. A server error carries a SQLSTATE; anything else — a socket reset,
 * a DNS failure, a pool timeout — is treated as `unavailable`, which is the
 * transient reading and the one that keeps the run going.
 */
function classify(error: unknown): PublishOutcome {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const detail = redactSecrets(raw).slice(0, DETAIL_LIMIT);
  const code: unknown = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && SQLSTATE.test(code)) {
    if (TRANSIENT_SQLSTATE_CLASSES.has(code.slice(0, 2))) return { outcome: 'unavailable', detail };
    const named: unknown = (error as { constraint?: unknown }).constraint;
    return {
      outcome: 'refused',
      sqlstate: code,
      constraint: typeof named === 'string' && named.length > 0 ? named : null,
      detail,
    };
  }
  return { outcome: 'unavailable', detail };
}

/**
 * Map one statement's three reported values onto an outcome. A result that is
 * neither shape is a wire skew against the SQL in this file, and it resolves to
 * `unavailable` rather than throwing — this port may not halt a run even to
 * complain that the database answered something impossible.
 */
function classifyRows(rows: ReadonlyArray<Record<string, unknown>>): PublishOutcome {
  const row = rows.length === 1 ? rows[0] : undefined;
  const parentFound = row?.['parent_found'];
  const inserted = row?.['inserted'];
  const contradiction = row?.['contradiction'];
  const driftRows = row?.['drift_rows'];
  const ineligible = row?.['ineligible_reason'];
  if (typeof parentFound !== 'number' || typeof inserted !== 'number'
      || typeof driftRows !== 'number'
      || (contradiction !== null && typeof contradiction !== 'string')
      || (ineligible !== null && typeof ineligible !== 'string')) {
    return { outcome: 'unavailable', detail: `off-contract result shape (${rows.length} row(s))` };
  }
  // Precedence, and it is deliberate: a disagreement about a commitment outranks
  // everything, then an attempt that cannot carry the forecast, then absence.
  // Each of the first three means NOTHING was written.
  //
  // ⚠ THE COUNT DECIDES, NOT THE NAME. Any drift row closes `gate.ok` and
  //   suppresses the whole statement, but the name comes from a parallel array
  //   and `min()` drops a NULL — so a drift row the statement could not label
  //   used to arrive as inserted=0 with no contradiction, which the branch below
  //   reports as `duplicate`: a suppressed write read as a benign repeat, and
  //   therefore as a success. Reporting on the count means an unlabelled
  //   disagreement is still a contradiction.
  if (driftRows > 0) {
    return {
      outcome: 'contradiction',
      field: typeof contradiction === 'string' ? contradiction : UNNAMED_DRIFT_FIELD,
    };
  }
  if (typeof ineligible === 'string') {
    return { outcome: 'attempt_not_eligible', reason: ineligible as AttemptIneligibleReason };
  }
  if (parentFound === 0) return { outcome: 'parent_missing' };
  if (inserted === 0) return { outcome: 'duplicate' };
  return { outcome: 'published' };
}

/**
 * Reported when a drift row exists but the statement could not name the field.
 *
 * Unreachable from the statements above as they stand, because every drift
 * source labels its padded row. It is the second layer, for a drift source
 * added later WITHOUT that label — a bug in the SQL rather than anything a
 * caller did. Named rather than blank so it is greppable, and reported as a
 * contradiction rather than swallowed, because the write really was suppressed.
 */
export const UNNAMED_DRIFT_FIELD = 'unnamed (a drift check in this statement is misconfigured)';

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * The publisher over the same structural `StoreQuery` seam the atomic store uses,
 * so `pg` is never imported here and stays a runtime-wiring dependency.
 *
 * Construct with `null` — the default everywhere the credential is absent — and
 * every method returns `disabled` without touching the network. That is what
 * makes this safe to call unconditionally from a run path.
 */
export class SqlBenchmarkServingPort implements BenchmarkServingPort {
  constructor(private readonly deps: ServingStoreDeps | null) {}

  publishAttempt(attempt: ArmAttempt): Promise<PublishOutcome> {
    return this.publish(ATTEMPT_SQL, () => attemptPayload(attempt), true);
  }

  sealDecision(seal: DecisionSeal): Promise<PublishOutcome> {
    return this.publish(SEAL_SQL, () => sealPayload(seal), true);
  }

  revealDecision(reveal: DecisionReveal): Promise<PublishOutcome> {
    return this.publish(REVEAL_SQL, () => revealPayload(reveal));
  }

  publishRationale(rationale: DecisionRationale): Promise<PublishOutcome> {
    return this.publish(RATIONALE_SQL, () => rationalePayload(rationale));
  }

  publishScore(score: DecisionScore): Promise<PublishOutcome> {
    // Serialized for the same reason a seal is: the statement drift-compares
    // the stored row, and inside a lone statement that read uses a snapshot
    // taken before the statement began — a concurrent writer's different score
    // would be invisible and absorbed as `duplicate`. The lock keys are the
    // participant and cohort already present in the payload.
    return this.publish(SCORE_SQL, () => scorePayload(score), true);
  }

  publishScoringRun(run: ScoringRun): Promise<PublishOutcome> {
    // Serialized for exactly the reason a score is: the statement now
    // drift-compares the stored row, and inside a lone statement that read uses
    // a snapshot taken before the statement began, so a concurrent writer's
    // different row is invisible and absorbed as `duplicate`. A drift check
    // without the lock is the shape that measured 58 of 100 races writing
    // anyway (see LOCK_SQL) — adding one without the other would look like a
    // guarantee and not be one.
    //
    // The payload carries no `participant_id`, so `lockKeys` supplies the empty
    // participant key and the cohort key does the ordering. That is a SUPERSET
    // lock — every scoring-run publish, of every cohort, contends on the one
    // empty participant key — which costs a queue of at most one write per
    // publication and preserves the participant-then-cohort acquisition order
    // every other writer uses, so no cycle can form.
    return this.publish(SCORING_RUN_SQL, () => scoringRunPayload(run), true);
  }

  /**
   * The one place a projection write can fail, and the one place that decides it
   * never propagates. Validation and serialisation run first, inside the try —
   * a `Refusal` is this module's own signal and must not be reported as a
   * database problem, while `JSON.stringify` is in there because a runtime value
   * of the wrong type once threw a TypeError straight out of a method documented
   * never to throw.
   *
   * `serialized` writes take the lock and then the statement, on one connection,
   * so the statement's drift check reads a snapshot that includes every
   * committed parent. Everything else is a lone statement with nothing to order
   * against.
   *
   * A lost race on a shared parent row is retried EXACTLY once. Every write is
   * an idempotent DO NOTHING so a retry cannot double-insert, and one is enough
   * because the retry runs after the winner has committed. Bounded at one so a
   * persistent 23505 — which would mean the allowlist is wrong — surfaces rather
   * than spinning.
   */
  private async publish(
    sql: string,
    build: () => Record<string, unknown>,
    serialized = false,
  ): Promise<PublishOutcome> {
    const deps = this.deps;
    if (deps === null) return { outcome: 'disabled' };

    let parameters: readonly unknown[];
    let keys: readonly string[] | null;
    try {
      parameters = [JSON.stringify(build())];
      // Inside the try with the payload it reads. It cannot throw as written —
      // its input is always `JSON.stringify` over a plain object — but it was
      // the one unguarded statement left in a method documented never to throw,
      // and a caller on a run path now depends on that being literally true.
      keys = serialized ? lockKeys(parameters[0] as string) : null;
    } catch (error) {
      if (error instanceof Refusal) {
        return { outcome: 'invalid_input', reason: error.reason, field: error.field };
      }
      return classify(error);
    }
    const run = async (): Promise<PublishOutcome> => {
      try {
        if (keys === null) return classifyRows(await deps.query(sql, parameters));
        return await deps.transactor.transaction(async (query) => {
          await query(LOCK_SQL, keys);
          return classifyRows(await query(sql, parameters));
        });
      } catch (error) {
        return classify(error);
      }
    };

    const first = await run();
    return isLostRace(first) ? await run() : first;
  }
}

/**
 * The lock keys, read back out of the payload that was already built, so the
 * lock and the write cannot disagree about which rows they cover.
 */
function lockKeys(payload: string): readonly string[] {
  const parsed = JSON.parse(payload) as { participant_id?: unknown; cohort_id?: unknown };
  return [String(parsed.participant_id ?? ''), String(parsed.cohort_id ?? '')];
}
