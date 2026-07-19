import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import {
  LineOpenFireFn,
  NoopAttemptLifecycle,
  deriveFireId,
  deriveRunId,
  runOneFire,
} from './cohortRunner.js';
import type { AttemptLifecyclePort, FireDeps, PreparedFire } from './cohortRunner.js';
import type { FireArtifactV1 } from './fireArtifactProducer.js';
import { parseFireArtifactV1, verifyFireArtifactReplay } from './fireArtifactWriter.js';
import { LineOpenArtifactSink, nodeArtifactFs } from './lineOpenArtifactSink.js';
import type { ArtifactFs } from './lineOpenArtifactSink.js';
import { RehearsalClaimPort, StoreClaimPort, assertDispatchPermit } from './lineOpenClaim.js';
import type { DispatchPermit } from './lineOpenClaim.js';
import { runSlate } from './runner.js';
import { SqlAtomicStore } from './store/atomicStore.js';
import type { StoreQuery } from './store/atomicStore.js';
import type { AdmitDispatchRequest, ScopeKey, ScopeReservation } from './store/contract.js';
import { LINE_OPEN_ARMS, LINE_OPEN_GAME_ID, lineOpenScopedResponse, prepareLineOpenFire } from './testFactories.js';
import type { ArmSpec, MarketKey, ProviderAdapter, ProviderResponse } from './types.js';

/**
 * The line-open runner walking skeleton (SPEC §3/§4/§5): the claim → fire → produce →
 * persist spine, plus the pre-dispatch-authority, attempt-lifecycle, and durable-install
 * guarantees. Every test drives real code — the store adapter (a scripted admitting
 * executor), the real runSlate, buildFireArtifact, and the atomic sink.
 */

const LEASE_EXPIRES_AT = '2026-07-18T12:10:00.000Z';
const TMP_PREFIX = join(tmpdir(), 'line-open-sink-');

/** A scripted store executor that admits every dispatch with a valid full-roster lease
 *  bijection (the DB itself is proven by the store conformance gate). */
function admittedStoreQuery(rosterSize: number): StoreQuery {
  return admittedStoreQueryWith(rosterSize, (n) =>
    Array.from({ length: n }, (_, i) => ({ leaseId: `lease-${i}`, armIndex: i, expiresAt: LEASE_EXPIRES_AT, state: 'live' })),
  );
}

/** As above, but with caller-chosen initial leases (for lease-bijection failure tests). */
function admittedStoreQueryWith(
  rosterSize: number,
  leases: (rosterSize: number) => unknown[],
): StoreQuery {
  return (sql, params) => {
    if (!sql.includes('admit_dispatch')) throw new Error(`unexpected store call in fixture: ${sql}`);
    const gameId = params[4] as string;
    const proposedMarkets = JSON.parse(params[5] as string) as MarketKey[];
    const scope = JSON.parse(params[6] as string) as Record<string, { spend: number; digest: string }>;
    const r = {
      outcome: 'admitted',
      claimedKeys: proposedMarkets.map((market) => ({ gameId, market })),
      preparedBytesDigest: scope[proposedMarkets.join('+')]?.digest ?? 'f'.repeat(64),
      initialLeases: leases(rosterSize),
      dispatchAuthorized: true,
    };
    return Promise.resolve([{ r }]);
  };
}

function requestDigest(fire: PreparedFire): string {
  return sha256Hex(canonicalize(fire.request.requestBundle));
}

/** A valid admit request for `fire`, with optional field overrides for authority tests. */
function admitReqFor(fire: PreparedFire, overrides: Partial<AdmitDispatchRequest> = {}): AdmitDispatchRequest {
  const markets: MarketKey[] = [...fire.proposedMarkets];
  const cohortId = overrides.cohortId ?? fire.booted.cohortId;
  const proposedMarkets = overrides.proposedMarkets ?? markets;
  const scopeKey = [...proposedMarkets].join('+') as ScopeKey;
  const reservation: ScopeReservation = { spendReservationUsdMicros: 1_000, preparedBytesDigest: requestDigest(fire) };
  return {
    cohortId,
    fireId: deriveFireId({ cohortId, gameId: fire.gameId, proposedMarkets, detectedAt: fire.detectedAt, preparedSnapshotDigest: fire.preparedSnapshotDigest }),
    ownerId: 'owner-test',
    expectedSchemaVersion: 1,
    gameId: fire.gameId,
    proposedMarkets,
    scopeReservations: { [scopeKey]: reservation } as Readonly<Partial<Record<ScopeKey, ScopeReservation>>>,
    ...overrides,
  };
}

async function mintPermit(store: StoreClaimPort, req: AdmitDispatchRequest): Promise<DispatchPermit> {
  const outcome = await store.admit(req);
  assert.equal(outcome.kind, 'Authorized', `expected an admitted permit, got ${outcome.kind}`);
  return (outcome as { permit: DispatchPermit }).permit;
}

function storeDeps(overrides: Partial<FireDeps> = {}): FireDeps {
  return {
    claimPort: new StoreClaimPort(new SqlAtomicStore(admittedStoreQuery(LINE_OPEN_ARMS.length))),
    fireFn: new LineOpenFireFn(),
    artifactSink: new LineOpenArtifactSink(mkdtempSync(TMP_PREFIX)),
    lifecycle: new NoopAttemptLifecycle(),
    ownerId: 'owner-test',
    storeSchemaVersion: 1,
    spendReservationUsdMicros: 1_000,
    ...overrides,
  };
}

function sinkDir(deps: FireDeps): string {
  return (deps.artifactSink as unknown as { baseDir: string }).baseDir;
}

function cleanup(deps: FireDeps): void {
  rmSync(sinkDir(deps), { recursive: true, force: true });
}

/** Wrap a fire's adapters so every model call is counted (for zero-call assertions). */
function withCallCounter(fire: PreparedFire): { fire: PreparedFire; calls: () => number } {
  let count = 0;
  const adapters = new Map<string, ProviderAdapter>();
  for (const [id, a] of fire.adapters) {
    adapters.set(id, {
      provider: a.provider,
      requestedModelId: a.requestedModelId,
      credentialEnvVar: a.credentialEnvVar,
      hasCredential: a.hasCredential,
      chat: (...args: Parameters<ProviderAdapter['chat']>) => {
        count += 1;
        return a.chat(...args);
      },
    });
  }
  return { fire: { ...fire, adapters }, calls: () => count };
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
    const reloaded = parseFireArtifactV1(readFileSync(result.path!, 'utf8'));
    assert.deepEqual(verifyFireArtifactReplay(reloaded), []);
    assert.deepEqual(reloaded.scopedMarkets, ['moneyline', 'total']);
    assert.equal(reloaded.gameId, LINE_OPEN_GAME_ID);
    assert.equal(reloaded.arms.length, LINE_OPEN_ARMS.length);
    // The stub roster's responses re-validate, so every arm is a valid terminal outcome —
    // exercising the valid-arm accepted-body re-validation path.
    assert.ok(reloaded.arms.every((a) => a.terminalOutcome === 'valid'));
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

// --- rehearsal cannot mint a permit or write an artifact --------------------

test('a rehearsal claim never admits, fires nothing, and writes no artifact', async () => {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const deps = storeDeps({ claimPort: new RehearsalClaimPort() });
  try {
    const result = await runOneFire(fire, deps);
    assert.equal(result.fired, false);
    assert.equal(result.outcome.kind, 'WouldAdmit');
    assert.equal(result.path, undefined);
    assert.equal(result.artifact, undefined);
    assert.deepEqual(readdirSync(sinkDir(deps)), []);
  } finally {
    cleanup(deps);
  }
});

test('a dispatch permit cannot be forged by a structural copy', () => {
  const forged = { cohortId: 'x', fireId: 'y', gameId: 'z', claimedKeys: [], preparedBytesDigest: 'f'.repeat(64), initialLeases: [] } as DispatchPermit;
  assert.throws(() => assertDispatchPermit(forged), /not minted by a store admission/);
});

test('a minted permit is deeply frozen — nested claimed keys and leases cannot be mutated', async () => {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const store = new StoreClaimPort(new SqlAtomicStore(admittedStoreQuery(LINE_OPEN_ARMS.length)));
  const permit = await mintPermit(store, admitReqFor(fire));
  assert.throws(() => {
    (permit.claimedKeys[0] as { market: string }).market = 'total';
  });
  assert.throws(() => {
    (permit.initialLeases[0] as { state: string }).state = 'expired';
  });
  assert.equal(permit.claimedKeys[0]!.market, 'moneyline');
  assert.equal(permit.initialLeases[0]!.state, 'live');
});

// --- pre-dispatch authority: a mismatched permit fires NOTHING --------------
// Each case asserts ZERO model calls and no installed artifact: the executor binds every
// authorizing dimension BEFORE any adapter is touched.

async function assertNoDispatch(mint: (store: StoreClaimPort, fire: PreparedFire) => Promise<DispatchPermit>, message: RegExp): Promise<void> {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const counted = withCallCounter(fire);
  const store = new StoreClaimPort(new SqlAtomicStore(admittedStoreQuery(LINE_OPEN_ARMS.length)));
  const permit = await mint(store, fire);
  await assert.rejects(() => new LineOpenFireFn().fire(permit, counted.fire, new NoopAttemptLifecycle()), message);
  assert.equal(counted.calls(), 0, 'no model adapter may be called when the permit does not bind the fire');
}

test('a permit for a different cohort fires nothing', async () => {
  await assertNoDispatch((store, fire) => mintPermit(store, admitReqFor(fire, { cohortId: 'a'.repeat(64) })), /does not authorize this cohort/);
});

test('a permit for a different game fires nothing', async () => {
  await assertNoDispatch((store, fire) => mintPermit(store, admitReqFor(fire, { gameId: '00000000-0000-4000-8000-0000000000f2' })), /does not authorize this game/);
});

test('a permit for a different claimed scope fires nothing', async () => {
  await assertNoDispatch((store, fire) => mintPermit(store, admitReqFor(fire, { proposedMarkets: ['moneyline'] })), /claimed scope does not equal/);
});

test('a permit whose authorized digest does not match the request fires nothing', async () => {
  await assertNoDispatch(async (store, fire) => {
    const req = admitReqFor(fire);
    const wrong: AdmitDispatchRequest = {
      ...req,
      scopeReservations: { 'moneyline+total': { spendReservationUsdMicros: 1_000, preparedBytesDigest: 'a'.repeat(64) } },
    };
    return mintPermit(store, wrong);
  }, /does not match the digest the permit authorized/);
});

test('a permit with a broken initial-lease bijection fires nothing', async () => {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const counted = withCallCounter(fire);
  // One fewer lease than the roster.
  const store = new StoreClaimPort(
    new SqlAtomicStore(admittedStoreQueryWith(LINE_OPEN_ARMS.length, (n) =>
      Array.from({ length: n - 1 }, (_, i) => ({ leaseId: `lease-${i}`, armIndex: i, expiresAt: LEASE_EXPIRES_AT, state: 'live' })),
    )),
  );
  const permit = await mintPermit(store, admitReqFor(fire));
  await assert.rejects(() => new LineOpenFireFn().fire(permit, counted.fire, new NoopAttemptLifecycle()), /one initial lease per roster arm/);
  assert.equal(counted.calls(), 0);
});

async function assertNoDispatchLeases(makeLeases: (n: number) => unknown[], message: RegExp): Promise<void> {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const counted = withCallCounter(fire);
  const store = new StoreClaimPort(new SqlAtomicStore(admittedStoreQueryWith(LINE_OPEN_ARMS.length, makeLeases)));
  const permit = await mintPermit(store, admitReqFor(fire));
  await assert.rejects(() => new LineOpenFireFn().fire(permit, counted.fire, new NoopAttemptLifecycle()), message);
  assert.equal(counted.calls(), 0, 'a broken lease bijection must dispatch no adapter');
}

test('a permit with a duplicate initial-lease arm index fires nothing', async () => {
  await assertNoDispatchLeases(
    (n) => [
      ...Array.from({ length: n - 1 }, (_, i) => ({ leaseId: `lease-${i}`, armIndex: i, expiresAt: LEASE_EXPIRES_AT, state: 'live' })),
      { leaseId: 'dup', armIndex: 0, expiresAt: LEASE_EXPIRES_AT, state: 'live' }, // arm n-1 missing, arm 0 duplicated
    ],
    /duplicate initial lease/,
  );
});

test('a permit with an out-of-range initial-lease arm index fires nothing', async () => {
  await assertNoDispatchLeases(
    (n) => [
      ...Array.from({ length: n - 1 }, (_, i) => ({ leaseId: `lease-${i}`, armIndex: i, expiresAt: LEASE_EXPIRES_AT, state: 'live' })),
      { leaseId: 'oor', armIndex: n + 5, expiresAt: LEASE_EXPIRES_AT, state: 'live' },
    ],
    /outside \[0/,
  );
});

test('a permit with a non-live initial lease fires nothing', async () => {
  await assertNoDispatchLeases(
    (n) => Array.from({ length: n }, (_, i) => ({ leaseId: `lease-${i}`, armIndex: i, expiresAt: LEASE_EXPIRES_AT, state: i === 0 ? 'expired' : 'live' })),
    /is not live/,
  );
});

test('a request mutated during the awaited admission fires nothing and installs no artifact', async () => {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const counted = withCallCounter(fire);
  const deps = storeDeps({
    claimPort: {
      // A hostile claim port: it mutates the caller-owned request during admission, then
      // returns a genuine permit for the ORIGINAL (pre-mutation) authorized digest. The
      // executor re-verifies the digest at dispatch and refuses.
      admit: async (req: AdmitDispatchRequest) => {
        const store = new StoreClaimPort(new SqlAtomicStore(admittedStoreQuery(LINE_OPEN_ARMS.length)));
        const outcome = await store.admit(req);
        (counted.fire.request.requestBundle.games[0]!.markets.moneyline as { awayDecimal: number }).awayDecimal = 9.99;
        return outcome;
      },
    },
  });
  try {
    await assert.rejects(() => runOneFire(counted.fire, deps), /does not match the digest the permit authorized/);
    assert.equal(counted.calls(), 0);
    assert.deepEqual(readdirSync(sinkDir(deps)), []);
  } finally {
    cleanup(deps);
  }
});

test('a permit for a different fire id is refused before dispatch (zero calls)', async () => {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const counted = withCallCounter(fire);
  const deps = storeDeps({
    claimPort: {
      // Returns a genuine permit whose fire id is NOT the one runOneFire admitted with.
      admit: async (req: AdmitDispatchRequest) => {
        const store = new StoreClaimPort(new SqlAtomicStore(admittedStoreQuery(LINE_OPEN_ARMS.length)));
        return store.admit({ ...req, fireId: 'a'.repeat(64) });
      },
    },
  });
  try {
    const result = await runOneFire(counted.fire, deps);
    assert.equal(result.fired, false);
    assert.equal(result.outcome.kind, 'Fault');
    assert.equal(counted.calls(), 0);
  } finally {
    cleanup(deps);
  }
});

// --- attempt lifecycle at the HTTP boundary ---------------------------------

function recordingLifecycle(opts: { authorized: boolean }): { lifecycle: AttemptLifecyclePort; log: string[] } {
  const log: string[] = [];
  return {
    log,
    lifecycle: {
      releaseInitial: (i) => {
        log.push(`releaseInitial:${i}`);
        return Promise.resolve();
      },
      acquireRepair: (i, o) => {
        log.push(`acquireRepair:${i}:${o}`);
        return Promise.resolve({ authorized: opts.authorized });
      },
      releaseRepair: (i, o) => {
        log.push(`releaseRepair:${i}:${o}`);
        return Promise.resolve();
      },
    },
  };
}

function scriptedAdapter(arm: ArmSpec, bodies: string[]): { adapter: ProviderAdapter; calls: () => number } {
  let i = 0;
  const response = (rawText: string): ProviderResponse => ({
    rawText,
    reportedModelId: arm.requestedModelId,
    providerResponseId: 'stub',
    httpStatus: 200,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    usageRaw: {},
    requestParams: {},
  });
  return {
    calls: () => i,
    adapter: {
      provider: arm.provider,
      requestedModelId: arm.requestedModelId,
      credentialEnvVar: arm.credentialEnvVar,
      hasCredential: () => true,
      chat: () => {
        const body = bodies[i];
        i += 1;
        if (body === undefined) throw new Error('scripted adapter exhausted');
        return Promise.resolve(response(body));
      },
    },
  };
}

test('with a lifecycle, each arm releases its initial lease exactly once', async () => {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const lc = recordingLifecycle({ authorized: false });
  await runSlate(fire.arms, fire.adapters, [fire.request], { ...fire.runOptions, lifecycle: lc.lifecycle });
  for (let i = 0; i < fire.arms.length; i += 1) {
    assert.equal(lc.log.filter((l) => l === `releaseInitial:${i}`).length, 1, `arm ${i} releases its initial lease exactly once`);
  }
});

test('a repair is sent only under an authorized lease, and its lease is released once', async () => {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const arm = fire.arms[0]!;
  const valid = JSON.stringify(lineOpenScopedResponse(fire.request, arm, fire.booted.cohortId));
  const invalid = JSON.stringify({ ...(JSON.parse(valid) as Record<string, unknown>), cohortId: 'wrong-cohort-echo' });

  // Denied: acquireRepair returns false → the second HTTP request is never sent.
  const denied = scriptedAdapter(arm, [invalid, valid]);
  const deniedLc = recordingLifecycle({ authorized: false });
  const r1 = await runSlate([arm], new Map([[arm.participantId, denied.adapter]]), [fire.request], { ...fire.runOptions, lifecycle: deniedLc.lifecycle });
  assert.equal(denied.calls(), 1, 'a denied repair sends only the initial request');
  assert.equal(r1.results[0]!.outcome, 'invalid_schema');
  // The FULL ordered log: the initial lease is released BEFORE the repair lease is acquired
  // (never a double-hold), and a denied repair acquires-then-refuses with no release.
  assert.deepEqual(deniedLc.log, ['releaseInitial:0', 'acquireRepair:0:1']);

  // Authorized: acquireRepair returns true → the repair is sent and released exactly once.
  const allowed = scriptedAdapter(arm, [invalid, valid]);
  const allowedLc = recordingLifecycle({ authorized: true });
  const r2 = await runSlate([arm], new Map([[arm.participantId, allowed.adapter]]), [fire.request], { ...fire.runOptions, lifecycle: allowedLc.lifecycle });
  assert.equal(allowed.calls(), 2, 'an authorized repair sends the initial + the repair');
  assert.equal(r2.results[0]!.outcome, 'valid');
  // Full ordered log: release the initial lease, THEN acquire + release the repair lease —
  // so the arm never holds two concurrency slots (the exact double-hold this gate prevents).
  assert.deepEqual(allowedLc.log, ['releaseInitial:0', 'acquireRepair:0:1', 'releaseRepair:0:1']);
});

test('with a lifecycle, every initial-attempt exit releases the initial lease exactly once', async () => {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const arm = fire.arms[0]!;

  // (a) credential missing → the arm is skipped and its initial lease released once.
  const noCred = recordingLifecycle({ authorized: true });
  const noCredAdapter: ProviderAdapter = {
    provider: arm.provider,
    requestedModelId: arm.requestedModelId,
    credentialEnvVar: arm.credentialEnvVar,
    hasCredential: () => false,
    chat: () => Promise.reject(new Error('must not be called')),
  };
  const rc = await runSlate([arm], new Map([[arm.participantId, noCredAdapter]]), [fire.request], { ...fire.runOptions, lifecycle: noCred.lifecycle });
  assert.equal(rc.results[0]!.outcome, 'credential_missing');
  assert.deepEqual(noCred.log, ['releaseInitial:0']);

  // (b) the decision cutoff already passed at dispatch → skipped, released once, no call.
  const past = recordingLifecycle({ authorized: true });
  const ok = scriptedAdapter(arm, [JSON.stringify(lineOpenScopedResponse(fire.request, arm, fire.booted.cohortId))]);
  const afterCutoff = Date.parse(fire.request.game.scheduledStartUtc) + 1_000;
  const rp = await runSlate([arm], new Map([[arm.participantId, ok.adapter]]), [fire.request], { ...fire.runOptions, nowMs: () => afterCutoff, lifecycle: past.lifecycle });
  assert.equal(rp.results[0]!.outcome, 'cutoff_missed');
  assert.equal(ok.calls(), 0);
  assert.deepEqual(past.log, ['releaseInitial:0']);

  // (c) a throw before the initial attempt → the finally backstop releases exactly once.
  const thrown = recordingLifecycle({ authorized: true });
  const throwingAdapter: ProviderAdapter = {
    provider: arm.provider,
    requestedModelId: arm.requestedModelId,
    credentialEnvVar: arm.credentialEnvVar,
    hasCredential: () => {
      throw new Error('credential probe failed');
    },
    chat: () => Promise.reject(new Error('must not be called')),
  };
  await assert.rejects(() => runSlate([arm], new Map([[arm.participantId, throwingAdapter]]), [fire.request], { ...fire.runOptions, lifecycle: thrown.lifecycle }));
  assert.deepEqual(thrown.log, ['releaseInitial:0']);
});

// --- durable, atomic, no-clobber sink ---------------------------------------

async function genuineFire(): Promise<{ permit: DispatchPermit; artifact: FireArtifactV1; fire: PreparedFire }> {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const store = new StoreClaimPort(new SqlAtomicStore(admittedStoreQuery(LINE_OPEN_ARMS.length)));
  const permit = await mintPermit(store, admitReqFor(fire));
  const artifact = (await new LineOpenFireFn().fire(permit, fire, new NoopAttemptLifecycle())).artifact;
  return { permit, artifact, fire };
}

function recordingFs(): { fs: ArtifactFs; ops: string[] } {
  const ops: string[] = [];
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      ops.push(name);
      return fn(...args);
    };
  return {
    ops,
    fs: {
      mkdirp: wrap('mkdirp', nodeArtifactFs.mkdirp),
      openExclusive: wrap('open', nodeArtifactFs.openExclusive),
      writeAll: wrap('writeAll', nodeArtifactFs.writeAll),
      fsync: wrap('fsync', nodeArtifactFs.fsync),
      close: wrap('close', nodeArtifactFs.close),
      link: wrap('link', nodeArtifactFs.link),
      syncDir: wrap('syncDir', nodeArtifactFs.syncDir),
      readFileUtf8: wrap('readFile', nodeArtifactFs.readFileUtf8),
      unlink: wrap('unlink', nodeArtifactFs.unlink),
    },
  };
}

test('the sink install order is complete-write → temp fsync → no-clobber install → directory fsync', async () => {
  const dir = mkdtempSync(TMP_PREFIX);
  try {
    const { permit, artifact } = await genuineFire();
    const { fs, ops } = recordingFs();
    const sink = new LineOpenArtifactSink(dir, fs);
    const { path } = sink.write(permit, artifact);
    const order = ops.filter((o) => o === 'writeAll' || o === 'fsync' || o === 'link' || o === 'syncDir');
    assert.deepEqual(order, ['writeAll', 'fsync', 'link', 'syncDir']);
    // The complete bytes are on disk and self-verify.
    const reloaded = parseFireArtifactV1(readFileSync(path, 'utf8'));
    assert.deepEqual(verifyFireArtifactReplay(reloaded), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory-sync failure fails the install; a completion retry re-syncs the directory', async () => {
  const dir = mkdtempSync(TMP_PREFIX);
  try {
    const { permit, artifact } = await genuineFire();
    let syncDirCalls = 0;
    let failNext = true;
    const flaky: ArtifactFs = {
      ...nodeArtifactFs,
      syncDir: (d) => {
        syncDirCalls += 1;
        if (failNext) {
          failNext = false;
          throw new Error('simulated directory sync failure');
        }
        nodeArtifactFs.syncDir(d);
      },
    };
    const sink = new LineOpenArtifactSink(dir, flaky);
    // The fresh link succeeds but its directory fsync fails → the whole call fails.
    assert.throws(() => sink.write(permit, artifact), /simulated directory sync failure/);
    // The completion retry (EEXIST, identical bytes) re-establishes directory durability
    // rather than papering over the un-synced entry.
    const retry = sink.write(permit, artifact);
    assert.equal(retry.created, false);
    assert.equal(syncDirCalls, 2, 'syncDir is attempted on the fresh link AND on the idempotent retry');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installing the same artifact twice is idempotent; a byte-different collision fails loud', async () => {
  const dir = mkdtempSync(TMP_PREFIX);
  const sink = new LineOpenArtifactSink(dir);
  const fireFn = new LineOpenFireFn();
  try {
    const { fire } = prepareLineOpenFire(['moneyline', 'total']);
    const store = new StoreClaimPort(new SqlAtomicStore(admittedStoreQuery(LINE_OPEN_ARMS.length)));
    const permit = await mintPermit(store, admitReqFor(fire));

    // Same permit (⇒ same fire id ⇒ same path), byte-different artifacts: a later bundleBuiltAt
    // is not part of the fire-id derivation nor the request, so it collides on the path yet
    // differs in bytes.
    const a = (await fireFn.fire(permit, fire, new NoopAttemptLifecycle())).artifact;
    const b = (await fireFn.fire(permit, { ...fire, bundleBuiltAt: '2026-07-18T12:00:59.000Z' }, new NoopAttemptLifecycle())).artifact;

    const first = sink.write(permit, a);
    assert.equal(first.created, true);
    const retry = sink.write(permit, a);
    assert.equal(retry.created, false);
    assert.equal(retry.path, first.path);
    assert.throws(() => sink.write(permit, b), /byte-different fire artifact already installed/);
    assert.equal(readdirSync(join(dir, fire.booted.cohortId)).length, 1);
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
    const evil = Buffer.from('../../etc/passwd', 'utf8').toString('base64url');
    assert.equal(evil.includes('/'), false);
    assert.equal(evil.includes('.'), false);
  } finally {
    cleanup(deps);
  }
});

// --- store claim port fails closed, never authorizes ------------------------

test('the store claim port faults (authorizes nothing) when the store throws', async () => {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const port = new StoreClaimPort(new SqlAtomicStore(() => Promise.reject(new Error('db unreachable'))));
  const outcome = await port.admit(admitReqFor(fire));
  assert.equal(outcome.kind, 'Fault');
});

test('the store claim port faults (authorizes nothing) on a non-admitted result', async () => {
  const { fire } = prepareLineOpenFire(['moneyline', 'total']);
  const refusing: StoreQuery = () => Promise.resolve([{ r: { outcome: 'refused', reason: 'all_claimed', dispatchAuthorized: false } }]);
  const port = new StoreClaimPort(new SqlAtomicStore(refusing));
  const outcome = await port.admit(admitReqFor(fire));
  assert.equal(outcome.kind, 'Fault');
});

// --- fire identity ----------------------------------------------------------

test('fireId is a deterministic pre-admit anchor over proposedMarkets, not retained scope', () => {
  const base = {
    cohortId: 'a'.repeat(64),
    gameId: LINE_OPEN_GAME_ID,
    proposedMarkets: ['moneyline', 'total'] as MarketKey[],
    detectedAt: '2026-07-18T12:00:30.000Z',
    preparedSnapshotDigest: 'b'.repeat(64),
  };
  assert.equal(deriveFireId(base), deriveFireId({ ...base, proposedMarkets: ['total', 'moneyline'] }));
  assert.match(deriveFireId(base), /^[0-9a-f]{64}$/);
  assert.notEqual(deriveFireId(base), deriveFireId({ ...base, cohortId: 'd'.repeat(64) }));
  assert.notEqual(deriveFireId(base), deriveFireId({ ...base, gameId: '00000000-0000-4000-8000-0000000000f2' }));
  assert.notEqual(deriveFireId(base), deriveFireId({ ...base, detectedAt: '2026-07-18T12:00:31.000Z' }));
  assert.notEqual(deriveFireId(base), deriveFireId({ ...base, proposedMarkets: ['moneyline'] }));
  assert.notEqual(deriveFireId(base), deriveFireId({ ...base, preparedSnapshotDigest: 'c'.repeat(64) }));
  const fid = deriveFireId(base);
  assert.match(deriveRunId(fid), /^[0-9a-f]{64}$/);
  assert.notEqual(deriveRunId(fid), fid);
  assert.equal(deriveRunId(fid), deriveRunId(fid));
});
