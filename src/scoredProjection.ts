import { z } from 'zod';
import { parseNdjsonObjects, publishableCohortId } from './servingProjection.js';
import type { JsonRecord } from './servingProjection.js';
import type { DecisionScore, SourceRef } from './servingStore.js';

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
 * The identity fields a participant_scorecard record shares with the pass. It
 * is never projected, but it IS part of the artifact `source_sha256` binds to
 * every published row — so a scorecard spliced in from a different pass would
 * make the canonical record disagree with the rows citing it, permanently and
 * silently. The gate holds it to the same one-file-one-pass rule.
 */
const scorecardIdentitySchema = z
  .object({
    recordType: z.literal('participant_scorecard'),
    label: z.string().min(1),
    runId: z.string().min(1),
    scoredAt: z.string().min(1),
    scoringPolicyVersion: z.string().min(1),
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

export type ScoredGate =
  | {
      readonly publishable: true;
      readonly header: ScoredHeader;
      /**
       * The gate's OWN parse of every scored_decision, handed onward so the
       * projector cannot disagree with the gate about what a record says. The
       * run path re-reads instead; here the gate already had to parse every
       * record to check identity coherence, and a second parse would only be a
       * second opinion.
       */
      readonly decisions: readonly ScoredDecisionRecord[];
    }
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

  // Scorecard records are tolerated and never projected, but they are part of
  // the file `source_sha256` stamps on every published row — the same
  // one-file-one-pass rule holds them too, or the canonical record the rows
  // cite carries another pass's aggregates with nothing ever detecting it.
  for (const [index, record] of records.entries()) {
    if (record['recordType'] !== 'participant_scorecard') continue;
    const parsed = scorecardIdentitySchema.safeParse(record);
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
  }

  return {
    publishable: true,
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
