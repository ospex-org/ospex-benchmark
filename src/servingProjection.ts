import { PROJECTION_SCALES, quantizeForProjection } from './projectionNumeric.js';
import { participantFacts, projectionParticipant } from './servingIdentity.js';
import { baselineDigest, decisionDigest, forecastDigest, suppliedMarkets } from './schema.js';
import { sha256Hex } from './canonical.js';
import { describeError } from './config.js';
import { parseRunRecords, verifyRunIntegrity } from './scoring.js';
import type { AxisName, AxesScores, GameBundle, MarketKey } from './types.js';
import type { ProjectionParticipant } from './servingIdentity.js';
import type { RevealedFingerprint } from './schema.js';
import type {
  ArmAttempt,
  AttemptFacts,
  DecisionRationale,
  DecisionReveal,
  DecisionSeal,
  NetworkKey,
  ParticipantFacts,
  RosterFacts,
  RunFacts,
  SourceRef,
} from './servingStore.js';

/**
 * Turns a written run artifact into the writes that mirror it onto the serving
 * projection.
 *
 * ── THE ONE RULE ─────────────────────────────────────────────────────────────
 * Every value published here is a pure function of the NDJSON file and the
 * frozen registry — never of the process doing the publishing. Nothing reads a
 * constant, an environment variable, a clock or a git tree at publish time
 * except `revealedAt`, which is by definition the moment of publication and is
 * compared against nothing.
 *
 * That rule is not tidiness. The projection freezes a run's identity on the
 * first write and compares every later write against it, dropping the whole
 * write — the decision row included — on any disagreement. Meanwhile the
 * publisher is fail-soft by design, so a write lost to a network blip is lost
 * silently, and the only way to get it back is to publish the same artifact
 * again. If any frozen value were re-derived at that moment — today's commit,
 * a bumped deployment round — the recovery would contradict the row it was
 * trying to complete and lose everything it touched. Reading them out of the
 * file makes a recovery byte-identical to the original by construction, which
 * is why `run_meta.projection` exists.
 *
 * The same rule is what makes this function serve both callers: a fire
 * publishes the file it has just written, and a backfill publishes a file
 * written months ago, through identical code.
 *
 * ── WHAT IS DELIBERATELY NOT PUBLISHED ───────────────────────────────────────
 * Scores, and the per-cohort scoring-run summary. Both belong to the scorer,
 * which runs later, from a different artifact, after the closing lines land.
 * The coverage summary in particular is keyed per cohort while a watch fire
 * writes one artifact per game, so publishing it from here would freeze a
 * whole day's coverage from whichever game happened to go first.
 */

// ---------------------------------------------------------------------------
// Reading the artifact
// ---------------------------------------------------------------------------

export type JsonRecord = Record<string, unknown>;

/** Parse one NDJSON artifact into records. Malformed lines are refused, not
 *  skipped: a half-read artifact would publish a partial run that looks
 *  complete. `what` names the artifact kind in the refusal, nothing more. */
export function parseNdjsonObjects(text: string, what: string): readonly JsonRecord[] {
  const records: JsonRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${what} line ${index + 1} is not valid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${what} line ${index + 1} is not a JSON object`);
    }
    records.push(parsed as JsonRecord);
  }
  return records;
}

/** Parse the NDJSON a run wrote. */
export function parseRunArtifact(text: string): readonly JsonRecord[] {
  return parseNdjsonObjects(text, 'run artifact');
}

/**
 * Put the artifact through the SCORER's own reader before publishing any of it.
 *
 * The projector below has its own reader, and it has to: the canonical one
 * drops the provider telemetry a projection needs. But a second reader is a
 * second opinion about what a valid artifact is, and the weaker of the two
 * decides what gets published. Measured, on files this module used to accept:
 *
 *   two run_meta records — the canonical reader refuses the file outright as
 *   ambiguous, while this module took the first and published every decision in
 *   the file under that run's identity, including decisions belonging to the
 *   other one;
 *
 *   a truncated file — cutting a trailing `run_failure` record turned a run the
 *   gate REFUSES into one it accepts, because the gate can only see the records
 *   that are present. The canonical verifier cross-checks the counts run_meta
 *   declares against the records that follow it, so a file missing anything is
 *   caught by the artifact disagreeing with itself.
 *
 * So integrity is answered once, by the reader that already owns the question,
 * and this module's reader only ever runs on a file that reader accepted.
 */
export function verifyArtifactIntegrity(text: string): string | null {
  let run: ReturnType<typeof parseRunRecords>;
  try {
    run = parseRunRecords(text.split(/\r?\n/));
  } catch (error) {
    return `the artifact is not a well-formed run file (${describeError(error)})`;
  }

  // The expected roster comes from the APPEND-ONLY REGISTRY, filtered to the
  // participants this artifact contains. Both halves matter, and I have now got
  // each one wrong in turn:
  //
  //   taking the roster from the artifact's own records made the check
  //   SELF-APPROVING. A self-consistent file naming a real participant while
  //   declaring an arbitrary requested model passed, and the projector then
  //   published that contradictory identity. Nothing can verify itself.
  //
  //   leaving the verifier at its default compares the run against whichever
  //   arms THIS BUILD ships, so the day a fifth arm is enrolled every artifact
  //   written before it becomes unpublishable — and republishing an artifact is
  //   the only way to recover a write this fail-soft publisher lost. Recovery
  //   must not expire because the roster grew.
  //
  // Filtering an append-only registry to the participants present resolves the
  // two: an old artifact is judged against exactly the arms it ran, by the
  // registry's record of what those arms ARE, not by its own claims about them.
  // An arm the registry has never heard of is refused outright, because the
  // registry only ever grows — so an unknown arm is not an old one.
  const observed = new Set(run.armResponses.map((response) => response.participantId));
  const unknown = [...observed].filter((id) => projectionParticipant(id) === null);
  if (unknown.length > 0) {
    return `the artifact names arms the registry has never enrolled: ${unknown.sort().join(', ')}`;
  }

  // Every field here comes from the REGISTRY, never from the artifact. That is
  // the whole point of the roster: `verifyRunIntegrity` compares the run's own
  // `armRoster` stamp — provider, requested model and configuration digest —
  // against this, and a value taken from the file would be the file agreeing
  // with itself.
  //
  // The configuration is registry-sourced for a second reason too. A
  // participant row is GLOBAL and insert-once, so sourcing it per-run would let
  // two artifacts disagree with the first one silently winning. It also keeps
  // the backfill path open: an artifact written before the stamp existed
  // declares no configuration at all, and those runs were provider-defaults by
  // construction, which is exactly what the registry says they were.
  const expectedArms = [...observed].map((id) => {
    // Non-null by the guard above, which refuses the whole artifact for any
    // unenrolled arm. Coalescing to '' instead would satisfy the type and hand
    // the verifier an empty provider to match against.
    const entry = projectionParticipant(id)!;
    return {
      participantId: id,
      provider: entry.provider ?? '',
      requestedModelId: entry.modelId ?? '',
      approvedReportedModelIds: [...entry.approvedReportedModelIds],
      configuration: entry.configuration ?? {},
    };
  });

  const violations = verifyRunIntegrity(run, { expectedArms });
  if (violations.length > 0) {
    return `the artifact fails its own integrity check: ${violations.join('; ')}`;
  }
  return null;
}

const str = (record: JsonRecord, key: string): string | null =>
  typeof record[key] === 'string' ? (record[key] as string) : null;
const num = (record: JsonRecord, key: string): number | null =>
  typeof record[key] === 'number' && Number.isFinite(record[key]) ? (record[key] as number) : null;
const bool = (record: JsonRecord, key: string): boolean | null =>
  typeof record[key] === 'boolean' ? (record[key] as boolean) : null;
const nested = (record: JsonRecord, key: string): JsonRecord | null => {
  const value = record[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
};
const strings = (record: JsonRecord, key: string): string[] | null => {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : null;
};
const typed = (records: readonly JsonRecord[], recordType: string): JsonRecord[] =>
  records.filter((record) => record['recordType'] === recordType);

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * The cohorts this path is allowed to publish under.
 *
 * A cohort is the unit results are pooled within, and mixing two kinds of run
 * into one is the mistake the projection's own documentation warns about first.
 * The runner mints `watch-v0-<date>` and `smoke-v0-<date>`, but `--cohort-id`
 * on the smoke path accepts anything — including a name that would pool a
 * rehearsal into a canonical cohort, or a content-addressed campaign cohort id
 * whose runs have an entirely different grain.
 */
const PUBLISHABLE_COHORT = /^(?:watch|smoke)-v0-\d{4}-\d{2}-\d{2}$/;

/** The one definition of which cohorts may reach the projection, shared with
 *  the scored-artifact gate so the two paths cannot drift apart. */
export function publishableCohortId(cohortId: string): boolean {
  return PUBLISHABLE_COHORT.test(cohortId);
}

/** Facts the projection freezes, carried by the artifact rather than re-derived. */
export interface ProjectionStamp {
  readonly network: NetworkKey;
  readonly deploymentRound: string;
  readonly responseSchemaVersion: number | null;
  readonly benchmarkCommit: string | null;
}

export interface RunHeader {
  readonly runId: string;
  readonly cohortId: string;
  readonly slateDate: string;
  readonly createdAt: string;
  readonly executionPolicy: string | null;
  readonly slateSha256: string | null;
  readonly promptScaffoldVersion: string | null;
  readonly promptScaffoldSha256: string | null;
  readonly baselinePolicyVersion: string | null;
  readonly stamp: ProjectionStamp;
}

export type RunGate =
  | { readonly publishable: true; readonly header: RunHeader }
  | { readonly publishable: false; readonly reason: string };

const NETWORKS: readonly string[] = ['polygon', 'amoy'];

/**
 * Whether a run artifact may reach the projection at all.
 *
 * Every check reads the artifact, so the answer does not depend on which
 * process is asking — a fire and a backfill of the same file agree. Each one
 * guards against a write that could not be taken back:
 *
 *   mode / clockMode  a dry run swaps in mock adapters that return fabricated
 *                     forecasts under the real model ids. Those rows would be
 *                     indistinguishable from measured ones, and would very
 *                     likely be the FIRST write, minting the global participant
 *                     registry from a fixture.
 *   run_failure       a run that failed the model-identity or provider-collision
 *                     check is permanently unscoreable, and the scorer refuses
 *                     it outright. Sealing it publishes commitments that can
 *                     never be revealed or scored.
 *   cohortId          see PUBLISHABLE_COHORT.
 *   projection stamp  an artifact written before the stamp existed cannot
 *                     supply the run's frozen identity, and inventing it here
 *                     is the one thing this module must not do.
 */
export function publishableRun(records: readonly JsonRecord[]): RunGate {
  const no = (reason: string): RunGate => ({ publishable: false, reason });

  const meta = typed(records, 'run_meta')[0];
  if (meta === undefined) return no('the artifact carries no run_meta record');
  if (str(meta, 'mode') !== 'live') return no('not a live run');
  if (str(meta, 'clockMode') !== 'wall') return no('the run used a synthetic clock');
  if (typed(records, 'run_failure').length > 0) {
    return no('the run recorded an identity or provider-collision failure');
  }

  const runId = str(meta, 'runId');
  const cohortId = str(meta, 'cohortId');
  const slateDate = str(meta, 'slateDate');
  const createdAt = str(meta, 'createdAt');
  if (runId === null || cohortId === null || slateDate === null || createdAt === null) {
    return no('run_meta is missing one of runId, cohortId, slateDate, createdAt');
  }
  if (!PUBLISHABLE_COHORT.test(cohortId)) return no('cohortId is outside the published namespace');

  const stamp = nested(meta, 'projection');
  if (stamp === null) return no('the artifact predates the projection stamp');
  const network = str(stamp, 'network');
  const deploymentRound = str(stamp, 'deploymentRound');
  if (network === null || deploymentRound === null) {
    return no('the projection stamp is missing network or deploymentRound');
  }
  if (!NETWORKS.includes(network)) return no('the projection stamp names an unknown network');

  return {
    publishable: true,
    header: {
      runId,
      cohortId,
      slateDate,
      createdAt,
      executionPolicy: str(meta, 'executionPolicy'),
      slateSha256: str(meta, 'slateSha256'),
      promptScaffoldVersion: str(meta, 'promptScaffoldVersion'),
      promptScaffoldSha256: str(meta, 'promptScaffoldSha256'),
      // buildRecords omits the key entirely when the run derived no baselines,
      // and when two versions somehow disagree — so absence is expected and
      // means "no single version applies", not "the field was forgotten".
      baselinePolicyVersion: str(meta, 'baselinePolicyVersion'),
      stamp: {
        network: network as NetworkKey,
        deploymentRound,
        responseSchemaVersion: num(stamp, 'responseSchemaVersion'),
        benchmarkCommit: str(stamp, 'benchmarkCommit'),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** One sealed forecast and everything published about it, in order. */
export interface ProjectedDecision {
  readonly seal: DecisionSeal;
  readonly reveal: DecisionReveal;
  /** Null for a control, which authored no prose. */
  readonly rationale: DecisionRationale | null;
}

/**
 * What to write, and in what order.
 *
 * Attempts first, all of them, then decisions: a seal resolves the provider
 * call it cites, so the call has to be committed and visible before any seal
 * that names it. Within `decisions` the entries are independent of each other.
 */
export interface ProjectionPlan {
  readonly runId: string;
  readonly cohortId: string;
  readonly attempts: readonly ArmAttempt[];
  readonly decisions: readonly ProjectedDecision[];
  /** Rows deliberately not published, each with the reason, for the log. */
  readonly skipped: readonly string[];
}

export interface ProjectionClock {
  /** The reveal instant. The only publish-time value in the whole plan. */
  now(): string;
}

/**
 * ── WHY A FORECAST IS REVEALED WITH THE RUN, NOT AFTER THE GAME ──────────────
 * Recorded here because the seal-and-reveal split makes an embargo POSSIBLE and
 * a reader can reasonably assume one was intended.
 *
 * It is not. Reading what each model chose, and why, before the game is the
 * point of publishing any of this — a pick that only appears once the result is
 * known is a claim rather than a forecast. The commitment digest is what makes
 * that safe: it is written at seal time and recomputable from the reveal, so an
 * early publication is still provably the pick that was made and not one edited
 * afterwards.
 *
 * The cost, stated plainly rather than left implicit: the picks are visible
 * while the market they are scored against is still open. That is accepted, and
 * it has been asked twice, so the reasoning is written down rather than left to
 * be re-derived.
 *
 * KEEPING THE PICKS SECRET WAS NEVER A REQUIREMENT. Not for the maker, not for
 * anyone. Scoring is against a reference feed rather than a book a reader can
 * move, so the measurement cannot be gamed by publication; and beyond that
 * there is no audience to game it — no users, no volume, nobody reading. The
 * one residual worry anyone has raised is models copying each other, which is
 * remote and is accepted too.
 *
 * That is a judgement about the current state of the world rather than a
 * property of the code, and it is the maintainer's to revisit. The schema keeps
 * the seal and the reveal in separate tables, so holding picks back later is a
 * scheduling change here and not a migration. If measured downstream effects
 * ever appear, this is the paragraph to come back to.
 */

/**
 * Build the plan for an artifact that has already passed `publishableRun`.
 *
 * Anything that cannot be published truthfully is skipped with a reason rather
 * than published with a substitute: every field here is written once and the
 * writer holds no UPDATE, so a plausible stand-in is permanent and a gap is
 * not.
 */
export function projectRun(
  records: readonly JsonRecord[],
  header: RunHeader,
  source: SourceRef,
  clock: ProjectionClock,
): ProjectionPlan {
  const skipped: string[] = [];
  const attempts: ArmAttempt[] = [];
  const decisions: ProjectedDecision[] = [];

  const run: RunFacts = {
    runId: header.runId,
    cohortId: header.cohortId,
    slateDate: header.slateDate,
    network: header.stamp.network,
    deploymentRound: header.stamp.deploymentRound,
    startedAt: header.createdAt,
    bundleSha256: header.slateSha256,
    // Plans are a campaign concept; this path builds no plan artifact.
    // Deliberately not filled with the slate hash, which already has its own
    // column: two fields claiming different things while holding the same bytes
    // is worse than an honest absence.
    planSha256: null,
    promptScaffoldSha256: header.promptScaffoldSha256,
    promptScaffoldVersion: header.promptScaffoldVersion,
    responseSchemaVersion: header.stamp.responseSchemaVersion,
    baselinePolicyVersion: header.baselinePolicyVersion,
    // No cost is computed on this path, so no price table priced it. A token
    // count is published on every attempt, which keeps dollars derivable at
    // read time from whichever table a reader trusts — while a figure invented
    // here would be frozen, and would understate the arms that search most.
    priceVersion: null,
    benchmarkCommit: header.stamp.benchmarkCommit,
    executionPolicy: header.executionPolicy,
  };

  // The markets the frozen bundle OFFERED, per game. This is the per-market
  // eligible denominator, so it has to be a fact about the opportunity and
  // never about what came back: derived from the response, the denominator
  // would equal the numerator and every coverage figure would read 100%.
  const offered = new Map<string, MarketKey[]>();
  for (const record of typed(records, 'bundle_game')) {
    const gameId = str(record, 'gameId');
    const bundle = nested(record, 'bundle');
    // Only `markets` is read, and only for the presence of its three blocks —
    // checked here so a malformed bundle is a skipped game with a reason rather
    // than a throw out of a projection that must never fail a run.
    if (gameId === null || bundle === null || nested(bundle, 'markets') === null) continue;
    offered.set(gameId, suppliedMarkets(bundle as unknown as GameBundle));
  }

  for (const record of typed(records, 'arm_game_response')) {
    const armAttempts = projectArmAttempts(record, run, header, offered, skipped, source);
    attempts.push(...armAttempts);
  }

  for (const record of typed(records, 'decision')) {
    const projected = projectModelDecision(record, run, header, clock, skipped, source);
    if (projected !== null) decisions.push(projected);
  }

  for (const record of typed(records, 'baseline_decision')) {
    const projected = projectBaselineDecision(record, run, header, clock, skipped, source);
    if (projected !== null) decisions.push(projected);
  }

  return { runId: header.runId, cohortId: header.cohortId, attempts, decisions, skipped };
}

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

/**
 * The provider calls one arm made on one game: ordinal 0 always, ordinal 1 when
 * a deterministic format repair ran.
 *
 * Ordinal 0 is written whatever the outcome — a refused, timed-out or non-final
 * call is exactly the row that keeps a failed arm in the opportunity
 * denominator, and omitting it would compute every rate over successes alone.
 *
 * `outcome`, `validationErrors` and `suppliedMarkets` are RESPONSE-LEVEL and
 * are repeated identically on the repair row. That is the schema's own design —
 * "either row alone describes the opportunity" — and it is the only reading
 * under which pinning a denominator to ordinal 0 is correct: stamping the
 * initial failure on ordinal 0 of an arm that was repaired to valid would drop
 * every repaired success out of the count.
 *
 * A stated bound: the repair's TRANSPORT status — whether it was throttled,
 * timed out, or came back schema-invalid — has no column in this projection, so
 * a throttled repair is not distinguishable here from an invalid one. That fact
 * stays in the artifact. It is a gap in the model rather than in this mapping,
 * and inventing a column for it belongs in a schema change.
 */
function projectArmAttempts(
  record: JsonRecord,
  run: RunFacts,
  header: RunHeader,
  offered: ReadonlyMap<string, MarketKey[]>,
  skipped: string[],
  source: SourceRef,
): ArmAttempt[] {
  const runnerId = str(record, 'participantId');
  const gameId = str(record, 'gameId');
  const outcome = str(record, 'outcome');
  if (runnerId === null || gameId === null || outcome === null) {
    skipped.push('an arm_game_response record is missing participantId, gameId or outcome');
    return [];
  }
  const entry = projectionParticipant(runnerId);
  if (entry === null) {
    skipped.push(`attempt for "${runnerId}" on ${gameId}: participant is not enrolled`);
    return [];
  }
  const markets = offered.get(gameId);
  if (markets === undefined || markets.length === 0) {
    skipped.push(`attempt for "${runnerId}" on ${gameId}: no bundle_game record supplies its markets`);
    return [];
  }

  const participant: ParticipantFacts = participantFacts(entry);
  const roster = rosterFacts();
  const validationErrors = strings(record, 'validationErrors');
  const requestedModelId = str(record, 'requestedModelId');

  const legs: Array<[ordinal: number, leg: JsonRecord | null]> = [
    [0, nested(record, 'attempt')],
    [1, nested(record, 'repair')],
  ];

  const built: ArmAttempt[] = [];
  for (const [attemptOrdinal, leg] of legs) {
    if (leg === null) {
      if (attemptOrdinal === 0) {
        skipped.push(`attempt for "${runnerId}" on ${gameId}: the record carries no initial attempt`);
      }
      continue;
    }
    built.push({
      run,
      participant,
      roster,
      gameId,
      facts: attemptFacts(leg, attemptOrdinal, outcome, markets, validationErrors, requestedModelId),
      source,
    });
  }
  return built;
}

function attemptFacts(
  leg: JsonRecord,
  attemptOrdinal: number,
  outcome: string,
  suppliedMarketKeys: readonly MarketKey[],
  validationErrors: readonly string[] | null,
  requestedModelId: string | null,
): AttemptFacts {
  const requestAt = str(leg, 'requestAt');
  const httpStatus = num(leg, 'httpStatus');
  // Either name: `answerText` on files written since #92, `rawResponse` on
  // everything archived before it. Same value under both.
  const answerText = str(leg, 'answerText') ?? str(leg, 'rawResponse');
  const tokens = nested(leg, 'tokens');
  const searchAudit = nested(leg, 'searchAudit');
  // The envelope BODY is private evidence and no serving column carries it;
  // what the projection needs from it is whether this attempt's audit can still
  // be RE-DERIVED, which is what decides how far the recorded status can be
  // trusted. So presence is not enough: retention now covers every 2xx,
  // including the HTML error page a proxy returns, and a body no JSON parser
  // accepts disproves nothing. Reading presence alone would publish the
  // provable negative `no_search_evidence` on the strength of bytes nobody can
  // replay — which is the conflation #92 exists to remove, one layer over.
  const envelope = nested(leg, 'responseEnvelope');
  const envelopeReplayable = envelope !== null && parsesAsJson(str(envelope, 'body'));

  return {
    attemptOrdinal,
    suppliedMarkets: suppliedMarketKeys,
    // Exact rather than approximate: the runner leaves requestAt null on every
    // path where nothing was sent, and parks the discarded clock reading
    // elsewhere precisely so this stays truthful.
    sent: requestAt !== null,
    outcome,
    requestedModelId,
    reportedModelId: str(leg, 'reportedModelId'),
    providerResponseId: str(leg, 'providerResponseId'),
    httpStatus,
    providerStopReason: str(leg, 'providerStopReason'),
    turnCompleted: bool(leg, 'turnCompleted'),
    validationErrors,
    requestAt,
    // responseAt is stamped on timeouts and transport failures too, so it is
    // not a receipt on its own. Published only when something actually came
    // back; otherwise every timeout would claim a response it never received.
    responseAt: answerText !== null || httpStatus !== null ? str(leg, 'responseAt') : null,
    latencyMs: num(leg, 'latencyMs'),
    inputTokens: tokens === null ? null : num(tokens, 'inputTokens'),
    outputTokens: tokens === null ? null : num(tokens, 'outputTokens'),
    // null means UNKNOWN and never zero, for all three of these. Two providers
    // publish no search counter at all, and "did not search" is not an allowed
    // reading of its absence.
    reasoningTokens: tokens === null ? null : num(tokens, 'reasoningTokens'),
    billableOutputTokens: tokens === null ? null : num(tokens, 'billableOutputTokens'),
    billableSearchCount: searchAudit === null ? null : num(searchAudit, 'searchCount'),
    searchEvidenceStatus: searchEvidenceStatus(searchAudit, envelopeReplayable),
    costUsd: null,
    priceVersion: null,
  };
}

/**
 * How far the web-search audit for this call can be trusted.
 *
 * The audit already separates the two things a reader would otherwise conflate:
 * it is null only when the response carried no search evidence at all, and it
 * lists a reason for every gap otherwise. So "nothing ran" and "we could not
 * see what ran" never collapse into one value, and neither is ever reported as
 * a search count of zero.
 *
 * The absent audit needed one more distinction, which is the reporting half of
 * #92. An empty audit is a claim made by the extractor that read the response,
 * and that claim is only checkable while the response survives. With a
 * REPLAYABLE envelope, `no_search_evidence` can be re-derived — and disproved —
 * from the stored body. Without one (every file archived before retention, and
 * every 2xx whose retained body no JSON parser accepts) the same absence is
 * unfalsifiable, so it is reported as `unknown_unproven`: ENVELOPE-UNAVAILABLE,
 * not "nothing ran".
 *
 * Replayable, not merely present, because the two came apart in this change.
 * Retention now covers every 2xx — an HTML error page from a proxy included —
 * so a leg can carry bytes that verify against their own digest and still
 * support no re-derivation at all. `replay:search-audit` calls that leg
 * `unparseable` and exits 1; publishing `no_search_evidence` for it would be
 * this table asserting a provable negative the tool beside it refuses to make.
 *
 * Both values already exist in this column, which is plain `text` with no
 * check constraint (ospex-indexer migration 073), so nothing about the schema
 * moves.
 */
/** Whether a retained body can be parsed at all — the property that makes an
 *  empty audit re-derivable rather than merely archived. */
function parsesAsJson(body: string | null): boolean {
  if (body === null) return false;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function searchEvidenceStatus(searchAudit: JsonRecord | null, envelopeReplayable: boolean): string {
  if (searchAudit === null) return envelopeReplayable ? 'no_search_evidence' : 'unknown_unproven';
  const incomplete = strings(searchAudit, 'incomplete');
  if (incomplete === null) return 'unknown_unproven';
  return incomplete.length === 0 ? 'complete' : 'unknown_unproven';
}

/**
 * The per-cohort roster binding, which is now a wallet and nothing else.
 *
 * It used to carry an `arm_id` — the version-scoped model string, or for a
 * control the baseline policy it ran under. That column is gone: the model is
 * on the participant row where it belongs, and a control's policy version was
 * always also `benchmark_runs.baseline_policy_version`, so nothing is lost.
 */
function rosterFacts(): RosterFacts {
  return {
    // No wallet exists to bind: this repo holds no key material and a CLV
    // forecast is never filled, so there is no position to join to. A
    // placeholder would be worse than absent — one shared address across
    // participants trips the roster's own uniqueness index and takes the whole
    // statement, attempt and run row included, down with it.
    //
    // ⚠ FIRST WRITE WINS, per (cohort, participant). Supplying an address later
    //   in the same cohort is reported as a contradiction and drops the child
    //   row. Bind it on a cohort's first write or not at all; cohorts roll
    //   daily, so the cost of the null is one slate.
    walletAddress: null,
  };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

const AXES: readonly AxisName[] = ['valuation', 'trend', 'consensus', 'news', 'softness'];
const MARKETS: readonly string[] = ['moneyline', 'spread', 'total'];

function projectModelDecision(
  record: JsonRecord,
  run: RunFacts,
  header: RunHeader,
  clock: ProjectionClock,
  skipped: string[],
  source: SourceRef,
): ProjectedDecision | null {
  const runnerId = str(record, 'participantId');
  const gameId = str(record, 'gameId');
  const market = str(record, 'market');
  const selection = str(record, 'selection');
  const observedDecimal = num(record, 'observedDecimal');
  const rationale = str(record, 'rationale');
  const evidenceRefs = strings(record, 'evidenceRefs');
  const probabilities = nested(record, 'probabilities');
  const confidence = num(record, 'confidence');
  const wouldAbstain = bool(record, 'wouldAbstain');
  const selectedForExecution = bool(record, 'selectedForExecution');

  const where = `${runnerId ?? '?'} / ${gameId ?? '?'} / ${market ?? '?'}`;
  if (
    runnerId === null || gameId === null || market === null || !MARKETS.includes(market) ||
    selection === null || observedDecimal === null || probabilities === null ||
    confidence === null || wouldAbstain === null || selectedForExecution === null ||
    rationale === null || evidenceRefs === null
  ) {
    skipped.push(`decision ${where}: the record is missing a required forecast field`);
    return null;
  }
  const win = num(probabilities, 'win');
  const push = num(probabilities, 'push');
  const loss = num(probabilities, 'loss');
  if (win === null || push === null || loss === null) {
    skipped.push(`decision ${where}: probabilities are incomplete`);
    return null;
  }

  const entry = projectionParticipant(runnerId);
  if (entry === null) {
    skipped.push(`decision ${where}: participant is not enrolled`);
    return null;
  }

  // The instant this forecast became a commitment. There is no substitute: the
  // attempt's settle time is stamped on failures too, and the run's open time
  // belongs to the run. A missing value on a decision-bearing arm is a producer
  // bug, and publishing a plausible timestamp for it would freeze the wrong
  // chronology under a constraint that orders the reveal against it.
  const sealedAt = str(record, 'acceptedAt');
  if (sealedAt === null) {
    skipped.push(`decision ${where}: the accepted attempt carries no acceptedAt`);
    return null;
  }

  const axes = readAxes(record);
  const primaryAxis = str(record, 'primaryAxis');
  const primaryExpectation = str(record, 'primaryExpectation');
  const fingerprint: RevealedFingerprint = {
    selection,
    line: num(record, 'line'),
    observedDecimal,
    win,
    push,
    loss,
    confidence,
    wouldAbstain,
    selectedForExecution,
    axes,
    primaryAxis: primaryAxis as AxisName | null,
    primaryExpectation,
  };

  const decision = {
    cohortId: run.cohortId,
    participantId: entry.participantId,
    gameId,
    market: market as MarketKey,
  };

  const seal: DecisionSeal = {
    run,
    participant: participantFacts(entry),
    roster: rosterFacts(),
    gameId,
    // The repair, when one was accepted; otherwise the initial call. The seal
    // must cite the call whose body it came from.
    attemptOrdinal: str(record, 'attemptUsed') === 'repair' ? 1 : 0,
    market: market as MarketKey,
    sealedAt,
    forecastDigest: quantizedDigest(fingerprint),
    // The prose is withheld from every read role, and this is what lets it be
    // published later and still be provably the original. Hashed as the
    // artifact carries it, which is also exactly what the projection stores,
    // so the preimage is the stored value rather than something adjacent to it.
    rationaleDigest: sha256Hex(rationale),
    bundleSha256: str(record, 'bundleSha256'),
    // The artifact's own v1/v2 discriminator, so replaying an older body stamps
    // what that body was rather than what the validator accepts today.
    responseSchemaVersion: axes === null ? 1 : 2,
    // Not in the artifact, so a republish could not reproduce it — and a
    // contest id is not a durable join key anyway: the counter restarted at R5
    // and will restart again. The spine is (network, gameId).
    contestId: null,
    // A line-open concept. This path opens no speculation, and a value here
    // would assert a market placement that never happened.
    speculationId: null,
    source,
  };

  const reveal: DecisionReveal = {
    decision,
    revealedAt: clock.now(),
    selection,
    line: fingerprint.line,
    observedDecimal,
    probWin: win,
    probPush: push,
    probLoss: loss,
    confidence,
    wouldAbstain,
    selectedForExecution,
    reasonCode: str(record, 'reasonCode'),
    axisValuation: axes === null ? null : axes.valuation,
    axisTrend: axes === null ? null : axes.trend,
    axisConsensus: axes === null ? null : axes.consensus,
    axisNews: axes === null ? null : axes.news,
    axisSoftness: axes === null ? null : axes.softness,
    primaryAxis,
    primaryExpectation,
    source,
  };

  return {
    seal,
    reveal,
    rationale: { decision, rationale, evidenceRefs, source },
  };
}

/**
 * A deterministic control's pick on one game.
 *
 * It states a side, the line it took and the price that side was quoted, and
 * nothing else — no probabilities, no confidence, no analysis. Those columns
 * are published as the nulls they are, and the commitment hashes them as nulls,
 * so what the control promised is exactly what a reader can check. Inventing an
 * even-money probability to fill the shape would be frozen permanently and then
 * rendered publicly as something the control claimed.
 *
 * No attempt row: a control makes no provider call, which is why the seal cites
 * no ordinal.
 */
function projectBaselineDecision(
  record: JsonRecord,
  run: RunFacts,
  header: RunHeader,
  clock: ProjectionClock,
  skipped: string[],
  source: SourceRef,
): ProjectedDecision | null {
  const runnerId = str(record, 'participantId');
  const gameId = str(record, 'gameId');
  const market = str(record, 'market');
  const selection = str(record, 'selection');
  const observedDecimal = num(record, 'observedDecimal');

  const where = `${runnerId ?? '?'} / ${gameId ?? '?'} / ${market ?? '?'}`;
  if (
    runnerId === null || gameId === null || market === null || !MARKETS.includes(market) ||
    selection === null || observedDecimal === null
  ) {
    skipped.push(`baseline ${where}: the record is missing a required field`);
    return null;
  }
  const entry = projectionParticipant(runnerId);
  if (entry === null) {
    skipped.push(`baseline ${where}: participant is not enrolled`);
    return null;
  }

  const line = num(record, 'line');
  const fingerprint: RevealedFingerprint = {
    selection,
    line,
    observedDecimal,
    win: null,
    push: null,
    loss: null,
    confidence: null,
    wouldAbstain: null,
    selectedForExecution: null,
    axes: null,
    primaryAxis: null,
    primaryExpectation: null,
  };

  const decision = {
    cohortId: run.cohortId,
    participantId: entry.participantId,
    gameId,
    market: market as MarketKey,
  };

  return {
    seal: {
      run,
      participant: participantFacts(entry),
      roster: rosterFacts(),
      gameId,
      // No provider call was made. The projection expects null here for a
      // control and refuses it for a model.
      attemptOrdinal: null,
      market: market as MarketKey,
      // A control's pick is fixed the moment the run opens: it is a rule
      // applied to the frozen bundle, not a response that arrived at some
      // instant. The run's own open time is the honest reading, and it is at or
      // before every model seal in the same run.
      sealedAt: header.createdAt,
      forecastDigest: baselineDigest({ selection, line, observedDecimal }),
      // No prose was authored, so there is nothing to prove later.
      rationaleDigest: null,
      bundleSha256: str(record, 'requestSha256'),
      // A control validated no response.
      responseSchemaVersion: null,
      contestId: null,
      speculationId: null,
      source,
    },
    reveal: {
      decision,
      revealedAt: clock.now(),
      selection,
      line,
      observedDecimal,
      probWin: null,
      probPush: null,
      probLoss: null,
      confidence: null,
      wouldAbstain: null,
      selectedForExecution: null,
      reasonCode: null,
      axisValuation: null,
      axisTrend: null,
      axisConsensus: null,
      axisNews: null,
      axisSoftness: null,
      primaryAxis: null,
      primaryExpectation: null,
      source,
    },
    rationale: null,
  };
}

/** All five axes or none: the response carries the block whole, and a partial
 *  set would mean a shape the validator never accepted. */
function readAxes(record: JsonRecord): AxesScores | null {
  const axes = nested(record, 'axes');
  if (axes === null) return null;
  const scores: Partial<Record<AxisName, number>> = {};
  for (const axis of AXES) {
    const value = num(axes, axis);
    if (value === null) return null;
    scores[axis] = value;
  }
  return scores as AxesScores;
}

// ---------------------------------------------------------------------------
// The commitment, and checking it against what will be revealed
// ---------------------------------------------------------------------------

/**
 * The digest over the fingerprint AS THE REVEAL COLUMNS WILL HOLD IT.
 *
 * The reveal is stored at fixed scale, and the response schema bounds these
 * fields by range and never by precision — a model that computes one chance in
 * three returns sixteen decimals. Hashing the unrounded value and storing the
 * rounded one produces a commitment nothing can check, which is the whole
 * purpose of sealing before the game.
 */
function quantizedDigest(fingerprint: RevealedFingerprint): string {
  return decisionDigest(quantizeFingerprint(fingerprint));
}

function quantizeFingerprint(fingerprint: RevealedFingerprint): RevealedFingerprint {
  const at = (value: number | null, scale: number): number | null =>
    value === null ? null : quantizeForProjection(value, scale);
  return {
    ...fingerprint,
    line: at(fingerprint.line, PROJECTION_SCALES.line),
    observedDecimal: at(fingerprint.observedDecimal, PROJECTION_SCALES.observedDecimal),
    win: at(fingerprint.win, PROJECTION_SCALES.probability),
    push: at(fingerprint.push, PROJECTION_SCALES.probability),
    loss: at(fingerprint.loss, PROJECTION_SCALES.probability),
    confidence: at(fingerprint.confidence, PROJECTION_SCALES.confidence),
  };
}

/**
 * Recompute a decision's commitment from the reveal that will be published
 * beside it, exactly as an outside verifier would.
 *
 * This exists because the reveal write has NO drift check of its own: a reveal
 * that disagrees with its seal is accepted silently, and the commitment is then
 * unverifiable forever with nothing anywhere reporting it. The producer is the
 * only place that can catch a mapping error — two probabilities transposed, a
 * quantiser dropped on one side — and it can only catch it by doing the
 * verifier's job before publishing rather than trusting that both mappings
 * agree.
 */
export function revealMatchesSeal(decision: ProjectedDecision): boolean {
  const { reveal } = decision;
  const axes =
    reveal.axisValuation === null || reveal.axisTrend === null ||
    reveal.axisConsensus === null || reveal.axisNews === null || reveal.axisSoftness === null
      ? null
      : {
          valuation: reveal.axisValuation,
          trend: reveal.axisTrend,
          consensus: reveal.axisConsensus,
          news: reveal.axisNews,
          softness: reveal.axisSoftness,
        };
  return (
    quantizedDigest({
      selection: reveal.selection,
      line: reveal.line,
      observedDecimal: reveal.observedDecimal,
      win: reveal.probWin,
      push: reveal.probPush,
      loss: reveal.probLoss,
      confidence: reveal.confidence,
      wouldAbstain: reveal.wouldAbstain,
      selectedForExecution: reveal.selectedForExecution,
      axes,
      primaryAxis: reveal.primaryAxis as AxisName | null,
      primaryExpectation: reveal.primaryExpectation,
    }) === decision.seal.forecastDigest
  );
}

/** Re-exported so a caller needs one import to check a model digest directly. */
export { forecastDigest };
