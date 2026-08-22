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
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const record = asRecord(JSON.parse(trimmed));
    if (record === null) continue;
    if (record['recordType'] === 'run_meta') {
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
     extractor for its provider), or a named file could not be read
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
      deps.log.line(
        `${file}: run ${report.runId ?? '(unknown)'}, evidence era ${report.evidenceEra ?? (report.preRetentionArchive ? 'PRE-RETENTION (envelopes unavailable)' : 'NONE (not a pre-retention archive; envelopes required)')}`,
      );
      deps.log.line(
        `  ${report.counts.retained} replayed, ${report.counts.unavailable} envelope-unavailable, ${report.counts.unretained} unretained, ${report.counts.unreadable} unreadable, ${report.counts.changed} changed`,
      );
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
