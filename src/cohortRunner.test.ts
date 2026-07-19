import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import {
  LineOpenFireFn,
  NoopAttemptLifecycle,
  deriveFireId,
  deriveRunId,
  runOneFire,
} from './cohortRunner.js';
import type { FireDeps, PreparedFire } from './cohortRunner.js';
import { parseFireArtifactV1, verifyFireArtifactReplay } from './fireArtifactWriter.js';
import { LineOpenArtifactSink } from './lineOpenArtifactSink.js';
import { RehearsalClaimPort, StoreClaimPort, assertDispatchPermit } from './lineOpenClaim.js';
import type { DispatchPermit } from './lineOpenClaim.js';
import { SqlAtomicStore } from './store/atomicStore.js';
import type { StoreQuery } from './store/atomicStore.js';
import { LINE_OPEN_ARMS, LINE_OPEN_GAME_ID, prepareLineOpenFire } from './testFactories.js';
import type { MarketKey } from './types.js';

/**
 * The line-open runner walking skeleton (SPEC §3/§4/§5): the claim → fire → produce →
 * persist spine, proven end-to-end for one prepared, already-eligible fire through the
 * real store adapter (scripted `admitted` executor), the real `runSlate`, the real
 * `buildFireArtifact`, and the atomic no-clobber sink. Plus the frozen acceptance teeth:
 * rehearsal cannot mint a permit or write an artifact; the sink is permit-gated,
 * atomic/no-clobber, base64url-safe; and the fire id is the pre-admit anchor.
 */

/** A scripted store executor that admits every dispatch (the DB is exercised for real by
 *  the store conformance gate; here the adapter's mapping is what matters). */
function admittedStoreQuery(rosterSize: number): StoreQuery {
  return (sql, params) => {
    if (!sql.includes('admit_dispatch')) throw new Error(`unexpected store call in fixture: ${sql}`);
    const gameId = params[4] as string;
    const proposedMarkets = JSON.parse(params[5] as string) as MarketKey[];
    const scope = JSON.parse(params[6] as string) as Record<string, { spend: number; digest: string }>;
    const scopeKey = proposedMarkets.join('+');
    const r = {
      outcome: 'admitted',
      claimedKeys: proposedMarkets.map((market) => ({ gameId, market })),
      preparedBytesDigest: scope[scopeKey]?.digest ?? 'f'.repeat(64),
      initialLeases: Array.from({ length: rosterSize }, (_, i) => ({
        leaseId: `lease-${i}`,
        armIndex: i,
        expiresAt: '2026-07-18T12:10:00.000Z',
        state: 'live',
      })),
      dispatchAuthorized: true,
    };
    return Promise.resolve([{ r }]);
  };
}

function storeDeps(overrides: Partial<FireDeps> = {}): FireDeps {
  return {
    claimPort: new StoreClaimPort(new SqlAtomicStore(admittedStoreQuery(LINE_OPEN_ARMS.length))),
    fireFn: new LineOpenFireFn(),
    artifactSink: new LineOpenArtifactSink(mkdtempSync(join(tmpdir(), 'f5a-'))),
    lifecycle: new NoopAttemptLifecycle(),
    ownerId: 'owner-test',
    storeSchemaVersion: 1,
    spendReservationUsdMicros: 1_000,
    ...overrides,
  };
}

function cleanup(deps: FireDeps): void {
  const sink = deps.artifactSink as LineOpenArtifactSink;
  const dir = (sink as unknown as { baseDir: string }).baseDir;
  rmSync(dir, { recursive: true, force: true });
}

// --- walking skeleton: one fire, end-to-end ---------------------------------

test('a 2-market fire runs claim → fire → produce → persist and installs a replay-clean artifact', async () => {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const deps = storeDeps();
  try {
    const result = await runOneFire(fire, deps);
    assert.equal(result.fired, true);
    assert.equal(result.outcome.kind, 'Authorized');
    assert.ok(result.path && existsSync(result.path));
    // The persisted file is self-verifying from its own bytes.
    const reloaded = parseFireArtifactV1(readFileSync(result.path!, 'utf8'));
    assert.deepEqual(verifyFireArtifactReplay(reloaded), []);
    assert.deepEqual(reloaded.scopedMarkets, ['moneyline', 'total']);
    assert.equal(reloaded.gameId, LINE_OPEN_GAME_ID);
    assert.equal(reloaded.arms.length, LINE_OPEN_ARMS.length);
  } finally {
    cleanup(deps);
  }
});

test('a 1-market (moneyline-only) fire persists a replay-clean single-market artifact', async () => {
  const { fire } = prepareLineOpenFire(['moneyline']);
  const deps = storeDeps();
  try {
    const result = await runOneFire(fire, deps);
    assert.equal(result.fired, true);
    const reloaded = parseFireArtifactV1(readFileSync(result.path!, 'utf8'));
    assert.deepEqual(verifyFireArtifactReplay(reloaded), []);
    assert.deepEqual(reloaded.scopedMarkets, ['moneyline']);
  } finally {
    cleanup(deps);
  }
});

// --- frozen tooth: rehearsal cannot mint a permit or write an artifact -------

test('a rehearsal claim never admits, fires nothing, and writes no artifact', async () => {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const deps = storeDeps({ claimPort: new RehearsalClaimPort() });
  try {
    const result = await runOneFire(fire, deps);
    assert.equal(result.fired, false);
    assert.equal(result.outcome.kind, 'WouldAdmit');
    assert.equal(result.path, undefined);
    assert.equal(result.artifact, undefined);
    const dir = (deps.artifactSink as unknown as { baseDir: string }).baseDir;
    assert.deepEqual(readdirSync(dir), []); // nothing installed
  } finally {
    cleanup(deps);
  }
});

test('a dispatch permit cannot be forged by a structural copy', () => {
  const forged = {
    cohortId: 'x',
    fireId: 'y',
    gameId: 'z',
    claimedKeys: [],
    preparedBytesDigest: 'f'.repeat(64),
    initialLeases: [],
  } as DispatchPermit;
  assert.throws(() => assertDispatchPermit(forged), /not minted by a store admission/);
});

test('the sink refuses to install under a forged permit', async () => {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const deps = storeDeps();
  try {
    // Produce a genuine artifact, then try to install it with a forged permit.
    const result = await runOneFire(fire, deps);
    const forged = {
      cohortId: result.artifact!.cohortId,
      fireId: result.artifact!.fireId,
      gameId: result.artifact!.gameId,
      claimedKeys: result.artifact!.scopedMarkets.map((m) => ({ gameId: result.artifact!.gameId, market: m })),
      preparedBytesDigest: 'f'.repeat(64),
      initialLeases: [],
    } as DispatchPermit;
    assert.throws(() => deps.artifactSink.write(forged, result.artifact!), /not minted by a store admission/);
  } finally {
    cleanup(deps);
  }
});

// --- frozen tooth: atomic no-clobber sink -----------------------------------

test('installing the same artifact twice is idempotent; a byte-different collision fails loud', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'f5a-'));
  const sink = new LineOpenArtifactSink(dir);
  const fireFn = new LineOpenFireFn();
  try {
    const { fire } = prepareLineOpenFire(['moneyline', 'total']);
    const cohortId = fire.booted.cohortId;
    const markets: MarketKey[] = ['moneyline', 'total'];
    const fireId = deriveFireId({
      cohortId,
      gameId: fire.gameId,
      proposedMarkets: markets,
      detectedAt: fire.detectedAt,
      preparedSnapshotDigest: fire.preparedSnapshotDigest,
    });
    const runId = deriveRunId(fireId);

    // A genuine permit for this fire id (the store admits it).
    const store = new StoreClaimPort(new SqlAtomicStore(admittedStoreQuery(LINE_OPEN_ARMS.length)));
    const outcome = await store.admit({
      cohortId,
      fireId,
      ownerId: 'owner-test',
      expectedSchemaVersion: 1,
      gameId: fire.gameId,
      proposedMarkets: markets,
      scopeReservations: { 'moneyline+total': { spendReservationUsdMicros: 1_000, preparedBytesDigest: fire.request.requestSha256 } },
    });
    assert.equal(outcome.kind, 'Authorized');
    const permit = (outcome as { permit: DispatchPermit }).permit;

    // Same fire id, but a byte-different artifact (a later bundleBuiltAt is NOT part of the
    // fire-id derivation, so it collides on the path yet differs in bytes).
    const a = (await fireFn.fire(permit, fire, { fireId, runId })).artifact;
    const bFire: PreparedFire = { ...fire, bundleBuiltAt: '2026-07-18T12:00:59.000Z' };
    const b = (await fireFn.fire(permit, bFire, { fireId, runId })).artifact;

    const first = sink.write(permit, a);
    assert.equal(first.created, true);
    // Same bytes → idempotent completion retry.
    const retry = sink.write(permit, a);
    assert.equal(retry.created, false);
    assert.equal(retry.path, first.path);
    // Different bytes at the same path → fail loud, never overwrite.
    assert.throws(() => sink.write(permit, b), /byte-different fire artifact already installed/);
    // Exactly one file remains — the original.
    const files = readdirSync(join(dir, cohortId));
    assert.equal(files.length, 1);
    assert.equal(readFileSync(first.path, 'utf8').length > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the path segment for a game id is base64url-encoded (an arbitrary id cannot escape)', async () => {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const deps = storeDeps();
  try {
    const result = await runOneFire(fire, deps);
    const name = basename(result.path!);
    const seg = Buffer.from(LINE_OPEN_GAME_ID, 'utf8').toString('base64url');
    assert.ok(name.startsWith(`fire-${seg}-`), `path uses the base64url game segment: ${name}`);
    // base64url of any string — including a path traversal — carries no separators.
    const evil = Buffer.from('../../etc/passwd', 'utf8').toString('base64url');
    assert.equal(evil.includes('/'), false);
    assert.equal(evil.includes('.'), false);
  } finally {
    cleanup(deps);
  }
});

// --- frozen tooth: fire identity --------------------------------------------

test('fireId is a deterministic pre-admit anchor over proposedMarkets, not retained scope', () => {
  const base = {
    cohortId: 'a'.repeat(64),
    gameId: LINE_OPEN_GAME_ID,
    proposedMarkets: ['moneyline', 'total'] as MarketKey[],
    detectedAt: '2026-07-18T12:00:30.000Z',
    preparedSnapshotDigest: 'b'.repeat(64),
  };
  // Deterministic + canonical-order-insensitive on the same set.
  assert.equal(deriveFireId(base), deriveFireId({ ...base, proposedMarkets: ['total', 'moneyline'] }));
  assert.match(deriveFireId(base), /^[0-9a-f]{64}$/);
  // A different detection instant, market set, or snapshot digest → a different id.
  assert.notEqual(deriveFireId(base), deriveFireId({ ...base, detectedAt: '2026-07-18T12:00:31.000Z' }));
  assert.notEqual(deriveFireId(base), deriveFireId({ ...base, proposedMarkets: ['moneyline'] }));
  assert.notEqual(deriveFireId(base), deriveFireId({ ...base, preparedSnapshotDigest: 'c'.repeat(64) }));
  // runId is a domain-separated digest of the fire id (never equal to it, deterministic).
  const fid = deriveFireId(base);
  assert.match(deriveRunId(fid), /^[0-9a-f]{64}$/);
  assert.notEqual(deriveRunId(fid), fid);
  assert.equal(deriveRunId(fid), deriveRunId(fid));
});
