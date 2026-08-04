import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildCampaignAuthorization } from './campaignAuthorization.js';
import type { CampaignAuthorization, CampaignAuthorizationPort } from './campaignAuthorization.js';
import { buildCampaignManifest } from './campaignProfile.js';
import { armCampaign, installManifestNoClobber, resumeCampaign, statusCampaign, stopCampaign, tickCampaign } from './campaignMain.js';
import type { CampaignDeps } from './campaignMain.js';
import { assertCohortAdapterCapability } from './cohortAdapterCapability.js';
import { cohortBoot } from './cohortBoot.js';
import type { CohortTickInput, CohortTickResult } from './cohortRunner.js';
import { FireArtifactSink } from './fireArtifactSink.js';
import type { ArtifactFs } from './fireArtifactSink.js';
import { STORE_SCHEMA_VERSION } from './store/constants.js';
import type { AtomicStore } from './store/contract.js';
import type { CampaignTickJournalPort, CampaignTickOutcome, ScheduleEntry } from './campaignSchedule.js';
import type { UnresolvedFire, UnresolvedFireRead } from './escalationLatch.js';
import type { CampaignBudgetStatus, CampaignFireStatus, CampaignStatusReadPort } from './store/campaignStatusRead.js';
import { defaultExpectedArms } from './scoring.js';

/**
 * The campaign owner-level flows — arm, tick, stop — driven WITHOUT a database, a network,
 * or a provider. Every seam is injected, so these prove the decisions the CLI owns: the
 * attended arming gate with the standard [Y/n] semantics and exact prompt bytes; the
 * AUTHORITY-ORDERED durable writes (manifest → budget → authorization, so no failed arm
 * leaves standing authority); the reconciliation of re-runs and of already-armed cohorts;
 * and the unattended tick's ACTIVATED path — the required publication evidence, the
 * composed escalation latch, the gated billable mint (which probes the synthetic env
 * credentials for itself), the assembled real tick input behind the injected `runTick`
 * seam, and the journaled outcome classification. The spawned-CLI probes at the bottom
 * drive the PRODUCTION readline seam end to end.
 */

const NOW = Date.parse('2026-08-05T00:00:00.000Z');
const WEEK_MS = 7 * 24 * 3_600_000;
const ROSTER = defaultExpectedArms().map((a) => a.participantId);

const SYNTHETIC_ENV: Record<string, string | undefined> = {
  STORE_DATABASE_URL: 'postgres://synthetic/none',
  // The tick constructs its real read seams from these (never invoked — `runTick` is
  // injected), and the gated billable mint probes each roster adapter's credential env
  // var FOR ITSELF — synthetic values satisfy the probe; no network call ever happens.
  SUPABASE_URL: 'http://127.0.0.1:1',
  SUPABASE_ANON_KEY: 'synthetic-anon-key',
  OPENAI_API_KEY: 'synthetic-test-credential',
  ANTHROPIC_API_KEY: 'synthetic-test-credential',
  GEMINI_API_KEY: 'synthetic-test-credential',
  GOOGLE_API_KEY: '',
  XAI_API_KEY: 'synthetic-test-credential',
};

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Capture BOTH console channels (printLine → log, printError → error) for the call. */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line?: unknown) => logs.push(String(line ?? ''));
  console.error = (line?: unknown) => errors.push(String(line ?? ''));
  try {
    return { value: await fn(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** An in-memory authorization port that records every call. */
class MemoryAuthPort implements CampaignAuthorizationPort {
  readonly records = new Map<string, CampaignAuthorization>();
  readonly calls: string[] = [];
  async read(cohortId: string): Promise<unknown | null> {
    this.calls.push(`read:${cohortId}`);
    return this.records.get(cohortId) ?? null;
  }
  async arm(record: CampaignAuthorization): Promise<'armed' | 'already_armed'> {
    this.calls.push(`arm:${record.cohortId}`);
    if (this.records.has(record.cohortId)) return 'already_armed';
    this.records.set(record.cohortId, record);
    return 'armed';
  }
  async disarm(cohortId: string, at: string): Promise<'disarmed' | 'not_found'> {
    this.calls.push(`disarm:${cohortId}`);
    const existing = this.records.get(cohortId);
    if (existing === undefined) return 'not_found';
    if (existing.disarmedAt === null) this.records.set(cohortId, { ...existing, disarmedAt: at });
    return 'disarmed';
  }
}

/** A store recording budget inits; every dispatch-path method is unreachable by design. */
function recordingStore(calls: string[]): AtomicStore {
  const unreached = (): never => {
    throw new Error('the campaign flow must never reach a dispatch-path store method');
  };
  return {
    initCohortBudget: async (req) => {
      calls.push(`init:${req.cohortId}`);
      return { outcome: 'initialized' as const };
    },
    admitDispatch: unreached,
    acquireRepairLease: unreached,
    releaseLease: unreached,
    completeClaim: unreached,
  };
}

/** A configurable in-memory tick journal; `windowValue`/`frontierId` serve the
 *  authoritative halt window, `entriesValue` the bounded display read. */
class FakeTickJournal implements CampaignTickJournalPort {
  readonly calls: string[] = [];
  /** Structured finish records, because a dispatched tick's detail is JSON (colons and
   *  all) and the flat call string cannot be parsed back reliably. */
  readonly finishes: Array<{ entryId: number; outcome: CampaignTickOutcome; detail: string | null }> = [];
  entriesValue: ScheduleEntry[] = [];
  windowValue: ScheduleEntry[] = [];
  frontierId = 70;
  resumeOutcome: 'resumed' | 'frontier_moved' = 'resumed';
  nextId = 71;
  async begin(cohortId: string, startedAtIso: string): Promise<number> {
    this.calls.push(`begin:${cohortId}:${startedAtIso}`);
    return this.nextId;
  }
  async finish(entryId: number, outcome: CampaignTickOutcome, detail: string | null, finishedAtIso: string): Promise<void> {
    this.calls.push(`finish:${entryId}:${outcome}:${detail ?? '<null>'}:${finishedAtIso}`);
    this.finishes.push({ entryId, outcome, detail });
  }
  async resume(
    cohortId: string,
    atIso: string,
    detail: string | null,
    expectedFrontierId: number,
  ): Promise<'resumed' | 'frontier_moved'> {
    this.calls.push(`resume:${cohortId}:${atIso}:${detail ?? '<null>'}:${expectedFrontierId}`);
    return this.resumeOutcome;
  }
  async scheduleWindow(cohortId: string, healthyOutcomes: readonly string[]): Promise<{ frontierId: number; entries: readonly ScheduleEntry[] }> {
    this.calls.push(`window:${cohortId}:${healthyOutcomes.join('+')}`);
    return { frontierId: this.frontierId, entries: this.windowValue };
  }
  async entries(cohortId: string, limit: number): Promise<readonly ScheduleEntry[]> {
    this.calls.push(`entries:${cohortId}:${limit}`);
    return this.entriesValue;
  }
}

/** A configurable store-derived escalation-latch read; records calls, returns `fires`. */
class FakeUnresolvedFires implements UnresolvedFireRead {
  readonly calls: string[] = [];
  fires: UnresolvedFire[] = [];
  async unresolvedFires(cohortId: string): Promise<readonly UnresolvedFire[]> {
    this.calls.push(`unresolved:${cohortId}`);
    return this.fires;
  }
}

/** A configurable read-only status port; records calls and, by construction, cannot write. */
class FakeStatusReads implements CampaignStatusReadPort {
  readonly calls: string[] = [];
  budgetValue: CampaignBudgetStatus | null = null;
  firesValue: CampaignFireStatus = {
    firesAdmitted: 0,
    firesCompleted: 0,
    firesPending: 0,
    callsMade: 0,
    claimsPending: 0,
    claimsCompleted: 0,
    activeLeases: 0,
    lastAdmittedAt: null,
  };
  async budget(cohortId: string): Promise<CampaignBudgetStatus | null> {
    this.calls.push(`budget:${cohortId}`);
    return this.budgetValue;
  }
  async fires(cohortId: string): Promise<CampaignFireStatus> {
    this.calls.push(`fires:${cohortId}`);
    return this.firesValue;
  }
}

function deps(
  over: Partial<CampaignDeps> & { auth?: MemoryAuthPort } = {},
): CampaignDeps & {
  auth: MemoryAuthPort;
  storeCalls: string[];
  statusReads: FakeStatusReads;
  unresolvedFires: FakeUnresolvedFires;
  tickJournal: FakeTickJournal;
  opens: { store: number; reads: number };
  /** Every assembled tick input `runTick` received — recorded even when a test injects
   *  its own `runTick`, so the assembly is always observable. */
  tickInputs: CohortTickInput[];
} {
  const { runTick: overRunTick, ...rest } = over;
  const auth = over.auth ?? new MemoryAuthPort();
  const storeCalls: string[] = [];
  const statusReads = new FakeStatusReads();
  const unresolvedFires = new FakeUnresolvedFires();
  const tickJournal = new FakeTickJournal();
  const opens = { store: 0, reads: 0 };
  const tickInputs: CohortTickInput[] = [];
  const base: CampaignDeps = {
    openStore: async () => {
      opens.store += 1;
      return { store: recordingStore(storeCalls), authorizations: auth, unresolvedFires, tickJournal, close: async () => {} };
    },
    openReads: async () => {
      opens.reads += 1;
      return { authorizations: auth, statusReads, unresolvedFires, tickJournal, close: async () => {} };
    },
    observeCredentials: (ids) => new Map(ids.map((id) => [id, true])),
    confirm: async () => 'y',
    now: () => NOW,
    resolvePublication: async () => {
      throw new Error('no publication resolution was expected in this test');
    },
    runTick: async (input) => {
      tickInputs.push(input);
      if (overRunTick) return overRunTick(input);
      return { discoveredCount: 0, dispositions: [], fireOutcomes: [], admittedCount: 0 };
    },
    ...rest,
  };
  return { ...base, auth, storeCalls, statusReads, unresolvedFires, tickJournal, opens, tickInputs };
}

function options(over: Record<string, unknown> = {}): Parameters<typeof armCampaign>[0] {
  const command = (over['command'] as string | undefined) ?? 'arm';
  return {
    command,
    calls: 800,
    days: 7,
    // --start is REQUIRED (the campaign's identity anchor); the fixture pins it to the same
    // instant as the test clock so derived expectations (window, expiry) stay byte-stable.
    startIso: '2026-08-05T00:00:00.000Z',
    dispatches: 1,
    manifestPath: null,
    emitPath: join(mkdtempSync(join(tmpdir(), 'campaign-')), 'campaign-manifest.json'),
    publicationPath: null,
    // ARM binds a durable evidence destination (mkdtemp is absolute); every other command
    // takes none — a tick's root comes from the durable record, and a tick GIVEN one
    // refuses.
    artifactsPath: command === 'arm' ? mkdtempSync(join(tmpdir(), 'campaign-artifacts-')) : null,
    ...over,
  } as Parameters<typeof armCampaign>[0];
}

/** The exact manifest bytes the default test arm builds (deterministic at the fixed clock). */
function expectedManifestBytes(): string {
  return buildCampaignManifest(NOW, { callCap: 800, windowForwardMs: WEEK_MS, maxDispatchesPerTick: 1 }).bytes;
}

// ===========================================================================
// the manifest installer — the fire-artifact sink's durable loop + a final read-back
// ===========================================================================

test('installManifestNoClobber (real fs): installs, reconciles identical bytes, refuses different bytes, fails on a directory — no temp litter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'campaign-install-'));
  const path = join(dir, 'm.json');
  const bytes = Buffer.from('{"a":1}', 'utf8');
  assert.deepEqual(installManifestNoClobber(path, bytes), { kind: 'installed' });
  assert.equal(readFileSync(path, 'utf8'), '{"a":1}');
  assert.deepEqual(installManifestNoClobber(path, bytes), { kind: 'already_installed' });
  const conflict = installManifestNoClobber(path, Buffer.from('{"a":2}', 'utf8'));
  assert.equal(conflict.kind, 'conflict');
  assert.equal(readFileSync(path, 'utf8'), '{"a":1}', 'an existing file is NEVER clobbered');
  assert.equal(installManifestNoClobber(dir, bytes).kind, 'failed', 'a directory at the path fails, not throws');
  assert.deepEqual(readdirSync(dir), ['m.json'], 'every outcome cleans its temp — no litter beside the manifest');
});

// --- a recording, stateful fake ArtifactFs (mirrors the sink's own test harness) ---------

type FakeOp = 'mkdirp' | 'openExclusive' | 'write' | 'fsync' | 'close' | 'link' | 'syncDir' | 'readFile' | 'unlink';

function errWithCode(message: string, code: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(message);
  e.code = code;
  return e;
}

class FakeInstallFs implements ArtifactFs {
  readonly log: FakeOp[] = [];
  readonly files = new Map<string, Buffer>();
  private readonly temps = new Map<number, { path: string; chunks: Buffer[] }>();
  private nextFd = 7;
  private writeCalls = 0;
  private syncDirCalls = 0;
  onWrite?: (length: number, call: number) => number;
  onReadFile?: (path: string) => Buffer;
  throwOn: Partial<Record<FakeOp, Error>> = {};
  /** Fail only the FIRST syncDir (the fresh-publication one); a retry's syncDir succeeds. */
  syncDirFailFirstOnly?: Error;

  mkdirp(_dir: string): void {
    this.log.push('mkdirp');
    if (this.throwOn.mkdirp) throw this.throwOn.mkdirp;
  }
  openExclusive(path: string): number {
    this.log.push('openExclusive');
    if (this.throwOn.openExclusive) throw this.throwOn.openExclusive;
    if (this.files.has(path)) throw errWithCode('EEXIST: file already exists', 'EEXIST');
    const fd = this.nextFd;
    this.nextFd += 1;
    this.temps.set(fd, { path, chunks: [] });
    return fd;
  }
  write(fd: number, data: Buffer, offset: number, length: number): number {
    this.log.push('write');
    if (this.throwOn.write) throw this.throwOn.write;
    this.writeCalls += 1;
    // A hang is not an acceptable failure mode for a battery: if the loop under test ever
    // accepts zero progress, this guard turns the runaway into a loud error instead.
    if (this.writeCalls > 10_000) throw new Error('fake fs: runaway write loop — zero progress was accepted');
    const n = this.onWrite ? this.onWrite(length, this.writeCalls) : length;
    if (Number.isInteger(n) && n >= 1 && n <= length) {
      this.temps.get(fd)?.chunks.push(Buffer.from(data.subarray(offset, offset + n)));
    }
    return n;
  }
  fsync(_fd: number): void {
    this.log.push('fsync');
    if (this.throwOn.fsync) throw this.throwOn.fsync;
  }
  close(fd: number): void {
    this.log.push('close');
    const t = this.temps.get(fd);
    if (t) this.files.set(t.path, Buffer.concat(t.chunks)); // the temp is durable after close
    if (this.throwOn.close) throw this.throwOn.close;
  }
  link(existingPath: string, newPath: string): void {
    this.log.push('link');
    if (this.throwOn.link) throw this.throwOn.link;
    if (this.files.has(newPath)) throw errWithCode('EEXIST: file already exists', 'EEXIST');
    const bytes = this.files.get(existingPath);
    if (bytes === undefined) throw new Error(`fake link: missing source ${existingPath}`);
    this.files.set(newPath, bytes);
  }
  syncDir(_dir: string): void {
    this.log.push('syncDir');
    this.syncDirCalls += 1;
    if (this.syncDirFailFirstOnly && this.syncDirCalls === 1) throw this.syncDirFailFirstOnly;
    if (this.throwOn.syncDir) throw this.throwOn.syncDir;
  }
  readFile(path: string): Buffer {
    this.log.push('readFile');
    if (this.throwOn.readFile) throw this.throwOn.readFile;
    if (this.onReadFile) return this.onReadFile(path);
    const b = this.files.get(path);
    if (b === undefined) throw new Error(`fake readFile: missing ${path}`);
    return b;
  }
  unlink(path: string): void {
    this.log.push('unlink');
    this.files.delete(path);
    if (this.throwOn.unlink) throw this.throwOn.unlink;
  }
}

const FINAL = '/campaigns/m.json';
const MANIFEST_BYTES = Buffer.from('{"manifest":1}', 'utf8');

test('durable install ORDER: temp open → complete write → file sync → close → no-clobber link → directory sync → temp cleanup → final read-back', () => {
  const fs = new FakeInstallFs();
  assert.deepEqual(installManifestNoClobber(FINAL, MANIFEST_BYTES, fs), { kind: 'installed' });
  assert.deepEqual(fs.log, ['mkdirp', 'openExclusive', 'write', 'fsync', 'close', 'link', 'syncDir', 'unlink', 'readFile']);
  assert.ok(fs.files.get(FINAL)!.equals(MANIFEST_BYTES), 'the final bytes are exact');
  assert.equal(fs.files.size, 1, 'the temp is gone; only the final remains');
});

test('a short-writing filesystem is looped to completion; the final bytes are exact', () => {
  const fs = new FakeInstallFs();
  fs.onWrite = () => 1; // one byte per call
  assert.deepEqual(installManifestNoClobber(FINAL, MANIFEST_BYTES, fs), { kind: 'installed' });
  assert.equal(fs.log.filter((op) => op === 'write').length, MANIFEST_BYTES.length);
  assert.ok(fs.files.get(FINAL)!.equals(MANIFEST_BYTES));
});

test('ZERO write progress fails loudly — never an infinite loop, never a partial final', () => {
  const fs = new FakeInstallFs();
  fs.onWrite = () => 0;
  const result = installManifestNoClobber(FINAL, MANIFEST_BYTES, fs);
  assert.equal(result.kind, 'failed');
  assert.match((result as { message: string }).message, /invalid progress/);
  assert.ok(!fs.log.includes('link'), 'no publication was attempted');
  assert.ok(!fs.files.has(FINAL), 'the final path never came to exist');
});

test('a temp fsync failure fails BEFORE publication, with the temp cleaned up', () => {
  const fs = new FakeInstallFs();
  fs.throwOn.fsync = new Error('fsync-boom');
  const result = installManifestNoClobber(FINAL, MANIFEST_BYTES, fs);
  assert.equal(result.kind, 'failed');
  assert.match((result as { message: string }).message, /fsync-boom/);
  assert.ok(!fs.log.includes('link'));
  assert.equal(fs.files.size, 0, 'no final, and the temp was unlinked');
});

test('close-failure precedence: a lone close failure fails the install; a write failure WINS over a close failure', () => {
  const closeOnly = new FakeInstallFs();
  closeOnly.throwOn.close = new Error('close-boom');
  const r1 = installManifestNoClobber(FINAL, MANIFEST_BYTES, closeOnly);
  assert.equal(r1.kind, 'failed');
  assert.match((r1 as { message: string }).message, /close-boom/);
  assert.ok(!closeOnly.log.includes('link'), 'no publication after a failed close');

  const both = new FakeInstallFs();
  both.throwOn.write = new Error('write-boom');
  both.throwOn.close = new Error('close-boom');
  const r2 = installManifestNoClobber(FINAL, MANIFEST_BYTES, both);
  assert.equal(r2.kind, 'failed');
  assert.match((r2 as { message: string }).message, /write-boom/, 'the first meaningful error is preserved');
});

test('a non-EEXIST publication failure fails with the final path never created and the temp cleaned', () => {
  const fs = new FakeInstallFs();
  fs.throwOn.link = errWithCode('EPERM: operation not permitted', 'EPERM');
  const result = installManifestNoClobber(FINAL, MANIFEST_BYTES, fs);
  assert.equal(result.kind, 'failed');
  assert.ok(!fs.files.has(FINAL));
  assert.equal(fs.files.size, 0);
});

test('an existing IDENTICAL final reconciles as replay success — and re-runs the directory sync', () => {
  const fs = new FakeInstallFs();
  fs.files.set(FINAL, Buffer.from(MANIFEST_BYTES));
  assert.deepEqual(installManifestNoClobber(FINAL, MANIFEST_BYTES, fs), { kind: 'already_installed' });
  assert.ok(fs.log.includes('syncDir'), 'the idempotent path re-establishes directory durability');
  assert.equal(fs.log.filter((op) => op === 'readFile').length, 2, 'the identity compare AND the final read-back both ran');
});

test('an existing DIFFERENT final is a conflict: untouched, never truncated, never rewritten', () => {
  const fs = new FakeInstallFs();
  const other = Buffer.from('{"someone":"else"}', 'utf8');
  fs.files.set(FINAL, other);
  const result = installManifestNoClobber(FINAL, MANIFEST_BYTES, fs);
  assert.equal(result.kind, 'conflict');
  assert.ok(fs.files.get(FINAL)!.equals(other), 'the existing bytes are exactly as they were');
});

test('a directory-sync failure is UNKNOWN persistence (failed) — and the identical retry converges, retrying the sync', () => {
  const fs = new FakeInstallFs();
  fs.syncDirFailFirstOnly = new Error('dirsync-boom');
  const first = installManifestNoClobber(FINAL, MANIFEST_BYTES, fs);
  assert.equal(first.kind, 'failed');
  assert.match((first as { message: string }).message, /dirsync-boom/);
  // The entry exists but its durability is unknown; the identical retry re-validates the
  // final bytes and re-runs the directory sync, which now succeeds.
  const retry = installManifestNoClobber(FINAL, MANIFEST_BYTES, fs);
  assert.deepEqual(retry, { kind: 'already_installed' });
  assert.equal(fs.log.filter((op) => op === 'syncDir').length, 2);
});

test('a temp-cleanup failure never replaces the primary result', () => {
  const fs = new FakeInstallFs();
  fs.throwOn.unlink = new Error('unlink-boom');
  assert.deepEqual(installManifestNoClobber(FINAL, MANIFEST_BYTES, fs), { kind: 'installed' });
});

test('a failing or lying final read-back fails the install AFTER publication', () => {
  const throwing = new FakeInstallFs();
  throwing.throwOn.readFile = new Error('readback-boom');
  const r1 = installManifestNoClobber(FINAL, MANIFEST_BYTES, throwing);
  assert.equal(r1.kind, 'failed');
  assert.match((r1 as { message: string }).message, /read-back of/);

  const lying = new FakeInstallFs();
  lying.onReadFile = () => Buffer.from('{"corrupted":true}', 'utf8');
  const r2 = installManifestNoClobber(FINAL, MANIFEST_BYTES, lying);
  assert.equal(r2.kind, 'failed');
  assert.match((r2 as { message: string }).message, /read-back verification failed/);
});

test('RETRY CONVERGENCE: after every pre-publication boundary failure, the identical retry installs cleanly', () => {
  // The dir-sync case (publication happened, durability unknown) has its own test above;
  // these are the failures where NOTHING was published — the retry must be a clean fresh
  // install, with the final bytes exact and no stale state in the way.
  const injections: Array<{ label: string; inject: (fs: FakeInstallFs) => void; clear: (fs: FakeInstallFs) => void }> = [
    {
      label: 'zero write progress',
      inject: (fs) => {
        fs.onWrite = () => 0;
      },
      clear: (fs) => {
        delete fs.onWrite;
      },
    },
    {
      label: 'temp fsync failure',
      inject: (fs) => {
        fs.throwOn.fsync = new Error('fsync-boom');
      },
      clear: (fs) => {
        delete fs.throwOn.fsync;
      },
    },
    {
      label: 'close failure',
      inject: (fs) => {
        fs.throwOn.close = new Error('close-boom');
      },
      clear: (fs) => {
        delete fs.throwOn.close;
      },
    },
    {
      label: 'publish failure (EPERM)',
      inject: (fs) => {
        fs.throwOn.link = errWithCode('EPERM: operation not permitted', 'EPERM');
      },
      clear: (fs) => {
        delete fs.throwOn.link;
      },
    },
    {
      label: 'temp open failure',
      inject: (fs) => {
        fs.throwOn.openExclusive = errWithCode('EACCES: permission denied', 'EACCES');
      },
      clear: (fs) => {
        delete fs.throwOn.openExclusive;
      },
    },
  ];
  for (const { label, inject, clear } of injections) {
    const fs = new FakeInstallFs();
    inject(fs);
    assert.equal(installManifestNoClobber(FINAL, MANIFEST_BYTES, fs).kind, 'failed', label);
    assert.ok(!fs.files.has(FINAL), `${label}: nothing was published`);
    clear(fs);
    assert.deepEqual(installManifestNoClobber(FINAL, MANIFEST_BYTES, fs), { kind: 'installed' }, `${label}: retry converges`);
    assert.ok(fs.files.get(FINAL)!.equals(MANIFEST_BYTES), `${label}: the retried bytes are exact`);
  }
});

test('a temp-open or mkdirp failure fails with nothing created anywhere', () => {
  const openFail = new FakeInstallFs();
  openFail.throwOn.openExclusive = errWithCode('EACCES: permission denied', 'EACCES');
  assert.equal(installManifestNoClobber(FINAL, MANIFEST_BYTES, openFail).kind, 'failed');
  assert.equal(openFail.files.size, 0);

  const mkdirFail = new FakeInstallFs();
  mkdirFail.throwOn.mkdirp = new Error('mkdir-boom');
  assert.equal(installManifestNoClobber(FINAL, MANIFEST_BYTES, mkdirFail).kind, 'failed');
  assert.deepEqual(mkdirFail.log, ['mkdirp'], 'nothing ran after the failed mkdirp');
});

// ===========================================================================
// arm
// ===========================================================================

test('arm prints the exact terms and, on confirmation, initializes the budget and records the authorization', async () => {
  const d = deps();
  const opts = options();
  const { value: code, logs } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
  assert.equal(code, 0, logs.join('\n'));

  const output = logs.join('\n');
  assert.match(output, /ARM CAMPAIGN/);
  assert.match(output, /at most 800 provider calls \(100 fires/);
  assert.match(output, /\$37\.09 expected at the observed rate/);
  assert.match(output, /hard-stopped above \$100/);
  assert.match(output, /expiry 2026-08-12T00:00:00\.000Z/);

  // The authorization was recorded, and the manifest written for later ticks.
  assert.equal(d.auth.records.size, 1);
  const record = [...d.auth.records.values()][0]!;
  assert.equal(record.disarmedAt, null);
  assert.deepEqual([...record.participantIds], ROSTER);
  const emitted = readFileSync(opts.emitPath, 'utf8');
  assert.equal(cohortBoot({ manifestBytes: emitted }).cohortId, record.cohortId);
});

test('the exact terms print BEFORE the single confirmation, whose prompt is the exact [Y/n] bytes', async () => {
  const events: string[] = [];
  const d = deps({
    confirm: async (prompt) => {
      events.push(`confirm:${prompt}`);
      return 'y';
    },
  });
  const opts = options();
  const { value: code, logs } = await captured(async () => {
    const original = console.log;
    console.log = (line?: unknown) => events.push(`print:${String(line ?? '')}`);
    try {
      return await withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d));
    } finally {
      console.log = original;
    }
  });
  assert.equal(code, 0, logs.join('\n'));

  // Exactly one confirmation, with the exact frozen [Y/n] prompt bytes — label drift fails here.
  const confirmEvents = events.filter((e) => e.startsWith('confirm:'));
  assert.deepEqual(confirmEvents, ['confirm:arm this campaign for unattended running? [Y/n] ']);
  // Every term line (through the [Y/n] hint) strictly precedes the confirmation.
  const confirmIndex = events.indexOf(confirmEvents[0]!);
  const hintIndex = events.findIndex((e) => e.startsWith('print:') && e.includes("Enter or 'y' proceeds"));
  assert.ok(hintIndex >= 0 && hintIndex < confirmIndex, 'the semantics hint printed before the prompt');
  assert.ok(
    events.findIndex((e) => e.includes('ARM CAMPAIGN')) < confirmIndex,
    'the terms header printed before the prompt',
  );
});

test('the standard [Y/n] semantics: Enter and y/Y/yes ARM; n and any other answer refuse; EOF refuses', async () => {
  for (const answer of ['', 'y', 'Y', 'yes']) {
    const d = deps({ confirm: async () => answer });
    const opts = options();
    const { value: code } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
    assert.equal(code, 0, `answer ${JSON.stringify(answer)} arms`);
    assert.equal(d.auth.records.size, 1, `answer ${JSON.stringify(answer)}: the authorization was recorded`);
  }
  for (const answer of ['n', 'N', 'no', 'yeah', 'q']) {
    const d = deps({ confirm: async () => answer });
    const opts = options();
    const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
    assert.equal(code, 2, `answer ${JSON.stringify(answer)} refuses`);
    assert.equal(d.auth.records.size, 0, `answer ${JSON.stringify(answer)}: nothing armed`);
    assert.deepEqual(d.auth.calls, [], 'the authorization port was never touched');
    assert.deepEqual(d.storeCalls, [], 'the store was never touched');
    assert.ok(!existsSync(opts.emitPath), 'no manifest was written on a refusal');
    assert.match(errors.join('\n'), /arming refused \(answer/);
  }
});

test('EOF (a stream closing without a line) refuses BEFORE normalization — it is never Enter', async () => {
  const d = deps({ confirm: async () => null });
  const opts = options();
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /confirmation stream closed \(EOF\)/);
  assert.equal(d.auth.records.size, 0);
  assert.deepEqual(d.auth.calls, []);
  assert.deepEqual(d.storeCalls, []);
  assert.ok(!existsSync(opts.emitPath));
});

test('arm REFUSES before any prompt when a roster credential is missing', async () => {
  const d = deps({
    observeCredentials: (ids) => new Map(ids.map((id) => [id, id !== ROSTER[2]])),
    confirm: async () => {
      throw new Error('must not prompt for an unarmable campaign');
    },
  });
  const { value: code } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(options(), d)));
  assert.equal(code, 2);
  assert.equal(d.auth.records.size, 0);
});

test('arm REFUSES a size outside the campaign bounds', async () => {
  for (const calls of [7, 4_001]) {
    const d = deps();
    const { value: code } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(options({ calls }), d)));
    assert.equal(code, 2, `calls=${calls}`);
    assert.equal(d.auth.records.size, 0);
  }
});

test('arm refuses a --start that is not an offset-qualified instant, and accepts one that is', async () => {
  for (const bad of ['2026-08-09T00:00:00', 'not-a-date', '2026-02-30T00:00:00Z']) {
    const d = deps();
    const opts = options({ startIso: bad });
    const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
    assert.equal(code, 2, `--start ${bad} refuses`);
    assert.match(errors.join('\n'), /offset-qualified/);
    assert.ok(!existsSync(opts.emitPath), 'nothing durable');
  }
  const d = deps();
  const { value: code } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => armCampaign(options({ startIso: '2026-08-09T00:00:00Z' }), d)),
  );
  assert.equal(code, 0);
  const record = [...d.auth.records.values()][0]!;
  assert.equal(record.expiresAt, '2026-08-16T00:00:00.000Z', 'expiry = the chosen start + the window');
});

// ---------------------------------------------------------------------------
// --start is REQUIRED — the campaign's identity anchor, so the identical public command
// stays byte-identical while the clock advances and every retry actually reconciles.
// ---------------------------------------------------------------------------

test('an OMITTED --start refuses before the prompt, the filesystem, and the store', async () => {
  let storeOpened = false;
  const d = deps({
    confirm: async () => {
      throw new Error('must not prompt without a start');
    },
    openStore: async () => {
      storeOpened = true;
      throw new Error('must not open the store');
    },
  });
  const opts = options({ startIso: null });
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /requires an explicit --start/);
  assert.ok(!existsSync(opts.emitPath), 'no manifest was written');
  assert.equal(storeOpened, false, 'the store was never opened');
  assert.deepEqual(d.auth.calls, []);
});

// ---------------------------------------------------------------------------
// --artifacts is REQUIRED — the durable evidence destination, bound at arming for the
// campaign's lifetime; its identity marker is what a tick verifies before reading
// evidence.
// ---------------------------------------------------------------------------

test('an OMITTED --artifacts refuses before the prompt, the filesystem, and the store', async () => {
  const d = deps({
    confirm: async () => {
      throw new Error('must not prompt without an evidence destination');
    },
  });
  const opts = options({ artifactsPath: null });
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /requires an explicit --artifacts/);
  assert.ok(!existsSync(opts.emitPath), 'no manifest was written');
  assert.deepEqual(d.opens, { store: 0, reads: 0 });
  assert.deepEqual(d.auth.calls, []);
});

test('arm INSTALLS the root identity marker and BINDS root + id into the record; an existing marker is adopted', async () => {
  // Fresh root: the arm mints and durably installs the identity.
  const { auth, cohortId, evidenceRoot } = await armed();
  const markerPath = join(evidenceRoot, 'evidence-root.json');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { evidenceRootVersion: number; evidenceRootId: string };
  assert.equal(marker.evidenceRootVersion, 1);
  const record = auth.records.get(cohortId)!;
  assert.equal(record.evidenceRoot, evidenceRoot, 'the record binds the RESOLVED absolute root');
  assert.equal(record.evidenceRootId, marker.evidenceRootId, 'the record binds the id the arm durably installed');

  // A root that ALREADY carries a marker: a second campaign at the same root adopts the
  // same identity (a root has ONE identity for its lifetime).
  const sharedRoot = mkdtempSync(join(tmpdir(), 'campaign-shared-root-'));
  writeFileSync(join(sharedRoot, 'evidence-root.json'), `${JSON.stringify({ evidenceRootVersion: 1, evidenceRootId: 'pre-existing-identity' })}\n`);
  const auth2 = new MemoryAuthPort();
  const opts2 = options({ startIso: '2026-08-06T00:00:00.000Z', artifactsPath: sharedRoot });
  const { value: code2 } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts2, deps({ auth: auth2 }))));
  assert.equal(code2, 0);
  const record2 = [...auth2.records.values()][0]!;
  assert.equal(record2.evidenceRootId, 'pre-existing-identity');
});

test('an UNREADABLE root marker refuses the arm before the prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'campaign-badmarker-'));
  writeFileSync(join(root, 'evidence-root.json'), '{not json');
  const d = deps({
    confirm: async () => {
      throw new Error('must not prompt over an unreadable root identity');
    },
  });
  const { value: code, errors } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => armCampaign(options({ artifactsPath: root }), d)),
  );
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /identity marker at .* is unreadable/);
  assert.deepEqual(d.auth.calls, []);
});

test('a marker RACED IN between the prompt and the durable install conflicts: refused with nothing durable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'campaign-markerrace-'));
  const d = deps({
    confirm: async () => {
      // The deterministic race: another identity lands on the root while the operator is
      // answering — the no-clobber install must refuse rather than adopt or overwrite.
      writeFileSync(join(root, 'evidence-root.json'), `${JSON.stringify({ evidenceRootVersion: 1, evidenceRootId: 'raced-in-identity' })}\n`);
      return 'y';
    },
  });
  const opts = options({ artifactsPath: root });
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /DIFFERENT identity marker/);
  assert.ok(!existsSync(opts.emitPath), 'no manifest was written after the conflict');
  assert.equal(d.auth.records.size, 0, 'no authority was created');
});

test('reconciliation requires the LIVE marker to match the standing identity — a replaced or recreated root refuses instead of reporting ALREADY armed', async () => {
  // The negative control — an intact marker still reconciles exit 0 — is pinned by the
  // 'UNKNOWN-COMMIT convergence' and 're-running the SAME arm reconciles' tests.
  // (i) The marker at the same pathname is replaced with a different identity.
  {
    const auth = new MemoryAuthPort();
    const opts = options();
    const first = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth }))));
    assert.equal(first.value, 0);
    const standing = [...auth.records.values()][0]!;
    const root = resolve(opts.artifactsPath!);
    writeFileSync(join(root, 'evidence-root.json'), `${JSON.stringify({ evidenceRootVersion: 1, evidenceRootId: 'identity-B' })}\n`);
    const retry = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth, now: () => NOW + 60_000 }))));
    assert.equal(retry.value, 2, 'the attended command must not report a reconciliation the next tick will refuse');
    assert.match(retry.errors.join('\n'), /no longer carries the\s+armed identity/);
    assert.deepEqual([...auth.records.values()][0], standing, 'the standing record was not rewritten');
  }
  // (ii) The root is lost entirely and the retry finds nothing to adopt: the retry stamps
  // a FRESH identity onto the recreated pathname (durable step 0 precedes the store read
  // by design), but the reconciliation still refuses against the standing id.
  {
    const auth = new MemoryAuthPort();
    const opts = options();
    const first = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth }))));
    assert.equal(first.value, 0);
    const root = resolve(opts.artifactsPath!);
    rmSync(root, { recursive: true, force: true });
    const retry = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth, now: () => NOW + 60_000 }))));
    assert.equal(retry.value, 2);
    assert.match(retry.errors.join('\n'), /no longer carries the\s+armed identity/);
  }
});

test('a RETRY pointed at a DIFFERENT --artifacts refuses to reconcile: the root is bound for the campaign\'s lifetime', async () => {
  const auth = new MemoryAuthPort();
  const opts = options();
  const first = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth }))));
  assert.equal(first.value, 0);
  const standing = [...auth.records.values()][0]!;

  const retry = await captured(() =>
    withEnv(SYNTHETIC_ENV, () =>
      armCampaign(
        options({ emitPath: opts.emitPath, artifactsPath: mkdtempSync(join(tmpdir(), 'campaign-other-root-')) }),
        deps({ auth, now: () => NOW + 60_000 }),
      ),
    ),
  );
  assert.equal(retry.value, 2);
  assert.match(retry.errors.join('\n'), /refusing to reconcile an arm pointed at/);
  assert.deepEqual([...auth.records.values()][0], standing, 'the standing record was not rewritten');
});

test('RETRY IDENTITY: fixed --start + an advancing clock + a pre-authorization failure → the identical retry succeeds with the exact same bytes', async () => {
  const auth = new MemoryAuthPort();
  const opts = options();
  const first = deps({
    auth,
    openStore: async () => {
      throw new Error('store unreachable');
    },
  });
  const r1 = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, first)));
  assert.equal(r1.value, 1);
  assert.match(r1.errors.join('\n'), /NO standing authority was created/);
  const bytesAfterFirst = readFileSync(opts.emitPath);

  // One minute later, the IDENTICAL public command — only the clock moved.
  const retry = deps({ auth, now: () => NOW + 60_000 });
  const r2 = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, retry)));
  assert.equal(r2.value, 0, r2.errors.join('\n'));
  assert.ok(readFileSync(opts.emitPath).equals(bytesAfterFirst), 'the manifest bytes never changed across the retry');
  assert.equal(auth.records.size, 1, 'exactly one standing authorization');
});

test('UNKNOWN-COMMIT convergence: an authorizing write that commits but loses its response reconciles on the identical retry, rewriting nothing', async () => {
  const auth = new MemoryAuthPort();
  const originalArm = auth.arm.bind(auth);
  let firstAttempt = true;
  auth.arm = async (record) => {
    if (firstAttempt) {
      firstAttempt = false;
      await originalArm(record); // the INSERT commits...
      throw new Error('response lost'); // ...but the caller never learns it
    }
    return originalArm(record);
  };
  const opts = options();
  const r1 = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth }))));
  assert.equal(r1.value, 1);
  assert.match(r1.errors.join('\n'), /commit status UNKNOWN/);
  const committed = [...auth.records.values()][0]!;

  const r2 = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth, now: () => NOW + 60_000 }))));
  assert.equal(r2.value, 0, r2.errors.join('\n'));
  assert.match(r2.logs.join('\n'), /ALREADY armed; the standing authorization validates/);
  assert.deepEqual([...auth.records.values()][0], committed, 'the committed record was re-read and fully validated, never rewritten');
});

test('UNKNOWN-COMMIT with a disarmed/expired/divergent/malformed stored row REFUSES on the identical retry', async () => {
  // Each retry must refuse (exit 2) and must NOT rewrite the standing record. The refusal
  // message differs by where it fires: a disarmed/divergent/malformed record survives to
  // the reconciliation read and refuses with the once-ever guidance; an EXPIRED campaign's
  // retry cannot even rebuild its own record (its expiry is no longer after the retry
  // clock), so it refuses in the pre-prompt build — earlier, which is strictly safer.
  const scenarios: Array<{
    label: string;
    tamper: (rec: CampaignAuthorization) => unknown;
    retryNow?: number;
    expect: RegExp;
  }> = [
    {
      label: 'disarmed',
      tamper: (rec) => ({ ...rec, disarmedAt: '2026-08-05T01:00:00.000Z' }),
      expect: /armed at most once, ever/,
    },
    { label: 'expired', tamper: (rec) => rec, retryNow: NOW + WEEK_MS + 1, expect: /refusing to arm/ },
    {
      label: 'divergent caps',
      tamper: (rec) => ({ ...rec, cohortCallCap: rec.cohortCallCap + 8 }),
      expect: /armed at most once, ever/,
    },
    {
      label: 'malformed (missing expiresAt)',
      tamper: (rec) => {
        const { expiresAt: _dropped, ...rest } = rec;
        return rest;
      },
      expect: /armed at most once, ever/,
    },
  ];
  for (const scenario of scenarios) {
    const auth = new MemoryAuthPort();
    const opts = options();
    const armed0 = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth }))));
    assert.equal(armed0.value, 0, scenario.label);
    const cohortId = [...auth.records.keys()][0]!;
    const tampered = scenario.tamper(auth.records.get(cohortId)!) as CampaignAuthorization;
    auth.records.set(cohortId, tampered);

    const retry = await captured(() =>
      withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth, now: () => scenario.retryNow ?? NOW + 60_000 }))),
    );
    assert.equal(retry.value, 2, `${scenario.label}: a dead or divergent standing record refuses`);
    assert.match(retry.errors.join('\n'), scenario.expect, scenario.label);
    assert.deepEqual(auth.records.get(cohortId), tampered, `${scenario.label}: the standing record was not rewritten`);
  }
});

// ---------------------------------------------------------------------------
// AUTHORITY ORDER — the manifest is durable BEFORE any store write, the budget before the
// authorization, and no failed arm leaves standing authority.
// ---------------------------------------------------------------------------

test('AUTHORITY ORDER: the manifest is on disk and byte-exact BEFORE the budget init and BEFORE the authorizing write', async () => {
  const opts = options();
  const expected = expectedManifestBytes();
  const observations: string[] = [];
  const auth = new MemoryAuthPort();
  const originalArm = auth.arm.bind(auth);
  auth.arm = async (record) => {
    const installed = existsSync(opts.emitPath) && readFileSync(opts.emitPath, 'utf8') === expected;
    observations.push(`arm:manifest-installed=${installed}`);
    return originalArm(record);
  };
  const store: AtomicStore = {
    initCohortBudget: async () => {
      const installed = existsSync(opts.emitPath) && readFileSync(opts.emitPath, 'utf8') === expected;
      observations.push(`init:manifest-installed=${installed}`);
      return { outcome: 'initialized' as const };
    },
    admitDispatch: () => {
      throw new Error('unreached');
    },
    acquireRepairLease: () => {
      throw new Error('unreached');
    },
    releaseLease: () => {
      throw new Error('unreached');
    },
    completeClaim: () => {
      throw new Error('unreached');
    },
  };
  const d = deps({ auth, openStore: async () => ({ store, authorizations: auth, unresolvedFires: new FakeUnresolvedFires(), tickJournal: new FakeTickJournal(), close: async () => {} }) });
  const { value: code } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
  assert.equal(code, 0);
  assert.deepEqual(
    observations,
    ['init:manifest-installed=true', 'arm:manifest-installed=true'],
    'manifest first, budget second, authorization LAST',
  );
});

test('an emit path that is an existing DIRECTORY fails loudly with NOTHING durable created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'campaign-dirclash-'));
  const d = deps();
  const { value: code, errors } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => armCampaign(options({ emitPath: dir }), d)),
  );
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /before any authority was created/);
  assert.deepEqual(d.auth.calls, [], 'the authorization port was never touched');
  assert.deepEqual(d.storeCalls, [], 'the budget was never initialized');
});

test('an emit path holding DIFFERENT bytes refuses (never overwrites) with NOTHING durable created', async () => {
  const opts = options();
  writeFileSync(opts.emitPath, '{"some":"other manifest"}');
  const d = deps();
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /refusing to overwrite/);
  assert.equal(readFileSync(opts.emitPath, 'utf8'), '{"some":"other manifest"}', 'the existing file is untouched');
  assert.deepEqual(d.auth.calls, []);
  assert.deepEqual(d.storeCalls, []);
});

test('an emit path already holding the IDENTICAL bytes reconciles — the re-run of an interrupted arm succeeds', async () => {
  const opts = options();
  writeFileSync(opts.emitPath, expectedManifestBytes());
  const d = deps();
  const { value: code, logs } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
  assert.equal(code, 0, logs.join('\n'));
  assert.match(logs.join('\n'), /already installed .*byte-identical/);
  assert.equal(d.auth.records.size, 1);
});

test('a budget-init refusal fails BEFORE the authorizing step: exit 1, no authorization recorded', async () => {
  const opts = options();
  const auth = new MemoryAuthPort();
  const store: AtomicStore = {
    initCohortBudget: async () => ({ outcome: 'refused' as const, reason: 'config_mismatch' as const }),
    admitDispatch: () => {
      throw new Error('unreached');
    },
    acquireRepairLease: () => {
      throw new Error('unreached');
    },
    releaseLease: () => {
      throw new Error('unreached');
    },
    completeClaim: () => {
      throw new Error('unreached');
    },
  };
  const d = deps({ auth, openStore: async () => ({ store, authorizations: auth, unresolvedFires: new FakeUnresolvedFires(), tickJournal: new FakeTickJournal(), close: async () => {} }) });
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /NO standing authority was created/);
  assert.deepEqual(auth.calls, [], 'the authorizing write was never attempted');
});

test('a store that cannot even open fails AFTER the manifest install with NO standing authority', async () => {
  const opts = options();
  const d = deps({
    openStore: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /NO standing authority was created/);
  assert.match(errors.join('\n'), /re-running the same arm reconciles/);
  assert.ok(existsSync(opts.emitPath), 'the manifest was installed first — authority always implies its manifest');
  assert.deepEqual(d.auth.calls, []);
});

test('a THROWING authorizing write reports its commit status UNKNOWN and names both recovery paths', async () => {
  const opts = options();
  const auth = new MemoryAuthPort();
  auth.arm = async () => {
    throw new Error('socket hang up');
  };
  const d = deps({ auth });
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
  assert.equal(code, 1);
  const output = errors.join('\n');
  assert.match(output, /commit status UNKNOWN/);
  assert.match(output, /re-run the same arm/);
  assert.match(output, /campaign:stop/);
  assert.ok(existsSync(opts.emitPath), 'the manifest survives for the stop path');
});

// ---------------------------------------------------------------------------
// re-running arm — a cohort is armed at most once, ever
// ---------------------------------------------------------------------------

test('re-running the SAME arm reconciles: exit 0 and the standing authorization is unchanged', async () => {
  const auth = new MemoryAuthPort();
  const opts = options();
  const { value: first } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth }))));
  assert.equal(first, 0);
  const recordAfterFirst = [...auth.records.values()][0]!;

  const { value: second, logs } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth }))),
  );
  assert.equal(second, 0, 'the re-run reconciles rather than failing');
  assert.match(logs.join('\n'), /ALREADY armed; the standing authorization validates/);
  assert.equal(auth.records.size, 1);
  assert.deepEqual([...auth.records.values()][0], recordAfterFirst, 'the standing record was not replaced');
});

test('arm against a DISARMED cohort refuses: a cohort is armed at most once, ever — a new campaign is a NEW manifest', async () => {
  const auth = new MemoryAuthPort();
  const opts = options();
  const { value: first } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth }))));
  assert.equal(first, 0);
  const booted = cohortBoot({ manifestBytes: readFileSync(opts.emitPath, 'utf8') });
  await auth.disarm(booted.cohortId, new Date(NOW).toISOString());

  const { value: second, errors } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth }))),
  );
  assert.equal(second, 2);
  const output = errors.join('\n');
  assert.match(output, /armed at most once, ever/);
  assert.match(output, /NEW manifest/);
  const stored = auth.records.get(booted.cohortId)!;
  assert.notEqual(stored.disarmedAt, null, 'the disarmed record stands — never revived or replaced');
});

// ===========================================================================
// cleanup must not falsify a decided outcome — close-failure injection per phase
// ===========================================================================

const FAILING_CLOSE = async (): Promise<void> => {
  throw new Error('simulated close failure');
};

/** deps whose store AND read closes ALWAYS reject; the decided outcome must stand anyway. */
function depsWithFailingClose(
  over: Partial<CampaignDeps> & { auth?: MemoryAuthPort } = {},
): ReturnType<typeof deps> {
  const base = deps(over);
  return {
    ...base,
    openStore: async () => {
      const opened = await base.openStore('unused');
      return { ...opened, close: FAILING_CLOSE };
    },
    openReads: async () => {
      const opened = await base.openReads('unused');
      return { ...opened, close: FAILING_CLOSE };
    },
  };
}

test('a CONFIRMED arm survives a close failure: exit 0, ARMED stands, the cleanup is a warning', async () => {
  const d = depsWithFailingClose();
  const opts = options();
  const { value: code, logs, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
  assert.equal(code, 0, 'the durable authorization is real — the exit must say so');
  assert.match(logs.join('\n'), /ARMED\./);
  assert.match(errors.join('\n'), /warning: closing the store connection failed AFTER the outcome was decided/);
  assert.equal(d.auth.records.size, 1);
});

test('a PRE-AUTHORITY failure keeps its primary error through a close failure', async () => {
  const auth = new MemoryAuthPort();
  const storeCalls: string[] = [];
  const refusingStore: AtomicStore = {
    ...recordingStore(storeCalls),
    initCohortBudget: async () => ({ outcome: 'refused' as const, reason: 'config_mismatch' as const }),
  };
  const d = deps({ auth, openStore: async () => ({ store: refusingStore, authorizations: auth, unresolvedFires: new FakeUnresolvedFires(), tickJournal: new FakeTickJournal(), close: FAILING_CLOSE }) });
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(options(), d)));
  assert.equal(code, 1);
  const output = errors.join('\n');
  assert.match(output, /NO standing authority was created/, 'the primary pre-authority error is preserved');
  assert.match(output, /warning: closing the store connection failed/);
  assert.deepEqual(auth.calls, [], 'the authorizing write was never attempted');
});

test('an UNKNOWN-COMMIT arm keeps its recovery message through a close failure', async () => {
  const auth = new MemoryAuthPort();
  auth.arm = async () => {
    throw new Error('socket hang up');
  };
  const d = depsWithFailingClose({ auth });
  const opts = options();
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
  assert.equal(code, 1);
  const output = errors.join('\n');
  assert.match(output, /commit status UNKNOWN/, 'the unknown-commit classification is preserved');
  assert.match(output, /re-run the same arm/, 'both recovery paths still print');
  assert.match(output, /warning: closing the store connection failed/);
});

test('a RECONCILED already-armed re-run survives a close failure: exit 0', async () => {
  const auth = new MemoryAuthPort();
  const opts = options();
  const first = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth }))));
  assert.equal(first.value, 0);
  const { value: code, logs } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => armCampaign(opts, depsWithFailingClose({ auth }))),
  );
  assert.equal(code, 0);
  assert.match(logs.join('\n'), /ALREADY armed/);
});

test('a CONFIRMED stop and an ABSENT stop keep their outcomes through a close failure', async () => {
  const { manifestPath, auth, cohortId } = await armed();
  const stopped = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => stopCampaign(options({ command: 'stop', manifestPath }), depsWithFailingClose({ auth }))),
  );
  assert.equal(stopped.value, 0, 'the disarm is durable — the exit must say so');
  assert.match(stopped.logs.join('\n'), /STOPPED\./);
  assert.match(stopped.errors.join('\n'), /warning: closing the store connection failed/);
  assert.notEqual(auth.records.get(cohortId)!.disarmedAt, null);

  const { bytes } = buildCampaignManifest(NOW + 3_600_000, { callCap: 800, windowForwardMs: WEEK_MS });
  const otherPath = join(mkdtempSync(join(tmpdir(), 'campaign-close-absent-')), 'manifest.json');
  writeFileSync(otherPath, bytes);
  const absent = await captured(() =>
    withEnv(SYNTHETIC_ENV, () =>
      stopCampaign(options({ command: 'stop', manifestPath: otherPath }), depsWithFailingClose({ auth })),
    ),
  );
  assert.equal(absent.value, 2, 'the never-armed refusal is preserved');
});

test('both tick outcomes keep their exit codes through a close failure', async () => {
  const { manifestPath, auth } = await armed();
  const resolver = publishedResolver(manifestPath);
  const valid = await captured(() =>
    withEnv(SYNTHETIC_ENV, () =>
      tickCampaign(
        options({ command: 'tick', manifestPath, publicationPath: publicationFile() }),
        depsWithFailingClose({ auth, confirm: NEVER_PROMPT, resolvePublication: resolver.resolve }),
      ),
    ),
  );
  assert.equal(valid.value, 0, 'the dispatched outcome is preserved');

  const { bytes } = buildCampaignManifest(NOW + 7_200_000, { callCap: 800, windowForwardMs: WEEK_MS });
  const strangerPath = join(mkdtempSync(join(tmpdir(), 'campaign-close-tick-')), 'manifest.json');
  writeFileSync(strangerPath, bytes);
  const strangerResolver = publishedResolver(strangerPath);
  const refused = await captured(() =>
    withEnv(SYNTHETIC_ENV, () =>
      tickCampaign(
        options({ command: 'tick', manifestPath: strangerPath, publicationPath: publicationFile() }),
        depsWithFailingClose({ auth, confirm: NEVER_PROMPT, resolvePublication: strangerResolver.resolve }),
      ),
    ),
  );
  assert.equal(refused.value, 2, 'the no-authorization refusal is preserved');
});

// ===========================================================================
// HOSTILE rejection values — error rendering must be TOTAL, or reporting a cleanup or
// authorizing failure would itself throw and replace the already-classified outcome.
// ===========================================================================

/**
 * The four hostile fixtures from the frozen correction, built WITHOUT converting them:
 * the harness never calls String(value), reads its prototype, or serializes it — each
 * value is paired with a separate safe string label used in every assertion message.
 */
function hostileFixtures(): Array<{ label: string; value: unknown }> {
  const throwingCoercion = Object.create(null) as { toString(): string };
  throwingCoercion.toString = () => {
    throw new Error('coercion escaped');
  };

  const throwingMessageGetter = new Error('hidden');
  Object.defineProperty(throwingMessageGetter, 'message', {
    get() {
      throw new Error('message getter escaped');
    },
  });

  const pair = Proxy.revocable({}, {});
  pair.revoke();

  const selfThrowingCoercion = Object.create(null) as { toString(): string };
  selfThrowingCoercion.toString = () => {
    throw selfThrowingCoercion;
  };

  return [
    { label: 'object whose toString() throws', value: throwingCoercion },
    { label: 'Error whose message getter throws', value: throwingMessageGetter },
    { label: 'revoked proxy', value: pair.proxy },
    { label: 'object whose coercion throws itself', value: selfThrowingCoercion },
  ];
}

/** A close() that rejects with the given hostile value. */
const rejectWith = (value: unknown) => async (): Promise<void> => {
  throw value;
};

/** deps whose store AND read closes reject with `value`; everything else is the normal fake. */
function depsWithHostileClose(
  value: unknown,
  over: Partial<CampaignDeps> & { auth?: MemoryAuthPort } = {},
): ReturnType<typeof deps> {
  const base = deps(over);
  return {
    ...base,
    openStore: async () => {
      const opened = await base.openStore('unused');
      return { ...opened, close: rejectWith(value) };
    },
    openReads: async () => {
      const opened = await base.openReads('unused');
      return { ...opened, close: rejectWith(value) };
    },
  };
}

test('HOSTILE close rejection cannot override a CONFIRMED arm: 0, ARMED, one durable row, fallback-rendered warning', async () => {
  for (const { label, value } of hostileFixtures()) {
    const d = depsWithHostileClose(value);
    const opts = options();
    const { value: code, logs, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
    assert.equal(code, 0, `${label}: the confirmed arm resolves 0 — it must never reject`);
    assert.match(logs.join('\n'), /ARMED\./, label);
    const output = errors.join('\n');
    assert.match(output, /warning: closing the store connection failed/, label);
    assert.match(output, /<unprintable thrown value>/, `${label}: the fixed fallback literal renders`);
    assert.equal(d.auth.records.size, 1, `${label}: exactly one durable authorization`);
  }
});

test('HOSTILE close rejection cannot override a RECONCILED existing arm: 0, standing row untouched', async () => {
  for (const { label, value } of hostileFixtures()) {
    const auth = new MemoryAuthPort();
    const opts = options();
    const first = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth }))));
    assert.equal(first.value, 0, label);
    const standing = [...auth.records.values()][0]!;

    const { value: code, logs, errors } = await captured(() =>
      withEnv(SYNTHETIC_ENV, () => armCampaign(opts, depsWithHostileClose(value, { auth }))),
    );
    assert.equal(code, 0, `${label}: the reconciled re-run resolves 0`);
    assert.match(logs.join('\n'), /ALREADY armed; the standing authorization validates/, label);
    assert.match(errors.join('\n'), /warning: closing the store connection failed/, label);
    assert.deepEqual([...auth.records.values()][0], standing, `${label}: the standing record was not rewritten`);
  }
});

test('HOSTILE authorizing rejection still names UNKNOWN commit and both recovery paths: resolves 1, one durable row', async () => {
  for (const { label, value } of hostileFixtures()) {
    const auth = new MemoryAuthPort();
    const originalArm = auth.arm.bind(auth);
    auth.arm = async (record) => {
      await originalArm(record); // the INSERT commits...
      throw value; // ...and the acknowledgement is a hostile value
    };
    const opts = options();
    const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth }))));
    assert.equal(code, 1, `${label}: the command resolves failure — it must never reject`);
    const output = errors.join('\n');
    assert.match(output, /commit status UNKNOWN/, label);
    assert.match(output, /re-run the same arm/, label);
    assert.match(output, /campaign:stop/, label);
    assert.equal(auth.records.size, 1, `${label}: the committed row stands`);
  }
});

test('HOSTILE authorizing rejection + HOSTILE close rejection together preserve the unknown-commit classification', async () => {
  const fixtures = hostileFixtures();
  const armHostile = fixtures[2]!; // revoked proxy from the authorizing write
  const closeHostile = fixtures[0]!; // throwing coercion from the cleanup
  const auth = new MemoryAuthPort();
  const originalArm = auth.arm.bind(auth);
  auth.arm = async (record) => {
    await originalArm(record);
    throw armHostile.value;
  };
  const d = depsWithHostileClose(closeHostile.value, { auth });
  const opts = options();
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d)));
  assert.equal(code, 1, 'the primary unknown-commit classification survives BOTH hostile failures');
  const output = errors.join('\n');
  assert.match(output, /commit status UNKNOWN/);
  assert.match(output, /re-run the same arm/);
  assert.match(output, /warning: closing the store connection failed/);
  assert.equal(auth.records.size, 1);
});

test('PRE-AUTHORITY failures keep their classification under hostile values: rows 0, resolves 1, no authority', async () => {
  for (const { label, value } of hostileFixtures()) {
    // (i) a normal budget refusal with a HOSTILE close rejection...
    const auth1 = new MemoryAuthPort();
    const storeCalls1: string[] = [];
    const refusing: AtomicStore = {
      ...recordingStore(storeCalls1),
      initCohortBudget: async () => ({ outcome: 'refused' as const, reason: 'config_mismatch' as const }),
    };
    const d1 = deps({ auth: auth1, openStore: async () => ({ store: refusing, authorizations: auth1, unresolvedFires: new FakeUnresolvedFires(), tickJournal: new FakeTickJournal(), close: rejectWith(value) }) });
    const r1 = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(options(), d1)));
    assert.equal(r1.value, 1, `${label} (hostile close): pre-authority failure resolves 1`);
    assert.match(r1.errors.join('\n'), /NO standing authority was created/, label);
    assert.equal(auth1.records.size, 0, label);

    // (ii) ...and a budget initialization that REJECTS with the hostile value itself.
    const auth2 = new MemoryAuthPort();
    const storeCalls2: string[] = [];
    const hostileInit: AtomicStore = {
      ...recordingStore(storeCalls2),
      initCohortBudget: async () => {
        throw value;
      },
    };
    const d2 = deps({ auth: auth2, openStore: async () => ({ store: hostileInit, authorizations: auth2, unresolvedFires: new FakeUnresolvedFires(), tickJournal: new FakeTickJournal(), close: rejectWith(value) }) });
    const r2 = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(options(), d2)));
    assert.equal(r2.value, 1, `${label} (hostile primary + hostile close): still resolves 1`);
    assert.match(r2.errors.join('\n'), /NO standing authority was created/, label);
    assert.equal(auth2.records.size, 0, label);
  }
});

test('CONFIRMED and ABSENT stop keep their outcomes under hostile close rejections; the first stop instant stands', async () => {
  for (const { label, value } of hostileFixtures()) {
    const { manifestPath, auth, cohortId } = await armed();
    const stopped = await captured(() =>
      withEnv(SYNTHETIC_ENV, () =>
        stopCampaign(options({ command: 'stop', manifestPath }), depsWithHostileClose(value, { auth })),
      ),
    );
    assert.equal(stopped.value, 0, `${label}: the durable disarm resolves 0`);
    assert.match(stopped.logs.join('\n'), /STOPPED\./, label);
    const firstInstant = auth.records.get(cohortId)!.disarmedAt;
    assert.notEqual(firstInstant, null, label);

    // A repeated stop (also with a hostile close) preserves the FIRST stop instant.
    const again = await captured(() =>
      withEnv(SYNTHETIC_ENV, () =>
        stopCampaign(
          options({ command: 'stop', manifestPath }),
          depsWithHostileClose(value, { auth, now: () => NOW + 120_000 }),
        ),
      ),
    );
    assert.equal(again.value, 0, label);
    assert.equal(auth.records.get(cohortId)!.disarmedAt, firstInstant, `${label}: history was not rewritten`);

    // The absent-cohort refusal is preserved too.
    const { bytes } = buildCampaignManifest(NOW + 5_400_000, { callCap: 800, windowForwardMs: WEEK_MS });
    const otherPath = join(mkdtempSync(join(tmpdir(), 'campaign-hostile-absent-')), 'manifest.json');
    writeFileSync(otherPath, bytes);
    const absent = await captured(() =>
      withEnv(SYNTHETIC_ENV, () =>
        stopCampaign(options({ command: 'stop', manifestPath: otherPath }), depsWithHostileClose(value, { auth })),
      ),
    );
    assert.equal(absent.value, 2, `${label}: the never-armed refusal is preserved`);
  }
});

test('the tick keeps its exits under hostile close rejections: 0 when dispatched, 2 when refused', async () => {
  for (const { label, value } of hostileFixtures()) {
    const { manifestPath, auth } = await armed();
    const resolver = publishedResolver(manifestPath);
    const valid = await captured(() =>
      withEnv(SYNTHETIC_ENV, () =>
        tickCampaign(
          options({ command: 'tick', manifestPath, publicationPath: publicationFile() }),
          depsWithHostileClose(value, { auth, confirm: NEVER_PROMPT, resolvePublication: resolver.resolve }),
        ),
      ),
    );
    assert.equal(valid.value, 0, `${label}: the dispatched outcome is preserved`);
    assert.match(valid.logs.join('\n'), /campaign authorization VALID/, label);

    const { bytes } = buildCampaignManifest(NOW + 9_000_000, { callCap: 800, windowForwardMs: WEEK_MS });
    const strangerPath = join(mkdtempSync(join(tmpdir(), 'campaign-hostile-tick-')), 'manifest.json');
    writeFileSync(strangerPath, bytes);
    const strangerResolver = publishedResolver(strangerPath);
    const refused = await captured(() =>
      withEnv(SYNTHETIC_ENV, () =>
        tickCampaign(
          options({ command: 'tick', manifestPath: strangerPath, publicationPath: publicationFile() }),
          depsWithHostileClose(value, { auth, confirm: NEVER_PROMPT, resolvePublication: strangerResolver.resolve }),
        ),
      ),
    );
    assert.equal(refused.value, 2, `${label}: the no-authorization refusal is preserved`);
  }
});

// ===========================================================================
// tick
// ===========================================================================

/** Arm a campaign and return its manifest path, the shared port, and the BOUND evidence
 *  root (the record's root — where a tick's evidence scan reads and its sink writes). */
async function armed(): Promise<{ manifestPath: string; auth: MemoryAuthPort; cohortId: string; evidenceRoot: string }> {
  const auth = new MemoryAuthPort();
  const opts = options();
  const { value: code } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth }))));
  assert.equal(code, 0);
  const cohortId = cohortBoot({ manifestBytes: readFileSync(opts.emitPath, 'utf8') }).cohortId;
  return { manifestPath: opts.emitPath, auth, cohortId, evidenceRoot: resolve(opts.artifactsPath!) };
}

const NEVER_PROMPT = async (): Promise<string | null> => {
  throw new Error('an unattended tick must never prompt');
};

/** Tick deps + options against `manifestPath`, with VERIFIABLE publication evidence: the
 *  resolver publishes the exact local manifest bytes at a compliant instant. */
function tickFixture(
  manifestPath: string,
  auth: MemoryAuthPort,
  over: Partial<CampaignDeps> = {},
): { d: ReturnType<typeof deps>; opts: Parameters<typeof armCampaign>[0]; resolver: ReturnType<typeof publishedResolver> } {
  const resolver = publishedResolver(manifestPath);
  const d = deps({ auth, confirm: NEVER_PROMPT, resolvePublication: resolver.resolve, ...over });
  const opts = options({ command: 'tick', manifestPath, publicationPath: publicationFile() });
  return { d, opts, resolver };
}

test('a tick with NO armed authorization fires nothing and exits 2 — never a mock fallback, never a prompt', async () => {
  const { bytes } = buildCampaignManifest(NOW, { callCap: 800, windowForwardMs: WEEK_MS });
  const dir = mkdtempSync(join(tmpdir(), 'campaign-tick-'));
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, bytes);

  const { d, opts } = tickFixture(manifestPath, new MemoryAuthPort());
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /no live campaign authorization/);
  assert.deepEqual(d.storeCalls, [], 'the store was never touched');
  assert.equal(d.tickInputs.length, 0, 'nothing was dispatched');
  assert.ok(
    d.tickJournal.calls.some((c) => c.startsWith('finish:71:no_live_authorization:')),
    'the refusal is a journaled outcome the schedule halt rule will see',
  );
});

test('a tick against a DISARMED campaign fires nothing and exits 2', async () => {
  const { manifestPath, auth, cohortId } = await armed();
  await auth.disarm(cohortId, new Date(NOW).toISOString());
  const { d, opts } = tickFixture(manifestPath, auth);
  const { value: code } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 2);
  assert.deepEqual(d.unresolvedFires.calls, [], 'the latch is not consulted once the authorization already refused');
  assert.equal(d.tickInputs.length, 0, 'nothing was dispatched');
});

test('a tick after EXPIRY fires nothing and exits 2', async () => {
  const { manifestPath, auth } = await armed();
  const { d, opts } = tickFixture(manifestPath, auth, { now: () => NOW + WEEK_MS + 1 });
  const { value: code } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 2);
  assert.equal(d.tickInputs.length, 0, 'nothing was dispatched');
});

test('a VALID armed authorization DISPATCHES: billable capability, branded publication, durable sink — and journals the healthy outcome (exit 0)', async () => {
  const { manifestPath, auth, cohortId, evidenceRoot } = await armed();
  auth.calls.length = 0; // observe only the tick's interactions
  const { d, opts } = tickFixture(manifestPath, auth);
  const { value: code, logs } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 0, 'a healthy dispatched tick exits 0 — the scheduler follows with another tick');
  const output = logs.join('\n');
  assert.match(output, /publication evidence VERIFIED/);
  assert.match(output, /campaign authorization VALID/);
  assert.match(output, /escalation latch CLEAR — no unresolved fire and no installed escalation evidence/);
  assert.match(output, /dispatching up to 1 fire\(s\) \(REAL provider adapters/);
  assert.match(output, /TICK COMPLETE — 0 fire\(s\) admitted of 0 candidate\(s\) discovered/);
  assert.deepEqual(auth.calls, [`read:${cohortId}`], 'the ONLY port interaction is the read');
  assert.deepEqual(d.unresolvedFires.calls, [`unresolved:${cohortId}`], 'the tick-level composed latch read ran exactly once');
  assert.deepEqual(d.storeCalls, [], 'the scripted tick admitted nothing — no dispatch-path store call');

  // The assembled REAL tick input: a genuinely MINTED billable capability over the exact
  // roster, the branded publication record for this cohort, the durable sink, and the
  // store admission pins. A raw adapter map or a mock capability cannot produce these.
  assert.equal(d.tickInputs.length, 1);
  const input = d.tickInputs[0]!;
  assert.equal(input.booted.cohortId, cohortId);
  assertCohortAdapterCapability(input.capability);
  assert.equal(input.capability.billingClass, 'billable', 'the gated producer minted REAL billing authority');
  assert.deepEqual([...input.capability.adapters().keys()], ROSTER);
  assert.equal(input.publication.cohortId, cohortId, 'the verified publication record is bound to this cohort');
  assert.ok(input.sink instanceof FireArtifactSink, 'the durable artifact sink is wired');
  assert.equal(
    (input.sink as unknown as { baseDir: string }).baseDir,
    evidenceRoot,
    'the sink writes under the RECORD-BOUND root the evidence scan reads — a sink pointed elsewhere would orphan its evidence',
  );
  assert.equal(input.admission.expectedSchemaVersion, STORE_SCHEMA_VERSION);
  assert.ok(input.admission.ownerId.length > 0);

  const at = new Date(NOW).toISOString();
  assert.deepEqual(
    d.tickJournal.calls.filter((c) => !c.startsWith('finish:')),
    [`window:${cohortId}:dispatched`, `begin:${cohortId}:${at}`],
    'the halt rule read the authoritative window, then the tick journaled its begin',
  );
  const finish = d.tickJournal.finishes[0]!;
  assert.equal(finish.entryId, 71);
  assert.equal(finish.outcome, 'dispatched');
  assert.deepEqual(JSON.parse(finish.detail!), {
    discovered: 0,
    evaluated: 0,
    admitted: 0,
    deferrals: {},
    outcomes: {},
    installed: [],
  });
});

test('a HALTED schedule refuses the tick (exit 2) before any journal write or authorization read', async () => {
  const { manifestPath, auth, cohortId } = await armed();
  auth.calls.length = 0;
  const { d, opts, resolver } = tickFixture(manifestPath, auth);
  d.tickJournal.windowValue = [
    { id: 4, kind: 'tick', startedAt: '2026-08-04T23:00:00.000Z', finishedAt: '2026-08-04T23:00:05.000Z', outcome: 'loud_failure', detail: 'boom' },
  ];
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 2);
  const refusal = errors.join('\n');
  assert.match(refusal, /SCHEDULE HALTED — refusing to run/);
  assert.match(refusal, /"loud_failure"/);
  assert.match(refusal, /campaign:resume/, 'the operator is told the lever');
  assert.deepEqual(
    d.tickJournal.calls,
    [`window:${cohortId}:dispatched`],
    'a halted tick writes no journal entry — its refusal is derived state',
  );
  assert.equal(resolver.calls.length, 0, 'the halt precedes even the publication resolution');
  assert.deepEqual(auth.calls, [], 'and the authorization read');
  assert.deepEqual(d.unresolvedFires.calls, [], 'and the latch read');
  assert.equal(d.tickInputs.length, 0, 'nothing was dispatched');
});

test('a crashed tick surfaces through the AUTHORITATIVE window read even when the bounded display read no longer holds it', async () => {
  const { manifestPath, auth } = await armed();
  const { d, opts } = tickFixture(manifestPath, auth);
  // The bounded display read holds only healthy ticks (a fast cron pushed the crash out);
  // the authoritative window still carries the stale entry — and it alone decides.
  d.tickJournal.entriesValue = [
    { id: 60, kind: 'tick', startedAt: '2026-08-04T23:50:00.000Z', finishedAt: '2026-08-04T23:50:05.000Z', outcome: 'dispatched', detail: null },
  ];
  d.tickJournal.windowValue = [
    { id: 3, kind: 'tick', startedAt: '2026-08-04T00:00:00.000Z', finishedAt: null, outcome: null, detail: null },
  ];
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /tick 3 started .* never finished within the tick deadline/);
});

test('a tick that finds a STALE UNFINISHED entry (the crash shape) halts the same way', async () => {
  const { manifestPath, auth } = await armed();
  const { d, opts } = tickFixture(manifestPath, auth);
  // Started far beyond the campaign manifest tick deadline, never finished.
  d.tickJournal.windowValue = [
    { id: 4, kind: 'tick', startedAt: '2026-08-04T00:00:00.000Z', finishedAt: null, outcome: null, detail: null },
  ];
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /never finished within the tick deadline/);
});

test('a journal FINISH failure never changes the decided outcome — reported, and the entry left to halt the schedule', async () => {
  const { manifestPath, auth } = await armed();
  const { d, opts } = tickFixture(manifestPath, auth);
  d.tickJournal.finish = async (): Promise<never> => {
    throw new Error('journal write lost');
  };
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 0, 'the decided healthy outcome stands');
  assert.match(errors.join('\n'), /journal finish failed AFTER the outcome was decided/);
  assert.match(errors.join('\n'), /will halt the schedule until an operator reviews it/);
});

test('a journal BEGIN failure is LOUD — a tick that cannot reach the journal proceeds to nothing', async () => {
  const { manifestPath, auth } = await armed();
  const { d, opts } = tickFixture(manifestPath, auth);
  d.tickJournal.begin = async (): Promise<never> => {
    throw new Error('journal begin lost');
  };
  await assert.rejects(
    captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d))),
    /journal begin lost/,
  );
  assert.deepEqual(d.auth.calls.filter((c) => c.startsWith('read:')), [], 'no authorization was read');
  assert.equal(d.tickInputs.length, 0, 'nothing was dispatched');
});

test('a tick under a LIVE authorization but a TRIPPED escalation latch refuses (exit 2) and names the cause', async () => {
  const { manifestPath, auth, cohortId } = await armed();
  const { d, opts } = tickFixture(manifestPath, auth);
  const fireId = 'f'.repeat(64);
  d.unresolvedFires.fires = [{ fireId, admittedAt: '2026-08-05T12:00:00.000Z' }];
  const { value: code, logs, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 2, 'a latched campaign must not dispatch');
  assert.match(logs.join('\n'), /campaign authorization VALID/, 'the authorization itself DID validate — the latch is what refused');
  const refusal = errors.join('\n');
  assert.match(refusal, /ESCALATION LATCH — refusing to dispatch: 1 cause\(s\)/);
  assert.match(refusal, new RegExp(`unresolved fire ${fireId} \\(admitted 2026-08-05T12:00:00\\.000Z\\)`));
  assert.match(refusal, /campaign:stop/, 'the operator is told the lever');
  assert.equal(d.tickInputs.length, 0, 'nothing was dispatched');
  assert.deepEqual(d.unresolvedFires.calls, [`unresolved:${cohortId}`]);
  assert.ok(
    d.tickJournal.calls.some((c) => c.startsWith(`finish:71:escalation_latched:unresolved fire ${fireId}`)),
    'the latched refusal is journaled with the cause named',
  );
});

test('a latch read failure fails the tick LOUD — a broken latch is never read as clear — and journals loud_failure', async () => {
  const { manifestPath, auth } = await armed();
  const { d, opts } = tickFixture(manifestPath, auth);
  d.unresolvedFires.unresolvedFires = async (): Promise<never> => {
    throw new Error('latch read: connection reset');
  };
  await assert.rejects(
    captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d))),
    /latch read: connection reset/,
  );
  assert.ok(
    d.tickJournal.calls.some((c) => c.startsWith('finish:71:loud_failure:latch read: connection reset')),
    'the loud failure is journaled best-effort before it propagates',
  );
  assert.equal(d.tickInputs.length, 0, 'nothing was dispatched');
});

test('resume: a schedule that is NOT halted has nothing to resume — exit 2, no write, no prompt', async () => {
  const { manifestPath, auth, cohortId } = await armed();
  const d = deps({ auth, confirm: NEVER_PROMPT });
  const { value: code, errors } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => resumeCampaign(options({ command: 'resume', manifestPath }), d)),
  );
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /nothing to resume — the schedule is not halted/);
  assert.deepEqual(
    d.tickJournal.calls,
    [`window:${cohortId}:dispatched`],
    'read-only: no resume row was written',
  );
});

test('resume: a HALTED schedule resumes only through the standard [Y/n] — accept writes the acknowledgment, exit 0', async () => {
  const { manifestPath, auth, cohortId } = await armed();
  const prompts: string[] = [];
  const d = deps({
    auth,
    confirm: async (prompt) => {
      prompts.push(prompt);
      return '';
    },
  });
  d.tickJournal.windowValue = [
    { id: 4, kind: 'tick', startedAt: '2026-08-04T23:00:00.000Z', finishedAt: '2026-08-04T23:00:05.000Z', outcome: 'loud_failure', detail: 'boom' },
  ];
  const { value: code, logs } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => resumeCampaign(options({ command: 'resume', manifestPath }), d)),
  );
  assert.equal(code, 0, logs.join('\n'));
  assert.deepEqual(prompts, ['resume scheduled ticking for this campaign? [Y/n] '], 'the exact prompt bytes');
  const output = logs.join('\n');
  assert.match(output, /RESUME SCHEDULING/);
  assert.match(output, /clears the schedule halt ONLY/);
  assert.match(output, /RESUMED\./);
  const at = new Date(NOW).toISOString();
  assert.equal(d.tickJournal.calls.length, 2);
  assert.equal(d.tickJournal.calls[0], `window:${cohortId}:dispatched`);
  assert.ok(
    d.tickJournal.calls[1]!.startsWith(`resume:${cohortId}:${at}:tick 4 finished`) &&
      d.tickJournal.calls[1]!.endsWith(':70'),
    `the acknowledgment carries the reviewed halt reason AND the reviewed frontier; got ${d.tickJournal.calls[1]}`,
  );
});

test('a publication-verification failure journals publication_refused — the halt rule sees it on the next tick', async () => {
  const { manifestPath, auth } = await armed();
  auth.calls.length = 0; // observe only the tick's interactions
  const dir = mkdtempSync(join(tmpdir(), 'campaign-pub-journal-'));
  const publicationPath = join(dir, 'publication.json');
  writeFileSync(
    publicationPath,
    JSON.stringify({ repositoryOwner: 'ospex-org', repositoryName: 'ospex-benchmark', path: 'manifests/campaign.json', commitSha: 'a'.repeat(40) }),
  );
  const d = deps({
    auth,
    confirm: NEVER_PROMPT,
    resolvePublication: async () => {
      throw new Error('resolver unreachable');
    },
  });
  const { value: code, errors } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => tickCampaign(options({ command: 'tick', manifestPath, publicationPath }), d)),
  );
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /publication evidence REFUSED/);
  assert.ok(
    d.tickJournal.calls.some((c) => c.startsWith('finish:71:publication_refused:')),
    `the refusal is a journaled outcome; calls: ${d.tickJournal.calls.join(' | ')}`,
  );
  assert.deepEqual(auth.calls, [], 'refused before the authorization read');
});

test("the tick's journal read failure is LOUD — a broken journal is never read as a clear schedule", async () => {
  const { manifestPath, auth } = await armed();
  const { d, opts } = tickFixture(manifestPath, auth);
  d.tickJournal.scheduleWindow = async (): Promise<never> => {
    throw new Error('journal read: connection reset');
  };
  await assert.rejects(
    captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d))),
    /journal read: connection reset/,
  );
  assert.deepEqual(auth.calls.filter((c) => c.startsWith('read:')), [], 'nothing proceeded past the broken read');
  assert.equal(d.tickInputs.length, 0, 'nothing was dispatched');
});

test('an unusable publication descriptor refuses BEFORE the store: no open, no journal trace', async () => {
  const { manifestPath, auth } = await armed();
  const dir = mkdtempSync(join(tmpdir(), 'campaign-pub-unusable-'));
  const publicationPath = join(dir, 'publication.json');
  writeFileSync(publicationPath, '{"not":"a descriptor"}');
  const d = deps({ auth, confirm: NEVER_PROMPT });
  const { value: code, errors } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => tickCampaign(options({ command: 'tick', manifestPath, publicationPath }), d)),
  );
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /publication descriptor .* is unusable/);
  assert.deepEqual(d.opens, { store: 0, reads: 0 }, 'a configuration error never opens the store');
  assert.deepEqual(d.tickJournal.calls, [], 'and leaves no journal trace — the documented pre-journal bound');
});

test('resume: refuses while an IN-FLIGHT tick has no outcome to review — nothing may be bounded out of the window unseen', async () => {
  const { manifestPath, auth } = await armed();
  const d = deps({ auth, confirm: NEVER_PROMPT });
  d.tickJournal.windowValue = [
    // The halt cause the operator is reviewing...
    { id: 4, kind: 'tick', startedAt: '2026-08-04T23:00:00.000Z', finishedAt: '2026-08-04T23:00:05.000Z', outcome: 'loud_failure', detail: null },
    // ...and an overlapping tick still inside its deadline, outcome pending.
    { id: 5, kind: 'tick', startedAt: new Date(NOW - 1_000).toISOString(), finishedAt: null, outcome: null, detail: null },
  ];
  const { value: code, errors } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => resumeCampaign(options({ command: 'resume', manifestPath }), d)),
  );
  assert.equal(code, 2, 'refused — no prompt was reached (the confirm seam throws if touched)');
  assert.match(errors.join('\n'), /refusing to resume: tick 5 .* still in flight/);
  assert.ok(!d.tickJournal.calls.some((c) => c.startsWith('resume:')), 'no acknowledgment was written');
});

test('resume: EOF and a negative answer both refuse without writing', async () => {
  for (const [confirm, expectation] of [
    [async () => null, /confirmation stream closed \(EOF\)/],
    [async () => 'n', /resume refused \(answer "n"\)/],
  ] as const) {
    const { manifestPath, auth } = await armed();
    const d = deps({ auth, confirm });
    d.tickJournal.windowValue = [
      { id: 4, kind: 'tick', startedAt: '2026-08-04T23:00:00.000Z', finishedAt: '2026-08-04T23:00:05.000Z', outcome: 'loud_failure', detail: null },
    ];
    const { value: code, errors } = await captured(() =>
      withEnv(SYNTHETIC_ENV, () => resumeCampaign(options({ command: 'resume', manifestPath }), d)),
    );
    assert.equal(code, 2);
    assert.match(errors.join('\n'), expectation);
    assert.ok(!d.tickJournal.calls.some((c) => c.startsWith('resume:')), 'no acknowledgment was written');
  }
});

// ===========================================================================
// status — the read-only monitoring surface
// ===========================================================================

test('status with NO armed campaign: exit 2, NOT ARMED, never-armed budget note, and NO writes of any kind', async () => {
  const { bytes } = buildCampaignManifest(NOW, { callCap: 800, windowForwardMs: WEEK_MS });
  const dir = mkdtempSync(join(tmpdir(), 'campaign-status-'));
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, bytes);
  const cohortId = cohortBoot({ manifestBytes: bytes }).cohortId;

  const d = deps({ confirm: NEVER_PROMPT });
  const { value: code, logs } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath }), d)),
  );
  assert.equal(code, 2);
  const output = logs.join('\n');
  assert.match(output, /authorization NOT ARMED/);
  assert.match(output, /budget none — no cohort budget initialized/);
  assert.match(output, /next tick would REFUSE/);
  assert.deepEqual(d.auth.calls, [`read:${cohortId}`], 'the only authorization interaction is the read');
  assert.deepEqual(d.storeCalls, [], 'no budget init, no dispatch-path store call');
  assert.deepEqual(d.statusReads.calls, [`budget:${cohortId}`], 'fires are not read when no budget exists');
  assert.deepEqual(d.opens, { store: 0, reads: 1 }, 'the mutating open is never touched by status');
});

test('status of a LIVE campaign: exit 0 and the full durable report, with reservations labeled and the estimate honest', async () => {
  const { manifestPath, auth, cohortId } = await armed();
  auth.calls.length = 0; // observe only the status call's interactions
  const d = deps({ auth, confirm: NEVER_PROMPT });
  // Every count is PAIRWISE DISTINCT, so swapping ANY two rendered slots changes the
  // output — a symmetric fixture once let a completed/pending swap survive as
  // output-equivalent, which is exactly the wrong-monitoring-data class this test owns.
  d.statusReads.budgetValue = {
    callCap: 800,
    callsReserved: 16,
    spendCapUsdMicros: 80_000_000_000,
    spendReservedUsdMicros: 1_600_000_000,
  };
  d.statusReads.firesValue = {
    firesAdmitted: 3,
    firesCompleted: 1,
    firesPending: 2,
    callsMade: 9,
    claimsPending: 5,
    claimsCompleted: 6,
    activeLeases: 4,
    lastAdmittedAt: '2026-08-05T12:00:00.000Z',
  };
  const { value: code, logs } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath }), d)),
  );
  assert.equal(code, 0, logs.join('\n'));
  const output = logs.join('\n');
  assert.match(output, /CAMPAIGN STATUS — cohort/);
  assert.match(output, /authorization LIVE — armed 2026-08-05T00:00:00\.000Z, expires 2026-08-12T00:00:00\.000Z/);
  assert.match(output, /calls {2}16 reserved of 800 cap; 9 attempt\(s\) actually started/);
  assert.match(output, /reservations \$1600\.00 of \$80000\.00 cap/);
  assert.match(output, /NOT invoices/, 'reservations are never presented as money spent');
  assert.match(output, /≈ \$0\.42 expected invoice for the started attempts at the observed rate \(an estimate\)/);
  assert.match(
    output,
    /fires {2}3 admitted \(1 completed, 2 pending\); claims 6 completed, 5 pending; 4 active lease\(s\)/,
    'the exact labeled slots — a swapped pair cannot render this line',
  );
  assert.match(output, /last {3}fire admitted 2026-08-05T12:00:00\.000Z/);
  assert.match(output, /latch {2}clear — no unresolved fire/);
  assert.match(output, /ticks {2}none recorded/);
  assert.match(output, /sched {2}clear — scheduling may continue/);
  assert.match(output, /next tick would AUTHORIZE/);
  assert.match(output, /activation is LIVE/);
  assert.match(output, /which this read-only surface cannot see/, 'the verdict states the checks only the tick itself can run');
  assert.deepEqual(d.auth.calls, [`read:${cohortId}`]);
  assert.deepEqual(d.unresolvedFires.calls, [`unresolved:${cohortId}`], 'the latch read ran exactly once');
  assert.deepEqual(d.storeCalls, [], 'status performs no store write');
  assert.deepEqual(d.opens, { store: 0, reads: 1 }, 'status opens ONLY the read-only path — never the bootstrapping store');
});

test('status of a LIVE campaign with a TRIPPED escalation latch: the latch line renders and the verdict mirrors the tick (exit 2)', async () => {
  const { manifestPath, auth } = await armed();
  const d = deps({ auth, confirm: NEVER_PROMPT });
  d.statusReads.budgetValue = { callCap: 800, callsReserved: 8, spendCapUsdMicros: 80_000_000_000, spendReservedUsdMicros: 800_000_000 };
  const fireId = 'f'.repeat(64);
  d.unresolvedFires.fires = [{ fireId, admittedAt: '2026-08-05T12:00:00.000Z' }];
  const { value: code, logs } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath }), d)),
  );
  assert.equal(code, 2, 'a latched campaign mirrors the tick it predicts: REFUSE');
  const output = logs.join('\n');
  assert.match(output, /authorization LIVE/, 'the authorization itself is live — the latch is the refusing fact');
  assert.match(output, /latch {2}ESCALATION LATCH TRIPPED — 1 unresolved fire\(s\)/);
  assert.match(output, new RegExp(`${fireId} \\(admitted 2026-08-05T12:00:00\\.000Z\\)`));
  assert.match(output, /next tick would REFUSE — the escalation latch is tripped/);
  assert.doesNotMatch(output, /next tick would AUTHORIZE/);
});

test('status renders the tick journal and a HALTED schedule, and the verdict mirrors the tick precedence (exit 2)', async () => {
  const { manifestPath, auth } = await armed();
  const d = deps({ auth, confirm: NEVER_PROMPT });
  d.statusReads.budgetValue = { callCap: 800, callsReserved: 8, spendCapUsdMicros: 80_000_000_000, spendReservedUsdMicros: 800_000_000 };
  const badTick: ScheduleEntry = { id: 4, kind: 'tick', startedAt: '2026-08-04T23:00:00.000Z', finishedAt: '2026-08-04T23:00:05.000Z', outcome: 'loud_failure', detail: 'boom' };
  d.tickJournal.entriesValue = [badTick];
  d.tickJournal.windowValue = [badTick];
  // The latch is ALSO tripped: the halted schedule must still own the verdict line — the
  // tick's own precedence checks the halt before anything else.
  d.unresolvedFires.fires = [{ fireId: 'f'.repeat(64), admittedAt: '2026-08-05T12:00:00.000Z' }];
  const { value: code, logs } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath }), d)),
  );
  assert.equal(code, 2);
  const output = logs.join('\n');
  assert.match(output, /ticks {2}last tick 4 started 2026-08-04T23:00:00\.000Z — finished 2026-08-04T23:00:05\.000Z \(loud_failure\)/);
  assert.match(output, /^ {9}boom$/m, "the last tick's detail renders on its continuation line");
  assert.match(output, /sched {2}HALTED — .*campaign:resume to resume scheduling/);
  assert.match(output, /next tick would REFUSE — the schedule is halted \(operator resume required\)/);
  assert.doesNotMatch(output, /next tick would REFUSE — the escalation latch/, 'the halt owns the verdict, in the tick’s own precedence');
  assert.doesNotMatch(output, /next tick would AUTHORIZE/);
});

test('status renders an UNFINISHED last tick distinctly', async () => {
  const { manifestPath, auth } = await armed();
  const d = deps({ auth, confirm: NEVER_PROMPT });
  d.statusReads.budgetValue = { callCap: 800, callsReserved: 0, spendCapUsdMicros: 80_000_000_000, spendReservedUsdMicros: 0 };
  // Fresh enough to be in-flight: the schedule stays clear, the line says unfinished.
  const inFlight: ScheduleEntry = { id: 7, kind: 'tick', startedAt: new Date(NOW - 1_000).toISOString(), finishedAt: null, outcome: null, detail: null };
  d.tickJournal.entriesValue = [inFlight];
  d.tickJournal.windowValue = [inFlight];
  const { value: code, logs } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath }), d)),
  );
  assert.equal(code, 0, logs.join('\n'));
  const output = logs.join('\n');
  assert.match(output, /ticks {2}last tick 7 started .* — unfinished/);
  assert.match(output, /sched {2}clear/);
});

test('a status journal read failure is LOUD — monitoring must never render a schedule it could not read', async () => {
  const { manifestPath, auth } = await armed();
  const d = deps({ auth, confirm: NEVER_PROMPT });
  d.statusReads.budgetValue = { callCap: 800, callsReserved: 0, spendCapUsdMicros: 80_000_000_000, spendReservedUsdMicros: 0 };
  d.tickJournal.entries = async (): Promise<never> => {
    throw new Error('journal read: connection reset');
  };
  await assert.rejects(
    captured(() => withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath }), d))),
    /journal read: connection reset/,
  );
});

test('a status latch read failure is LOUD — monitoring must never render a clear latch it could not read', async () => {
  const { manifestPath, auth } = await armed();
  const d = deps({ auth, confirm: NEVER_PROMPT });
  d.statusReads.budgetValue = { callCap: 800, callsReserved: 0, spendCapUsdMicros: 80_000_000_000, spendReservedUsdMicros: 0 };
  d.unresolvedFires.unresolvedFires = async (): Promise<never> => {
    throw new Error('latch read: connection reset');
  };
  await assert.rejects(
    captured(() => withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath }), d))),
    /latch read: connection reset/,
  );
});

test('status of a DISARMED and of an EXPIRED campaign: exit 2 with the dead state named', async () => {
  const disarmedCase = await armed();
  await disarmedCase.auth.disarm(disarmedCase.cohortId, new Date(NOW + 60_000).toISOString());
  const d1 = deps({ auth: disarmedCase.auth, confirm: NEVER_PROMPT });
  d1.statusReads.budgetValue = { callCap: 800, callsReserved: 0, spendCapUsdMicros: 80_000_000_000, spendReservedUsdMicros: 0 };
  const r1 = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath: disarmedCase.manifestPath }), d1)),
  );
  assert.equal(r1.value, 2);
  assert.match(r1.logs.join('\n'), /authorization DISARMED at 2026-08-05T00:01:00\.000Z/);
  assert.match(r1.logs.join('\n'), /next tick would REFUSE/);

  const expiredCase = await armed();
  const d2 = deps({ auth: expiredCase.auth, confirm: NEVER_PROMPT, now: () => NOW + WEEK_MS + 1 });
  d2.statusReads.budgetValue = { callCap: 800, callsReserved: 0, spendCapUsdMicros: 80_000_000_000, spendReservedUsdMicros: 0 };
  const r2 = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath: expiredCase.manifestPath }), d2)),
  );
  assert.equal(r2.value, 2);
  assert.match(r2.logs.join('\n'), /authorization EXPIRED at 2026-08-12T00:00:00\.000Z/);
});

test('status shows a LIVE record whose next tick would still REFUSE — a credential revoked mid-campaign surfaces here first', async () => {
  const { manifestPath, auth } = await armed();
  const d = deps({
    auth,
    confirm: NEVER_PROMPT,
    observeCredentials: (ids) => new Map(ids.map((id) => [id, id !== ROSTER[1]])),
  });
  d.statusReads.budgetValue = { callCap: 800, callsReserved: 0, spendCapUsdMicros: 80_000_000_000, spendReservedUsdMicros: 0 };
  const { value: code, logs } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath }), d)),
  );
  assert.equal(code, 2, 'the exit mirrors the next tick, not the record alone');
  const output = logs.join('\n');
  assert.match(output, /authorization LIVE/, 'the record itself is truthfully live');
  assert.match(output, /next tick would REFUSE:.*no usable credential/);
});

test('status reports a MALFORMED stored record: exit 2 with the violations shown', async () => {
  const { manifestPath, auth, cohortId } = await armed();
  const record = auth.records.get(cohortId)!;
  const { expiresAt: _dropped, ...malformed } = record;
  auth.records.set(cohortId, malformed as CampaignAuthorization);
  const d = deps({ auth, confirm: NEVER_PROMPT });
  d.statusReads.budgetValue = { callCap: 800, callsReserved: 0, spendCapUsdMicros: 80_000_000_000, spendReservedUsdMicros: 0 };
  const { value: code, logs } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath }), d)),
  );
  assert.equal(code, 2);
  assert.match(logs.join('\n'), /authorization MALFORMED/);
});

test('status flags the INTEGRITY ANOMALY of standing authority without a budget row: exit 1', async () => {
  const { manifestPath, auth } = await armed();
  const d = deps({ auth, confirm: NEVER_PROMPT });
  d.statusReads.budgetValue = null; // authority exists, budget row does not — the store lost state
  const { value: code, errors } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath }), d)),
  );
  assert.equal(code, 1, 'an anomaly is loud — never a normal report');
  assert.match(errors.join('\n'), /INTEGRITY ANOMALY/);
  assert.ok(!d.statusReads.calls.some((c) => c.startsWith('fires:')), 'no further reads after the anomaly');
});

test('status of an INTERRUPTED arm (budget exists, authorization absent): reports the budget and exits 2', async () => {
  const { bytes } = buildCampaignManifest(NOW, { callCap: 800, windowForwardMs: WEEK_MS });
  const dir = mkdtempSync(join(tmpdir(), 'campaign-status-interrupted-'));
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, bytes);
  const d = deps({ confirm: NEVER_PROMPT });
  d.statusReads.budgetValue = { callCap: 800, callsReserved: 0, spendCapUsdMicros: 80_000_000_000, spendReservedUsdMicros: 0 };
  const { value: code, logs } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath }), d)),
  );
  assert.equal(code, 2);
  const output = logs.join('\n');
  assert.match(output, /authorization NOT ARMED/);
  assert.match(output, /0 reserved of 800 cap/, 'the initialized budget still reports');
  assert.match(output, /next tick would REFUSE/);
});

test('status outcomes survive close failures — normal and hostile alike', async () => {
  // Normal Error close rejection on a live campaign: the 0 stands with a warning.
  const live = await armed();
  const dLive = depsWithFailingClose({ auth: live.auth, confirm: NEVER_PROMPT });
  dLive.statusReads.budgetValue = { callCap: 800, callsReserved: 0, spendCapUsdMicros: 80_000_000_000, spendReservedUsdMicros: 0 };
  const r1 = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath: live.manifestPath }), dLive)),
  );
  assert.equal(r1.value, 0);
  assert.match(r1.errors.join('\n'), /warning: closing the store connection failed/);

  // Hostile close rejections cannot override the classified outcome either.
  for (const { label, value } of hostileFixtures()) {
    const c = await armed();
    const d = depsWithHostileClose(value, { auth: c.auth, confirm: NEVER_PROMPT });
    d.statusReads.budgetValue = { callCap: 800, callsReserved: 0, spendCapUsdMicros: 80_000_000_000, spendReservedUsdMicros: 0 };
    const { value: code } = await captured(() =>
      withEnv(SYNTHETIC_ENV, () => statusCampaign(options({ command: 'status', manifestPath: c.manifestPath }), d)),
    );
    assert.equal(code, 0, `${label}: the status outcome stands`);
  }
});

// ===========================================================================
// tick — public-Git publication evidence (verified when supplied; required at activation)
// ===========================================================================

const PUBLICATION_SHA = 'ab'.repeat(20);

/** Write a strict descriptor file beside the campaign fixtures and return its path. */
function publicationFile(over: Record<string, unknown> = {}): string {
  const path = join(mkdtempSync(join(tmpdir(), 'campaign-publication-')), 'publication.json');
  writeFileSync(
    path,
    JSON.stringify({
      repositoryOwner: 'ospex-org',
      repositoryName: 'ospex-benchmark',
      path: 'manifests/campaign.json',
      commitSha: PUBLICATION_SHA,
      ...over,
    }),
  );
  return path;
}

/** A resolver fixture that publishes the EXACT local manifest bytes at a compliant instant
 *  (strictly before the fixture manifest's windowStart, which is NOW - 1h). */
function publishedResolver(manifestPath: string, over: { bytes?: Buffer; committedAt?: string } = {}) {
  const calls: unknown[] = [];
  const resolve = async (publication: unknown): Promise<{ blobBytes: Uint8Array; committerTimestamp: string }> => {
    calls.push(publication);
    return {
      blobBytes: new Uint8Array(over.bytes ?? readFileSync(manifestPath)),
      committerTimestamp: over.committedAt ?? new Date(NOW - 2 * 3_600_000).toISOString(),
    };
  };
  return { resolve, calls };
}

test('a tick with VERIFIED publication evidence proceeds to dispatch (exit 0) and names the commit', async () => {
  const { manifestPath, auth } = await armed();
  const resolver = publishedResolver(manifestPath);
  const d = deps({ auth, confirm: NEVER_PROMPT, resolvePublication: resolver.resolve });
  const publicationPath = publicationFile();
  const { value: code, logs } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => tickCampaign(options({ command: 'tick', manifestPath, publicationPath }), d)),
  );
  assert.equal(code, 0, logs.join('\n'));
  const output = logs.join('\n');
  assert.match(output, /publication evidence VERIFIED/);
  assert.match(output, new RegExp(`@ ${PUBLICATION_SHA}`));
  assert.equal(resolver.calls.length, 1, 'exactly one resolution');
  assert.deepEqual(resolver.calls[0], {
    repositoryOwner: 'ospex-org',
    repositoryName: 'ospex-benchmark',
    path: 'manifests/campaign.json',
    commitSha: PUBLICATION_SHA,
  });
});

test('the ALL-ZEROS rehearsal commit is refused STRUCTURALLY — before any resolution is attempted', async () => {
  const { manifestPath, auth } = await armed();
  auth.calls.length = 0; // observe only the tick's interactions
  const d = deps({ auth, confirm: NEVER_PROMPT }); // the default resolver THROWS if ever called
  const publicationPath = publicationFile({ commitSha: '0'.repeat(40) });
  const { value: code, errors } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => tickCampaign(options({ command: 'tick', manifestPath, publicationPath }), d)),
  );
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /rehearsal commit/);
  assert.deepEqual(d.auth.calls, [], 'refused before any authorization read');
});

test('publication failures REFUSE the tick before authorization: byte mismatch, late committer, resolver failure', async () => {
  const cases: Array<{ label: string; resolver: (manifestPath: string) => { resolve: CampaignDeps['resolvePublication'] }; expect: RegExp }> = [
    {
      label: 'published blob differs from the local manifest',
      resolver: (m) => publishedResolver(m, { bytes: Buffer.from('{"someone":"else"}', 'utf8') }),
      expect: /differ from the local manifest bytes/,
    },
    {
      label: 'committer not strictly before windowStart',
      resolver: (m) => publishedResolver(m, { committedAt: new Date(NOW - 3_600_000).toISOString() }),
      expect: /not strictly before windowStart/,
    },
    {
      label: 'resolver failure (network)',
      resolver: () => ({
        resolve: async () => {
          throw new Error('getaddrinfo ENOTFOUND api.github.com');
        },
      }),
      expect: /resolve failed|ENOTFOUND/,
    },
  ];
  for (const { label, resolver, expect } of cases) {
    const { manifestPath, auth } = await armed();
    const d = deps({ auth, confirm: NEVER_PROMPT, resolvePublication: resolver(manifestPath).resolve });
    const publicationPath = publicationFile();
    const { value: code, errors } = await captured(() =>
      withEnv(SYNTHETIC_ENV, () => tickCampaign(options({ command: 'tick', manifestPath, publicationPath }), d)),
    );
    assert.equal(code, 2, label);
    const output = errors.join('\n');
    assert.match(output, /publication evidence REFUSED/, label);
    assert.match(output, expect, label);
    assert.deepEqual(auth.calls.filter((c) => c.startsWith('read:')), [], `${label}: never reached the authorization`);
  }
});

test('an unusable descriptor file refuses: missing, malformed JSON, or an off-schema shape', async () => {
  const { manifestPath, auth } = await armed();
  const missing = join(mkdtempSync(join(tmpdir(), 'campaign-pub-missing-')), 'nope.json');
  const malformed = publicationFile();
  writeFileSync(malformed, '{not json');
  const shortSha = publicationFile({ commitSha: 'abc123' });
  const traversal = publicationFile({ path: '../main/package.json' }); // the sha-pin bypass class
  for (const publicationPath of [missing, malformed, shortSha, traversal]) {
    const d = deps({ auth, confirm: NEVER_PROMPT });
    const { value: code, errors } = await captured(() =>
      withEnv(SYNTHETIC_ENV, () => tickCampaign(options({ command: 'tick', manifestPath, publicationPath }), d)),
    );
    assert.equal(code, 2, publicationPath);
    assert.match(errors.join('\n'), /publication descriptor .* is unusable/, publicationPath);
  }
});

test('without --publication the tick REFUSES before the store: exit 2, opens nothing, no journal trace', async () => {
  const { manifestPath, auth } = await armed();
  const d = deps({ auth, confirm: NEVER_PROMPT });
  const { value: code, errors } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => tickCampaign(options({ command: 'tick', manifestPath }), d)),
  );
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /REQUIRES --publication/);
  assert.deepEqual(d.opens, { store: 0, reads: 0 }, 'a missing descriptor never opens the store');
  assert.deepEqual(d.tickJournal.calls, [], 'and leaves no journal trace — the documented pre-journal bound');
  assert.equal(d.tickInputs.length, 0, 'and dispatches nothing');
});

// ===========================================================================
// tick — the activation assembly (the latch-guarded claim port, the evidence-scan root,
// the second-pass gated mint, the outcome classification, and the journal detail)
// ===========================================================================

test('the claim port handed to the tick is LATCH-GUARDED: an admission after the latch trips aborts as escalation_latched, and the store admit is never reached', async () => {
  const { manifestPath, auth } = await armed();
  const fireId = 'a1'.repeat(32);
  const resolver = publishedResolver(manifestPath);
  const d = deps({
    auth,
    confirm: NEVER_PROMPT,
    resolvePublication: resolver.resolve,
    runTick: async (input) => {
      // The escalation lands AFTER the tick-level check (which read clear) and BEFORE
      // this admission — the exact window only the per-admission guard covers.
      d.unresolvedFires.fires = [{ fireId, admittedAt: '2026-08-05T12:30:00.000Z' }];
      await input.claimPort.admit({ cohortId: input.booted.cohortId } as never);
      throw new Error('unreachable — the guarded admit must throw on a tripped latch');
    },
  });
  const opts = options({ command: 'tick', manifestPath, publicationPath: publicationFile() });
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /escalation latch is tripped .* refusing to admit any dispatch/);
  assert.equal(d.unresolvedFires.calls.length, 2, 'the latch was consulted at the tick level AND at the admission');
  assert.ok(
    d.tickJournal.calls.some((c) => c.startsWith(`finish:71:escalation_latched:unresolved fire ${fireId}`)),
    'the mid-tick trip is journaled as the latched refusal',
  );
});

test('the admission guard consults the EVIDENCE half too: a sidecar installed mid-tick trips the guarded admit', async () => {
  // The store half of the admission guard is pinned by the test above; this one proves
  // the guard wraps the COMPOSED latch — a guard composed from the store source alone
  // would admit here, because no unresolved fire exists.
  const { manifestPath, auth, evidenceRoot } = await armed();
  const resolver = publishedResolver(manifestPath);
  const opts = options({ command: 'tick', manifestPath, publicationPath: publicationFile() });
  const sidecarName = `fire-g9-total-${'ab'.repeat(32)}-spend.json`;
  const d = deps({
    auth,
    confirm: NEVER_PROMPT,
    resolvePublication: resolver.resolve,
    runTick: async (input) => {
      // The escalation evidence lands AFTER the tick-level check (which read clear) and
      // BEFORE this admission — only an admission guard that includes the evidence scan
      // can catch it. It lands under the RECORD-BOUND root, the only root the tick reads.
      const cohortDir = join(evidenceRoot, input.booted.cohortId);
      mkdirSync(cohortDir, { recursive: true });
      writeFileSync(join(cohortDir, sidecarName), JSON.stringify({ reason: 'spend_evidence_unknown' }));
      await input.claimPort.admit({ cohortId: input.booted.cohortId } as never);
      throw new Error('unreachable — the guarded admit must throw on installed escalation evidence');
    },
  });
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 2);
  const refusal = errors.join('\n');
  assert.match(refusal, /escalation latch is tripped .* refusing to admit any dispatch/);
  assert.ok(refusal.includes(sidecarName), 'the refusal names the evidence installed mid-tick');
  assert.ok(
    d.tickJournal.calls.some((c) => c.startsWith('finish:71:escalation_latched:installed escalation evidence')),
    'the mid-tick evidence trip is journaled with its cause',
  );
});

test('installed escalation evidence under the ARMED root trips the TICK-LEVEL latch even with the store shadow CLEAR (the post-recovery scenario): exit 2, nothing dispatched', async () => {
  // The store-derived source reads clear here (no unresolved fire — the reviewed-recovery
  // state), so the installed sidecar under the record-bound root is the ONLY signal —
  // exactly the case the evidence half exists for.
  const { manifestPath, auth, cohortId, evidenceRoot } = await armed();
  const { d, opts } = tickFixture(manifestPath, auth);
  const cohortDir = join(evidenceRoot, cohortId);
  mkdirSync(cohortDir, { recursive: true });
  const sidecarName = `fire-g1-moneyline-${'b2'.repeat(32)}-spend.json`;
  writeFileSync(join(cohortDir, sidecarName), JSON.stringify({ reason: 'spend_attempt_over_reservation' }));
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 2);
  const refusal = errors.join('\n');
  assert.match(refusal, /ESCALATION LATCH — refusing to dispatch/);
  assert.match(refusal, /installed escalation evidence/);
  assert.match(refusal, /spend_attempt_over_reservation/);
  assert.ok(refusal.includes(sidecarName), "the cause names the sidecar file under the tick's artifact root");
  assert.equal(d.tickInputs.length, 0, 'nothing was dispatched');
  assert.ok(d.tickJournal.calls.some((c) => c.startsWith('finish:71:escalation_latched:')));
});

test('a dispatched fire that left UNRESOLVED spend evidence journals dispatch_unresolved and exits 2 — escalated and unsettled alike', async () => {
  const cases = [
    {
      label: 'spend-guard escalation',
      outcome: {
        kind: 'InstalledEscalated',
        reason: 'spend_attempt_over_reservation',
        offenders: [],
        sidecar: { path: 'sidecar.json', sha256: 'x'.repeat(64) },
        install: { path: 'artifact.json' },
      },
      desc: 'InstalledEscalated/spend_attempt_over_reservation (0 offending attempt(s))',
    },
    {
      label: 'unconfirmed settlement',
      outcome: {
        kind: 'Installed',
        completion: { status: 'unsettled', reason: 'store_complete_failed' },
        sidecar: null,
        install: { path: 'artifact.json' },
      },
      desc: 'Installed/unsettled(store_complete_failed)',
    },
  ];
  for (const { label, outcome, desc } of cases) {
    const fireId = 'c3'.repeat(32);
    const result = {
      discoveredCount: 1,
      dispositions: [{ gameId: 'g1', market: 'total', outcome: 'prepared' }],
      fireOutcomes: [{ fireId, gameId: 'g1', market: 'total', outcome }],
      admittedCount: 1,
    } as unknown as CohortTickResult;
    const { manifestPath, auth } = await armed();
    const { d, opts } = tickFixture(manifestPath, auth, { runTick: async () => result });
    const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
    assert.equal(code, 2, label);
    assert.match(errors.join('\n'), /DISPATCH LEFT UNRESOLVED SPEND EVIDENCE — 1 fire\(s\)/, label);
    const finish = d.tickJournal.finishes[0]!;
    assert.equal(finish.outcome, 'dispatch_unresolved', label);
    const detail = JSON.parse(finish.detail!) as { outcomes: Record<string, number>; installed: string[] };
    assert.deepEqual(detail.outcomes, { [desc]: 1 }, label);
    assert.deepEqual(detail.installed, [`${fireId} g1 total ${desc}`], label);
  }
});

test('a healthy dispatched tick journals its detail: deferrals grouped by reason, outcome counts, and the installed fires', async () => {
  const fireId = 'd4'.repeat(32);
  const result = {
    discoveredCount: 5,
    dispositions: [
      { gameId: 'g1', market: 'moneyline', outcome: 'defer', reason: 'opener_not_visible' },
      { gameId: 'g2', market: 'total', outcome: 'defer', reason: 'opener_not_visible' },
      { gameId: 'g3', market: 'total', outcome: 'defer', reason: 'quote_moved' },
      { gameId: 'g4', market: 'moneyline', outcome: 'reject', reason: 'stale_entry' },
      { gameId: 'g5', market: 'total', outcome: 'prepared' },
    ],
    fireOutcomes: [
      {
        fireId,
        gameId: 'g5',
        market: 'total',
        outcome: { kind: 'Installed', completion: { status: 'settled' }, sidecar: null, install: { path: 'artifact.json' } },
      },
      // The claim shapes the SPINE actually emits (`ClaimOutcome`): a Skip carries its
      // reason, and a cap-exhaustion refusal maps to Defer — both are HEALTHY here (the
      // negative control: a completed campaign keeps ticking healthily on Defer until its
      // authorization expires; only Fault/WouldAdmit outcomes are escalated).
      {
        fireId: 'e5'.repeat(32),
        gameId: 'g6',
        market: 'moneyline',
        outcome: { kind: 'NotAdmitted', outcome: { kind: 'Skip', reason: 'all_claimed' } },
      },
      {
        fireId: 'e6'.repeat(32),
        gameId: 'g7',
        market: 'total',
        outcome: { kind: 'NotAdmitted', outcome: { kind: 'Defer', reason: 'spend_cap' } },
      },
    ],
    admittedCount: 1,
  } as unknown as CohortTickResult;
  const { manifestPath, auth } = await armed();
  const { d, opts } = tickFixture(manifestPath, auth, { runTick: async () => result });
  const { value: code, logs } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 0, logs.join('\n'));
  assert.match(logs.join('\n'), /TICK COMPLETE — 1 fire\(s\) admitted of 5 candidate\(s\) discovered/);
  const finish = d.tickJournal.finishes[0]!;
  assert.equal(finish.outcome, 'dispatched');
  assert.deepEqual(JSON.parse(finish.detail!), {
    discovered: 5,
    evaluated: 3,
    admitted: 1,
    deferrals: { 'defer:opener_not_visible': 2, 'defer:quote_moved': 1, 'reject:stale_entry': 1 },
    outcomes: { 'Installed/settled': 1, 'NotAdmitted/Skip(all_claimed)': 1, 'NotAdmitted/Defer(spend_cap)': 1 },
    installed: [`${fireId} g5 total Installed/settled`],
  });
});

test('a FAULT-class admission outcome journals dispatch_faulted and exits 2 — a dead or migrated store must halt the schedule, never tick healthily over it', async () => {
  const cases = [
    {
      label: 'store schema skew',
      outcome: { kind: 'NotAdmitted', outcome: { kind: 'Fault', reason: 'version_mismatch' } },
      desc: 'NotAdmitted/Fault(version_mismatch)',
    },
    {
      label: 'rehearsal port wired into the paid path',
      outcome: { kind: 'NotAdmitted', outcome: { kind: 'WouldAdmit' } },
      desc: 'NotAdmitted/WouldAdmit',
    },
  ];
  for (const { label, outcome, desc } of cases) {
    const fireId = 'f6'.repeat(32);
    const result = {
      discoveredCount: 1,
      dispositions: [{ gameId: 'g1', market: 'total', outcome: 'prepared' }],
      fireOutcomes: [{ fireId, gameId: 'g1', market: 'total', outcome }],
      admittedCount: 0,
    } as unknown as CohortTickResult;
    const { manifestPath, auth } = await armed();
    const { d, opts } = tickFixture(manifestPath, auth, { runTick: async () => result });
    const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
    assert.equal(code, 2, label);
    assert.match(errors.join('\n'), /DISPATCH FAULTED — 1 admission\(s\)/, label);
    assert.match(errors.join('\n'), /store contract is not holding/, label);
    const finish = d.tickJournal.finishes[0]!;
    assert.equal(finish.outcome, 'dispatch_faulted', label);
    const detail = JSON.parse(finish.detail!) as { outcomes: Record<string, number> };
    assert.deepEqual(detail.outcomes, { [desc]: 1 }, label);
  }
});

test("the gated mint is a SECOND independent pass: a vanished real credential refuses the tick even when the resolution's observation passes", async () => {
  const { manifestPath, auth } = await armed();
  // The injected observation says EVERY roster credential exists, so the resolution
  // authorizes — only the producer's own probe of the real adapters can catch the gap.
  const { d, opts } = tickFixture(manifestPath, auth);
  const { value: code, errors } = await captured(() =>
    withEnv({ ...SYNTHETIC_ENV, ANTHROPIC_API_KEY: undefined }, () => tickCampaign(opts, d)),
  );
  assert.equal(code, 2);
  const refusal = errors.join('\n');
  assert.match(refusal, /billable adapter mint REFUSED/);
  assert.match(refusal, /no usable credential/);
  assert.equal(d.tickInputs.length, 0, 'no tick input was assembled — nothing dispatched');
  assert.ok(d.tickJournal.calls.some((c) => c.startsWith('finish:71:no_live_authorization:')));
});

test('missing read-seam env refuses BEFORE the store: exit 2, no open, no journal trace', async () => {
  const { manifestPath, auth } = await armed();
  const { d, opts } = tickFixture(manifestPath, auth);
  const { value: code, errors } = await captured(() =>
    withEnv({ ...SYNTHETIC_ENV, SUPABASE_URL: undefined }, () => tickCampaign(opts, d)),
  );
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /missing env: SUPABASE_URL/);
  assert.deepEqual(d.opens, { store: 0, reads: 0 });
  assert.deepEqual(d.tickJournal.calls, []);
  assert.equal(d.tickInputs.length, 0, 'and dispatches nothing');
});

test('a tick GIVEN --artifacts refuses BEFORE the store: the root is bound at arm and cannot be changed per-tick', async () => {
  const { manifestPath, auth } = await armed();
  const resolver = publishedResolver(manifestPath);
  const d = deps({ auth, confirm: NEVER_PROMPT, resolvePublication: resolver.resolve });
  const opts = options({
    command: 'tick',
    manifestPath,
    publicationPath: publicationFile(),
    artifactsPath: mkdtempSync(join(tmpdir(), 'campaign-switch-')),
  });
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /takes no --artifacts/);
  assert.deepEqual(d.opens, { store: 0, reads: 0 });
  assert.deepEqual(d.tickJournal.calls, [], 'no journal trace');
  assert.equal(d.tickInputs.length, 0, 'and dispatches nothing');
});

test('TRIPWIRE — a lost or recreated evidence root refuses the tick: an empty directory at the armed pathname is NOT the armed root', async () => {
  // The reviewer-shaped bypass, as a permanent regression: recovery settled the store
  // shadow (the fake reads no unresolved fire), escalation evidence had been installed
  // under the armed root, and then the root is lost and recreated empty at the SAME
  // pathname. Without the identity binding this read as a clear latch and dispatched.
  const { manifestPath, auth, cohortId, evidenceRoot } = await armed();
  const cohortDir = join(evidenceRoot, cohortId);
  mkdirSync(cohortDir, { recursive: true });
  writeFileSync(join(cohortDir, `fire-g1-total-${'cd'.repeat(32)}-spend.json`), JSON.stringify({ reason: 'spend_attempt_over_reservation' }));

  // The mount is lost; something recreates the same pathname as an empty directory.
  rmSync(evidenceRoot, { recursive: true, force: true });
  mkdirSync(evidenceRoot, { recursive: true });

  const { d, opts } = tickFixture(manifestPath, auth);
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 2, 'the recreated empty root must REFUSE, never read as a clear latch');
  assert.match(errors.join('\n'), /EVIDENCE ROOT REFUSED/);
  assert.match(errors.join('\n'), /recreated empty directory is NOT the armed root/);
  assert.equal(d.tickInputs.length, 0, 'nothing was dispatched');
  assert.ok(
    d.tickJournal.calls.some((c) => c.startsWith('finish:71:evidence_root_refused:')),
    'the refusal is a journaled outcome the schedule halt rule sees',
  );

  // The fully-ABSENT root refuses the same way (the un-recreated mount loss).
  rmSync(evidenceRoot, { recursive: true, force: true });
  const second = tickFixture(manifestPath, auth);
  const absent = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(second.opts, second.d)));
  assert.equal(absent.value, 2);
  assert.match(absent.errors.join('\n'), /EVIDENCE ROOT REFUSED/);
  assert.equal(second.d.tickInputs.length, 0);
});

test('LATE WINDOW — root-identity loss between the tick-level check and an admission trips the guard: escalation_latched, inner store admit unreachable', async () => {
  // The tick-level root verification and latch check both read CLEAR; the sabotage lands
  // inside the dispatch loop, immediately before an admission — the window only a
  // per-admission identity re-verification covers. The inner store's `admitDispatch`
  // throws a DISTINCT 'must never reach' error, which would surface as loud_failure /
  // exit 1 — so the exit-2 escalation_latched outcome proves the guard fired FIRST and
  // the store admission boundary was never reached.
  const sabotages: Array<{ label: string; sabotage: (root: string) => void }> = [
    {
      label: 'root lost and recreated empty',
      sabotage: (root) => {
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { recursive: true });
      },
    },
    {
      label: 'marker replaced with a foreign identity',
      sabotage: (root) => {
        writeFileSync(join(root, 'evidence-root.json'), `${JSON.stringify({ evidenceRootVersion: 1, evidenceRootId: 'foreign-late' })}\n`);
      },
    },
  ];
  for (const { label, sabotage } of sabotages) {
    const { manifestPath, auth, evidenceRoot } = await armed();
    const resolver = publishedResolver(manifestPath);
    const d = deps({
      auth,
      confirm: NEVER_PROMPT,
      resolvePublication: resolver.resolve,
      runTick: async (input) => {
        sabotage(evidenceRoot);
        await input.claimPort.admit({ cohortId: input.booted.cohortId } as never);
        throw new Error('unreachable — the guarded admit must throw after root-identity loss');
      },
    });
    const opts = options({ command: 'tick', manifestPath, publicationPath: publicationFile() });
    const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
    assert.equal(code, 2, label);
    const refusal = errors.join('\n');
    assert.match(refusal, /escalation latch is tripped .* refusing to admit any dispatch/, label);
    assert.match(refusal, /evidence root lost/, label);
    assert.ok(
      d.tickJournal.calls.some((c) => c.startsWith('finish:71:escalation_latched:evidence root lost')),
      `${label}: the late-window trip is journaled with its cause`,
    );
  }
});

test('TRIPWIRE — a FOREIGN identity marker at the armed pathname refuses the tick: another root\'s identity is not the armed root', async () => {
  const { manifestPath, auth, evidenceRoot } = await armed();
  rmSync(evidenceRoot, { recursive: true, force: true });
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, 'evidence-root.json'), `${JSON.stringify({ evidenceRootVersion: 1, evidenceRootId: 'a-different-root' })}\n`);
  const { d, opts } = tickFixture(manifestPath, auth);
  const { value: code, errors } = await captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d)));
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /not the armed\s+id/);
  assert.equal(d.tickInputs.length, 0, 'nothing was dispatched');
  assert.ok(d.tickJournal.calls.some((c) => c.startsWith('finish:71:evidence_root_refused:')));
});

test('a loud dispatch failure journals loud_failure best-effort and propagates', async () => {
  const { manifestPath, auth } = await armed();
  const { d, opts } = tickFixture(manifestPath, auth, {
    runTick: async () => {
      throw new Error('provider adapter exploded');
    },
  });
  await assert.rejects(
    captured(() => withEnv(SYNTHETIC_ENV, () => tickCampaign(opts, d))),
    /provider adapter exploded/,
  );
  assert.ok(d.tickJournal.calls.some((c) => c.startsWith('finish:71:loud_failure:provider adapter exploded')));
});

// ===========================================================================
// stop
// ===========================================================================

test('stop disarms an armed campaign, is idempotent, and refuses an unknown cohort', async () => {
  const { manifestPath, auth, cohortId } = await armed();

  const { value: first } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => stopCampaign(options({ command: 'stop', manifestPath }), deps({ auth }))),
  );
  assert.equal(first, 0);
  const disarmedAt = auth.records.get(cohortId)!.disarmedAt;
  assert.notEqual(disarmedAt, null);

  // Idempotent, and the FIRST stop instant is preserved — a repeat must not rewrite history.
  const { value: second } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () =>
      stopCampaign(options({ command: 'stop', manifestPath }), deps({ auth, now: () => NOW + 60_000 })),
    ),
  );
  assert.equal(second, 0);
  assert.equal(auth.records.get(cohortId)!.disarmedAt, disarmedAt);

  // A cohort that was never armed.
  const { bytes } = buildCampaignManifest(NOW + 3_600_000, { callCap: 800, windowForwardMs: WEEK_MS });
  const otherPath = join(mkdtempSync(join(tmpdir(), 'campaign-other-')), 'manifest.json');
  writeFileSync(otherPath, bytes);
  const { value: unknown } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => stopCampaign(options({ command: 'stop', manifestPath: otherPath }), deps({ auth }))),
  );
  assert.equal(unknown, 2);
});

test('the recorded authorization is bound to the armed cohort and expires with the window', async () => {
  const { manifestPath, auth, cohortId, evidenceRoot } = await armed();
  const booted = cohortBoot({ manifestBytes: readFileSync(manifestPath, 'utf8') });
  const record = auth.records.get(cohortId)!;
  // The bound identity is whatever the arm durably installed at the root.
  const marker = JSON.parse(readFileSync(join(evidenceRoot, 'evidence-root.json'), 'utf8')) as { evidenceRootId: string };
  const expected = buildCampaignAuthorization({
    booted,
    observedCredentialedParticipantIds: ROSTER,
    armedAtMs: NOW,
    expiresAtMs: NOW + WEEK_MS,
    evidenceRoot,
    evidenceRootId: marker.evidenceRootId,
  });
  assert.deepEqual(
    {
      ...record,
      participantIds: [...record.participantIds],
      observedCredentialedParticipantIds: [...record.observedCredentialedParticipantIds],
    },
    {
      ...expected,
      participantIds: [...expected.participantIds],
      observedCredentialedParticipantIds: [...expected.observedCredentialedParticipantIds],
    },
  );
});

// ===========================================================================
// spawned-CLI probes — the PRODUCTION readline seam, end to end
// ===========================================================================

/** Drive the ACTUAL CLI the way `yarn campaign:*` does (tsx on the entry module). */
function runCli(args: string[], env: Record<string, string>, input: string): {
  status: number | null;
  signal: NodeJS.Signals | null;
  out: string;
} {
  const scriptPath = fileURLToPath(new URL('./campaignMain.ts', import.meta.url));
  const repoRoot = dirname(dirname(scriptPath));
  const result = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
    input,
  });
  return { status: result.status, signal: result.signal, out: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

/** An intentionally-unreachable Postgres URL: any DB touch fails immediately and distinctively. */
const UNREACHABLE_STORE_URL = 'postgres://x:x@127.0.0.1:1/nope';

/** Synthetic credentials satisfy every pre-prompt gate; real env vars always win over .env. */
const PROBE_ENV = {
  STORE_DATABASE_URL: UNREACHABLE_STORE_URL,
  OPENAI_API_KEY: 'synthetic-test-credential',
  ANTHROPIC_API_KEY: 'synthetic-test-credential',
  GEMINI_API_KEY: 'synthetic-test-credential',
  GOOGLE_API_KEY: '',
  XAI_API_KEY: 'synthetic-test-credential',
};

test('spawned CLI: a piped EMPTY LINE is Enter and ACCEPTS — then the manifest installs BEFORE any authority', () => {
  const emitPath = join(mkdtempSync(join(tmpdir(), 'campaign-cli-enter-')), 'campaign-manifest.json');
  const artifactsDir = mkdtempSync(join(tmpdir(), 'campaign-cli-enter-artifacts-'));
  const { status, signal, out } = runCli(
    ['arm', '--calls', '8', '--days', '1', '--start', '2027-01-01T00:00:00Z', '--artifacts', artifactsDir, '--emit', emitPath],
    PROBE_ENV,
    '\n',
  );
  // The exact [Y/n] prompt reached stdout through the production readline seam.
  assert.ok(
    out.includes('arm this campaign for unattended running? [Y/n]'),
    `the exact [Y/n] prompt printed; out=${out}`,
  );
  // Enter ACCEPTED: no refusal printed, and the flow proceeded to the durable steps.
  assert.ok(!/arming refused/.test(out), `Enter must accept the capital-Y default; out=${out}`);
  // The manifest was installed (authority order step 1) ...
  assert.ok(existsSync(emitPath), `the manifest installs before any store write; out=${out}`);
  // ... and the unreachable store then failed BEFORE any authority was created: exit 1, said plainly.
  assert.equal(status, 1, `signal=${String(signal)} out=${out}`);
  assert.ok(/NO standing authority was created/.test(out), `the pre-authority failure is named; out=${out}`);
});

test('spawned CLI: true EOF (stream closes without a line) REFUSES with nothing durable', () => {
  const emitPath = join(mkdtempSync(join(tmpdir(), 'campaign-cli-eof-')), 'campaign-manifest.json');
  const artifactsDir = mkdtempSync(join(tmpdir(), 'campaign-cli-eof-artifacts-'));
  const { status, out } = runCli(
    ['arm', '--calls', '8', '--days', '1', '--start', '2027-01-01T00:00:00Z', '--artifacts', artifactsDir, '--emit', emitPath],
    PROBE_ENV,
    '',
  );
  assert.equal(status, 2, `EOF refuses with exit 2; out=${out}`);
  assert.ok(/confirmation stream closed \(EOF\)/.test(out), `the refusal names EOF; out=${out}`);
  assert.ok(!existsSync(emitPath), 'no manifest was written');
  assert.ok(!/NO standing authority/.test(out) && !/ARMED/.test(out), `the durable steps were never reached; out=${out}`);
});

test("spawned CLI: an explicit 'n' REFUSES with nothing durable", () => {
  const emitPath = join(mkdtempSync(join(tmpdir(), 'campaign-cli-n-')), 'campaign-manifest.json');
  const artifactsDir = mkdtempSync(join(tmpdir(), 'campaign-cli-n-artifacts-'));
  const { status, out } = runCli(
    ['arm', '--calls', '8', '--days', '1', '--start', '2027-01-01T00:00:00Z', '--artifacts', artifactsDir, '--emit', emitPath],
    PROBE_ENV,
    'n\n',
  );
  assert.equal(status, 2, `'n' refuses with exit 2; out=${out}`);
  assert.ok(/arming refused \(answer "n"\)/.test(out), `the refusal echoes the answer; out=${out}`);
  assert.ok(!existsSync(emitPath), 'no manifest was written');
});

test('spawned CLI: an OMITTED --start refuses before the prompt is ever shown', () => {
  const emitPath = join(mkdtempSync(join(tmpdir(), 'campaign-cli-nostart-')), 'campaign-manifest.json');
  const artifactsDir = mkdtempSync(join(tmpdir(), 'campaign-cli-nostart-artifacts-'));
  const { status, out } = runCli(
    ['arm', '--calls', '8', '--days', '1', '--artifacts', artifactsDir, '--emit', emitPath],
    PROBE_ENV,
    '\n',
  );
  assert.equal(status, 2, `a missing --start refuses with exit 2; out=${out}`);
  assert.ok(/requires an explicit --start/.test(out), `the refusal names the requirement; out=${out}`);
  assert.ok(!out.includes('[Y/n]'), `the prompt was never shown; out=${out}`);
  assert.ok(!existsSync(emitPath), 'no manifest was written');
});

test('spawned CLI: --help names the status command and its read-only contract', () => {
  const { status, out } = runCli(['--help'], PROBE_ENV, '');
  assert.equal(status, 0, `--help exits 0; out=${out}`);
  assert.ok(out.includes('campaign:status'), `the status command is listed; out=${out}`);
  assert.ok(/STATUS \(read-only/.test(out), `the read-only contract is stated; out=${out}`);
  assert.ok(/NOT invoices/.test(out.replace(/\n/g, ' ')) || /RESERVATIONS \(not invoices\)/.test(out), `the reservations caveat is stated; out=${out}`);
});

test('spawned CLI: tick with an unusable --publication refuses (exit 2) before touching anything, and --help names the flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'campaign-cli-pub-'));
  const manifestPath = join(dir, 'manifest.json');
  const { bytes } = buildCampaignManifest(Date.parse('2027-01-01T00:00:00Z'), { callCap: 800, windowForwardMs: WEEK_MS });
  writeFileSync(manifestPath, bytes);
  const { status, out } = runCli(
    ['tick', '--manifest', manifestPath, '--publication', join(dir, 'missing-descriptor.json')],
    PROBE_ENV,
    '',
  );
  assert.equal(status, 2, `an unusable descriptor refuses; out=${out}`);
  assert.ok(/publication descriptor .* is unusable/.test(out), `the refusal names the descriptor; out=${out}`);
  assert.ok(!/ECONNREFUSED/i.test(out), `refused before the store was ever dialed; out=${out}`);

  const help = runCli(['--help'], PROBE_ENV, '');
  assert.equal(help.status, 0);
  assert.ok(help.out.includes('--publication'), `the flag is documented; out=${help.out}`);
  assert.ok(help.out.includes('--artifacts'), `the evidence-destination flag is documented; out=${help.out}`);
});

test('spawned CLI: tick WITHOUT --publication refuses (exit 2) before touching anything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'campaign-cli-nopub-'));
  const manifestPath = join(dir, 'manifest.json');
  const { bytes } = buildCampaignManifest(Date.parse('2027-01-01T00:00:00Z'), { callCap: 800, windowForwardMs: WEEK_MS });
  writeFileSync(manifestPath, bytes);
  const { status, out } = runCli(['tick', '--manifest', manifestPath], PROBE_ENV, '');
  assert.equal(status, 2, `a missing descriptor refuses; out=${out}`);
  assert.ok(/REQUIRES --publication/.test(out), `the refusal names the requirement; out=${out}`);
  assert.ok(!/ECONNREFUSED/i.test(out), `refused before the store was ever dialed; out=${out}`);
});

test('spawned CLI: status against an unreachable store fails LOUD (exit 1), never prompts, never writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'campaign-cli-status-'));
  const manifestPath = join(dir, 'manifest.json');
  const { bytes } = buildCampaignManifest(Date.parse('2027-01-01T00:00:00Z'), { callCap: 800, windowForwardMs: WEEK_MS });
  writeFileSync(manifestPath, bytes);
  const { status, out } = runCli(['status', '--manifest', manifestPath], PROBE_ENV, '');
  assert.equal(status, 1, `an unreachable store is a loud failure; out=${out}`);
  assert.ok(!out.includes('[Y/n]'), `status never prompts; out=${out}`);
  assert.ok(!/ARMED\.|STOPPED\./.test(out), `status changed nothing; out=${out}`);
});
