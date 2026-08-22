import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVIDENCE_ERA, sealResponseEnvelope } from './providers/responseEnvelope.js';
import { extractGoogleSearchAudit } from './providers/searchAudit.js';
import { AUDIT_REASON } from './providers/searchAudit.js';
import {
  CURRENT_EXTRACTORS,
  isBlockingState,
  REPLAY_ENVELOPE_STATES,
  REPLAY_EXIT,
  replaySearchAudits,
  runReplayMain,
} from './searchAuditReplay.js';
import { damageEnvelope, ENVELOPE_DAMAGE } from './testFactories.js';
import type { EnvelopeDamage } from './testFactories.js';
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
  /** Damage the sealed envelope so exactly one schema rule refuses it; see
   *  `ENVELOPE_DAMAGE`. Something IS under the envelope key and it is not an
   *  envelope — a hand-edited file, not an archived one. */
  damage?: EnvelopeDamage;
  /**
   * Write this leg the way a PRE-#92 build did: the answer under the old name
   * `rawResponse`, and no `responseEnvelope` key at all. This is the only leg
   * shape that can make a file a coherent archive, so it is the only one whose
   * missing envelope reports as `unavailable`.
   */
  archived?: boolean;
  /** Content signals, defaulted to non-null stand-ins. Set `null` to strip one
   *  — the receipt cases need a leg with every content signal gone. */
  reportedModelId?: string | null;
  providerResponseId?: string | null;
  /** The settled HTTP status. Defaults to 200 when a body was received. */
  httpStatus?: number | null;
}

function attemptRecord(fixture: LegFixture): Record<string, unknown> {
  const sealed = fixture.body === null ? null : sealResponseEnvelope(fixture.body);
  const record: Record<string, unknown> = {
    reportedModelId: fixture.reportedModelId === undefined ? 'fixture-model' : fixture.reportedModelId,
    providerResponseId:
      fixture.providerResponseId === undefined ? 'fixture-response' : fixture.providerResponseId,
    httpStatus:
      fixture.httpStatus === undefined ? (fixture.body === null ? null : 200) : fixture.httpStatus,
    searchAudit: fixture.archivedAudit,
  };
  if (fixture.archived === true) {
    // A pre-#92 leg carries neither key a retaining build adds. Assigned by
    // NOT assigning: the point of the archive rule is key presence, so a
    // fixture that wrote `responseEnvelope: undefined` would not model it.
    record['rawResponse'] = fixture.answerText;
    return record;
  }
  record['answerText'] = fixture.answerText;
  record['responseEnvelope'] =
    sealed === null
      ? null
      : fixture.damage !== undefined
        ? damageEnvelope(sealed, fixture.damage)
        : fixture.tamper === true
          ? { ...sealed, body: `${sealed.body} ` }
          : sealed;
  return record;
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

/** A leg written the way a pre-#92 build wrote it. Used wherever a case needs
 *  a file that is genuinely an archive rather than one edited to look like it. */
function archivedLeg(overrides: Partial<LegFixture> = {}): LegFixture {
  return {
    participantId: 'google-arm',
    provider: 'google',
    body: null,
    archivedAudit: null,
    answerText: 'archived answer',
    archived: true,
    ...overrides,
  };
}

test('an archived attempt with no envelope is envelope-unavailable, not "no search ran"', () => {
  const report = replaySearchAudits(runLines([archivedLeg()], { era: false }));
  assert.equal(report.evidenceEra, null, 'the file predates retention');
  assert.equal(report.preRetentionArchive, true, 'and reads as one as a WHOLE');
  assert.equal(report.legs[0]!.envelope, 'unavailable');
  assert.equal(report.legs[0]!.replayedAudit, null);
  assert.equal(report.legs[0]!.changed, false, 'nothing was replayed, so nothing changed');
  assert.equal(report.counts.unavailable, 1);
  assert.equal(report.counts.unretained, 0);
  assert.equal(report.counts.retained, 0);
});

// ---------------------------------------------------------------------------
// unretained: evidence that existed and was not kept
// ---------------------------------------------------------------------------

test('a current-era leg that received a response and kept nothing is UNRETAINED', () => {
  // B1-a. This is the leg the scorer calls a violation; the replay used to
  // call it `unavailable` and exit 0, so two tools reading the same bytes
  // disagreed about whether anything was wrong.
  const report = replaySearchAudits(
    runLines([
      {
        participantId: 'google-arm',
        provider: 'google',
        body: null,
        archivedAudit: null,
        answerText: 'an answer that came from somewhere',
        httpStatus: 200,
      },
    ]),
  );
  assert.equal(report.preRetentionArchive, false);
  assert.equal(report.legs[0]!.envelope, 'unretained');
  assert.equal(report.counts.unretained, 1);
  assert.equal(report.counts.unavailable, 0, 'and NOT "there was nothing to read"');
});

test('a leg that received NOTHING stays unavailable, even in a retaining-era run', () => {
  // The negative control the state needs, and it is the one that keeps every
  // timeout scoreable. Every content signal is null and the status never
  // settled, so nothing says a body arrived.
  const report = replaySearchAudits(
    runLines([
      {
        participantId: 'google-arm',
        provider: 'google',
        body: null,
        archivedAudit: null,
        answerText: null,
        reportedModelId: null,
        providerResponseId: null,
        httpStatus: null,
      },
    ]),
  );
  assert.equal(report.preRetentionArchive, false, 'the run IS in the retaining era');
  assert.equal(report.legs[0]!.envelope, 'unavailable');
  assert.equal(report.counts.unretained, 0);
  assert.equal(isBlockingState('unavailable'), false, 'so it cannot move the exit code');
});

test('a bare 2xx with no content left is still a receipt, so its missing envelope is unretained', () => {
  // Rule 3b: every OTHER signal is null, so the status is the only thing that
  // can produce this answer. With any of them present the three-signal
  // predicate would answer the same way and this case would say nothing about
  // the fourth disjunct.
  const bare = {
    participantId: 'google-arm' as const,
    provider: 'google' as const,
    body: null,
    archivedAudit: null,
    answerText: null,
    reportedModelId: null,
    providerResponseId: null,
  };
  const stateFor = (httpStatus: number | null): string =>
    replaySearchAudits(runLines([{ ...bare, httpStatus }])).legs[0]!.envelope;
  assert.equal(stateFor(200), 'unretained', 'a 200 is a receipt');
  assert.equal(stateFor(500), 'unavailable', 'a 500 is not — its body is not retained by design');
  assert.equal(stateFor(null), 'unavailable', 'and nothing settled at all is not');
});

test('deleting the era stamp does NOT turn the report back into "unavailable"', () => {
  // The reviewer's probe, on the replay side. A file with modern legs and no
  // stamp is not an archive, so its missing envelopes are still unretained.
  const modern: LegFixture = {
    participantId: 'google-arm',
    provider: 'google',
    body: null,
    archivedAudit: null,
    answerText: 'an answer',
  };
  const stamped = replaySearchAudits(runLines([modern]));
  const unstamped = replaySearchAudits(runLines([modern], { era: false }));
  assert.equal(unstamped.evidenceEra, null, 'the stamp really is gone');
  assert.equal(stamped.legs[0]!.envelope, 'unretained');
  assert.equal(unstamped.legs[0]!.envelope, 'unretained', 'and the verdict did not move');
  // The control that says the exemption still exists at all: the same file,
  // written the way a pre-#92 build wrote it, IS exempt.
  assert.equal(replaySearchAudits(runLines([archivedLeg()], { era: false })).legs[0]!.envelope, 'unavailable');
});

test('an era key of the WRONG TYPE is still a stamp — presence, not type', () => {
  // A hand-edit that blanks the stamp rather than deleting it. The legs here
  // are archive-shaped, so nothing but how the stamp is READ can decide this:
  // by presence the file is not an archive and is enforced, by type it would
  // be exempt. Every era carrier can only raise enforcement.
  const meta = JSON.stringify({ recordType: 'run_meta', runId: RUN_ID, evidenceEra: null });
  const legLine = JSON.stringify({
    recordType: 'arm_game_response',
    runId: RUN_ID,
    participantId: 'google-arm',
    provider: 'google',
    gameId: GAME,
    attempt: attemptRecord(archivedLeg()),
    repair: null,
  });
  const report = replaySearchAudits([meta, legLine]);
  assert.equal(report.evidenceEra, null, 'nothing readable is under the key');
  assert.equal(report.preRetentionArchive, false, 'and the file is still not an archive');
  assert.equal(report.legs[0]!.envelope, 'unretained');

  // The control that says the exemption still exists: the SAME leg, in a file
  // with no era key at all.
  assert.equal(
    replaySearchAudits(runLines([archivedLeg()], { era: false })).legs[0]!.envelope,
    'unavailable',
  );
});

test('one modern leg withdraws the archive exemption from the whole file', () => {
  // The predicate is whole-file, so a mixed file is enforced everywhere — not
  // just on the leg that gave it away. The archived leg alone is the control
  // directly above, so the change here is exactly the added leg.
  const report = replaySearchAudits(
    runLines(
      [
        archivedLeg(),
        { participantId: 'google-arm', provider: 'google', body: null, archivedAudit: null, answerText: 'modern' },
      ],
      { era: false },
    ),
  );
  assert.equal(report.preRetentionArchive, false);
  assert.deepEqual(
    report.legs.map((leg) => leg.envelope),
    ['unretained', 'unretained'],
  );
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
  // The negative control is the archived case above, which keeps the same
  // shape MINUS the envelope key and must still report `unavailable`.
  //
  // Every entry in the damage table is swept, because the states they used to
  // produce DIFFER: before both readers shared one schema, `extra-key` replayed
  // clean at exit 0 and the two self-consistent-but-wrong-shape cases reported
  // `digest-mismatch`. Asserting "unreadable" would have passed on two of them
  // for the wrong reason — the assertion is on WHICH state.
  const fixture = {
    participantId: 'google-arm' as const,
    provider: 'google' as const,
    body: GROUNDED_BODY,
    archivedAudit: null,
    answerText: 'grounded answer',
  };
  for (const damage of Object.keys(ENVELOPE_DAMAGE) as EnvelopeDamage[]) {
    const report = replaySearchAudits(runLines([{ ...fixture, damage }]));
    assert.equal(report.legs[0]!.envelope, 'malformed', damage);
    assert.equal(report.legs[0]!.replayedAudit, null, `nothing is extracted from ${damage}`);
    assert.equal(report.counts.unreadable, 1, `${damage} counts as unreadable`);
    assert.equal(report.counts.unavailable, 0, `${damage} is not "there was nothing to read"`);
    assert.equal(report.counts.retained, 0, `${damage} is not replayed`);
  }

  // The well-formed version of the identical fixture replays, so every refusal
  // above is about the damage rather than about the fixture.
  assert.equal(replaySearchAudits(runLines([fixture])).legs[0]!.envelope, 'retained');
});

// The other half of that parity — the SCORER refusing the same four shapes —
// is measured in `responseEnvelopeIntegrity.test.ts`, over the same
// `ENVELOPE_DAMAGE` table applied to a real fired artifact. It cannot live
// here: these fixtures are minimal records with no cohort id and no label, so
// `parseRunRecords` refuses them before it ever reaches an attempt, and a
// refusal that happens for the wrong reason proves nothing about the envelope.

test('the command exits 1 on a malformed envelope and names it', () => {
  const text = `${runLines([
    {
      participantId: 'google-arm',
      provider: 'google',
      body: GROUNDED_BODY,
      archivedAudit: null,
      answerText: 'grounded answer',
      damage: 'extra-key',
    },
  ]).join('\n')}\n`;
  const { code, out } = cli({ 'run.ndjson': text }, ['run.ndjson']);
  assert.equal(code, REPLAY_EXIT.blocking);
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
  assert.equal(code, REPLAY_EXIT.blocking);
  assert.ok(out.some((line) => line.includes('digest-mismatch')));
});

test('the command exits 0 on a PRE-RETENTION file and says so', () => {
  // The negative control for the exit code above: envelope-unavailable is the
  // honest answer for an archived file, not a failure it could have avoided.
  const text = `${runLines([archivedLeg()], { era: false }).join('\n')}\n`;
  const { code, out } = cli({ 'run.ndjson': text }, ['run.ndjson']);
  assert.equal(code, REPLAY_EXIT.ok);
  assert.ok(out.some((line) => line.includes('PRE-RETENTION')));
  assert.ok(out.some((line) => line.includes('1 envelope-unavailable')));
});

test('the command exits 1 on an unretained leg, and names it', () => {
  const text = `${runLines([
    {
      participantId: 'google-arm',
      provider: 'google',
      body: null,
      archivedAudit: null,
      answerText: 'an answer that came from somewhere',
    },
  ]).join('\n')}\n`;
  const { code, out } = cli({ 'run.ndjson': text }, ['run.ndjson']);
  assert.equal(code, REPLAY_EXIT.blocking);
  assert.ok(out.some((line) => line.includes('unretained')), out.join('\n'));
  assert.ok(out.some((line) => line.includes('1 unretained')), out.join('\n'));
  assert.ok(
    !out.some((line) => line.includes('1 envelope-unavailable')),
    `it must not be reported as absent: ${out.join('\n')}`,
  );
});

test('the command exits 2 on usage errors', () => {
  assert.equal(cli({}, []).code, REPLAY_EXIT.usage);
  assert.equal(cli({}, ['missing.ndjson']).code, REPLAY_EXIT.usage);
});

// ---------------------------------------------------------------------------
// --quiet: the form to point at a directory of evidence
// ---------------------------------------------------------------------------

test('the state table classifies every state, and the exit code reads that table', () => {
  // The enumeration guard for the states. `REPLAY_ENVELOPE_STATES` is derived
  // from the classification map rather than listed twice, and the map's type
  // makes omitting a state a compile error — so this pins the map's CONTENT
  // against a literal, which the type cannot do.
  assert.deepEqual([...REPLAY_ENVELOPE_STATES].sort(), [
    'digest-mismatch',
    'malformed',
    'no-extractor',
    'retained',
    'unavailable',
    'unparseable',
    'unretained',
  ]);
  const blocking = REPLAY_ENVELOPE_STATES.filter(isBlockingState).sort();
  assert.deepEqual(blocking, [
    'digest-mismatch',
    'malformed',
    'no-extractor',
    'unparseable',
    'unretained',
  ]);
  assert.deepEqual(
    REPLAY_ENVELOPE_STATES.filter((state) => !isBlockingState(state)).sort(),
    ['retained', 'unavailable'],
    'exactly two states are silent, and both mean nothing was owed',
  );
});

test('--quiet prints NOTHING and exits 0 on a clean file', () => {
  // The property the corpus check rests on: pointed at good evidence it says
  // nothing at all. A run whose legs all replayed cleanly still counts as
  // clean when its audits CHANGED — the dry-run case, which is expected and
  // is not what the exit code is about.
  const text = `${runLines([
    {
      participantId: 'google-arm',
      provider: 'google',
      body: GROUNDED_BODY,
      archivedAudit: null,
      answerText: 'grounded answer',
    },
  ]).join('\n')}\n`;
  const loud = cli({ 'run.ndjson': text }, ['run.ndjson']);
  assert.ok(loud.out.length > 0, 'the loud form says plenty, so silence below is the flag');
  assert.ok(loud.out.some((line) => line.includes('CHANGED')), 'and this file HAS a changed leg');

  const { code, out, err } = cli({ 'run.ndjson': text }, ['--quiet', 'run.ndjson']);
  assert.equal(code, REPLAY_EXIT.ok);
  assert.deepEqual(out, []);
  assert.deepEqual(err, []);
});

test('--quiet prints one line per blocking leg, naming the file, and exits 1', () => {
  const bad = `${runLines([
    { participantId: 'a-arm', provider: 'google', body: null, archivedAudit: null, answerText: 'kept nothing' },
    {
      participantId: 'b-arm',
      provider: 'google',
      body: GROUNDED_BODY,
      archivedAudit: null,
      answerText: 'grounded answer',
      damage: 'extra-key',
    },
    // A clean leg and an archived-style one, neither of which may print.
    { participantId: 'c-arm', provider: 'google', body: GROUNDED_BODY, archivedAudit: null, answerText: 'grounded answer' },
  ]).join('\n')}\n`;
  const good = `${runLines([archivedLeg()], { era: false }).join('\n')}\n`;
  const { code, out } = cli({ 'bad.ndjson': bad, 'good.ndjson': good }, [
    '--quiet',
    'bad.ndjson',
    'good.ndjson',
  ]);
  assert.equal(code, REPLAY_EXIT.blocking);
  assert.equal(out.length, 2, `exactly the two blocking legs: ${out.join('\n')}`);
  assert.ok(out.every((line) => line.startsWith('bad.ndjson: ')), out.join('\n'));
  assert.ok(out.some((line) => line.includes('a-arm') && line.includes('unretained')));
  assert.ok(out.some((line) => line.includes('b-arm') && line.includes('malformed')));
  assert.ok(!out.some((line) => line.includes('c-arm')), 'the clean leg stays silent');
  assert.ok(!out.some((line) => line.includes('good.ndjson')), 'so does the whole clean file');
});

test('a file that cannot be parsed is named and counted, and the rest still run', () => {
  // One command is pointed at a whole directory, so a single bad file must not
  // abort the sweep — and must not pass silently either.
  const good = `${runLines([archivedLeg()], { era: false }).join('\n')}\n`;
  const { code, out } = cli({ 'broken.ndjson': '{not json at all\n', 'good.ndjson': good }, [
    '--quiet',
    'broken.ndjson',
    'good.ndjson',
  ]);
  assert.equal(code, REPLAY_EXIT.blocking);
  assert.equal(out.length, 1, out.join('\n'));
  assert.ok(out[0]!.startsWith('broken.ndjson: unreadable run file: '), out[0]);
});
