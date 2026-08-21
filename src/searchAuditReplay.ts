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
import { envelopeVerificationFailures } from './providers/responseEnvelope.js';
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
  /** No envelope on the record: it predates retention, or nothing came back. */
  | 'unavailable'
  /**
   * An envelope is PRESENT but is not one: a missing or wrong-typed `body`,
   * `sha256` or `bytes`. Reported apart from `unavailable`, because "we could
   * not read this" and "there was nothing to read" are the two readings #92
   * exists to keep apart, and collapsing them here would reintroduce the
   * conflation one layer down. The scorer refuses the same bytes outright
   * (`responseEnvelopeSchema` is `.strict()`), so the two readers agree.
   */
  | 'malformed'
  /** An envelope is present but its stored body does not reproduce its digest. */
  | 'digest-mismatch'
  /** The retained body is not parseable JSON. */
  | 'unparseable'
  /** No extractor is registered for this record's provider. */
  | 'no-extractor';

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
  legs: ReplayLeg[];
  counts: {
    retained: number;
    unavailable: number;
    unreadable: number;
    changed: number;
  };
}

interface AttemptLike {
  searchAudit?: unknown;
  responseEnvelope?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reading an envelope has THREE outcomes, not two. A record that carries no
 * envelope key at all is a file that predates retention or a leg that received
 * nothing; a record carrying something under that key which is not an envelope
 * is damaged evidence. Returning one null for both is what made the tool report
 * a hand-edited artifact as "nothing to see here" at exit 0.
 */
type EnvelopeRead =
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'envelope'; envelope: ProviderResponseEnvelope };

function readEnvelope(value: unknown): EnvelopeRead {
  if (value === undefined || value === null) return { kind: 'absent' };
  const record = asRecord(value);
  if (record === null) return { kind: 'malformed' };
  const { body, sha256, bytes } = record;
  if (typeof body !== 'string' || typeof sha256 !== 'string' || typeof bytes !== 'number') {
    return { kind: 'malformed' };
  }
  return { kind: 'envelope', envelope: { body, sha256, bytes } };
}

function readAudit(value: unknown): SearchAudit | null {
  const record = asRecord(value);
  if (record === null) return null;
  return record as unknown as SearchAudit;
}

function replayLeg(
  participantId: string,
  gameId: string,
  leg: 'attempt' | 'repair',
  provider: string,
  attempt: AttemptLike,
  extractors: Readonly<Record<string, SearchAuditExtractor>>,
): ReplayLeg {
  const archivedAudit = readAudit(attempt.searchAudit);
  const base = { participantId, gameId, leg, provider, archivedAudit, replayedAudit: null, changed: false };
  const read = readEnvelope(attempt.responseEnvelope);
  if (read.kind !== 'envelope') {
    return { ...base, envelope: read.kind === 'absent' ? 'unavailable' : 'malformed' };
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
  const legs: ReplayLeg[] = [];
  let runId: string | null = null;
  let evidenceEra: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const record = asRecord(JSON.parse(trimmed));
    if (record === null) continue;
    if (record['recordType'] === 'run_meta') {
      if (typeof record['runId'] === 'string') runId = record['runId'];
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
      legs.push(replayLeg(participantId, gameId, name, provider, attempt, extractors));
    }
  }
  return {
    runId,
    evidenceEra,
    legs,
    counts: {
      retained: legs.filter((l) => l.envelope === 'retained').length,
      unavailable: legs.filter((l) => l.envelope === 'unavailable').length,
      unreadable: legs.filter(
        (l) =>
          l.envelope === 'malformed' ||
          l.envelope === 'digest-mismatch' ||
          l.envelope === 'unparseable' ||
          l.envelope === 'no-extractor',
      ).length,
      changed: legs.filter((l) => l.changed).length,
    },
  };
}

const USAGE = `usage: yarn replay:search-audit <run.ndjson> [more.ndjson ...]

Re-extract each attempt's web-search audit from the provider response envelope
the run retained, and report where the result differs from what the run
recorded. Reads the named files and nothing else -- no provider is called and
nothing is billed.

Runs written before envelope retention report every attempt as
envelope-unavailable; that is the honest answer for them, not a failure.

Exit codes:
  0  every retained envelope was read
  1  at least one envelope is present but unreadable (not a well-formed
     envelope, digest mismatch, unparseable body, or no extractor for its
     provider)
  2  usage -- no files given, or a named file does not exist`;

export const REPLAY_EXIT = Object.freeze({ ok: 0, unreadable: 1, usage: 2 });

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
  if (files.length === 0) {
    deps.log.error(USAGE);
    return REPLAY_EXIT.usage;
  }
  let unreadable = 0;
  for (const file of files) {
    if (!deps.exists(file)) {
      deps.log.error(`no such file: ${file}`);
      return REPLAY_EXIT.usage;
    }
    const report = replaySearchAudits(deps.read(file).split('\n'));
    deps.log.line(
      `${file}: run ${report.runId ?? '(unknown)'}, evidence era ${report.evidenceEra ?? 'PRE-RETENTION (envelopes unavailable)'}`,
    );
    deps.log.line(
      `  ${report.counts.retained} replayed, ${report.counts.unavailable} envelope-unavailable, ${report.counts.unreadable} unreadable, ${report.counts.changed} changed`,
    );
    for (const leg of report.legs) {
      if (leg.envelope === 'retained' && !leg.changed) continue;
      deps.log.line(
        `  ${leg.participantId}:${leg.gameId}:${leg.leg} [${leg.provider}] ${leg.envelope}` +
          (leg.changed
            ? ` CHANGED archived(${describeAudit(leg.archivedAudit)}) -> replayed(${describeAudit(leg.replayedAudit)})`
            : ''),
      );
    }
    unreadable += report.counts.unreadable;
  }
  return unreadable > 0 ? REPLAY_EXIT.unreadable : REPLAY_EXIT.ok;
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
    process.exitCode = REPLAY_EXIT.unreadable;
  }
}
