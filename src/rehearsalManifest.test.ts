import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CohortBootError, assertBootedCohort, cohortBoot } from './cohortBoot.js';
import { cohortId, parseManifest } from './manifest.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import { SCHEDULE_CHANGE_TOLERANCE_MS } from './scoring.js';

/**
 * The in-process rehearsal manifest generator. Because every code-owned field is
 * imported from the running code, `cohortBoot` must accept the generated manifest —
 * that acceptance IS the rot guard: if a digest, version, or roster drifts in code
 * while the generator hardcodes an old value, this test fails loudly instead of a
 * silent runtime boot failure. The drift test proves `cohortBoot` really validates.
 */

const NOW = Date.parse('2026-07-18T12:00:40.000Z');

test('buildRehearsalManifest is code-consistent: cohortBoot accepts it and the cohortId matches', () => {
  const { manifest, bytes } = buildRehearsalManifest(NOW);

  const booted = cohortBoot({ manifestBytes: bytes });
  assert.doesNotThrow(() => assertBootedCohort(booted));
  assert.equal(booted.cohortId, cohortId(parseManifest(JSON.parse(bytes) as unknown)));
  // The returned manifest is the strict parse of the returned bytes.
  assert.deepEqual(manifest, booted.manifest);
});

test('buildRehearsalManifest builds a now-relative window that brackets now', () => {
  const { manifest } = buildRehearsalManifest(NOW);
  assert.ok(Date.parse(manifest.windowStart) < NOW, 'now is after windowStart');
  assert.ok(NOW < Date.parse(manifest.windowEnd), 'now is before windowEnd');
  assert.ok(Date.parse(manifest.windowStart) < Date.parse(manifest.windowEnd), 'window is a forward interval');
});

test('a drifted code-owned digest fails cohortBoot (the code-consistency guard is real)', () => {
  const { bytes } = buildRehearsalManifest(NOW);
  const raw = JSON.parse(bytes) as Record<string, unknown>;
  raw.marketPolicyDigest = 'f'.repeat(64); // well-formed hex, wrong value
  assert.throws(
    () => cohortBoot({ manifestBytes: JSON.stringify(raw) }),
    (e: unknown) => e instanceof CohortBootError && /marketPolicyDigest mismatch/.test(e.message),
  );
});

test('the rehearsal manifest tags schedule changes at the SAME tolerance the scoring CLI uses', () => {
  // Two paths, one knob name, one policy version: the cohort runner takes
  // the tolerance from its hashed manifest and `yarn score` from the code
  // constant. A literal in the generator would let them drift silently and
  // both would still stamp `scoring-v0.6.0`. The generator imports the
  // constant, and this is what makes that a checked property rather than a
  // convention — change the literal back and this goes red.
  const { manifest } = buildRehearsalManifest(NOW);
  assert.equal(manifest.constants.scheduleChangeToleranceMs, SCHEDULE_CHANGE_TOLERANCE_MS);
  // ...and the constant itself is pinned, so a change to it is deliberate.
  assert.equal(SCHEDULE_CHANGE_TOLERANCE_MS, 60_000);
});

test('the README quotes the schedule tolerance as the number the code actually uses', () => {
  // The README is a public policy statement and states the tolerance in
  // prose. A prose number nothing checks is exactly the doc-untruth class
  // this repo keeps finding, so it is pinned to the constant.
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(
    readme.includes(`${SCHEDULE_CHANGE_TOLERANCE_MS} ms`),
    'the README states the tolerance as the code constant renders it',
  );
  assert.ok(
    readme.includes('SCHEDULE_CHANGE_TOLERANCE_MS'),
    'and names the constant, so a reader can find its single source',
  );
});
