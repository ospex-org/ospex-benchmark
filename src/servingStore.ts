import { redactSecrets } from './config.js';
import { isParseableInstant } from './time.js';
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
 *    unavailable (see .claude/rules/advisory-tooling.md). This INVERTS the house
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

/** Why a cited provider call cannot carry the forecast being sealed. */
export type AttemptIneligibleReason = 'unsent' | 'outcome_not_accepted' | 'market_not_supplied';

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

/** Durable participant identity, stable across model versions. */
export interface ParticipantFacts {
  readonly participantId: string;
  readonly kind: ParticipantKind;
  readonly labId: string | null;
  readonly displayName: string;
}

/**
 * The per-cohort binding: which model version an arm ran and which wallet it
 * signed with.
 *
 * ⚠ FIRST WRITE WINS, and there is no second chance. The roster row is created by
 *   whichever attempt or seal reaches it first and the writer holds no UPDATE, so
 *   a `walletAddress` supplied later is not stored — it is reported as a
 *   `contradiction` and the original stands. The wallet is the join key from a
 *   forecast to its on-chain fill, so bind it before the first write for that
 *   participant or the join is dead for the whole cohort.
 */
export interface RosterFacts {
  readonly armId: string | null;
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
 * The forecast lands separately, and the absence of that reveal IS the embargo.
 *
 * `attemptOrdinal` names the already-published provider call this forecast came
 * from, or is null for a deterministic baseline that made none. A participant of
 * kind `model` must cite one: the foreign key is MATCH SIMPLE, so a NULL would
 * satisfy it and the row would then read as a baseline whose telemetry never
 * existed. That pairing is refused client-side.
 *
 * ⚠ `forecastDigest` is supplied, not derived. The schema documents it as the
 *   SHA-256 of this repo's `forecastFingerprint()` over its twelve
 *   decision-bearing fields — i.e. `sha256Hex(canonicalize(forecastFingerprint(f)))`
 *   using the helpers in `canonical.ts`. Nothing composes that today, so whoever
 *   wires a producer must, and must use exactly that composition: a digest
 *   computed any other way still passes the hex check here and still stores, but
 *   it cannot be recomputed from the later reveal, which is the column's only
 *   purpose.
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

/** The identity every statement shares: the run, the participant and the roster
 *  binding. Emitted with identical key names by both write paths, so one set of
 *  CTEs serves both. */
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
    arm_id: text(roster.armId, 'roster.armId'),
    wallet_address: roster.walletAddress,
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
    line: num(reveal.line, 'line'),
    observed_decimal: num(reveal.observedDecimal, 'observedDecimal', 0),
    prob_win: unit(reveal.probWin, 'probWin'),
    prob_push: unit(reveal.probPush, 'probPush'),
    prob_loss: unit(reveal.probLoss, 'probLoss'),
    confidence: unit(reveal.confidence, 'confidence'),
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
  return {
    ...decisionRef(rationale.decision, 'decision'),
    rationale: requiredText(rationale.rationale, 'rationale'),
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
 * DURABLE-FACT DRIFT, and why it is checked twice.
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
 * The comparison here reads the statement's own snapshot, which cannot see a
 * concurrent writer that has not committed yet. `verifyDrift` re-runs it after
 * the write for exactly that case. Because these tables are append-only, a
 * post-write read is authoritative rather than merely luckier: whatever it sees
 * is final.
 */
const RUN_DRIFT = `
  select t.f
    from public.benchmark_runs r, input,
         lateral unnest(
           array['run.slateDate','run.startedAt','run.bundleSha256','run.planSha256',
                 'run.promptScaffoldSha256','run.promptScaffoldVersion',
                 'run.responseSchemaVersion','run.baselinePolicyVersion',
                 'run.priceVersion','run.benchmarkCommit','run.executionPolicy'],
           array[r.slate_date               is distinct from input.slate_date,
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
   where r.run_id = input.run_id and t.differs`;

const PARTICIPANT_DRIFT = `
  select t.f
    from public.benchmark_participants p, input,
         lateral unnest(
           array['participant.kind','participant.labId','participant.displayName'],
           array[p.kind         is distinct from input.kind,
                 p.lab_id       is distinct from input.lab_id,
                 p.display_name is distinct from input.display_name]
         ) as t(f, differs)
   where p.participant_id = input.participant_id and t.differs`;

const ROSTER_DRIFT = `
  select t.f
    from public.benchmark_cohort_participants c, input,
         lateral unnest(
           array['roster.armId','roster.walletAddress'],
           array[c.arm_id         is distinct from input.arm_id,
                 c.wallet_address is distinct from input.wallet_address]
         ) as t(f, differs)
   where c.cohort_id = input.cohort_id
     and c.participant_id = input.participant_id and t.differs`;

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
    (participant_id, kind, lab_id, display_name, source_path, source_sha256)
  select participant_id, kind, lab_id, display_name, source_path, source_sha256
    from input, gate
   where gate.ok
     and not exists (select 1 from public.benchmark_participants p
                      where p.participant_id = input.participant_id)
  on conflict (participant_id) do nothing
  returning 1
), roster_ins as (
  insert into public.benchmark_cohort_participants
    (cohort_id, participant_id, network, arm_id, wallet_address, source_path, source_sha256)
  select cohort_id, participant_id, network, arm_id, wallet_address, source_path, source_sha256
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
    arm_id text, wallet_address text,
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
  select t.f
    from public.benchmark_arm_attempts a, input,
         lateral unnest(
           array['facts.sent','facts.outcome','facts.suppliedMarkets'],
           array[a.sent             is distinct from input.sent,
                 a.outcome          is distinct from input.attempt_outcome,
                 a.supplied_markets is distinct from input.supplied_markets]
         ) as t(f, differs)
   where a.cohort_id = input.cohort_id and a.participant_id = input.participant_id
     and a.game_id = input.game_id and a.attempt_ordinal = input.attempt_ordinal
     and t.differs
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
       null::text                             as ineligible_reason,
       1                                      as parent_found,
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
    arm_id text, wallet_address text,
    game_id text, has_attempt boolean, attempt_ordinal smallint,
    accepted_outcomes text[],
    market text, contest_id text, speculation_id text, sealed_at timestamptz,
    forecast_digest text, rationale_digest text, decision_bundle_sha256 text,
    decision_response_schema_version smallint,
    source_path text, source_sha256 text)
), drift as (${IDENTITY_DRIFT}
  union all
  -- The seal IS the pregame commitment. A second seal for the same key carrying
  -- a DIFFERENT digest is the one integrity failure this projection exists to
  -- make visible, and \`on conflict do nothing\` alone reports it as a replay.
  select 'forecastDigest'
    from public.benchmark_decisions d, input
   where d.cohort_id = input.cohort_id and d.participant_id = input.participant_id
     and d.game_id = input.game_id and d.market = input.market
     and d.forecast_digest is distinct from input.forecast_digest
), cited as (
  select a.id, a.sent, a.outcome, a.supplied_markets
    from public.benchmark_arm_attempts a, input
   where input.has_attempt
     and a.cohort_id = input.cohort_id
     and a.participant_id = input.participant_id
     and a.game_id = input.game_id
     and a.attempt_ordinal = input.attempt_ordinal
), ineligible as (
  select t.f
    from cited, input,
         lateral unnest(
           array['unsent','outcome_not_accepted','market_not_supplied'],
           array[not cited.sent,
                 not (cited.outcome = any(input.accepted_outcomes)),
                 not (input.market = any(cited.supplied_markets))]
         ) as t(f, differs)
   where t.differs
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
       (select min(f) from ineligible)           as ineligible_reason,
       (select count(*) from child_ready)::int   as parent_found,
       (select count(*) from decision_ins)::int  as inserted`;

/**
 * The same drift comparison, as a plain read. Run AFTER the write, because the
 * in-statement copy uses a snapshot that cannot see a concurrent writer which
 * has not committed yet — measured: twelve concurrent seals of one key with
 * twelve different digests did not all report the contradiction.
 *
 * These tables are append-only and the writer holds no UPDATE, so a row's facts
 * never change once written. That is what makes a read-after-write authoritative
 * here rather than just a second roll of the dice: whatever this sees is final.
 */
const VERIFY_IDENTITY_SQL = `
with input as (
  select * from jsonb_to_record($1::jsonb) as x(
    run_id text, cohort_id text, slate_date date,
    started_at timestamptz, run_bundle_sha256 text, plan_sha256 text,
    prompt_scaffold_sha256 text, prompt_scaffold_version text,
    run_response_schema_version smallint, baseline_policy_version text,
    run_price_version text, benchmark_commit text, execution_policy text,
    participant_id text, kind text, lab_id text, display_name text,
    arm_id text, wallet_address text,
    game_id text, market text, forecast_digest text)
), drift as (${IDENTITY_DRIFT}
  union all
  select 'forecastDigest'
    from public.benchmark_decisions d, input
   where input.market is not null
     and d.cohort_id = input.cohort_id and d.participant_id = input.participant_id
     and d.game_id = input.game_id and d.market = input.market
     and d.forecast_digest is distinct from input.forecast_digest
)
select (select min(f) from drift) as contradiction`;

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
       null::text                          as ineligible_reason,
       (select count(*) from parent)::int  as parent_found,
       (select count(*) from ins)::int     as inserted`;

/** The withheld prose, keyed to its decision the same way the reveal is. */
const RATIONALE_SQL = `
with input as (
  select * from jsonb_to_record($1::jsonb) as x(
    cohort_id text, participant_id text, game_id text, market text,
    rationale text, evidence_refs text[], source_path text, source_sha256 text)
), parent as (
  select d.id
    from public.benchmark_decisions d, input
   where d.cohort_id = input.cohort_id
     and d.participant_id = input.participant_id
     and d.game_id = input.game_id
     and d.market = input.market
), ins as (
  insert into public.benchmark_decision_rationales
    (decision_id, rationale, evidence_refs, source_path, source_sha256)
  select parent.id, input.rationale, input.evidence_refs, input.source_path, input.source_sha256
    from parent, input
  on conflict (decision_id) do nothing
  returning 1
)
select null::text                          as contradiction,
       null::text                          as ineligible_reason,
       (select count(*) from parent)::int  as parent_found,
       (select count(*) from ins)::int     as inserted`;

/**
 * A scored forecast. Append-only in the strong sense: the unique key blocks a
 * duplicate insert for one policy version and the writer holds no UPDATE, so a
 * rescore under a NEW version adds a row beside the old one and never overwrites
 * it. `yarn score` rewrites its NDJSON in place under a gitignored `out/`, so
 * this is where a superseded score keeps a home.
 */
const SCORE_SQL = `
with input as (
  select * from jsonb_to_record($1::jsonb) as x(
    cohort_id text, participant_id text, game_id text, market text,
    scoring_policy_version text, economic_clv_pct numeric(12,6),
    margin_adjusted_clv_pct numeric(12,6), devig_method text, ladder_version text,
    ladder_param_version text, refused boolean, refusal_reason text,
    schedule_changed boolean, held_out_of_primary boolean,
    close_decimal_selected numeric(12,6), close_decimal_opposing numeric(12,6),
    close_line numeric(10,4), line_movement_favorable numeric(10,4),
    scored_at timestamptz, source_path text, source_sha256 text)
), parent as (
  select d.id
    from public.benchmark_decisions d, input
   where d.cohort_id = input.cohort_id
     and d.participant_id = input.participant_id
     and d.game_id = input.game_id
     and d.market = input.market
), ins as (
  insert into public.benchmark_scores
    (decision_id, scoring_policy_version, economic_clv_pct, margin_adjusted_clv_pct,
     devig_method, ladder_version, ladder_param_version, refused, refusal_reason,
     schedule_changed, held_out_of_primary, close_decimal_selected,
     close_decimal_opposing, close_line, line_movement_favorable, scored_at,
     source_path, source_sha256)
  select parent.id, input.scoring_policy_version, input.economic_clv_pct,
         input.margin_adjusted_clv_pct, input.devig_method, input.ladder_version,
         input.ladder_param_version, input.refused, input.refusal_reason,
         input.schedule_changed, input.held_out_of_primary, input.close_decimal_selected,
         input.close_decimal_opposing, input.close_line, input.line_movement_favorable,
         input.scored_at, input.source_path, input.source_sha256
    from parent, input
  on conflict on constraint uq_benchmark_score_per_policy do nothing
  returning 1
)
select null::text                          as contradiction,
       null::text                          as ineligible_reason,
       (select count(*) from parent)::int  as parent_found,
       (select count(*) from ins)::int     as inserted`;

/**
 * Cohort-level coverage and the publication brake. It has no parent to find, so
 * `parent_found` is a literal 1 — the outcome mapping is shared with the others
 * and would otherwise read this as `parent_missing`.
 */
const SCORING_RUN_SQL = `
with input as (
  select * from jsonb_to_record($1::jsonb) as x(
    cohort_id text, scoring_policy_version text, eligible integer, scored integer,
    refused integer, schedule_held_out integer, refusal_reasons jsonb,
    ranking_allowed boolean, ranking_reason text, cost_per_pick_comparable boolean,
    benchmark_commit text, scored_at timestamptz, source_path text, source_sha256 text)
), ins as (
  insert into public.benchmark_scoring_runs
    (cohort_id, scoring_policy_version, eligible, scored, refused, schedule_held_out,
     refusal_reasons, ranking_allowed, ranking_reason, cost_per_pick_comparable,
     benchmark_commit, scored_at, source_path, source_sha256)
  select cohort_id, scoring_policy_version, eligible, scored, refused, schedule_held_out,
         refusal_reasons, ranking_allowed, ranking_reason, cost_per_pick_comparable,
         benchmark_commit, scored_at, source_path, source_sha256
    from input
  on conflict (cohort_id, scoring_policy_version) do nothing
  returning 1
)
select null::text                       as contradiction,
       null::text                       as ineligible_reason,
       1                                as parent_found,
       (select count(*) from ins)::int  as inserted`;

/** Every statement, exported so a test can hold each record declaration against
 *  the keys its payload builder emits — the drift the jsonb hop cannot detect. */
export const SERVING_STATEMENTS = Object.freeze({
  attempt: ATTEMPT_SQL,
  seal: SEAL_SQL,
  reveal: REVEAL_SQL,
  rationale: RATIONALE_SQL,
  score: SCORE_SQL,
  scoringRun: SCORING_RUN_SQL,
  verifyIdentity: VERIFY_IDENTITY_SQL,
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
  const ineligible = row?.['ineligible_reason'];
  if (typeof parentFound !== 'number' || typeof inserted !== 'number'
      || (contradiction !== null && typeof contradiction !== 'string')
      || (ineligible !== null && typeof ineligible !== 'string')) {
    return { outcome: 'unavailable', detail: `off-contract result shape (${rows.length} row(s))` };
  }
  // Precedence, and it is deliberate: a disagreement about a commitment outranks
  // everything, then an attempt that cannot carry the forecast, then absence.
  // Each of the first three means NOTHING was written.
  if (typeof contradiction === 'string') return { outcome: 'contradiction', field: contradiction };
  if (typeof ineligible === 'string') {
    return { outcome: 'attempt_not_eligible', reason: ineligible as AttemptIneligibleReason };
  }
  if (parentFound === 0) return { outcome: 'parent_missing' };
  if (inserted === 0) return { outcome: 'duplicate' };
  return { outcome: 'published' };
}

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
  constructor(private readonly query: StoreQuery | null) {}

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
    return this.publish(SCORE_SQL, () => scorePayload(score));
  }

  publishScoringRun(run: ScoringRun): Promise<PublishOutcome> {
    return this.publish(SCORING_RUN_SQL, () => scoringRunPayload(run));
  }

  /**
   * The one place a projection write can fail, and the one place that decides it
   * never propagates. Validation runs first and outside the try that swallows —
   * a `Refusal` is this module's own signal and must not be reported as a
   * database problem, while anything else thrown by a payload builder is a bug
   * here and still may not halt the run.
   *
   * A lost race on a shared parent row is retried EXACTLY once. Every write is an
   * idempotent DO NOTHING, so a retry cannot double-insert, and one is enough:
   * the retry runs after the winner has committed, so the `not exists` guard
   * skips the insert that collided. Bounded at one so a persistent 23505 — which
   * would mean the allowlist is wrong — surfaces instead of spinning.
   */
  private async publish(
    sql: string,
    build: () => Record<string, unknown>,
    verifyDrift = false,
  ): Promise<PublishOutcome> {
    if (this.query === null) return { outcome: 'disabled' };
    let parameters: readonly unknown[];
    try {
      // SERIALISATION IS INSIDE THE BOUNDARY. It was not, and a runtime value of
      // the wrong type — `turnCompleted: 1n`, measured — made JSON.stringify
      // throw a TypeError straight out of a method documented never to throw.
      // Booleans are type-checked now too, but the boundary is what makes the
      // guarantee hold for the next value nobody anticipated.
      parameters = [JSON.stringify(build())];
    } catch (error) {
      if (error instanceof Refusal) {
        return { outcome: 'invalid_input', reason: error.reason, field: error.field };
      }
      return classify(error);
    }
    const run = async (statement: string): Promise<PublishOutcome> => {
      try {
        return classifyRows(await this.query!(statement, parameters));
      } catch (error) {
        return classify(error);
      }
    };

    const first = await run(sql);
    const written = isLostRace(first) ? await run(sql) : first;
    if (!verifyDrift || written.outcome === 'refused' || written.outcome === 'unavailable') {
      return written;
    }

    // The in-statement drift check reads this statement's own snapshot, so it
    // cannot see a writer that had not committed when the snapshot was taken.
    // Re-asking after the write closes that: these tables are append-only and
    // the writer holds no UPDATE, so a row's facts never change once written and
    // what this read sees is final rather than merely later.
    try {
      const rows = await this.query(VERIFY_IDENTITY_SQL, parameters);
      const field = rows.length === 1 ? rows[0]?.['contradiction'] : undefined;
      if (typeof field === 'string') return { outcome: 'contradiction', field };
    } catch {
      // A failed second read must not turn a good write into an error. The write
      // reported what it reported; this pass simply could not add to it.
    }
    return written;
  }
}
