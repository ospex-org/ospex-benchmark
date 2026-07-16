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
 * valid manifests carried as raw bytes (this check compares raw bytes, decodes
 * fail-closed, and derives cohortId/windowStart; it does not re-run the
 * code-consistency checks). Each case isolates one refusal — mismatched raw bytes,
 * a different published cohort, an offset-less/late committer timestamp — plus the
 * two binding guarantees §2 requires: the descriptor (and the local bytes) are
 * snapshotted before any resolver call, and equality is a RAW-BYTE compare (not a
 * decoded string).
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

const bytesOf = (raw: Record<string, unknown>, pretty = false): Buffer =>
  Buffer.from(JSON.stringify(raw, null, pretty ? 2 : undefined), 'utf-8');

const LOCAL_BYTES = bytesOf(validRaw());

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

// --- checkPublication: raw-byte equality + cohortId + timestamp ---

test('a matching, timely precommitment verifies and returns a frozen record', () => {
  const verified = checkPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolved: resolved() });
  assert.deepEqual(verified, { publication: PUB, committerTimestamp: BEFORE });
  // Frozen: neither the record nor its nested descriptor can drift after verification.
  assert.throws(() => {
    (verified as unknown as { committerTimestamp: string }).committerTimestamp = 'x';
  });
  assert.throws(() => {
    (verified.publication as unknown as { commitSha: string }).commitSha = 'e'.repeat(40);
  });
});

test('byte equality is stricter than cohortId — pretty vs compact refuses on bytes alone', () => {
  // Pretty-printed blob: byte-different from the compact local bytes, but the same
  // semantic manifest, so ONLY the raw-byte check fails (cohortId still matches).
  const err = assertThrowsPublication(() =>
    checkPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolved: resolved({ blobBytes: bytesOf(validRaw(), true) }) }),
  );
  assert.deepEqual(err.violations, ['published blob bytes differ from the local manifest bytes']);
});

test('CRLF vs LF byte differences fail even when cohort identity matches', () => {
  const lf = bytesOf(validRaw(), true);
  const crlf = Buffer.from(lf.toString('utf-8').replace(/\n/g, '\r\n'), 'utf-8');
  const err = assertThrowsPublication(() =>
    checkPublication({ localManifestBytes: lf, publication: PUB, resolved: { blobBytes: crlf, committerTimestamp: BEFORE } }),
  );
  assert.deepEqual(err.violations, ['published blob bytes differ from the local manifest bytes']);
});

test('raw byte comparison, not decoded-string — the U+FFFD collision is refused', () => {
  // ef bf bd (valid UTF-8 for U+FFFD) vs ff (invalid UTF-8): different raw bytes a
  // lossy decoder would collapse to the same "�" string. The raw-byte compare
  // rejects the difference, and fail-closed decoding rejects the invalid-UTF-8 blob.
  const local = Buffer.from([0xef, 0xbf, 0xbd]);
  const blob = Buffer.from([0xff]);
  const err = assertThrowsPublication(() =>
    checkPublication({ localManifestBytes: local, publication: PUB, resolved: { blobBytes: blob, committerTimestamp: BEFORE } }),
  );
  assert.ok(err.violations.some((v) => /blob bytes differ/.test(v)), err.violations.join('; '));
});

test('a published blob that is a different cohort fails both byte and cohortId checks', () => {
  const other = bytesOf(validRaw({ windowEnd: '2026-07-16T03:00:00.000Z' }));
  const err = assertThrowsPublication(() =>
    checkPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolved: resolved({ blobBytes: other }) }),
  );
  assert.ok(err.violations.some((v) => /blob bytes differ/.test(v)), err.violations.join('; '));
  assert.ok(err.violations.some((v) => /published cohortId .* != local cohortId/.test(v)), err.violations.join('; '));
});

test('a published blob that is not a valid manifest is flagged', () => {
  const err = assertThrowsPublication(() =>
    checkPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolved: resolved({ blobBytes: Buffer.from('{ not json', 'utf-8') }) }),
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
  for (const ts of ['not-a-date', '2026-07-16T09:00:00', '2026-07-15T23:00:00']) {
    const err = assertThrowsPublication(() =>
      checkPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolved: resolved({ committerTimestamp: ts }) }),
    );
    assert.ok(err.violations.some((v) => /explicit offset/.test(v)), `${ts}: ${err.violations.join('; ')}`);
  }
});

test('an explicit non-Z offset is compared by true instant, not host zone', () => {
  // windowStart is 2026-07-16T00:00:00Z. 04:00+05:00 == 2026-07-15T23:00:00Z (before -> verifies).
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

test('an invalid local manifest is flagged (self-contained parse)', () => {
  const err = assertThrowsPublication(() =>
    checkPublication({ localManifestBytes: Buffer.from('{ not json', 'utf-8'), publication: PUB, resolved: resolved({ blobBytes: Buffer.from('{ not json', 'utf-8') }) }),
  );
  assert.ok(err.violations.some((v) => /local manifest is not a valid manifest/.test(v)), err.violations.join('; '));
});

test('violations accumulate into one refusal', () => {
  const other = bytesOf(validRaw({ windowEnd: '2026-07-16T03:00:00.000Z' }));
  const err = assertThrowsPublication(() =>
    checkPublication({ localManifestBytes: LOCAL_BYTES, publication: PUB, resolved: { blobBytes: other, committerTimestamp: AFTER } }),
  );
  assert.ok(err.violations.some((v) => /blob bytes differ/.test(v)), err.violations.join('; '));
  assert.ok(err.violations.some((v) => /not strictly before/.test(v)), err.violations.join('; '));
});

test('a descriptor that bypassed strict parsing (branch-name commitSha) is refused', () => {
  const branchRef = { ...PUB, commitSha: 'main' } as ManifestPublicationV1;
  const err = assertThrowsPublication(() =>
    checkPublication({ localManifestBytes: LOCAL_BYTES, publication: branchRef, resolved: resolved() }),
  );
  assert.ok(err.violations.some((v) => /publication descriptor is invalid/.test(v)), err.violations.join('; '));
});

// --- verifyPublication: resolver + descriptor snapshot binding ---

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

test('an invalid descriptor is rejected before the resolver/network is touched', async () => {
  let resolverCalls = 0;
  const resolver: PublicationResolver = {
    resolve: () => {
      resolverCalls += 1;
      return Promise.resolve(resolved());
    },
  };
  const branchRef = { ...PUB, commitSha: 'main' } as ManifestPublicationV1;
  const err = await assertRejectsPublication(
    verifyPublication({ localManifestBytes: LOCAL_BYTES, publication: branchRef, resolver }),
  );
  assert.equal(resolverCalls, 0);
  assert.ok(err.violations.some((v) => /invalid descriptor/.test(v)), err.violations.join('; '));
});

test('the descriptor is snapshotted+frozen before resolve — a cross-await mutation cannot rebind the record', async () => {
  const original: ManifestPublicationV1 = {
    repositoryOwner: 'owner-a',
    repositoryName: 'repo-a',
    path: 'path-a.json',
    commitSha: 'a'.repeat(40),
  };
  const snapshotBound = { ...original };
  let seen: ManifestPublicationV1 | undefined;
  const resolver: PublicationResolver = {
    resolve: (p) => {
      seen = { ...p };
      // (a) the received descriptor is the frozen snapshot — a resolver-side mutation throws.
      assert.throws(() => {
        (p as unknown as { commitSha: string }).commitSha = 'b'.repeat(40);
      });
      // (b) mutate the caller's ORIGINAL descriptor across the await, on EVERY field.
      original.repositoryOwner = 'owner-b';
      original.repositoryName = 'repo-b';
      original.path = 'path-b.json';
      original.commitSha = 'b'.repeat(40);
      return Promise.resolve(resolved());
    },
  };
  const verified = await verifyPublication({ localManifestBytes: LOCAL_BYTES, publication: original, resolver });
  // The resolver saw the original values, and the persisted record is bound to them —
  // owner/repo/path/commitSha all covered, not only the SHA.
  assert.deepEqual(seen, snapshotBound);
  assert.deepEqual(verified.publication, snapshotBound);
});

test('local bytes are detached before resolve — a cross-await buffer mutation cannot flip the verdict', async () => {
  const local = Buffer.from(LOCAL_BYTES); // caller-owned buffer, mutated mid-resolve
  const blob = Buffer.from(LOCAL_BYTES); // the resolver returns the published bytes
  const resolver: PublicationResolver = {
    resolve: () => {
      local.fill(0); // caller mutates the shared buffer while resolve() is pending
      return Promise.resolve({ blobBytes: blob, committerTimestamp: BEFORE });
    },
  };
  // verifyPublication copied the bytes before the await, so the check still sees the
  // published content and verifies (without the copy it would spuriously refuse).
  const verified = await verifyPublication({ localManifestBytes: local, publication: PUB, resolver });
  assert.equal(verified.committerTimestamp, BEFORE);
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
