import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { EVIDENCE_ERA, sealResponseEnvelope } from './providers/responseEnvelope.js';
import { extractGoogleSearchAudit } from './providers/searchAudit.js';
import { AUDIT_REASON } from './providers/searchAudit.js';
import {
  CURRENT_EXTRACTORS,
  isBlockingState,
  REPLAY_ENVELOPE_STATES,
  REPLAY_EXIT,
  replaySearchAudits,
  RUN_RECORD_TYPES,
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
  /** Write no `httpStatus` KEY at all — a hand-edited leg, since every build
   *  that has written one wrote that key. */
  omitHttpStatus?: boolean;
  /** The leg's own error text, which restates the status in prose. Omitted
   *  entirely unless a case is about that second carrier. */
  errorDetail?: string;
}

function attemptRecord(fixture: LegFixture): Record<string, unknown> {
  const sealed = fixture.body === null ? null : sealResponseEnvelope(fixture.body);
  const record: Record<string, unknown> = {
    reportedModelId: fixture.reportedModelId === undefined ? 'fixture-model' : fixture.reportedModelId,
    providerResponseId:
      fixture.providerResponseId === undefined ? 'fixture-response' : fixture.providerResponseId,
    searchAudit: fixture.archivedAudit,
  };
  if (fixture.omitHttpStatus !== true) {
    record['httpStatus'] =
      fixture.httpStatus === undefined ? (fixture.body === null ? null : 200) : fixture.httpStatus;
  }
  if (fixture.errorDetail !== undefined) record['errorDetail'] = fixture.errorDetail;
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

test('the replay reads the SAME three receipt carriers the scorer does', () => {
  // The one-field exemption a reviewer found after the era redesign, on the
  // replay side. Nulling `httpStatus` on a contentless leg used to make it
  // `unavailable` at exit 0 while the same bytes were a scorer violation — the
  // divergence this state exists to remove.
  //
  // Rule 3b: every content signal is null in every row, so only a status
  // carrier can decide, and each row leaves exactly one carrier standing.
  const bare = {
    participantId: 'google-arm' as const,
    provider: 'google' as const,
    body: null,
    archivedAudit: null,
    answerText: null,
    reportedModelId: null,
    providerResponseId: null,
  };
  const stateFor = (fixture: Partial<LegFixture>): string =>
    replaySearchAudits(runLines([{ ...bare, ...fixture }])).legs[0]!.envelope;

  assert.equal(stateFor({ httpStatus: 200 }), 'unretained', 'carrier 1: the numeric status');
  assert.equal(
    stateFor({ httpStatus: null, errorDetail: 'google returned HTTP 200: non-JSON response body' }),
    'unretained',
    'carrier 2: the status stated in prose, with the numeric field nulled',
  );
  assert.equal(
    stateFor({ httpStatus: null, omitHttpStatus: true }),
    'unretained',
    'carrier 3: the status key deleted, read fail-closed',
  );
  assert.equal(
    stateFor({ httpStatus: null, errorDetail: 'google returned HTTP 429: rate limited' }),
    'unavailable',
    'and the prose carrier keeps the 2xx bound',
  );
  // THE BOUND, and the negative control: all three silent, and the leg is a
  // leg that genuinely received nothing. Erasing an errored leg costs three
  // consistent edits, which is the residual the README and the PR body state.
  assert.equal(stateFor({ httpStatus: null }), 'unavailable');
});

test('the ARCHIVED answer name alone is a receipt, in a file that is not an archive', () => {
  // `receiptSignals` reads `answerText ?? rawResponse`, and the fallback had no
  // test: a reader consulting only the modern name would exempt every
  // pre-rename leg that ends up in a file the archive predicate refuses.
  //
  // Reaching it needs two legs. One archived-shape leg alone makes the file a
  // coherent archive, which exempts it for a different reason — so the modern
  // leg is here to withdraw that exemption, and the archived leg then has its
  // old answer name as its ONLY receipt: no model id, no response id, no
  // status, no error text.
  const report = replaySearchAudits(
    runLines([
      {
        participantId: 'google-modern',
        provider: 'google',
        body: '{"candidates":[]}',
        archivedAudit: null,
        answerText: 'a modern answer',
      },
      {
        participantId: 'google-archived',
        provider: 'google',
        body: null,
        archivedAudit: null,
        answerText: 'an answer under the pre-#92 name',
        archived: true,
        reportedModelId: null,
        providerResponseId: null,
        httpStatus: null,
      },
    ]),
  );
  assert.equal(report.preRetentionArchive, false, 'the modern leg withdraws the exemption');
  assert.equal(report.legs[0]!.envelope, 'retained', 'the modern leg is fine');
  assert.equal(report.legs[1]!.envelope, 'unretained', 'and the archived name is read as a receipt');
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

// ── shape before verdict — #92 ──────────────────────────────────────────────
// A fire artifact is a single JSON object with no `arm_game_response` record,
// so it collected zero legs, `isCoherentPreRetentionArchive` was vacuously true
// over them, and the command reported "PRE-RETENTION (envelopes unavailable),
// 0 replayed" at exit 0 — silent under `--quiet`. Reproduced on the real
// artifact before the fix; that is an evidence verdict about bytes never read
// as evidence, which is the one conflation this command exists to prevent.

/** A single JSON object on ONE line — the shape a fire artifact actually has. */
const oneLineObject = (): string => JSON.stringify({ artifactSchemaVersion: 1, arms: [] });

test('a single-JSON-object artifact is REFUSED, not reported as a clean archive', () => {
  // ⚠ THE FIXTURE MUST BE ONE LINE, and this asserts it before anything else.
  //   Measured: `JSON.stringify(artifact, null, 2)` is 377 lines, and a
  //   pretty-printed fixture is already refused on the UNFIXED build — the
  //   per-line `JSON.parse` throws and the existing catch exits 1. A test
  //   written that way passes with this whole gate deleted, and would score its
  //   mutant KILLED while it survived. Only the one-line form discriminates.
  const text = oneLineObject();
  assert.equal(text.split('\n').length, 1, 'or the per-line JSON.parse refuses it instead and this proves nothing');

  const { code, out } = cli({ 'fire.json': text }, ['fire.json']);
  assert.equal(code, REPLAY_EXIT.blocking);
  assert.ok(
    out.some((line) => line.includes('no NDJSON record carried a recordType')),
    out.join('\n'),
  );
  // ⚠ ASSERTED IN DEFAULT MODE ON PURPOSE. Under `--quiet` this file printed
  //   nothing at all before the fix, so an absence assertion there is satisfied
  //   by the broken build. Default mode is where PRE-RETENTION genuinely was
  //   printed, so this is the line that reddens without the gate.
  assert.ok(!out.some((line) => line.includes('PRE-RETENTION')), out.join('\n'));
  assert.ok(!out.some((line) => line.includes('0 replayed')), out.join('\n'));
});

test('a single-JSON-object artifact is named under --quiet too, and blocks', () => {
  // Its negative pair is the existing '--quiet prints NOTHING and exits 0 on a
  // clean file' above: this is refused loudly, that stays silent.
  const { code, out } = cli({ 'fire.json': oneLineObject() }, ['--quiet', 'fire.json']);
  assert.equal(code, REPLAY_EXIT.blocking);
  assert.equal(out.length, 1, out.join('\n'));
  assert.ok(out[0]!.startsWith('fire.json: unreadable run file: '), out[0]);
});

test('a SIBLING record stream is named but does NOT block', () => {
  // ⚠ THIS CASE IS THE CONTROL FOR THE WHOLE DESIGN, and the only input that
  //   separates the shipped gate from the obvious one. Keying the refusal on a
  //   missing `run_meta` instead of a missing `recordType` agrees with this
  //   build on all 42 run files and on every other fixture in this suite — and
  //   would refuse the `-scored.ndjson` that `yarn score` writes beside its
  //   input BY DEFAULT, plus the close-schedule audits, i.e. 5 files sitting in
  //   `out/` today and one more per scored run forever. `--quiet out/*.ndjson`
  //   is the documented directory sweep and is silent at exit 0 today; that
  //   contract is what this case protects.
  const scored = '{"recordType":"scored_run_meta","runId":"r"}\n{"recordType":"scored_decision"}\n';

  const { code, out } = cli({ 'r-scored.ndjson': scored }, ['r-scored.ndjson']);
  assert.equal(code, REPLAY_EXIT.ok, out.join('\n'));
  assert.ok(out.some((line) => line.includes('not a harness run file')), out.join('\n'));
  // Named, but still given no envelope verdict — the whole point of the tier.
  assert.ok(!out.some((line) => line.includes('PRE-RETENTION')), out.join('\n'));

  const quiet = cli({ 'r-scored.ndjson': scored }, ['--quiet', 'r-scored.ndjson']);
  assert.equal(quiet.code, REPLAY_EXIT.ok);
  assert.equal(quiet.out.length, 0, quiet.out.join('\n'));
});

test('a refused artifact does not abort the sweep', () => {
  // The refusal must `continue`, like the parse failure above — not short-
  // circuit the way a missing file does at REPLAY_EXIT.usage. The clean file
  // after it is the control: if the sweep aborted, its legs would go unread.
  const good = `${runLines([archivedLeg()], { era: false }).join('\n')}\n`;
  const { code, out } = cli({ 'fire.json': oneLineObject(), 'good.ndjson': good }, [
    '--quiet',
    'fire.json',
    'good.ndjson',
  ]);
  assert.equal(code, REPLAY_EXIT.blocking);
  assert.equal(out.length, 1, out.join('\n'));
  assert.ok(out[0]!.startsWith('fire.json: unreadable run file: '), out[0]);
});

// ── a truncated run must not pass as somebody else's stream ────────────────
// ⚠ A REVIEWER'S BLOCKER, kept closed here. The first version of this gate
//   asked only whether ANY `recordType` was present. A reviewer deleted ONLY
//   the `run_meta` line from a real 62-record run — 12 arm_game_response, 3
//   bundle_game, 21 decision, 24 baseline_decision — and the remainder was
//   reported "not a harness run file … no envelope verdict" at exit 0, silent
//   under `--quiet`, hiding the 15 legs the intact file replays. Reproduced
//   before the fix. Whole-record truncation must not be able to disguise
//   run-shaped evidence as a benign sibling.

/** A run file with its `run_meta` line removed — `runLines` always emits one
 *  first, so dropping index 0 is the truncation, and nothing else changes. */
const truncatedRun = (): string => `${runLines([archivedLeg()], { era: false }).slice(1).join('\n')}\n`;

test('a run file whose run_meta was deleted BLOCKS, and is not called a sibling', () => {
  const text = truncatedRun();
  // ⚠ THE FIXTURE MUST STILL CARRY A recordType, or this passes through the
  //   fire-artifact tier instead and proves nothing about truncation.
  assert.ok(text.includes('"recordType":"arm_game_response"'), 'or the run-shape tier is never reached');
  assert.ok(!text.includes('"recordType":"run_meta"'), 'the truncation must actually have happened');

  const { code, out } = cli({ 'truncated.ndjson': text }, ['truncated.ndjson']);
  assert.equal(code, REPLAY_EXIT.blocking);
  // ⚠ THE MESSAGE, not just the exit code: a fixture that accidentally carried
  //   no recordType at all would also exit 1, via the fire-artifact tier, and
  //   this test would pass for a reason unrelated to truncation.
  assert.ok(
    out.some((line) => line.includes('carrying 0 run_meta records')),
    out.join('\n'),
  );
  assert.ok(!out.some((line) => line.includes('not a harness run file')), out.join('\n'));
});

test('a truncated run is named under --quiet too', () => {
  const { code, out } = cli({ 'truncated.ndjson': truncatedRun() }, ['--quiet', 'truncated.ndjson']);
  assert.equal(code, REPLAY_EXIT.blocking);
  assert.equal(out.length, 1, out.join('\n'));
  assert.ok(out[0]!.startsWith('truncated.ndjson: unreadable run file: '), out[0]);
});

test('a MIXED stream — sibling records beside run records — blocks on the run records', () => {
  // The case the two tiers can disagree about. A sibling family is silent, run
  // records are not, and a stream carrying both is a run file with something
  // else concatenated onto it — never a reason to go quiet.
  const mixed = `{"recordType":"scored_run_meta","runId":"r"}\n${truncatedRun()}`;
  const { code, out } = cli({ 'mixed.ndjson': mixed }, ['mixed.ndjson']);
  assert.equal(code, REPLAY_EXIT.blocking);
  assert.ok(out.some((line) => line.includes('carrying 0 run_meta records')), out.join('\n'));
});

test('a run file carrying TWO run_meta records blocks — identity is ambiguous', () => {
  // The other half of "exactly one". The scorer refuses this outright; a reader
  // that silently took the last one would attribute legs to whichever record
  // happened to sort later.
  const lines = runLines([archivedLeg()], { era: false });
  const doubled = `${[lines[0]!, ...lines].join('\n')}\n`;
  const { code, out } = cli({ 'doubled.ndjson': doubled }, ['doubled.ndjson']);
  assert.equal(code, REPLAY_EXIT.blocking);
  assert.ok(out.some((line) => line.includes('carrying 2 run_meta records')), out.join('\n'));
});

test('...and the negative control: exactly one run_meta still replays normally', () => {
  // Without this, every case above passes on a build that blocks everything —
  // which is the regression the sibling tier exists to prevent.
  const { code, out } = cli({ 'good.ndjson': `${runLines([archivedLeg()], { era: false }).join('\n')}\n` }, [
    'good.ndjson',
  ]);
  assert.equal(code, REPLAY_EXIT.ok, out.join('\n'));
  assert.ok(out.some((line) => line.includes('PRE-RETENTION')), out.join('\n'));
});

test('a run_meta with no runId still reports its legs, under "run (unknown)"', () => {
  // ⚠ THE OVER-BLOCKING CONTROL for the three cases above, and a deliberate
  //   limit on how strict this gate gets. The blocker they close is evidence
  //   being HIDDEN; a damaged identity record hides nothing — every leg is still
  //   read and reported. Refusing it would throw away a readable evidence report
  //   over a cosmetic defect and make this reader stricter than the shapes it
  //   exists to read. The scorer, whose subject IS the run rather than the legs,
  //   strict-parses run_meta and is the right place for that.
  //
  //   Asked adversarially rather than assumed: what does tolerating this let
  //   someone do that "run-shaped evidence cannot be disguised" forbids?
  //   Nothing — the legs are all reported, and the identity is printed as
  //   unknown rather than guessed.
  const lines = runLines([archivedLeg()], { era: false });
  const meta = JSON.parse(lines[0]!) as Record<string, unknown>;
  delete meta['runId'];
  const text = `${[JSON.stringify(meta), ...lines.slice(1)].join('\n')}\n`;

  const { code, out } = cli({ 'noid.ndjson': text }, ['noid.ndjson']);
  assert.equal(code, REPLAY_EXIT.ok, out.join('\n'));
  assert.ok(out.some((line) => line.includes('run (unknown)')), out.join('\n'));
  // The legs are the point: a build that blocked here would report none.
  assert.ok(out.some((line) => line.includes('1 envelope-unavailable')), out.join('\n'));
});

test('RUN_RECORD_TYPES tracks what records.ts actually writes', () => {
  // Drift guard, anchored on executable object-literal syntax rather than on
  // prose. `records.ts` is the only producer of a run file, so its
  // `recordType: '…'` literals ARE the run vocabulary — and it is the right
  // authority rather than the scorer's switch, whose `default: break` means it
  // TOLERATES types it does not know. If records.ts gains one and this set does
  // not, a stream carrying only that new type stops counting as run-shaped and
  // a truncated run could pass as a sibling again.
  const source = readFileSync(new URL('./records.ts', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const written = new Set([...source.matchAll(/recordType: '([a-z_]+)'/g)].map((match) => match[1]!));
  assert.ok(written.size > 1, 'the extraction matched nothing, so this asserts nothing');
  written.delete('run_meta'); // the identity record itself, not a shape marker
  assert.deepEqual([...written].sort(), [...RUN_RECORD_TYPES].sort());
});

test('the library refuses the unrecognised shape too, not only the CLI', () => {
  // The exported reader is the API a future caller reaches for; a guard that
  // lived only in the CLI would leave it reporting the vacuous verdict.
  assert.throws(() => replaySearchAudits([oneLineObject()]), /not a harness run file/);
  // ...and the sibling tier RETURNS rather than throwing, which is what keeps
  // the directory sweep quiet. Paired here so one cannot be changed alone.
  assert.doesNotThrow(() => replaySearchAudits(['{"recordType":"scored_run_meta"}']));
  assert.equal(replaySearchAudits(['{"recordType":"scored_run_meta"}']).isRunFile, false);
});
