import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PublicationError,
  checkPublication,
  parseManifestPublication,
  verifyPublication,
} from './manifestPublication.js';
import type {
  ManifestPublicationV1,
  PublicationResolver,
  ResolvedPublication,
} from './manifestPublication.js';

/**
 * Public-Git precommitment verification (§2, case 17). Fixtures are structurally
 * valid manifests (this check parses + derives cohortId/windowStart; it does not
 * re-run the code-consistency checks). Each case isolates one refusal — mismatched
 * bytes, a different published cohort, or a committer timestamp not strictly before
 * windowStart — plus the resolver-failure and frozen-record guarantees.
 */

const WINDOW_START = '2026-07-16T00:00:00.000Z';
const BEFORE = '2026-07-15T23:59:59.000Z';
const EQUAL = '2026-07-16T00:00:00.000Z';
const AFTER = '2026-07-16T00:00:01.000Z';

const PUB: ManifestPublicationV1 = {
  repositoryOwner: 'ospex-org',
  repositoryName: 'ospex-benchmark',
  path: 'cohorts/2026-07-16.json',
  commitSha: 'f'.repeat(40),
};

function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactSchemaVersion: 1,
    network: 'polygon',
    sportAllowList: ['mlb'],
    windowStart: WINDOW_START,
    windowEnd: '2026-07-16T02:00:00.000Z',
    source: 'jsonodds',
    sourceQueryVersion: 'source-query-v1',
    marketPolicyVersion: 'market-policy-v1',
    marketPolicyDigest: 'a'.repeat(64),
    promptScaffoldSha256: 'b'.repeat(64),
    expectedArmRoster: [
      { participantId: 'p1', provider: 'openai', requestedModelId: 'm1', approvedReportedModelIds: ['m1'] },
    ],
    toolInferenceConfigSha256: 'c'.repeat(64),
    baselinePolicyVersion: 'baselines-v0.2.0',
    repairPolicyVersion: 'repair-v1',
    scoringPolicyVersion: 'scoring-v0.4.0',
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: 'prices-v1',
    modelPriceTableDigest: 'd'.repeat(64),
    runnerCommitSha: 'e'.repeat(40),
    constants: {
      pollIntervalMs: 30000,
      cleanEntryWindowMs: 120000,
      gameDiscoveryWindowHours: 168,
      maxClockSkewMs: 5000,
      freshFireMs: 30000,
      maxDispatchLagMs: 10000,
      historyReadTimeoutMs: 30000,
      providerCallTimeoutMs: 300000,
      maxOutputTokens: 16000,
      maxRepairAttemptsPerArm: 1,
      ingestionGraceMs: 900000,
      scheduleChangeToleranceMs: 60000,
      maxConcurrentProviderRequests: 1,
      maxDispatchesPerTick: 10,
    },
    cohortCallCap: 1000,
    cohortSpendCapUsdMicros: 5000000,
    ...overrides,
  };
}

const LOCAL_BYTES = JSON.stringify(validRaw());

function resolved(over: Partial<ResolvedPublication> = {}): ResolvedPublication {
  return { blobBytes: LOCAL_BYTES, committerTimestamp: BEFORE, ...over };
}

// --- schema ---

test('parseManifestPublication accepts a valid descriptor and rejects malformed ones', () => {
  assert.deepEqual(parseManifestPublication(PUB), PUB);
  assert.throws(() => parseManifestPublication({ ...PUB, extra: 'x' }), /invalid manifest publication/); // strict
  assert.throws(() => parseManifestPublication({ ...PUB, commitSha: undefined }), /commitSha/);
  for (const bad of ['main', 'F'.repeat(40), 'f'.repeat(39), 'f'.repeat(41), 'abc123']) {
    assert.throws(() => parseManifestPublication({ ...PUB, commitSha: bad }), /commitSha/, `commitSha=${bad}`);
  }
  assert.throws(() => parseManifestPublication({ ...PUB, repositoryOwner: '' }), /repositoryOwner/);
  assert.throws(() => parseManifestPublication({ ...PUB, path: '' }), /path/);
});

// --- checkPublication ---

test('a matching, timely precommitment verifies and returns a frozen record', () => {
  const verified = checkPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolved: resolved() });
  assert.deepEqual(verified, { publication: PUB, committerTimestamp: BEFORE });
  // Frozen: neither the record nor its nested descriptor can drift after verification.
  assert.throws(() => {
    (verified as unknown as { committerTimestamp: string }).committerTimestamp = 'x';
  });
  assert.throws(() => {
    (verified.publication as unknown as { commitSha: string }).commitSha = 'f'.repeat(40).replace('f', 'e');
  });
});

test('byte equality is stricter than cohortId — same manifest, different bytes still refuses', () => {
  // Pretty-printed blob: byte-different from the compact local bytes, but the same
  // semantic manifest, so ONLY the raw-byte check fails (cohortId still matches).
  const pretty = JSON.stringify(validRaw(), null, 2);
  const err = assertThrowsPublication(() =>
    checkPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolved: resolved({ blobBytes: pretty }) }),
  );
  assert.deepEqual(err.violations, ['published blob bytes differ from the local manifest bytes']);
});

test('a published blob that is a different cohort fails both byte and cohortId checks', () => {
  const other = JSON.stringify(validRaw({ windowEnd: '2026-07-16T03:00:00.000Z' }));
  const err = assertThrowsPublication(() =>
    checkPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolved: resolved({ blobBytes: other }) }),
  );
  assert.ok(err.violations.some((v) => /blob bytes differ/.test(v)), err.violations.join('; '));
  assert.ok(err.violations.some((v) => /published cohortId .* != local cohortId/.test(v)), err.violations.join('; '));
});

test('a published blob that is not a valid manifest is flagged', () => {
  const err = assertThrowsPublication(() =>
    checkPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolved: resolved({ blobBytes: '{ not json' }) }),
  );
  assert.ok(err.violations.some((v) => /published blob is not a valid manifest/.test(v)), err.violations.join('; '));
});

test('a committer timestamp equal to or after windowStart is not strictly before -> refuses', () => {
  for (const ts of [EQUAL, AFTER]) {
    const err = assertThrowsPublication(() =>
      checkPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolved: resolved({ committerTimestamp: ts }) }),
    );
    assert.ok(err.violations.some((v) => /not strictly before windowStart/.test(v)), `${ts}: ${err.violations.join('; ')}`);
  }
});

test('a garbage or offset-less committer timestamp is refused (no host-local interpretation)', () => {
  // A naive (offset-less) ISO string would be read by Date.parse in the runner's
  // local zone and compared against a UTC windowStart — a host-dependent verdict.
  // Both a garbage value and a valid-but-offset-less one must fail closed.
  for (const ts of ['not-a-date', '2026-07-16T09:00:00', '2026-07-15T23:00:00']) {
    const err = assertThrowsPublication(() =>
      checkPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolved: resolved({ committerTimestamp: ts }) }),
    );
    assert.ok(err.violations.some((v) => /explicit offset/.test(v)), `${ts}: ${err.violations.join('; ')}`);
  }
});

test('an explicit non-Z offset is compared by true instant, not host zone', () => {
  // windowStart is 2026-07-16T00:00:00Z. Both fixtures use a +05:00 offset so the
  // true instant — not the wall-clock digits — decides, independent of host zone.
  // 04:00+05:00 == 2026-07-15T23:00:00Z (before -> verifies).
  const verified = checkPublication({
    localManifestBytes: LOCAL_BYTES,
    publication: PUB,
    resolved: resolved({ committerTimestamp: '2026-07-16T04:00:00+05:00' }),
  });
  assert.equal(verified.committerTimestamp, '2026-07-16T04:00:00+05:00');
  // 06:00+05:00 == 2026-07-16T01:00:00Z (after -> refuses) even though "06:00" looks late-morning.
  const err = assertThrowsPublication(() =>
    checkPublication({
      localManifestBytes: LOCAL_BYTES,
      publication: PUB,
      resolved: resolved({ committerTimestamp: '2026-07-16T06:00:00+05:00' }),
    }),
  );
  assert.ok(err.violations.some((v) => /not strictly before/.test(v)), err.violations.join('; '));
});

test('a descriptor that bypassed strict parsing (branch-name commitSha) is refused', () => {
  // commitSha is not used in the pass/refuse logic, but it is persisted into the
  // step-6 evidence, so a non-canonical descriptor smuggled past parseManifestPublication
  // must still be rejected rather than frozen into the record.
  const branchRef = { ...PUB, commitSha: 'main' } as ManifestPublicationV1;
  const err = assertThrowsPublication(() =>
    checkPublication({ localManifestBytes: LOCAL_BYTES, publication: branchRef, resolved: resolved() }),
  );
  assert.ok(err.violations.some((v) => /publication descriptor is invalid/.test(v)), err.violations.join('; '));
});

test('an invalid local manifest is flagged (self-contained parse)', () => {
  const err = assertThrowsPublication(() =>
    checkPublication({ localManifestBytes: '{ not json', publication: PUB, resolved: resolved({ blobBytes: '{ not json' }) }),
  );
  assert.ok(err.violations.some((v) => /local manifest is not a valid manifest/.test(v)), err.violations.join('; '));
});

test('violations accumulate into one refusal', () => {
  const other = JSON.stringify(validRaw({ windowEnd: '2026-07-16T03:00:00.000Z' }));
  const err = assertThrowsPublication(() =>
    checkPublication({
      localManifestBytes: LOCAL_BYTES,
      publication: PUB,
      resolved: { blobBytes: other, committerTimestamp: AFTER },
    }),
  );
  assert.ok(err.violations.some((v) => /blob bytes differ/.test(v)), err.violations.join('; '));
  assert.ok(err.violations.some((v) => /not strictly before/.test(v)), err.violations.join('; '));
});

// --- verifyPublication (async, injected resolver) ---

test('verifyPublication resolves via the injected resolver and returns the verified record', async () => {
  const resolver: PublicationResolver = { resolve: () => Promise.resolve(resolved()) };
  const verified = await verifyPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolver });
  assert.deepEqual(verified, { publication: PUB, committerTimestamp: BEFORE });
});

test('a resolver that cannot resolve the commit fails the run', async () => {
  const resolver: PublicationResolver = { resolve: () => Promise.reject(new Error('404 commit not found')) };
  const err = await assertRejectsPublication(
    verifyPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolver }),
  );
  assert.ok(err.violations.some((v) => /resolve failed/.test(v)), err.violations.join('; '));
  assert.match(err.message, /could not resolve public commit/);
});

test('verifyPublication still enforces the checks after a successful resolve', async () => {
  const resolver: PublicationResolver = { resolve: () => Promise.resolve(resolved({ committerTimestamp: AFTER })) };
  const err = await assertRejectsPublication(
    verifyPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolver }),
  );
  assert.ok(err.violations.some((v) => /not strictly before/.test(v)), err.violations.join('; '));
});

function assertThrowsPublication(fn: () => unknown): PublicationError {
  let caught: unknown;
  assert.throws(fn, (error: unknown) => {
    caught = error;
    return error instanceof PublicationError;
  });
  return caught as PublicationError;
}

async function assertRejectsPublication(promise: Promise<unknown>): Promise<PublicationError> {
  let caught: unknown;
  await assert.rejects(promise, (error: unknown) => {
    caught = error;
    return error instanceof PublicationError;
  });
  return caught as PublicationError;
}
