import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cohortBoot } from './cohortBoot.js';
import { runCohortTick } from './cohortRunner.js';
import { decodeManifestText, selfResolvePublication } from './cohortRunnerMain.js';
import { DEMO_GAME_ID, buildDemoFixture } from './demoFixture.js';
import { FireArtifactSink } from './fireArtifactSink.js';
import { RehearsalClaimPort, StoreClaimPort } from './lineOpenClaim.js';
import { createMockAdapters } from './mock.js';
import { defaultExpectedArms } from './scoring.js';
import { STORE_SCHEMA_VERSION } from './store/constants.js';
import type { BootedCohort } from './cohortBoot.js';
import type { CohortTickInput } from './cohortRunner.js';
import type { ArtifactFs } from './fireArtifactSink.js';
import type { ClaimPort } from './lineOpenClaim.js';
import type { LineOpenRunOptions } from './lineOpenSpine.js';
import type {
  AcquireRepairLeaseRequest,
  AdmitDispatchRequest,
  AdmitResult,
  AtomicStore,
  CompleteClaimRequest,
  CompleteResult,
  InitCohortBudgetRequest,
  InitResult,
  Lease,
  ReleaseLeaseRequest,
  ReleaseResult,
  RepairLeaseResult,
} from './store/contract.js';

/**
 * The deterministic "see it fire" demo-fixture ALIGNMENT, driven end to end WITHOUT Postgres.
 * The synthetic candidate is anchored at a fixed instant and evaluated against an injected
 * clock a few ms later, so it flows through the REAL discovery + projector + composition spine
 * exactly as the live wall-clock demo does — proving the fixture is aligned to admit (not that
 * a database works, which the live `runner:fire` demonstrates separately). A genuine
 * `StoreClaimPort` over a scripted store + a real `FireArtifactSink` over an in-memory
 * filesystem take the candidate to Installed/settled with exactly one durable artifact.
 */

const CODE_ARMS = defaultExpectedArms();

// A fixed anchor: the fixture is now-relative to THIS instant, and the injected clock sits a
// few ms after it — inside the freshness delta, the clean-entry window, and the V-lag bound.
const ANCHOR_MS = Date.parse('2026-07-20T12:00:00.000Z');

/** A stateful injected clock: detection, per-fire seal, and every dispatch reading fall just
 *  after the anchor and well within maxDispatchLagMs of the detection instant. */
function tickClock(): () => number {
  const values = [ANCHOR_MS + 100, ANCHOR_MS + 200, ANCHOR_MS + 300, ANCHOR_MS + 400, ANCHOR_MS + 500];
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

function runOpts(now: () => number): LineOpenRunOptions {
  return {
    timeoutMs: 1_000,
    maxOutputTokens: 16_000,
    executionPolicy: 'fixed-moneyline-total',
    baselinePolicyVersion: 'baselines-v0.3.0',
    nowMs: now,
  };
}

// --- a scripted store that auto-admits the full proposed scope (mirrors the runner suite) ----

class ScriptedStore implements AtomicStore {
  readonly admitCalls: AdmitDispatchRequest[] = [];
  readonly completeCalls: CompleteClaimRequest[] = [];
  private admits = 0;

  constructor(private readonly rosterSize: number) {}

  initCohortBudget(_r: InitCohortBudgetRequest): Promise<InitResult> {
    throw new Error('not used'); // the tick never inits; boot does that in the live path
  }
  admitDispatch(req: AdmitDispatchRequest): Promise<AdmitResult> {
    this.admitCalls.push(req);
    const prefix = `a${(this.admits += 1)}-`;
    const initialLeases: Lease[] = Array.from({ length: this.rosterSize }, (_, armIndex) => ({
      leaseId: `${prefix}lease-${armIndex}`,
      armIndex,
      expiresAt: '2026-07-20T12:10:00.000Z',
      state: 'live' as const,
    }));
    const reservation = Object.values(req.scopeReservations)[0]!;
    return Promise.resolve({
      outcome: 'admitted',
      claimedKeys: req.proposedMarkets.map((market) => ({ gameId: req.gameId, market })),
      preparedBytesDigest: reservation.preparedBytesDigest,
      initialLeases,
      dispatchAuthorized: true,
    });
  }
  acquireRepairLease(req: AcquireRepairLeaseRequest): Promise<RepairLeaseResult> {
    return Promise.resolve({
      outcome: 'acquired',
      lease: { leaseId: `repair-${req.armIndex}-${req.repairOrdinal}`, armIndex: req.armIndex, expiresAt: '2026-07-20T12:20:00.000Z', state: 'live' },
      requestAuthorized: true,
    });
  }
  releaseLease(_req: ReleaseLeaseRequest): Promise<ReleaseResult> {
    return Promise.resolve({ outcome: 'released' });
  }
  completeClaim(req: CompleteClaimRequest): Promise<CompleteResult> {
    this.completeCalls.push(req);
    return Promise.resolve({ outcome: 'completed' });
  }
}

// --- a minimal in-memory ArtifactFs (atomic no-clobber, enough for the sink) ----------------

class MemoryFs implements ArtifactFs {
  readonly files = new Map<string, Buffer>();
  private readonly temps = new Map<number, { path: string; chunks: Buffer[] }>();
  private nextFd = 100;
  mkdirp(_dir: string): void {}
  openExclusive(path: string): number {
    if (this.files.has(path)) {
      const e = new Error('EEXIST') as NodeJS.ErrnoException;
      e.code = 'EEXIST';
      throw e;
    }
    const fd = this.nextFd;
    this.nextFd += 1;
    this.temps.set(fd, { path, chunks: [] });
    return fd;
  }
  write(fd: number, data: Buffer, offset: number, length: number): number {
    this.temps.get(fd)?.chunks.push(Buffer.from(data.subarray(offset, offset + length)));
    return length;
  }
  fsync(_fd: number): void {}
  close(fd: number): void {
    const t = this.temps.get(fd);
    if (t) this.files.set(t.path, Buffer.concat(t.chunks));
  }
  link(existingPath: string, newPath: string): void {
    if (this.files.has(newPath)) {
      const e = new Error('EEXIST') as NodeJS.ErrnoException;
      e.code = 'EEXIST';
      throw e;
    }
    const bytes = this.files.get(existingPath);
    if (bytes === undefined) throw new Error(`memory link: missing source ${existingPath}`);
    this.files.set(newPath, bytes);
  }
  syncDir(_dir: string): void {}
  readFile(path: string): Buffer {
    const b = this.files.get(path);
    if (b === undefined) throw new Error(`memory readFile: missing ${path}`);
    return b;
  }
  unlink(path: string): void {
    this.files.delete(path);
  }
}

/** Boot the demo cohort + self-resolve its publication from the fixture manifest bytes. */
function bootFixture(anchorMs: number): { fixture: ReturnType<typeof buildDemoFixture>; booted: BootedCohort } {
  const fixture = buildDemoFixture(anchorMs);
  const booted = cohortBoot({ live: false, manifestBytes: decodeManifestText(fixture.manifestBytes) });
  return { fixture, booted };
}

function tickInput(over: { claimPort: ClaimPort; sink?: CohortTickInput['sink']; now?: () => number }): CohortTickInput {
  const now = over.now ?? tickClock();
  const { fixture, booted } = bootFixture(ANCHOR_MS);
  return {
    booted,
    publication: selfResolvePublication(fixture.manifestBytes),
    discover: fixture.discover,
    readMarketEvidence: fixture.readMarketEvidence,
    claimPort: over.claimPort,
    adapters: createMockAdapters({ simulateCollision: false }),
    sink: over.sink ?? new FireArtifactSink('/base', new MemoryFs()),
    runOptions: runOpts(now),
    admission: { ownerId: 'demo-owner', expectedSchemaVersion: STORE_SCHEMA_VERSION },
    now,
  };
}

// ===========================================================================

test('the demo fixture discovers exactly one now-relative moneyline candidate and prepares it', async () => {
  // A report-only claim port never admits, so no adapter is called — this isolates the pure
  // ALIGNMENT: the synthetic candidate passes every detection/reconcile gate and PREPARES.
  const result = await runCohortTick(tickInput({ claimPort: new RehearsalClaimPort() }));

  assert.equal(result.discoveredCount, 1, 'exactly one synthetic candidate');
  assert.deepEqual(
    result.dispositions.map((d) => ({ ...d })),
    [{ gameId: DEMO_GAME_ID, market: 'moneyline', outcome: 'prepared' }],
    'the candidate is aligned to PREPARE (not deferred/rejected)',
  );
  assert.equal(result.fireOutcomes.length, 1);
  assert.equal(result.fireOutcomes[0]!.outcome.kind, 'NotAdmitted', 'a rehearsal admits nothing');
  assert.equal(result.admittedCount, 0);
});

test('over a genuine StoreClaimPort the demo candidate admits, dispatches the mock roster, installs, and settles', async () => {
  const store = new ScriptedStore(CODE_ARMS.length);
  const fs = new MemoryFs();
  const sink = new FireArtifactSink('/base', fs);

  const result = await runCohortTick(tickInput({ claimPort: new StoreClaimPort(store), sink }));

  assert.equal(result.discoveredCount, 1);
  assert.equal(result.admittedCount, 1, 'the aligned candidate admits exactly one fire');
  assert.equal(result.fireOutcomes.length, 1);
  const outcome = result.fireOutcomes[0]!.outcome;
  assert.equal(outcome.kind, 'Installed', 'the fire installs a durable artifact');
  if (outcome.kind !== 'Installed') return;
  assert.deepEqual(outcome.completion, { status: 'settled' }, 'the claim settles');
  assert.equal(store.admitCalls.length, 1, 'exactly one admission');
  assert.equal(store.completeCalls.length, 1, 'the installed claim settled once');
  // Exactly one artifact was durably installed, at the outcome's reported path.
  assert.equal(fs.files.size, 1, 'exactly one artifact file installed');
  assert.ok(fs.files.has(outcome.install.path), 'the installed path holds the artifact bytes');
  assert.equal(result.fireOutcomes[0]!.gameId, DEMO_GAME_ID);
  assert.equal(result.fireOutcomes[0]!.market, 'moneyline');
});
