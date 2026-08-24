import { z } from 'zod';
import { parseNdjsonObjects, publishableCohortId } from './servingProjection.js';
import type { JsonRecord } from './servingProjection.js';
import type { DecisionScore, ScoringRun, SourceRef } from './servingStore.js';

/**
 * Project a SCORED artifact (`<runId>-scored.ndjson`, written by `yarn score`)
 * onto `publishScore` calls.
 *
 * A sibling of `servingProjection.ts`, deliberately not part of it: the run
 * projector publishes what a run COMMITTED TO before first pitch, from the run
 * artifact; this one publishes what the scorer later MEASURED, from the
 * scorer's own artifact, after the closing lines landed. The two artifacts
 * have different readers, different gates and different failure modes, and the
 * run projector's own documentation places scores outside it.
 *
 * The same one rule applies: every published value is a pure function of the
 * artifact's bytes, so a fresh publish and a recovery republish are the same
 * call on the same file and cannot contradict the rows already landed. There
 * is no publish-time value at all on this path — `scored_at` comes from the
 * artifact, not from a clock read here.
 *
 * What is deliberately NOT projected, because `benchmark_scores` has no column
 * for it and the artifact remains the canonical record (bound to every row by
 * `source_sha256`): the conditional push-excluded variants, the shin-v1
 * sensitivity block, the TOTALS_V1 ladder values, and the per-participant
 * scorecard aggregates — an aggregate is a read-path GROUP BY, and publishing
 * one per artifact would freeze it from whichever file published first.
 */

// ---------------------------------------------------------------------------
// What a scored artifact says — the reader
// ---------------------------------------------------------------------------
//
// There is no canonical scored-file reader anywhere else in the repo (the
// scorer only ever WRITES these files), so this schema is the reader, and it is
// strict about every field the projection consumes. An older scored file that
// predates one of these fields is refused rather than guessed at — unlike a run
// artifact, a scored artifact is DERIVED: re-running `yarn score` over the
// canonical run file regenerates it in the current format, so refusing costs a
// command, not evidence.

const scoredRunMetaSchema = z
  .object({
    recordType: z.literal('scored_run_meta'),
    label: z.string().min(1),
    runId: z.string().min(1),
    cohortId: z.string().min(1),
    slateDate: z.string().min(1),
    sourceMode: z.string().min(1),
    scoredAt: z.string().min(1),
    scoringPolicyVersion: z.string().min(1),
    integrityVerified: z.boolean(),
    // The artifact's own declared record counts. `.int()` refuses the
    // Infinity that `1e400` parses to, and the gate holds the file to these
    // numbers — a truncated artifact is caught disagreeing with itself.
    picks: z.number().int().nonnegative(),
    participantScorecards: z.number().int().nonnegative(),
    // The scorer's OWN cohort-scalar coverage figures. The projector never
    // reads them: it derives the same two numbers from the scored_decision
    // records and REQUIRES agreement. Declaring them is what turns a meta
    // record spliced from another pass — or a file whose records were edited
    // under a meta that was not — into a refusal, rather than into the cohort
    // coverage a public read path serves. Same cross-check as the picks and
    // participantScorecards counts below, one level up from record counting.
    primaryScoreable: z.number().int().nonnegative(),
    scheduleChangedExcluded: z.number().int().nonnegative(),
    ladder: z
      .object({
        version: z.string().min(1),
        parameterVersion: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

/** The ten close fields the scorer echoes; the projection needs three. */
const closingSchema = z
  .object({
    line: z.number().finite().nullable(),
    awayDecimal: z.number().finite().nullable(),
    homeDecimal: z.number().finite().nullable(),
  })
  .passthrough();

// `.finite()` on every number is load-bearing, not decorative: JSON has no
// Infinity literal, but `1e400` parses to Infinity — the exact shape that once
// threw out of the run publisher's integrity check — and a non-finite value
// this schema admitted would surface later as an opaque per-row refusal.
const scoredDecisionSchema = z
  .object({
    recordType: z.literal('scored_decision'),
    label: z.string().min(1),
    runId: z.string().min(1),
    scoredAt: z.string().min(1),
    scoringPolicyVersion: z.string().min(1),
    participantId: z.string().min(1),
    gameId: z.string().min(1),
    market: z.enum(['moneyline', 'spread', 'total']),
    side: z.enum(['away', 'home']),
    devigMethod: z.string().min(1).nullable(),
    closing: closingSchema.nullable(),
    scheduleChanged: z.boolean().nullable(),
    inPrimaryStratum: z.boolean(),
    primaryClvPct: z.number().finite().nullable(),
    unscoredReason: z.string().min(1).nullable(),
    marginAdjustedClvPct: z.number().finite().nullable(),
    lineMovementFavorable: z.number().finite().nullable(),
  })
  .passthrough();

export type ScoredDecisionRecord = z.infer<typeof scoredDecisionSchema>;

/**
 * The identity fields a participant_scorecard record shares with the pass, plus
 * the one coverage number that lives nowhere else.
 *
 * The identity half: the per-participant aggregates are never projected, but
 * they ARE part of the artifact `source_sha256` binds to every published row —
 * so a scorecard spliced in from a different pass would make the canonical
 * record disagree with the rows citing it, permanently and silently. The gate
 * holds it to the same one-file-one-pass rule.
 *
 * The coverage half: `eligibleMarkets` is the OPPORTUNITY denominator, and no
 * scored_decision record can supply it. An arm that failed produced no pick, so
 * a denominator counted over picks is coverage computed over successes only —
 * the failure the run publisher's own contract names first ("a failed arm has
 * to be representable"). 073 names the same quantity on the database side as
 * `benchmark_arm_attempts.supplied_markets` at `attempt_ordinal = 0`, and the
 * scorer reaches it the same way: the supplied-market count summed over the
 * arm's dispatched games, one per pick for a control.
 */
const scorecardCoverageSchema = z
  .object({
    recordType: z.literal('participant_scorecard'),
    label: z.string().min(1),
    runId: z.string().min(1),
    scoredAt: z.string().min(1),
    scoringPolicyVersion: z.string().min(1),
    // WHO the opportunities belong to. Without it the scorecards are an
    // anonymous bag of numbers and the denominator is whatever they sum to:
    // measured on this branch, replacing a dispatched-but-scoreless arm's
    // scorecard with a duplicate of a surviving participant's kept the
    // declared `participantScorecards` count intact and quietly dropped that
    // arm's opportunities out of `eligible` — the exact survivor bias the
    // denominator exists to prevent.
    participantId: z.string().min(1),
    kind: z.enum(['model', 'baseline']),
    eligibleMarkets: z.number().int().nonnegative(),
    // The scorer's per-participant scoreable count, reconciled below against
    // the decisions the same file carries. It is what ties a scorecard to
    // records rather than letting it assert a number nothing corroborates.
    primaryScoreable: z.number().int().nonnegative(),
  })
  .passthrough();

/** The record types the current scorer writes. Anything else refuses the file:
 *  a scorer newer than this publisher may carry semantics this gate cannot
 *  judge, and publishing around an unknown record is publishing a partial view
 *  that looks complete. */
const KNOWN_RECORD_TYPES: ReadonlySet<string> = new Set([
  'scored_run_meta',
  'scored_decision',
  'participant_scorecard',
]);

export interface ScoredHeader {
  readonly runId: string;
  readonly cohortId: string;
  readonly slateDate: string;
  readonly label: string;
  readonly scoringPolicyVersion: string;
  readonly scoredAt: string;
  readonly ladderVersion: string;
  readonly ladderParamVersion: string;
}

/**
 * One gate-accepted scored artifact, as everything downstream sees it.
 *
 * Named because the cohort-scalar projection takes a LIST of these: a scoring
 * run is keyed (cohort, scoring policy version) while a scored artifact is per
 * RUN FILE, and a watch cohort is a DATE with one artifact per fired game.
 */
export interface ScoredArtifact {
  readonly header: ScoredHeader;
  /**
   * The gate's OWN parse of every scored_decision, handed onward so the
   * projector cannot disagree with the gate about what a record says. The
   * run path re-reads instead; here the gate already had to parse every
   * record to check identity coherence, and a second parse would only be a
   * second opinion.
   */
  readonly decisions: readonly ScoredDecisionRecord[];
  /** Summed over the file's participant_scorecard records — the opportunity
   *  denominator, including arms that were dispatched and produced nothing. */
  readonly eligibleMarkets: number;
  /** Which participants the file carries a scorecard for. The projector needs
   *  it to tell a complete denominator from one that is merely a sum. */
  readonly scorecardParticipants: readonly string[];
}

export type ScoredGate =
  | ({ readonly publishable: true } & ScoredArtifact)
  | { readonly publishable: false; readonly reason: string };

const describeIssue = (error: z.ZodError): string => {
  const issue = error.issues[0];
  return issue === undefined ? 'schema mismatch' : `${issue.path.join('.')}: ${issue.message}`;
};

/** Parse the NDJSON `yarn score` wrote. Malformed lines refuse, never skip. */
export function parseScoredArtifact(text: string): readonly JsonRecord[] {
  return parseNdjsonObjects(text, 'scored artifact');
}

/**
 * Whether a scored artifact may reach the projection at all.
 *
 * Every check reads the artifact, so a fresh publish and a republish of the
 * same file agree. Each one guards a write that could not be taken back:
 *
 *   meta count         counted on the RAW record list, before anything indexes
 *                      it — a second scored_run_meta shadowed by a first would
 *                      publish every row in the file under the wrong identity.
 *   sourceMode         a dry run scores mock forecasts fabricated under the
 *                      real model ids; published, they are indistinguishable
 *                      from measured CLV.
 *   integrityVerified  the scorer refuses to score a run that fails its
 *                      integrity check, so a scored file claiming otherwise
 *                      was not written by the scorer.
 *   cohortId           the same namespace rule as the run path, from the same
 *                      regex, so the two gates cannot drift.
 *   coherence          every scored_decision must agree with the meta record
 *                      on runId, label, policy version and scoredAt — one
 *                      file, one scoring pass, one identity.
 *   pick uniqueness    two rows for one (participant, game, market) cannot
 *                      both be the score of that pick; the file is ambiguous
 *                      and nothing in it should land.
 */
export function publishableScoredRun(records: readonly JsonRecord[]): ScoredGate {
  const no = (reason: string): ScoredGate => ({ publishable: false, reason });

  for (const [index, record] of records.entries()) {
    const recordType = record['recordType'];
    if (typeof recordType !== 'string' || !KNOWN_RECORD_TYPES.has(recordType)) {
      return no(`record ${index + 1} has an unknown recordType — a newer scorer wrote this file`);
    }
  }

  const metas = records.filter((record) => record['recordType'] === 'scored_run_meta');
  if (metas.length === 0) return no('the artifact carries no scored_run_meta record');
  if (metas.length > 1) {
    return no('the artifact carries two scored_run_meta records, so its identity is ambiguous');
  }

  const parsedMeta = scoredRunMetaSchema.safeParse(metas[0]);
  if (!parsedMeta.success) {
    return no(
      `scored_run_meta does not match the current scorer format (${describeIssue(parsedMeta.error)}) — re-score the run with the current scorer`,
    );
  }
  const meta = parsedMeta.data;

  if (meta.sourceMode !== 'live') return no('the scored run was not a live run');
  if (meta.integrityVerified !== true) {
    return no('the artifact does not claim integrityVerified, so the scorer did not write it');
  }
  if (!publishableCohortId(meta.cohortId)) return no('cohortId is outside the published namespace');

  // The file held to its OWN declared counts, on the raw record list — the
  // same cross-check the run artifact's canonical reader performs, for the
  // same measured reason: cutting trailing records otherwise turns a partial
  // pass into one that publishes cleanly, exits zero, and binds every row to
  // the truncated file's source_sha256 forever. Both counts, because
  // source_sha256 binds the WHOLE file: scorecards are never projected, but a
  // file missing them is not the canonical record its rows would cite.
  for (const [recordType, declared, field] of [
    ['scored_decision', meta.picks, 'picks'],
    ['participant_scorecard', meta.participantScorecards, 'participantScorecards'],
  ] as const) {
    const carried = records.filter((record) => record['recordType'] === recordType).length;
    if (carried !== declared) {
      return no(
        `the artifact declares ${field} = ${declared} but carries ${carried} ${recordType} ` +
          'record(s) — truncated, spliced, or not the scorer\'s output',
      );
    }
  }

  const decisions: ScoredDecisionRecord[] = [];
  const seen = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (record['recordType'] !== 'scored_decision') continue;
    const parsed = scoredDecisionSchema.safeParse(record);
    if (!parsed.success) {
      return no(
        `scored_decision record ${index + 1} does not match the current scorer format ` +
          `(${describeIssue(parsed.error)}) — re-score the run with the current scorer`,
      );
    }
    const decision = parsed.data;
    for (const [field, expected] of [
      ['runId', meta.runId],
      ['label', meta.label],
      ['scoringPolicyVersion', meta.scoringPolicyVersion],
      ['scoredAt', meta.scoredAt],
    ] as const) {
      if (decision[field] !== expected) {
        return no(`scored_decision record ${index + 1} disagrees with scored_run_meta on ${field}`);
      }
    }
    // The equivalence the projection turns into `refused`, enforced HERE
    // because nothing downstream can: the mapping derives `refused` from the
    // reason alone, the payload validator checks only refused<=>reason, and
    // the schema CHECK matches it — so a record carrying a refusal reason AND
    // a live CLV value would publish a refused row with numbers in it,
    // permanently, into standings queries that read NULL-ness as refusal. The
    // current scorer nulls both whenever it refuses; a file that says
    // otherwise was not written by it, whatever its other fields claim.
    if (
      decision.unscoredReason !== null &&
      (decision.primaryClvPct !== null || decision.marginAdjustedClvPct !== null)
    ) {
      return no(
        `scored_decision record ${index + 1} carries a refusal reason and a CLV value at once — ` +
          'the scorer never emits that pair, so the file is not its output',
      );
    }
    const key = `${decision.participantId} ${decision.gameId} ${decision.market}`;
    if (seen.has(key)) {
      return no(
        `two scored_decision records claim ${decision.participantId} / ${decision.gameId} / ` +
          `${decision.market} — the file is ambiguous about that pick`,
      );
    }
    seen.add(key);
    decisions.push(decision);
  }

  if (decisions.length === 0) return no('the artifact contains no scored decisions');

  // The file held to its OWN declared coverage, the same way it is already held
  // to its own declared record counts, and derived from the records rather than
  // read off the meta. A meta spliced from another pass, or records edited
  // under a meta that was not, disagrees here instead of quietly becoming the
  // cohort coverage a public read path serves.
  //
  // Both predicates are the scorer's, reproduced field for field:
  // `primaryScoreableCount` is `inPrimaryStratum && primaryClvPct !== null` and
  // `heldOutOfPrimary` is its complement on the stratum with the same value
  // conjunct — and the artifact carries `inPrimaryStratum` per record, so this
  // is a comparison rather than a second opinion about the stratum rule.
  const scored = decisions.filter((d) => d.inPrimaryStratum && d.primaryClvPct !== null).length;
  const heldOut = decisions.filter((d) => !d.inPrimaryStratum && d.primaryClvPct !== null).length;
  for (const [field, declared, derived] of [
    ['primaryScoreable', meta.primaryScoreable, scored],
    ['scheduleChangedExcluded', meta.scheduleChangedExcluded, heldOut],
  ] as const) {
    if (declared !== derived) {
      return no(
        `the artifact declares ${field} = ${declared} but its scored_decision records carry ` +
          `${derived} — spliced, edited, or not the scorer's output`,
      );
    }
  }

  // Scorecard records are tolerated and never projected AS AGGREGATES, but they
  // are part of the file `source_sha256` stamps on every published row — the
  // same one-file-one-pass rule holds them too, or the canonical record the
  // rows cite carries another pass's aggregates with nothing ever detecting it.
  // One number IS taken from them: `eligibleMarkets`, summed, because it is the
  // opportunity denominator and no other record in the file carries it.
  let eligibleMarkets = 0;
  const scorecards = new Map<string, number>();
  for (const [index, record] of records.entries()) {
    if (record['recordType'] !== 'participant_scorecard') continue;
    const parsed = scorecardCoverageSchema.safeParse(record);
    if (!parsed.success) {
      return no(
        `participant_scorecard record ${index + 1} does not match the current scorer format ` +
          `(${describeIssue(parsed.error)}) — re-score the run with the current scorer`,
      );
    }
    for (const [field, expected] of [
      ['runId', meta.runId],
      ['label', meta.label],
      ['scoringPolicyVersion', meta.scoringPolicyVersion],
      ['scoredAt', meta.scoredAt],
    ] as const) {
      if (parsed.data[field] !== expected) {
        return no(`participant_scorecard record ${index + 1} disagrees with scored_run_meta on ${field}`);
      }
    }
    // ONE scorecard per participant. A duplicate would double that
    // participant's opportunities AND — because the meta's declared
    // scorecard count still matches — silently take some other participant's
    // out of the sum. Measured on this branch before the check existed:
    // swapping a scoreless arm's scorecard for a copy of a surviving one
    // dropped `eligible` from 6 to 4 and the gate accepted the file.
    if (scorecards.has(parsed.data.participantId)) {
      return no(
        `two participant_scorecard records claim ${parsed.data.participantId} — the coverage ` +
          'denominator would count one participant twice and another not at all',
      );
    }
    scorecards.set(parsed.data.participantId, parsed.data.primaryScoreable);
    eligibleMarkets += parsed.data.eligibleMarkets;
  }

  // Every participant that took a pick must have a scorecard, and that
  // scorecard's own scoreable count must be the one its records add up to.
  // This is what stops the denominator being an unattached number: a scorecard
  // that cannot be reconciled against the decisions beside it is not evidence
  // about coverage. (A participant with a scorecard and NO decisions is the
  // point of the denominator — a dispatched arm that produced nothing — so it
  // is required to reconcile to zero, not required to be absent.)
  const scoreableByParticipant = new Map<string, number>();
  for (const decision of decisions) {
    const current = scoreableByParticipant.get(decision.participantId) ?? 0;
    const adds = decision.inPrimaryStratum && decision.primaryClvPct !== null ? 1 : 0;
    scoreableByParticipant.set(decision.participantId, current + adds);
  }
  // ⚠ PRESENCE is NOT required here — a scorecard-less file is still a
  //   perfectly publishable set of SCORES, and this gate serves that path too.
  //   `projectScoringRun` requires presence, because that is where the
  //   opportunity denominator is built and where a missing scorecard is a hole.
  // OVER THE SCORECARDS, not over the decisions. A scorecard for a participant
  // with NO decisions is the whole point of the denominator — a dispatched arm
  // that produced nothing — so it must reconcile to ZERO rather than being
  // skipped for having nothing to compare against. Iterating the decisions
  // instead left exactly that participant unchecked: a reviewer found a
  // scorecard-only arm declaring primaryScoreable = 7 accepted, against a
  // comment three lines up that said it had to reconcile to zero.
  for (const [participantId, declared] of scorecards) {
    const derived = scoreableByParticipant.get(participantId) ?? 0;
    if (declared !== derived) {
      return no(
        `${participantId}'s scorecard declares primaryScoreable = ${declared} but its ` +
          `scored_decision records carry ${derived}`,
      );
    }
  }

  // ⚠ NOT checked here: whether that sum is a plausible denominator for the
  //   picks. It is checked in `projectScoringRun`, because this gate also
  //   admits the PER-PICK path, and refusing the whole file over an
  //   opportunity denominator would block scores whose own rows are perfectly
  //   publishable. A defect in a number only one of two consumers reads
  //   belongs to that consumer.
  return {
    publishable: true,
    eligibleMarkets,
    scorecardParticipants: [...scorecards.keys()],
    header: {
      runId: meta.runId,
      cohortId: meta.cohortId,
      slateDate: meta.slateDate,
      label: meta.label,
      scoringPolicyVersion: meta.scoringPolicyVersion,
      scoredAt: meta.scoredAt,
      ladderVersion: meta.ladder.version,
      ladderParamVersion: meta.ladder.parameterVersion,
    },
    decisions,
  };
}

/**
 * Map gate-accepted records onto `DecisionScore` payloads. Total by
 * construction: the gate validated every field this touches.
 *
 * The one non-obvious name translation: the artifact's `primaryClvPct` IS the
 * economic CLV — "primary" names its place in the methodology (the vig-in
 * headline metric), and `economic_clv_pct` is the same number under the
 * column's name. `marginAdjustedClvPct` crosses unrenamed.
 *
 * `refused` is the equivalence the schema CHECK states: a row is refused
 * exactly when it carries an unscored reason. `heldOutOfPrimary` is the
 * negation of the artifact's stratum membership — today that means an
 * affirmative or undeterminable-with-value schedule change, and the projection
 * takes the artifact's verdict rather than re-deriving the stratum rule.
 *
 * The ladder version pair is stamped from the run-level meta onto every row:
 * it records which ladder the scoring pass ran, which is a fact about the
 * pass, not about whether this pick's market consulted it.
 */
export function projectScoredRun(
  header: ScoredHeader,
  decisions: readonly ScoredDecisionRecord[],
  source: SourceRef,
): DecisionScore[] {
  return decisions.map((record) => ({
    decision: {
      cohortId: header.cohortId,
      participantId: record.participantId,
      gameId: record.gameId,
      market: record.market,
    },
    runId: record.runId,
    label: record.label,
    scoringPolicyVersion: record.scoringPolicyVersion,
    economicClvPct: record.primaryClvPct,
    marginAdjustedClvPct: record.marginAdjustedClvPct,
    devigMethod: record.devigMethod,
    ladderVersion: header.ladderVersion,
    ladderParamVersion: header.ladderParamVersion,
    refused: record.unscoredReason !== null,
    refusalReason: record.unscoredReason,
    scheduleChanged: record.scheduleChanged,
    heldOutOfPrimary: !record.inPrimaryStratum,
    closeDecimalSelected:
      record.closing === null
        ? null
        : record.side === 'away'
          ? record.closing.awayDecimal
          : record.closing.homeDecimal,
    closeDecimalOpposing:
      record.closing === null
        ? null
        : record.side === 'away'
          ? record.closing.homeDecimal
          : record.closing.awayDecimal,
    closeLine: record.closing === null ? null : record.closing.line,
    lineMovementFavorable: record.lineMovementFavorable,
    scoredAt: record.scoredAt,
    source,
  }));
}

// ---------------------------------------------------------------------------
// The cohort-scalar scoring run
// ---------------------------------------------------------------------------

/**
 * The publication brake, as an operator states it.
 *
 * `benchmark_scoring_runs.ranking_allowed` is NOT NULL and 073 calls it a
 * first-class field rather than a note: a read path that serves CLV without it
 * lets a UI render a ranking the methodology forbids, and a NULL there must be
 * read as false. Nothing in an artifact can decide it — whether a sample
 * supports a ranking is a methodology judgment about the cohort — so it is
 * supplied, and it defaults to closed.
 */
export interface RankingDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * The default: closed, with the reason the work order specifies, verbatim.
 *
 * The row is INSERT-ONCE with no UPDATE grant, so publishing it is a one-shot
 * act per (cohort, scoring policy version) — opening the gate afterwards is an
 * owner-side correction, exactly as for a reveal. Measured on PostgreSQL 17.10:
 * republishing the same row with `ranking_allowed` flipped is refused as a
 * contradiction naming that field, which is the loud version of a lever that
 * used to report success and change nothing.
 */
export const RANKING_WITHHELD: RankingDecision = Object.freeze({
  allowed: false,
  reason: 'label: watch-v0 pending operator publication decision',
});

export type ScoringRunProjection =
  | { readonly publishable: true; readonly run: ScoringRun }
  | { readonly publishable: false; readonly reason: string };

/** ISO-8601 with an explicit offset, as `new Date().toISOString()` writes it.
 *  Checked here because MAX needs an order and `Date.parse` answers NaN
 *  silently — the gate's own `scoredAt` check is only "a non-empty string". */
function instantMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Project one cohort's scored artifacts onto its single coverage-and-brake row.
 *
 * ── WHY IT TAKES A LIST ──────────────────────────────────────────────────────
 * `benchmark_scoring_runs` is keyed `(cohort_id, scoring_policy_version)` while
 * a scored artifact is per RUN FILE, and the two grains are 1:N by construction:
 * `fireEligibleGame` mints `runId = watch-v0-<date>-<hex>` inside
 * `cohortId = watch-v0-<date>` once per fired game, so a fifteen-game slate is
 * fifteen artifacts under one cohort. A per-artifact producer would write the
 * first game's coverage and report every later game as a benign duplicate — the
 * whole day's published coverage frozen to whichever game fired first.
 *
 * So the caller supplies the artifacts it means to summarise, and this refuses
 * anything that is not one coherent cohort. Nothing here can know whether the
 * SET is complete — that is the operator's statement, and it is why the row is
 * published deliberately rather than as a side effect of publishing scores.
 *
 * ⚠ AN EARLIER VERSION OF THIS COMMENT ARGUED THAT AN INCOMPLETE SET WAS SAFE
 *   because a later, larger one would be refused as a contradiction. That is
 *   backwards, and a reviewer reproduced it: the row is INSERT-ONCE, so the
 *   partial row is the one that lands and the one a read path serves, and the
 *   drift check then refuses the CORRECT set. Everything upstream of here is
 *   therefore all-or-nothing — the publisher writes no cohort row unless every
 *   named artifact passed the gate and every artifact's scores published in
 *   full — and the drift check is what catches a LATER pass disagreeing, not a
 *   licence to publish a partial one now.
 *
 * ── EVERY VALUE IS A PURE FUNCTION OF THE ARTIFACTS' BYTES ───────────────────
 * The same rule the scored path runs under, so a fresh publish and a recovery
 * republish over the same files are the same call. `ranking` is the one input
 * from outside, and it is the operator's own statement rather than a clock read
 * or an environment read.
 */
export function projectScoringRun(
  artifacts: readonly ScoredArtifact[],
  ranking: RankingDecision,
  source: SourceRef,
): ScoringRunProjection {
  const no = (reason: string): ScoringRunProjection => ({ publishable: false, reason });

  if (artifacts.length === 0) return no('no scored artifacts were supplied');

  const first = artifacts[0]!.header;
  const runIds = new Set<string>();
  for (const { header } of artifacts) {
    // One cohort and one policy version, because those two ARE the row's key. A
    // mixed set would publish one cohort's numbers under the other's name, and
    // the write could not tell: the key it lands on is whichever header
    // happened to be read first.
    if (header.cohortId !== first.cohortId) {
      return no(
        `the artifacts span two cohorts (${first.cohortId} and ${header.cohortId}) — a scoring ` +
          'run is one cohort',
      );
    }
    if (header.scoringPolicyVersion !== first.scoringPolicyVersion) {
      return no(
        `the artifacts span two scoring policy versions (${first.scoringPolicyVersion} and ` +
          `${header.scoringPolicyVersion}) — a rescore under a new version is its own row`,
      );
    }
    // The same run twice doubles every count, and naming both a file and its
    // copy, or expanding two overlapping globs, is the ordinary way it happens.
    if (runIds.has(header.runId)) {
      return no(`run ${header.runId} was supplied twice, which would double-count its picks`);
    }
    runIds.add(header.runId);
    if (instantMs(header.scoredAt) === null) {
      return no(`run ${header.runId} carries an unparseable scoredAt (${header.scoredAt})`);
    }
  }

  // A DENOMINATOR IS ONLY COMPLETE IF EVERY ARM IT SHOULD COUNT IS IN IT.
  // The sum is over scorecards, so an artifact missing one silently drops that
  // arm's opportunities — survivor bias, which is the one thing `eligible`
  // exists to prevent. Required here rather than in the gate: a scorecard-less
  // file is still a publishable set of SCORES, and the gate serves that path.
  for (const artifact of artifacts) {
    const carried = new Set(artifact.scorecardParticipants);
    for (const decision of artifact.decisions) {
      if (carried.has(decision.participantId)) continue;
      return no(
        `run ${artifact.header.runId} carries picks for ${decision.participantId} but no ` +
          'participant_scorecard for it, so the opportunity denominator is missing an arm',
      );
    }
    if (artifact.decisions.length > 0 && carried.size === 0) {
      return no(`run ${artifact.header.runId} carries no participant_scorecard at all`);
    }
  }

  let eligible = 0;
  let scored = 0;
  let refused = 0;
  let scheduleHeldOut = 0;
  let picks = 0;
  const refusalReasons: Record<string, number> = {};
  for (const artifact of artifacts) {
    eligible += artifact.eligibleMarkets;
    picks += artifact.decisions.length;
    for (const decision of artifact.decisions) {
      if (decision.unscoredReason !== null) {
        refused += 1;
        refusalReasons[decision.unscoredReason] =
          (refusalReasons[decision.unscoredReason] ?? 0) + 1;
        continue;
      }
      // Neither refused nor valued: left out of all three buckets on purpose,
      // and caught by the partition check below rather than absorbed.
      if (decision.primaryClvPct === null) continue;
      if (decision.inPrimaryStratum) scored += 1;
      else scheduleHeldOut += 1;
    }
  }

  // THE PARTITION, asserted rather than assumed. `unscoredReason === null`
  // implies a primary value on every path the scorer can take — `scoreDecision`
  // either refuses with a reason and nulls both metrics, or fills them — so a
  // pick in no bucket means the file is not the scorer's output. The scorer
  // models the same residual and calls it `unexplained`; folding it silently
  // into `refused` would publish a refusal count with no reason behind it, into
  // a column a public read path divides by.
  const unexplained = picks - scored - refused - scheduleHeldOut;
  if (unexplained !== 0) {
    return no(
      `${unexplained} pick(s) carry neither a refusal reason nor a primary CLV value — the ` +
        'coverage columns would not account for them',
    );
  }

  // An opportunity denominator below the picks taken against it is not a small
  // discrepancy; it is a denominator that cannot be what it says, and this row
  // is insert-once, so it is refused rather than clamped. Checked HERE and not
  // in the artifact gate: the gate also admits the per-pick path, where this
  // number is not read at all.
  if (eligible < picks) {
    return no(
      `the scorecards sum to ${eligible} eligible market(s) across ${artifacts.length} ` +
        `artifact(s) while they carry ${picks} pick(s) — the opportunity denominator cannot be ` +
        'smaller than the picks taken against it',
    );
  }

  return {
    publishable: true,
    run: {
      cohortId: first.cohortId,
      scoringPolicyVersion: first.scoringPolicyVersion,
      // The OPPORTUNITY denominator: supplied markets over dispatched arm-games,
      // so an arm that failed stays in it. `eligible - picks` is exactly the
      // opportunities that produced no decision.
      eligible,
      // In the primary stratum AND carrying a value — `primaryScoreableCount`.
      scored,
      // Refused by a close-quality or selection gate, tagged or not.
      refused,
      // What the reschedule tag actually REMOVED from the primary estimate:
      // tagged AND carrying a value, which is the scorer's own
      // `heldOutOfPrimary`. ⚠ NOT the same population as
      // `benchmark_scores.held_out_of_primary`, which is the raw stratum tag and
      // is therefore also true on tagged rows an earlier gate had refused. A
      // read path reproducing this scalar wants
      // `count(*) filter (where held_out_of_primary and not refused)`.
      scheduleHeldOut,
      refusalReasons,
      rankingAllowed: ranking.allowed,
      rankingReason: ranking.reason,
      // No artifact measures cost, so this pass establishes nothing about
      // whether cost per pick is comparable across entrants. NULL says that;
      // `false` would be a claim.
      costPerPickComparable: null,
      // Absent from the scored artifact, and deliberately not resolved here.
      // `resolveBenchmarkCommit()` reads the machine that happens to be
      // publishing, which is not the build that produced these scores, and it
      // would break the property that a republish is the same call over the
      // same bytes — the reasoning `benchmarkCommit.ts` gives for stamping the
      // value into the run artifact instead. A reader who wants it joins
      // `benchmark_runs.benchmark_commit` on the cohort.
      benchmarkCommit: null,
      // The latest pass over the set: the instant by which all of these had been
      // scored. Outside the write's drift comparison, so a re-scored file moving
      // it does not close the recovery republish.
      scoredAt: new Date(
        Math.max(...artifacts.map(({ header }) => instantMs(header.scoredAt) ?? 0)),
      ).toISOString(),
      source,
    },
  };
}
