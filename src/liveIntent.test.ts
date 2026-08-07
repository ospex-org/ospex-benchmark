import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cohortBoot } from './cohortBoot.js';
import type { BootedCohort } from './cohortBoot.js';
import { buildCrossingManifest } from './crossingProfile.js';
import { resolveLiveIntent } from './liveIntent.js';
import type { LiveIntentRequest, LiveIntentResolution } from './liveIntent.js';
import { modelPriceTableDigest } from './modelPriceTable.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import { defaultExpectedArms } from './scoring.js';

/**
 * Tri-state live-intent resolution: `MockRequested` touches nothing; a live
 * request is refused (typed, accumulated violations, no prompt) on any pin or
 * credential violation; the exact terms print BEFORE the single confirmation;
 * explicit affirmatives and empty Enter authorize; other answers and EOF refuse;
 * and the authorization is the exact frozen record the gated producer expects.
 * A refused or unconfirmed live request NEVER resolves to mock.
 */

const FIXED_NOW = Date.parse('2026-07-18T12:00:00.000Z');
const ROSTER = defaultExpectedArms().map((a) => a.participantId);

function bootedCrossing(now: number = FIXED_NOW): BootedCohort {
  return cohortBoot({ manifestBytes: buildCrossingManifest(now).bytes });
}
function bootedRehearsal(): BootedCohort {
  return cohortBoot({ manifestBytes: buildRehearsalManifest(FIXED_NOW).bytes });
}

/** A scripted resolver request with one shared event log (sequencing is part of the contract). */
interface Harness {
  readonly request: LiveIntentRequest;
  readonly events: string[];
  readonly printed: string[];
}
function harness(over: {
  live: boolean;
  booted: BootedCohort;
  credentialed?: (id: string) => boolean;
  answer?: string | null;
}): Harness {
  const events: string[] = [];
  const printed: string[] = [];
  const credentialed = over.credentialed ?? ((): boolean => true);
  const request: LiveIntentRequest = {
    live: over.live,
    booted: over.booted,
    observeCredentials: (ids) => {
      events.push(`observe:${ids.join(',')}`);
      return new Map(ids.map((id) => [id, credentialed(id)]));
    },
    print: (line) => {
      events.push('print');
      printed.push(line);
    },
    confirm: async (prompt) => {
      events.push(`confirm:${prompt}`);
      return over.answer === undefined ? 'y' : over.answer;
    },
  };
  return { request, events, printed };
}

test('live:false resolves MockRequested without observing, printing, or prompting', async () => {
  const h = harness({ live: false, booted: bootedCrossing() });
  const resolution = await resolveLiveIntent(h.request);
  assert.deepEqual(resolution, { kind: 'MockRequested' });
  assert.ok(Object.isFrozen(resolution));
  assert.deepEqual(h.events, [], 'no seam was touched');
});

test('a forged (structurally-copied) booted cohort throws on BOTH paths — never resolves', async () => {
  const genuine = bootedCrossing();
  const forged = { cohortId: genuine.cohortId, manifest: genuine.manifest } as BootedCohort;
  for (const live of [false, true]) {
    const h = harness({ live, booted: forged });
    await assert.rejects(
      () => resolveLiveIntent(h.request),
      /not produced by cohortBoot/,
      `live=${live}`,
    );
  }
});

test('live + a non-crossing cohort refuses with named pin violations — no print, no prompt, no mock', async () => {
  const h = harness({ live: true, booted: bootedRehearsal() });
  const resolution = await resolveLiveIntent(h.request);
  assert.equal(resolution.kind, 'LiveRefused');
  if (resolution.kind !== 'LiveRefused') return;
  assert.ok(Object.isFrozen(resolution) && Object.isFrozen(resolution.violations));
  assert.ok(
    resolution.violations.some((v) => /cohortSpendCapUsdMicros/.test(v)),
    `pin violations named: [${resolution.violations.join('; ')}]`,
  );
  // The credential probe MAY run (violations accumulate) but nothing prints and no prompt shows.
  assert.deepEqual(h.printed, [], 'no terms printed for an unauthorizable run');
  assert.ok(!h.events.some((e) => e.startsWith('confirm:')), 'the prompt was never shown');
});

test('live + one missing credential refuses NAMING the participant — accumulated with any pin violations', async () => {
  // Crossing cohort, google arm not credentialed: exactly one named credential violation.
  const missingOne = harness({
    live: true,
    booted: bootedCrossing(),
    credentialed: (id) => id !== 'google-gemini-3.1-pro-preview',
  });
  const r1 = await resolveLiveIntent(missingOne.request);
  assert.equal(r1.kind, 'LiveRefused');
  if (r1.kind !== 'LiveRefused') return;
  assert.deepEqual(r1.violations, [
    'participant "google-gemini-3.1-pro-preview" has no usable credential (its adapter\'s credential probe returned false)',
  ]);
  assert.ok(!missingOne.events.some((e) => e.startsWith('confirm:')), 'never prompted');

  // Rehearsal cohort + no credentials at all: BOTH violation classes accumulate in one refusal.
  const both = harness({ live: true, booted: bootedRehearsal(), credentialed: () => false });
  const r2 = await resolveLiveIntent(both.request);
  assert.equal(r2.kind, 'LiveRefused');
  if (r2.kind !== 'LiveRefused') return;
  assert.ok(r2.violations.some((v) => /cohortSpendCapUsdMicros/.test(v)), 'pin class present');
  assert.ok(r2.violations.some((v) => /no usable credential/.test(v)), 'credential class present');
});

test('an ABSENT credential observation (id missing from the returned map) reads as not credentialed — fail closed', async () => {
  const events: string[] = [];
  const request: LiveIntentRequest = {
    live: true,
    booted: bootedCrossing(),
    observeCredentials: () => new Map(), // observes NOTHING — no id present at all
    print: () => events.push('print'),
    confirm: async () => {
      events.push('confirm');
      return 'y';
    },
  };
  const resolution = await resolveLiveIntent(request);
  assert.equal(resolution.kind, 'LiveRefused');
  if (resolution.kind !== 'LiveRefused') return;
  assert.equal(resolution.violations.length, ROSTER.length, 'every roster arm refused');
  assert.deepEqual(events, [], 'no print, no prompt');
});

test('the exact terms print BEFORE the single confirmation: cohortId, $800.00, call cap 8, one fire', async () => {
  const booted = bootedCrossing();
  const h = harness({ live: true, booted, answer: 'y' });
  const resolution = await resolveLiveIntent(h.request);
  assert.equal(resolution.kind, 'LiveAuthorized');

  assert.ok(h.printed.some((l) => l.includes(booted.cohortId)), 'the exact cohortId printed');
  assert.ok(
    h.printed.some((l) => l.includes('$800.00') && l.includes('800000000')),
    'the $800 reservation ceiling printed (dollars AND micros)',
  );
  assert.ok(h.printed.some((l) => /provider call cap 8/.test(l)), 'the 8-call cap printed');
  assert.ok(h.printed.some((l) => /one fire maximum/.test(l)), 'the one-fire limit printed');

  // Sequencing on the ONE shared event log: every print strictly precedes the one confirm —
  // whose recorded event pins the EXACT frozen prompt bytes (label drift fails here).
  const confirmEvents = h.events.filter((e) => e.startsWith('confirm:'));
  assert.deepEqual(
    confirmEvents,
    ['confirm:proceed with the attended live crossing? [Y/n] '],
    'the confirmation is requested exactly once, with the exact [Y/n] prompt bytes',
  );
  const lastPrint = h.events.lastIndexOf('print');
  assert.ok(lastPrint >= 0 && lastPrint < h.events.indexOf(confirmEvents[0]!), 'every term printed before the prompt');
});

test('the standard [Y/n] semantics: y/yes AND the empty Enter default authorize; n/other/EOF refuse (never mock)', async () => {
  // POSITIVE and DEFAULT: explicit affirmatives, and the empty Enter accepting the
  // capital-Y default (whitespace-only trims to empty and reads as Enter).
  const affirmatives = ['y', 'Y', 'yes', 'Yes', ' y ', '', '   '];
  for (const answer of affirmatives) {
    const h = harness({ live: true, booted: bootedCrossing(), answer });
    const resolution = await resolveLiveIntent(h.request);
    assert.equal(resolution.kind, 'LiveAuthorized', `answer ${JSON.stringify(answer)} authorizes`);
  }
  // NEGATIVE and EOF: any non-affirmative answer refuses, and a stream that closes
  // without producing a line is EOF rather than the empty-line Enter default.
  const refusals: (string | null)[] = ['n', 'N', 'no', 'q', 'yeah', 'true', '1', null];
  for (const answer of refusals) {
    const h = harness({ live: true, booted: bootedCrossing(), answer });
    const resolution = await resolveLiveIntent(h.request);
    assert.equal(resolution.kind, 'LiveRefused', `answer ${JSON.stringify(answer)} refuses`);
    if (resolution.kind !== 'LiveRefused') return;
    assert.ok(
      resolution.violations.some((v) =>
        answer === null ? /EOF/.test(v) : /declined/.test(v),
      ),
      `answer ${JSON.stringify(answer)}: the refusal names its cause`,
    );
    assert.ok(!('authorization' in resolution), 'a refusal carries no authorization');
  }
});

test('the authorization is the EXACT frozen record: booted identity, pinned caps, observed credentials', async () => {
  const booted = bootedCrossing();
  const h = harness({ live: true, booted, answer: 'y' });
  const resolution = await resolveLiveIntent(h.request);
  assert.equal(resolution.kind, 'LiveAuthorized');
  if (resolution.kind !== 'LiveAuthorized') return;

  // COMPLETE object equality — an undeclared field addition or a value drift fails here.
  assert.deepEqual(resolution.authorization, {
    cohortId: booted.cohortId,
    participantIds: ROSTER,
    modelPriceTableVersion: 'prices-v3',
    modelPriceTableDigest: modelPriceTableDigest('prices-v3'),
    liveOptIn: true,
    observedCredentialedParticipantIds: ROSTER,
    cohortSpendCapUsdMicros: 800_000_000,
    cohortCallCap: 8,
    maxConcurrentProviderRequests: 4,
    maxDispatchesPerTick: 1,
    maxRepairAttemptsPerArm: 1,
  });
  assert.ok(Object.isFrozen(resolution));
  assert.ok(Object.isFrozen(resolution.authorization));
  assert.ok(Object.isFrozen(resolution.authorization.participantIds));
  assert.ok(Object.isFrozen(resolution.authorization.observedCredentialedParticipantIds));
});

test('the credential probe receives EXACTLY the booted roster ids, once', async () => {
  const h = harness({ live: true, booted: bootedCrossing(), answer: 'y' });
  const resolution: LiveIntentResolution = await resolveLiveIntent(h.request);
  assert.equal(resolution.kind, 'LiveAuthorized');
  const observes = h.events.filter((e) => e.startsWith('observe:'));
  assert.deepEqual(observes, [`observe:${ROSTER.join(',')}`], 'one observation over the exact roster');
});
