import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVIDENCE_ERA, sealResponseEnvelope } from './providers/responseEnvelope.js';
import { extractGoogleSearchAudit } from './providers/searchAudit.js';
import { AUDIT_REASON } from './providers/searchAudit.js';
import {
  CURRENT_EXTRACTORS,
  REPLAY_EXIT,
  replaySearchAudits,
  runReplayMain,
} from './searchAuditReplay.js';
import type { SearchAudit } from './types.js';

/**
 * OFFLINE REPLAY of the search audit from retained evidence (#92).
 *
 * The four shapes the issue names are each driven end to end: grounding
 * metadata present, tool-use tokens as the only proof a search ran, no
 * recognized evidence at all, and — the case the whole change exists for — a
 * response shape no extractor of the day understood, recovered later by
 * running a NEW parser over the SAME retained bytes.
 *
 * Every fixture body here is written as a literal string rather than
 * `JSON.stringify`d from an object, because what the replay reads is bytes: a
 * fixture built by re-serializing an object cannot show that the stored bytes
 * were the received ones.
 */

const RUN_ID = 'replay-fixture-run';
const GAME = '00000000-0000-4000-8000-0000000rep01';

interface LegFixture {
  participantId: string;
  provider: string;
  /** The received body, or `null` for an attempt that retains no envelope. */
  body: string | null;
  archivedAudit: SearchAudit | null;
  answerText: string | null;
  /** Corrupt the sealed body after digesting it, to model a tampered file. */
  tamper?: boolean;
  /**
   * Remove `sha256` from the sealed envelope: something IS under the envelope
   * key, and it is not an envelope. A hand-edited file, not an archived one.
   */
  malform?: boolean;
}

function attemptRecord(fixture: LegFixture): Record<string, unknown> {
  const sealed = fixture.body === null ? null : sealResponseEnvelope(fixture.body);
  return {
    answerText: fixture.answerText,
    reportedModelId: 'fixture-model',
    providerResponseId: 'fixture-response',
    httpStatus: fixture.body === null ? null : 200,
    searchAudit: fixture.archivedAudit,
    responseEnvelope:
      sealed === null
        ? null
        : fixture.malform === true
          ? { body: sealed.body, bytes: sealed.bytes }
          : fixture.tamper === true
            ? { ...sealed, body: `${sealed.body} ` }
            : sealed,
  };
}

function runLines(fixtures: LegFixture[], options: { era?: boolean } = {}): string[] {
  const meta: Record<string, unknown> = { recordType: 'run_meta', runId: RUN_ID };
  if (options.era !== false) meta['evidenceEra'] = EVIDENCE_ERA;
  return [
    JSON.stringify(meta),
    ...fixtures.map((fixture, index) =>
      JSON.stringify({
        recordType: 'arm_game_response',
        runId: RUN_ID,
        participantId: fixture.participantId,
        provider: fixture.provider,
        gameId: `${GAME}${index}`,
        attempt: attemptRecord(fixture),
        repair: null,
      }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// the four evidence shapes
// ---------------------------------------------------------------------------

/** Shape 1: Google grounding metadata present — queries AND sources. */
const GROUNDED_BODY =
  '{\n  "modelVersion": "gemini-fixture",\n  "candidates": [ {\n    "finishReason": "STOP",\n    "content": { "parts": [ { "text": "grounded answer" } ] },\n    "groundingMetadata": {\n      "webSearchQueries": [ "yankees probable starter", "yankees bullpen usage" ],\n      "groundingChunks": [ { "web": { "uri": "https://example.invalid/a", "title": "A" } } ]\n    }\n  } ],\n  "usageMetadata": { "toolUsePromptTokenCount": 812 }\n}';

/** Shape 2: tool-use tokens are the ONLY proof a search ran. */
const TOOL_TOKENS_ONLY_BODY =
  '{\n  "modelVersion": "gemini-fixture",\n  "candidates": [ { "finishReason": "STOP", "content": { "parts": [ { "text": "ungrounded answer" } ] } } ],\n  "usageMetadata": { "toolUsePromptTokenCount": 341 }\n}';

/** Shape 3: nothing recognizable as search evidence at all. */
const NO_EVIDENCE_BODY =
  '{\n  "modelVersion": "gemini-fixture",\n  "candidates": [ { "finishReason": "STOP", "content": { "parts": [ { "text": "unsearched answer" } ] } } ],\n  "usageMetadata": { "promptTokenCount": 100, "candidatesTokenCount": 20 }\n}';

/**
 * Shape 4: a shape NO extractor in this build understands. The queries live
 * under a key the current parser never looks at, so today's extraction returns
 * nothing — indistinguishable, without the body, from a model that did not
 * search.
 */
const UNKNOWN_SHAPE_BODY =
  '{\n  "modelVersion": "gemini-preview-fixture",\n  "candidates": [ { "finishReason": "STOP", "content": { "parts": [ { "text": "answer from an unknown shape" } ] } } ],\n  "retrievalMetadata": { "executedQueries": [ "rangers starter tonight", "rangers lineup" ] }\n}';

/** Tomorrow's parser: it reads the new key, and defers to today's for the rest. */
function updatedGoogleExtractor(json: unknown): SearchAudit | null {
  const current = extractGoogleSearchAudit(json);
  const root = json as { retrievalMetadata?: { executedQueries?: unknown } };
  const executed = root?.retrievalMetadata?.executedQueries;
  if (!Array.isArray(executed)) return current;
  const queries = executed.filter((q): q is string => typeof q === 'string').map((query) => ({ query }));
  return {
    queries,
    results: current?.results ?? [],
    searchCount: queries.length,
    incomplete: current?.incomplete ?? [],
  };
}

test('shape 1: grounding metadata replays to the same queries and sources', () => {
  const archived = extractGoogleSearchAudit(JSON.parse(GROUNDED_BODY));
  const report = replaySearchAudits(
    runLines([
      {
        participantId: 'google-arm',
        provider: 'google',
        body: GROUNDED_BODY,
        archivedAudit: archived,
        answerText: 'grounded answer',
      },
    ]),
  );
  assert.equal(report.evidenceEra, EVIDENCE_ERA);
  const leg = report.legs[0]!;
  assert.equal(leg.envelope, 'retained');
  assert.equal(leg.changed, false, 'the same parser over the same bytes gives the same audit');
  assert.deepEqual(leg.replayedAudit?.queries.map((q) => q.query), [
    'yankees probable starter',
    'yankees bullpen usage',
  ]);
  assert.deepEqual(leg.replayedAudit?.results.map((r) => r.url), ['https://example.invalid/a']);
  assert.equal(leg.replayedAudit?.searchCount, 2);
});

test('shape 2: tool-use tokens alone replay to an INCOMPLETE audit, never to zero', () => {
  const archived = extractGoogleSearchAudit(JSON.parse(TOOL_TOKENS_ONLY_BODY));
  const report = replaySearchAudits(
    runLines([
      {
        participantId: 'google-arm',
        provider: 'google',
        body: TOOL_TOKENS_ONLY_BODY,
        archivedAudit: archived,
        answerText: 'ungrounded answer',
      },
    ]),
  );
  const replayed = report.legs[0]!.replayedAudit;
  assert.ok(replayed !== null, 'evidence that a search ran is not an absent audit');
  assert.equal(replayed.searchCount, null, 'the count is UNKNOWN, not zero');
  assert.ok(replayed.incomplete.includes(AUDIT_REASON.GROUNDING_METADATA_MISSING));
  assert.equal(report.legs[0]!.changed, false);
});

test('shape 3: no recognized evidence replays to no audit — and the body proves it', () => {
  const report = replaySearchAudits(
    runLines([
      {
        participantId: 'google-arm',
        provider: 'google',
        body: NO_EVIDENCE_BODY,
        archivedAudit: null,
        answerText: 'unsearched answer',
      },
    ]),
  );
  const leg = report.legs[0]!;
  assert.equal(leg.envelope, 'retained', 'the claim is checkable because the body survived');
  assert.equal(leg.replayedAudit, null);
  assert.equal(leg.changed, false);
});

test('shape 4: an UNKNOWN response shape becomes recoverable after a parser update', () => {
  // This is the acceptance criterion the whole change exists for. Today's
  // parser sees nothing in this body; the run therefore archived nothing, and
  // before retention that was the end of the story.
  const archivedByTodaysParser = extractGoogleSearchAudit(JSON.parse(UNKNOWN_SHAPE_BODY));
  assert.equal(archivedByTodaysParser, null, 'the shape really is unrecognized today');

  const lines = runLines([
    {
      participantId: 'google-arm',
      provider: 'google',
      body: UNKNOWN_SHAPE_BODY,
      archivedAudit: archivedByTodaysParser,
      answerText: 'answer from an unknown shape',
    },
  ]);

  // Replaying with the CURRENT parser reproduces the run's own verdict — the
  // negative control, without which "recovered" could just mean "the replay
  // always finds something".
  const today = replaySearchAudits(lines);
  assert.equal(today.legs[0]!.replayedAudit, null);
  assert.equal(today.counts.changed, 0);

  // Replaying the SAME retained bytes with a parser that understands the shape
  // recovers the executed queries.
  const tomorrow = replaySearchAudits(lines, {
    extractors: { ...CURRENT_EXTRACTORS, google: updatedGoogleExtractor },
  });
  const leg = tomorrow.legs[0]!;
  assert.equal(leg.envelope, 'retained');
  assert.equal(leg.changed, true, 'the parser update changed the answer, and the replay says so');
  assert.deepEqual(leg.replayedAudit?.queries.map((q) => q.query), [
    'rangers starter tonight',
    'rangers lineup',
  ]);
  assert.equal(leg.replayedAudit?.searchCount, 2);
  assert.equal(tomorrow.counts.changed, 1);
});

// ---------------------------------------------------------------------------
// what cannot be replayed, and why
// ---------------------------------------------------------------------------

test('an archived attempt with no envelope is envelope-unavailable, not "no search ran"', () => {
  const report = replaySearchAudits(
    runLines(
      [
        {
          participantId: 'google-arm',
          provider: 'google',
          body: null,
          archivedAudit: null,
          answerText: 'archived answer',
        },
      ],
      { era: false },
    ),
  );
  assert.equal(report.evidenceEra, null, 'the file predates retention');
  assert.equal(report.legs[0]!.envelope, 'unavailable');
  assert.equal(report.legs[0]!.replayedAudit, null);
  assert.equal(report.legs[0]!.changed, false, 'nothing was replayed, so nothing changed');
  assert.equal(report.counts.unavailable, 1);
  assert.equal(report.counts.retained, 0);
});

test('a tampered envelope is refused before its body is read', () => {
  // The body still parses and the "new" parser would happily read it. What
  // stops it is the digest: bytes that do not reproduce their own binding are
  // not evidence about the call they name.
  const report = replaySearchAudits(
    runLines([
      {
        participantId: 'google-arm',
        provider: 'google',
        body: GROUNDED_BODY,
        archivedAudit: null,
        answerText: 'grounded answer',
        tamper: true,
      },
    ]),
  );
  assert.equal(report.legs[0]!.envelope, 'digest-mismatch');
  assert.equal(report.legs[0]!.replayedAudit, null, 'an altered body is not extracted from');
  assert.equal(report.counts.unreadable, 1);
});

test('an envelope that is PRESENT but not an envelope is unreadable, never "unavailable"', () => {
  // The conflation #92 exists to remove, one layer down. Absent and malformed
  // both used to read as a single null, so a hand-edited file reported "there
  // was nothing to see" where the truth is "we could not read what is here".
  //
  // The negative control is the case above ('no envelope ... envelope-
  // unavailable'), which keeps the same shape MINUS the envelope key and must
  // still report `unavailable`. The two cases differ in exactly one thing.
  const fixture = {
    participantId: 'google-arm' as const,
    provider: 'google' as const,
    body: GROUNDED_BODY,
    archivedAudit: null,
    answerText: 'grounded answer',
  };
  const lines = runLines([{ ...fixture, malform: true }]);
  const report = replaySearchAudits(lines);
  assert.equal(report.legs[0]!.envelope, 'malformed');
  assert.equal(report.legs[0]!.replayedAudit, null, 'nothing is extracted from it');
  assert.equal(report.counts.unreadable, 1, 'it counts as unreadable, so the command exits non-zero');
  assert.equal(report.counts.unavailable, 0, 'and NOT as "there was nothing to read"');

  // The scorer refuses the same damage outright — that half is pinned on a real
  // fired artifact in `responseEnvelopeIntegrity.test.ts`, where the record is
  // complete enough that the refusal can only be about the envelope. These
  // minimal fixtures carry no cohort id or label, so a `parseRunRecords` here
  // would throw for a reason that has nothing to do with the envelope.

  // The well-formed version of the identical fixture replays, so the refusal
  // above is about the damage rather than about the fixture.
  assert.equal(replaySearchAudits(runLines([fixture])).legs[0]!.envelope, 'retained');
});

test('the command exits 1 on a malformed envelope and names it', () => {
  const text = `${runLines([
    {
      participantId: 'google-arm',
      provider: 'google',
      body: GROUNDED_BODY,
      archivedAudit: null,
      answerText: 'grounded answer',
      malform: true,
    },
  ]).join('\n')}\n`;
  const { code, out } = cli({ 'run.ndjson': text }, ['run.ndjson']);
  assert.equal(code, REPLAY_EXIT.unreadable);
  assert.ok(out.some((line) => line.includes('malformed')), out.join('\n'));
  assert.ok(out.some((line) => line.includes('1 unreadable')), out.join('\n'));
  assert.ok(
    !out.some((line) => line.includes('1 envelope-unavailable')),
    `it must not be reported as absent: ${out.join('\n')}`,
  );
});

test('a provider with no registered extractor is reported, not silently skipped', () => {
  const report = replaySearchAudits(
    runLines([
      {
        participantId: 'mystery-arm',
        provider: 'a-provider-this-build-does-not-know',
        body: GROUNDED_BODY,
        archivedAudit: null,
        answerText: 'answer',
      },
    ]),
  );
  assert.equal(report.legs[0]!.envelope, 'no-extractor');
  assert.equal(report.counts.unreadable, 1);
});

test('the repair leg is replayed too, with its own envelope', () => {
  const initial = attemptRecord({
    participantId: 'google-arm',
    provider: 'google',
    body: TOOL_TOKENS_ONLY_BODY,
    archivedAudit: null,
    answerText: 'ungrounded answer',
  });
  const repair = attemptRecord({
    participantId: 'google-arm',
    provider: 'google',
    body: GROUNDED_BODY,
    archivedAudit: null,
    answerText: 'grounded answer',
  });
  const report = replaySearchAudits([
    JSON.stringify({ recordType: 'run_meta', runId: RUN_ID, evidenceEra: EVIDENCE_ERA }),
    JSON.stringify({
      recordType: 'arm_game_response',
      runId: RUN_ID,
      participantId: 'google-arm',
      provider: 'google',
      gameId: GAME,
      attempt: initial,
      repair,
    }),
  ]);
  assert.deepEqual(
    report.legs.map((l) => l.leg),
    ['attempt', 'repair'],
  );
  // Different bodies, so the repair's audit cannot be the initial's by accident.
  assert.equal(report.legs[0]!.replayedAudit?.searchCount, null);
  assert.equal(report.legs[1]!.replayedAudit?.searchCount, 2);
});

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

function cli(files: Record<string, string>, argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runReplayMain({
    argv,
    exists: (path) => Object.hasOwn(files, path),
    read: (path) => files[path]!,
    log: { line: (text) => out.push(text), error: (text) => err.push(text) },
  });
  return { code, out, err };
}

test('the command exits 0 on a clean run and names the era', () => {
  const text = `${runLines([
    {
      participantId: 'google-arm',
      provider: 'google',
      body: GROUNDED_BODY,
      archivedAudit: extractGoogleSearchAudit(JSON.parse(GROUNDED_BODY)),
      answerText: 'grounded answer',
    },
  ]).join('\n')}\n`;
  const { code, out } = cli({ 'run.ndjson': text }, ['run.ndjson']);
  assert.equal(code, REPLAY_EXIT.ok);
  assert.ok(out.some((line) => line.includes(EVIDENCE_ERA)));
  assert.ok(out.some((line) => line.includes('1 replayed')));
});

test('the command exits 1 when an envelope is present but unreadable', () => {
  const text = `${runLines([
    {
      participantId: 'google-arm',
      provider: 'google',
      body: GROUNDED_BODY,
      archivedAudit: null,
      answerText: 'grounded answer',
      tamper: true,
    },
  ]).join('\n')}\n`;
  const { code, out } = cli({ 'run.ndjson': text }, ['run.ndjson']);
  assert.equal(code, REPLAY_EXIT.unreadable);
  assert.ok(out.some((line) => line.includes('digest-mismatch')));
});

test('the command exits 0 on a PRE-RETENTION file and says so', () => {
  // The negative control for the exit code above: envelope-unavailable is the
  // honest answer for an archived file, not a failure it could have avoided.
  const text = `${runLines(
    [
      {
        participantId: 'google-arm',
        provider: 'google',
        body: null,
        archivedAudit: null,
        answerText: 'archived answer',
      },
    ],
    { era: false },
  ).join('\n')}\n`;
  const { code, out } = cli({ 'run.ndjson': text }, ['run.ndjson']);
  assert.equal(code, REPLAY_EXIT.ok);
  assert.ok(out.some((line) => line.includes('PRE-RETENTION')));
  assert.ok(out.some((line) => line.includes('1 envelope-unavailable')));
});

test('the command exits 2 on usage errors', () => {
  assert.equal(cli({}, []).code, REPLAY_EXIT.usage);
  assert.equal(cli({}, ['missing.ndjson']).code, REPLAY_EXIT.usage);
});
