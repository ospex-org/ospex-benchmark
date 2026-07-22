import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CohortBootError, assertBootedCohort, cohortBoot } from './cohortBoot.js';
import { cohortId, parseManifest } from './manifest.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';

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

  const booted = cohortBoot({ live: false, manifestBytes: bytes });
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
    () => cohortBoot({ live: false, manifestBytes: JSON.stringify(raw) }),
    (e: unknown) => e instanceof CohortBootError && /marketPolicyDigest mismatch/.test(e.message),
  );
});
