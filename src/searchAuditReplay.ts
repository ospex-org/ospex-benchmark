import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describeErrorWithStack } from './config.js';
import { printError, printLine } from './console.js';
import { canonicalize } from './canonical.js';
import {
  extractAnthropicSearchAudit,
  extractGoogleSearchAudit,
  extractResponsesSearchAudit,
} from './providers/searchAudit.js';
import {
  archiveEraSignals,
  envelopeVerificationFailures,
  isCoherentPreRetentionArchive,
  receivedProviderResponse,
  recordsHttpStatus,
  responseEnvelopeSchema,
} from './providers/responseEnvelope.js';
import type { ReceiptSignals } from './providers/responseEnvelope.js';
import type { ProviderResponseEnvelope, SearchAudit } from './types.js';

/**
 * OFFLINE REPLAY of the web-search audit, against retained response envelopes.
 *
 * This is the half of #92 that makes retention worth anything. A run's
 * `searchAudit` is whatever the extractor of the day made of the response; when
 * a provider ships a shape that extractor does not recognize, the audit comes
 * back empty and is indistinguishable from a model that did not search. With
 * the complete body retained, the extraction can be run AGAIN — on a newer
 * parser, months later — and the difference is visible.
 *
 * The replay reads only the archived file. It opens no socket, calls no
 * provider, and re-bills nothing.
 *
 * The envelope's digest is checked before its body is parsed: an envelope that
 * does not reproduce its own digest is reported as `digest-mismatch` and its
 * body is NOT extracted, because a body that has been altered is not evidence
 * about the call it claims to describe.
 */

export type SearchAuditExtractor = (json: unknown) => SearchAudit | null;

/**
 * The current extractor per provider, keyed by the `provider` an
 * `arm_game_response` records. The Responses-API extractor serves both
 * providers that use that surface.
 */
export const CURRENT_EXTRACTORS: Readonly<Record<string, SearchAuditExtractor>> = Object.freeze({
  google: extractGoogleSearchAudit,
  anthropic: extractAnthropicSearchAudit,
  openai: extractResponsesSearchAudit,
  xai: extractResponsesSearchAudit,
});

/**
 * The record types `src/records.ts` writes into a harness run file, MINUS
 * `run_meta` itself — the markers whose presence means "this IS a run file, so
 * it owes exactly one `run_meta`".
 *
 * Taken from the PRODUCER, not from the scorer's reader. `records.ts` is the
 * only module that writes any of these, whereas `parseRunRecords`'s switch ends
 * in `default: break` — the scorer TOLERATES record types it does not know, so
 * its cases are recognition markers rather than a closed vocabulary. The drift
 * test in `searchAuditReplay.test.ts` re-derives this set from `records.ts` and
 * reddens if that file gains or loses one.
 *
 * Why a SET and not "some recordType is present": every other producer in this
 * repo writes its own families into the same directory — `scored_run_meta` and
 * `participant_scorecard` from the scorer, `close_schedule_audit*` from the
 * schedule audit, `retrosheet_*`, `inhouse_totals_meta`, `closing_total` — and
 * those must stay silent at exit 0. Only these six say "a run wrote this".
 */
export const RUN_RECORD_TYPES: ReadonlySet<string> = new Set([
  'arm_game_response',
  'baseline_decision',
  'bundle_game',
  'decision',
  'excluded_game',
  'run_failure',
]);

/**
 * The counts a run file declares about ITSELF, mapped to the record type each
 * one counts. `records.ts` writes all four into `run_meta` unconditionally.
 *
 * This is what gives an NDJSON file a length header. Identity (`run_meta`
 * present, exactly once) says the file is a run; these say the file is WHOLE.
 * They are an INDEPENDENT witness rather than a restatement: `records.ts`
 * computes each from the run context at write time — the slate, the excluded
 * list, the results array — not from the record array a reader would be
 * counting. A reader comparing them is comparing two derivations, which is the
 * only kind of cross-check worth having.
 *
 * Three of the four are REQUIRED by the scorer's own `runMetaSchema`, so a
 * `run_meta` lacking them is a hand edit rather than an era. `excludedGames` is
 * the exception, and the drift test holds it.
 */
export const RUN_MANIFEST_COUNTS: ReadonlyMap<string, string> = new Map([
  ['eligibleGames', 'bundle_game'],
  ['armGameResults', 'arm_game_response'],
  ['baselineDecisionCount', 'baseline_decision'],
  ['excludedGames', 'excluded_game'],
]);

/** Why an attempt could not be replayed, or that it could. */
export type ReplayEnvelopeState =
  | 'retained'
  /**
   * No envelope, and none was owed: the file predates retention, or nothing
   * came back on this leg. The honest word for an archive, and it is not a
   * failure.
   */
  | 'unavailable'
  /**
   * No envelope on a leg that RECEIVED a response, in a file that is not a
   * pre-retention archive. Evidence that existed and was not kept — the same
   * reading the scorer gives the same bytes, and reported apart from
   * `unavailable` because before this the tool said "there was nothing to see"
   * about a leg the scorer refused.
   */
  | 'unretained'
  /**
   * An envelope is PRESENT but is not one: a missing or wrong-typed `body`,
   * `sha256` or `bytes`, a `sha256` that is not 64 lowercase hex, a fractional
   * or negative `bytes`, or a key the record has no business carrying.
   * Reported apart from `unavailable`, because "we could not read this" and
   * "there was nothing to read" are the two readings #92 exists to keep apart,
   * and collapsing them here would reintroduce the conflation one layer down.
   * Both readers apply the SAME `responseEnvelopeSchema`, imported from one
   * module, so a shape the scorer refuses is a shape this reports.
   */
  | 'malformed'
  /** An envelope is present but its stored body does not reproduce its digest. */
  | 'digest-mismatch'
  /** The retained body is not parseable JSON. */
  | 'unparseable'
  /** No extractor is registered for this record's provider. */
  | 'no-extractor';

/**
 * How each state is treated: `clean` states are silent and exit 0, everything
 * else is printed and makes the command exit non-zero.
 *
 * The `Record<ReplayEnvelopeState, …>` type is the point. Adding a state to the
 * union without classifying it here is a compile error rather than a state that
 * silently defaults to "fine", and the counts, the `--quiet` filter and the
 * exit code all read this one map, so they cannot drift apart.
 */
const STATE_DISPOSITION: Record<ReplayEnvelopeState, 'clean' | 'unretained' | 'unreadable'> = {
  retained: 'clean',
  unavailable: 'clean',
  unretained: 'unretained',
  malformed: 'unreadable',
  'digest-mismatch': 'unreadable',
  unparseable: 'unreadable',
  'no-extractor': 'unreadable',
};

/** Every state, derived from the map above rather than listed a second time. */
export const REPLAY_ENVELOPE_STATES = Object.keys(STATE_DISPOSITION) as ReplayEnvelopeState[];

/** Whether a state makes the command exit non-zero (and print under `--quiet`). */
export function isBlockingState(state: ReplayEnvelopeState): boolean {
  return STATE_DISPOSITION[state] !== 'clean';
}

export interface ReplayLeg {
  participantId: string;
  gameId: string;
  leg: 'attempt' | 'repair';
  provider: string;
  envelope: ReplayEnvelopeState;
  /** The audit the run recorded at the time. */
  archivedAudit: SearchAudit | null;
  /** The audit re-derived now; `null` when the body could not be replayed. */
  replayedAudit: SearchAudit | null;
  /**
   * Whether the re-derived audit DIFFERS from the archived one — the signal a
   * parser update recovered (or lost) evidence. `false` when nothing was
   * replayed, which is reported separately as the envelope state.
   */
  changed: boolean;
}

export interface ReplayReport {
  runId: string | null;
  /** The run's evidence-era stamp; `null` on a file written before retention. */
  evidenceEra: string | null;
  /** Whether the WHOLE FILE reads as a coherent pre-retention archive — the one
   *  shape whose missing envelopes are `unavailable` rather than `unretained`. */
  preRetentionArchive: boolean;
  /**
   * Whether the file was recognised as a harness RUN file at all — a record
   * carrying `recordType: 'run_meta'`, the same marker `parseRunRecords`
   * requires. When false no leg was collected and NO envelope verdict is given:
   * `preRetentionArchive` is `false` because the archive predicate was never
   * asked, not because the file was asked and failed.
   */
  isRunFile: boolean;
  legs: ReplayLeg[];
  counts: {
    retained: number;
    unavailable: number;
    unretained: number;
    unreadable: number;
    changed: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reading an envelope has THREE outcomes, not two. A record that carries no
 * envelope key at all is a file that predates retention, a leg that received
 * nothing, or evidence that was thrown away; a record carrying something under
 * that key which is not an envelope is damaged evidence. Returning one null for
 * both is what made the tool report a hand-edited artifact as "nothing to see
 * here" at exit 0.
 *
 * The malformed test is `responseEnvelopeSchema` itself — the same object the
 * scorer parses with — rather than a local approximation of it.
 */
type EnvelopeRead =
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'envelope'; envelope: ProviderResponseEnvelope };

function readEnvelope(value: unknown): EnvelopeRead {
  if (value === undefined || value === null) return { kind: 'absent' };
  const parsed = responseEnvelopeSchema.safeParse(value);
  if (!parsed.success) return { kind: 'malformed' };
  return { kind: 'envelope', envelope: parsed.data };
}

function readAudit(value: unknown): SearchAudit | null {
  const record = asRecord(value);
  if (record === null) return null;
  return record as unknown as SearchAudit;
}

/** The receipt fields, read off the raw leg. Both answer names are consulted,
 *  because an archive carries the pre-#92 one — and the status key's PRESENCE
 *  is read as well as its value, because deleting it is an edit, not an era. */
function receiptSignals(attempt: Record<string, unknown>): ReceiptSignals {
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    answerText: text(attempt['answerText']) ?? text(attempt['rawResponse']),
    reportedModelId: text(attempt['reportedModelId']),
    providerResponseId: text(attempt['providerResponseId']),
    httpStatus: typeof attempt['httpStatus'] === 'number' ? attempt['httpStatus'] : null,
    httpStatusRecorded: recordsHttpStatus(attempt),
    errorDetail: text(attempt['errorDetail']),
  };
}

/** One archived leg, before anything is decided about it. */
interface RawLeg {
  participantId: string;
  gameId: string;
  leg: 'attempt' | 'repair';
  provider: string;
  attempt: Record<string, unknown>;
}

function replayLeg(
  raw: RawLeg,
  extractors: Readonly<Record<string, SearchAuditExtractor>>,
  preRetentionArchive: boolean,
): ReplayLeg {
  const { participantId, gameId, leg, provider, attempt } = raw;
  const archivedAudit = readAudit(attempt['searchAudit']);
  const base = { participantId, gameId, leg, provider, archivedAudit, replayedAudit: null, changed: false };
  const read = readEnvelope(attempt['responseEnvelope']);
  if (read.kind === 'malformed') return { ...base, envelope: 'malformed' };
  if (read.kind === 'absent') {
    // The same split the scorer makes, on the same two inputs: a file that owed
    // no envelopes, and a leg that received nothing, are `unavailable`. A leg
    // that received a response in a retaining-era file kept nothing, and the
    // scorer calls that a violation — so this cannot keep calling it "there was
    // nothing to read".
    const owed = !preRetentionArchive && receivedProviderResponse(receiptSignals(attempt));
    return { ...base, envelope: owed ? 'unretained' : 'unavailable' };
  }
  const envelope = read.envelope;
  // Before the body, its binding. An altered body is not evidence about the
  // call it names, so it is reported rather than extracted from.
  if (envelopeVerificationFailures(envelope).length > 0) {
    return { ...base, envelope: 'digest-mismatch' };
  }
  const extract = extractors[provider];
  if (extract === undefined) return { ...base, envelope: 'no-extractor' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope.body);
  } catch {
    return { ...base, envelope: 'unparseable' };
  }
  const replayedAudit = extract(parsed);
  return {
    ...base,
    envelope: 'retained',
    replayedAudit,
    // Canonical comparison: two audits that differ only in key order are the
    // same audit, and reporting that as a change would bury the real ones.
    changed: canonicalize(replayedAudit) !== canonicalize(archivedAudit),
  };
}

/**
 * Re-extract the search audit for every archived attempt in a run file.
 *
 * `extractors` defaults to the current per-provider parsers. Supplying a
 * different map is how a parser CHANGE is evaluated against evidence that was
 * already collected: run the new extractor over the old envelopes and read the
 * `changed` legs.
 */
export function replaySearchAudits(
  lines: readonly string[],
  options: { extractors?: Readonly<Record<string, SearchAuditExtractor>> } = {},
): ReplayReport {
  const extractors = options.extractors ?? CURRENT_EXTRACTORS;
  // TWO PASSES, because whether a missing envelope is owed is a property of the
  // whole file: every leg is collected first, the archive predicate is decided
  // once over all of them, and only then is any leg classified.
  const raw: RawLeg[] = [];
  let runId: string | null = null;
  let evidenceEraStamped = false;
  let evidenceEra: string | null = null;
  let runMetaCount = 0;
  let sawRecordType = false;
  let sawRunRecord = false;
  let runMeta: Record<string, unknown> | null = null;
  const recordCounts = new Map<string, number>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const record = asRecord(JSON.parse(trimmed));
    if (record === null) continue;
    const recordType = record['recordType'];
    if (typeof recordType === 'string') {
      sawRecordType = true;
      if (RUN_RECORD_TYPES.has(recordType)) sawRunRecord = true;
      recordCounts.set(recordType, (recordCounts.get(recordType) ?? 0) + 1);
    }
    if (recordType === 'run_meta') {
      runMetaCount += 1;
      runMeta = record;
      if (typeof record['runId'] === 'string') runId = record['runId'];
      // Presence, not type: a stamp of the wrong type is still a stamp, and
      // reading it as absent would hand a modern file the archive exemption.
      if (Object.hasOwn(record, 'evidenceEra')) evidenceEraStamped = true;
      if (typeof record['evidenceEra'] === 'string') evidenceEra = record['evidenceEra'];
      continue;
    }
    if (record['recordType'] !== 'arm_game_response') continue;
    const participantId = typeof record['participantId'] === 'string' ? record['participantId'] : '';
    const gameId = typeof record['gameId'] === 'string' ? record['gameId'] : '';
    const provider = typeof record['provider'] === 'string' ? record['provider'] : '';
    for (const name of ['attempt', 'repair'] as const) {
      const attempt = asRecord(record[name]);
      if (attempt === null) continue;
      raw.push({ participantId, gameId, leg: name, provider, attempt });
    }
  }
  // ⚠ SHAPE BEFORE VERDICT. Everything below this point is a property of a
  //   harness RUN file. Without this gate a file with no `arm_game_response`
  //   records collects zero legs, `isCoherentPreRetentionArchive` is VACUOUSLY
  //   true over them, and a fire artifact, a close-schedule audit, an empty file
  //   and `{}` all reported "PRE-RETENTION (envelopes unavailable), 0 replayed"
  //   at exit 0 — an evidence verdict about bytes that were never read as
  //   evidence, which is exactly the conflation this command exists to prevent.
  //
  //   THREE OUTCOMES, because they are three different mistakes:
  //
  //   - A stream carrying RUN RECORDS but not exactly one `run_meta` is a
  //     TRUNCATED OR AMBIGUOUS RUN FILE, and it blocks. A reviewer deleted only
  //     the `run_meta` line from a real 62-record run and an earlier version of
  //     this gate — which asked only whether ANY `recordType` was present —
  //     called the remainder a benign sibling at exit 0, silent under `--quiet`,
  //     hiding 15 replayable legs. Whole-record truncation must not be able to
  //     disguise run-shaped evidence as somebody else's file.
  //   - A record stream that is not THIS stream is a normal inhabitant of an
  //     evidence directory: `yarn score` writes `<runId>-scored.ndjson` beside
  //     its input by default, and `yarn audit:closes` writes into `out/` too.
  //     Name it, do NOT block — `--quiet out/*.ndjson` is the documented sweep
  //     and must stay silent at exit 0 where nothing is wrong. Measured: keying
  //     this gate on `run_meta` alone would refuse 5 files sitting in `out/`
  //     today and one more per scored run forever.
  //   - A file carrying no record stream at all was pointed at by mistake. That
  //     blocks, so it prints under `--quiet` and the exit code says so.
  //   ⚠ EXACTLY ONE, COUNTED — and validity beyond presence is deliberately NOT
  //     required here. A `run_meta` carrying no `runId` still reports its legs,
  //     under `run (unknown)`. That is not an oversight: this command's subject
  //     is the LEGS, and a damaged identity record hides none of them — the
  //     honest answer is the leg report plus "I do not know which run". Refusing
  //     it would throw away a readable evidence report over a cosmetic defect,
  //     and would make this reader stricter than the file shapes it exists to
  //     read. The scorer, whose subject IS the run, does strict-parse it.
  //     Measured: all 42 run files in `out/` carry a string `runId`, so nothing
  //     here rests on tolerating the damaged shape — only on not over-blocking.
  if (runMetaCount !== 1) {
    // `run_meta` counts as run-shaped in its own right, so TWO of them are
    // caught here too — the scorer refuses that as "identity is ambiguous", and
    // a file this reader cannot attribute to one run is not evidence about one.
    if (sawRunRecord || runMetaCount > 0) {
      throw new Error(
        `this is a harness run file carrying ${String(runMetaCount)} run_meta records, not exactly one ` +
          '(run records are present, so a missing or duplicated run_meta is a truncated or ' +
          'ambiguous run file, not another stream)',
      );
    }
    if (!sawRecordType) {
      throw new Error(
        'no NDJSON record carried a recordType, so this is not a harness run file ' +
          '(a fire artifact is a single JSON object — verify one with `yarn verify:sidecar`)',
      );
    }
    return {
      runId: null,
      evidenceEra: null,
      preRetentionArchive: false,
      isRunFile: false,
      legs: [],
      counts: { retained: 0, unavailable: 0, unretained: 0, unreadable: 0, changed: 0 },
    };
  }
  // ⚠ COMPLETENESS, AFTER IDENTITY. The gate above catches a run file that lost
  //   its `run_meta`; this catches one that KEPT it and lost the records.
  //
  //   Measured on a real 62-record run, truncating at line boundaries from the
  //   end: the leg count walked 15 → 14 → 12 → 9 → 2 → 0 with exit 0 and ZERO
  //   bytes under `--quiet` at every rung. On the era-stamped run it printed
  //   "evidence era response-envelope-v1, 0 replayed, 0 unretained, 0
  //   unreadable" — an affirmative clean verdict, carrying a REAL runId, on a
  //   file that had lost all 15 legs. That is the same output this file's own
  //   fire-artifact case asserts must never appear.
  //
  //   Only the shape gate can carry this. Every blocking signal below is
  //   PER-LEG (`blocking += counts.unreadable + counts.unretained`), so a file
  //   with zero legs cannot block — and deleting evidence is the one corruption
  //   that makes a file QUIETER.
  //
  //   The manifest is an INDEPENDENT witness (3d-witness): `records.ts` computes
  //   these four from the run context at write time — the slate, the excluded
  //   list, the results array — not from the record array this reader counts.
  //
  //   ABSENCE BLOCKS (rule 3k — a skip is an opt-out unless the skipped case is
  //   unreachable). `records.ts` writes all four unconditionally and three are
  //   required by the scorer's own schema, so a `run_meta` without them is a
  //   hand edit, not an era. That also closes the cheapest bypass of the gate
  //   above: appending a bare `{"recordType":"run_meta"}` to a truncated run
  //   restored it to exit 0 before this existed.
  //
  //   NO FLOOR IS IMPOSED. A run where every arm failed identity binding
  //   legitimately declares `armGameResults: 0` and carries no arm records, and
  //   passes. Measured: 42/42 run files in `out/` carry all four fields and all
  //   four agree exactly, so this costs the documented sweep nothing.
  const incomplete: string[] = [];
  for (const [field, recordType] of RUN_MANIFEST_COUNTS) {
    const meta = runMeta ?? {};
    if (!Object.hasOwn(meta, field)) {
      incomplete.push(`run_meta declares no ${field}`);
      continue;
    }
    const declared = meta[field];
    const actual = recordCounts.get(recordType) ?? 0;
    if (declared !== actual) {
      incomplete.push(
        `run_meta says ${String(declared)} ${field} but ${String(actual)} ${recordType} records survive`,
      );
    }
  }
  if (incomplete.length > 0) {
    throw new Error(
      `this run file is incomplete: ${incomplete.join('; ')} ` +
        '(records were deleted after the run wrote it, so any envelope verdict would describe ' +
        'a subset of the evidence without saying so)',
    );
  }
  const preRetentionArchive = isCoherentPreRetentionArchive({
    evidenceEraStamped,
    legs: raw.map((entry) => archiveEraSignals(entry.attempt)),
  });
  const legs = raw.map((entry) => replayLeg(entry, extractors, preRetentionArchive));
  const withDisposition = (kind: 'unretained' | 'unreadable'): number =>
    legs.filter((leg) => STATE_DISPOSITION[leg.envelope] === kind).length;
  return {
    runId,
    evidenceEra,
    preRetentionArchive,
    isRunFile: true,
    legs,
    counts: {
      retained: legs.filter((l) => l.envelope === 'retained').length,
      unavailable: legs.filter((l) => l.envelope === 'unavailable').length,
      unretained: withDisposition('unretained'),
      unreadable: withDisposition('unreadable'),
      changed: legs.filter((l) => l.changed).length,
    },
  };
}

const USAGE = `usage: yarn replay:search-audit [--quiet] <run.ndjson> [more.ndjson ...]

Re-extract each attempt's web-search audit from the provider response envelope
the run retained, and report where the result differs from what the run
recorded. Reads the named files and nothing else -- no provider is called and
nothing is billed.

A file written before envelope retention (no evidence-era stamp, every answer
under the old "rawResponse" name, no responseEnvelope key anywhere) reports
every attempt as envelope-unavailable at exit 0; that is the honest answer for
an archive, not a failure. In any other file, a leg that received a response
and retained nothing is "unretained" -- the same reading the scorer gives the
same bytes.

  --quiet  print only the legs that make this command exit non-zero, one line
           each, prefixed with their file. Prints nothing when all is well.

Exit codes:
  0  nothing to report
  1  at least one leg is unretained, or an envelope is present but unreadable
     (not a well-formed envelope, digest mismatch, unparseable body, or no
     extractor for its provider), or a named file could not be read or is not a
     record file at all. A record stream that is simply not THIS one -- a
     scored-run sibling, a close-schedule audit -- is named at exit 0 instead,
     so pointing this at a directory of evidence stays quiet when nothing is
     wrong.
  2  usage -- no files given, or a named file does not exist`;

export const REPLAY_EXIT = Object.freeze({ ok: 0, blocking: 1, usage: 2 });

function describeAudit(audit: SearchAudit | null): string {
  if (audit === null) return 'none';
  const gaps = audit.incomplete.length === 0 ? 'complete' : `${audit.incomplete.length} gap(s)`;
  return `${audit.queries.length} query/ies, ${audit.results.length} result(s), count ${audit.searchCount ?? 'unknown'}, ${gaps}`;
}

export function runReplayMain(deps: {
  argv: readonly string[];
  exists: (path: string) => boolean;
  read: (path: string) => string;
  log: { line: (text: string) => void; error: (text: string) => void };
}): number {
  const files = deps.argv.filter((arg) => !arg.startsWith('-'));
  const quiet = deps.argv.includes('--quiet');
  if (files.length === 0) {
    deps.log.error(USAGE);
    return REPLAY_EXIT.usage;
  }
  let blocking = 0;
  for (const file of files) {
    if (!deps.exists(file)) {
      deps.log.error(`no such file: ${file}`);
      return REPLAY_EXIT.usage;
    }
    let report: ReplayReport;
    try {
      report = replaySearchAudits(deps.read(file).split('\n'));
    } catch (error: unknown) {
      // A file that cannot be read or parsed is a finding, not a crash: naming
      // it and carrying on is what lets one command be pointed at a whole
      // evidence directory. It counts as blocking, so the exit code still says
      // something went wrong.
      deps.log.line(`${file}: unreadable run file: ${error instanceof Error ? error.message : String(error)}`);
      blocking += 1;
      continue;
    }
    if (!quiet) {
      if (!report.isRunFile) {
        // No era line and no counts: both would be verdicts about a file this
        // command did not read as evidence, and printing "0 replayed" beside
        // an era is what made a fire artifact look like a clean archive.
        deps.log.line(`${file}: not a harness run file (no run_meta record); no envelope verdict`);
      } else {
        deps.log.line(
          `${file}: run ${report.runId ?? '(unknown)'}, evidence era ${report.evidenceEra ?? (report.preRetentionArchive ? 'PRE-RETENTION (envelopes unavailable)' : 'NONE (not a pre-retention archive; envelopes required)')}`,
        );
        deps.log.line(
          `  ${report.counts.retained} replayed, ${report.counts.unavailable} envelope-unavailable, ${report.counts.unretained} unretained, ${report.counts.unreadable} unreadable, ${report.counts.changed} changed`,
        );
      }
    }
    for (const leg of report.legs) {
      // Quiet reports exactly what the exit code is about, and nothing else.
      if (quiet ? !isBlockingState(leg.envelope) : leg.envelope === 'retained' && !leg.changed) continue;
      deps.log.line(
        `${quiet ? `${file}: ` : '  '}${leg.participantId}:${leg.gameId}:${leg.leg} [${leg.provider}] ${leg.envelope}` +
          (leg.changed
            ? ` CHANGED archived(${describeAudit(leg.archivedAudit)}) -> replayed(${describeAudit(leg.replayedAudit)})`
            : ''),
      );
    }
    blocking += report.counts.unreadable + report.counts.unretained;
  }
  return blocking > 0 ? REPLAY_EXIT.blocking : REPLAY_EXIT.ok;
}

/** The same guard the other entry points use: importing this module for its
 *  exports must not run the CLI. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    process.exitCode = runReplayMain({
      argv: process.argv.slice(2),
      exists: existsSync,
      read: (path) => readFileSync(path, 'utf8'),
      log: { line: printLine, error: printError },
    });
  } catch (error: unknown) {
    printError(describeErrorWithStack(error));
    process.exitCode = REPLAY_EXIT.blocking;
  }
}
