import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildCampaignAuthorization } from './campaignAuthorization.js';
import type { CampaignAuthorization, CampaignAuthorizationPort } from './campaignAuthorization.js';
import { buildCampaignManifest } from './campaignProfile.js';
import { armCampaign, installManifestNoClobber, stopCampaign, tickCampaign } from './campaignMain.js';
import type { CampaignDeps } from './campaignMain.js';
import { cohortBoot } from './cohortBoot.js';
import type { ArtifactFs } from './fireArtifactSink.js';
import type { AtomicStore } from './store/contract.js';
import { defaultExpectedArms } from './scoring.js';

/**
 * The campaign owner-level flows — arm, tick, stop — driven WITHOUT a database, a network,
 * or a provider. Every seam is injected, so these prove the decisions the CLI owns: the
 * attended arming gate with the standard [Y/n] semantics and exact prompt bytes; the
 * AUTHORITY-ORDERED durable writes (manifest → budget → authorization, so no failed arm
 * leaves standing authority); the reconciliation of re-runs and of already-armed cohorts;
 * and the unattended tick's two refusals — no live authorization (exit 2) and the
 * structural activation refusal (exit 3): a VALID authorization must still never dispatch
 * in this build. The spawned-CLI probes at the bottom drive the PRODUCTION readline seam
 * end to end.
 */

const NOW = Date.parse('2026-08-05T00:00:00.000Z');
const WEEK_MS = 7 * 24 * 3_600_000;
const ROSTER = defaultExpectedArms().map((a) => a.participantId);

const SYNTHETIC_ENV: Record<string, string | undefined> = {
  STORE_DATABASE_URL: 'postgres://synthetic/none',
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

function deps(
  over: Partial<CampaignDeps> & { auth?: MemoryAuthPort } = {},
): CampaignDeps & { auth: MemoryAuthPort; storeCalls: string[] } {
  const auth = over.auth ?? new MemoryAuthPort();
  const storeCalls: string[] = [];
  const base: CampaignDeps = {
    openStore: async () => ({ store: recordingStore(storeCalls), authorizations: auth, close: async () => {} }),
    observeCredentials: (ids) => new Map(ids.map((id) => [id, true])),
    confirm: async () => 'y',
    now: () => NOW,
    ...over,
  };
  return { ...base, auth, storeCalls };
}

function options(over: Record<string, unknown> = {}): Parameters<typeof armCampaign>[0] {
  return {
    command: 'arm',
    calls: 800,
    days: 7,
    // --start is REQUIRED (the campaign's identity anchor); the fixture pins it to the same
    // instant as the test clock so derived expectations (window, expiry) stay byte-stable.
    startIso: '2026-08-05T00:00:00.000Z',
    dispatches: 1,
    manifestPath: null,
    emitPath: join(mkdtempSync(join(tmpdir(), 'campaign-')), 'campaign-manifest.json'),
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
  const d = deps({ auth, openStore: async () => ({ store, authorizations: auth, close: async () => {} }) });
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
  const d = deps({ auth, openStore: async () => ({ store, authorizations: auth, close: async () => {} }) });
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

/** deps whose store close ALWAYS rejects; the decided outcome must stand anyway. */
function depsWithFailingClose(
  over: Partial<CampaignDeps> & { auth?: MemoryAuthPort } = {},
): CampaignDeps & { auth: MemoryAuthPort; storeCalls: string[] } {
  const base = deps(over);
  return {
    ...base,
    openStore: async () => {
      const opened = await base.openStore('unused');
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
  const d = deps({ auth, openStore: async () => ({ store: refusingStore, authorizations: auth, close: FAILING_CLOSE }) });
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
  const valid = await captured(() =>
    withEnv(SYNTHETIC_ENV, () =>
      tickCampaign(options({ command: 'tick', manifestPath }), depsWithFailingClose({ auth, confirm: NEVER_PROMPT })),
    ),
  );
  assert.equal(valid.value, 3, 'the activation refusal is preserved');

  const { bytes } = buildCampaignManifest(NOW + 7_200_000, { callCap: 800, windowForwardMs: WEEK_MS });
  const strangerPath = join(mkdtempSync(join(tmpdir(), 'campaign-close-tick-')), 'manifest.json');
  writeFileSync(strangerPath, bytes);
  const refused = await captured(() =>
    withEnv(SYNTHETIC_ENV, () =>
      tickCampaign(options({ command: 'tick', manifestPath: strangerPath }), depsWithFailingClose({ auth, confirm: NEVER_PROMPT })),
    ),
  );
  assert.equal(refused.value, 2, 'the no-authorization refusal is preserved');
});

// ===========================================================================
// tick
// ===========================================================================

/** Arm a campaign and return its manifest path + the shared port. */
async function armed(): Promise<{ manifestPath: string; auth: MemoryAuthPort; cohortId: string }> {
  const auth = new MemoryAuthPort();
  const opts = options();
  const { value: code } = await captured(() => withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth }))));
  assert.equal(code, 0);
  const cohortId = cohortBoot({ manifestBytes: readFileSync(opts.emitPath, 'utf8') }).cohortId;
  return { manifestPath: opts.emitPath, auth, cohortId };
}

const NEVER_PROMPT = async (): Promise<string | null> => {
  throw new Error('an unattended tick must never prompt');
};

test('a tick with NO armed authorization fires nothing and exits 2 — never a mock fallback, never a prompt', async () => {
  const { bytes } = buildCampaignManifest(NOW, { callCap: 800, windowForwardMs: WEEK_MS });
  const dir = mkdtempSync(join(tmpdir(), 'campaign-tick-'));
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, bytes);

  const d = deps({ confirm: NEVER_PROMPT });
  const { value: code, errors } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => tickCampaign(options({ command: 'tick', manifestPath }), d)),
  );
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /no live campaign authorization/);
  assert.deepEqual(d.storeCalls, [], 'the store was never touched');
});

test('a tick against a DISARMED campaign fires nothing and exits 2', async () => {
  const { manifestPath, auth, cohortId } = await armed();
  await auth.disarm(cohortId, new Date(NOW).toISOString());
  const d = deps({ auth, confirm: NEVER_PROMPT });
  const { value: code } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => tickCampaign(options({ command: 'tick', manifestPath }), d)),
  );
  assert.equal(code, 2);
});

test('a tick after EXPIRY fires nothing and exits 2', async () => {
  const { manifestPath, auth } = await armed();
  const d = deps({ auth, confirm: NEVER_PROMPT, now: () => NOW + WEEK_MS + 1 });
  const { value: code } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => tickCampaign(options({ command: 'tick', manifestPath }), d)),
  );
  assert.equal(code, 2);
});

test('a VALID armed authorization: the tick validates end to end and REFUSES to dispatch (exit 3)', async () => {
  const { manifestPath, auth, cohortId } = await armed();
  auth.calls.length = 0; // observe only the tick's interactions
  const d = deps({ auth, confirm: NEVER_PROMPT });
  const { value: code, logs, errors } = await captured(() =>
    withEnv(SYNTHETIC_ENV, () => tickCampaign(options({ command: 'tick', manifestPath }), d)),
  );
  assert.equal(code, 3, 'a valid authorization exits 3 — NEVER 0 — while activation is disabled');
  assert.match(logs.join('\n'), /campaign authorization VALID/);
  const refusal = errors.join('\n');
  assert.match(refusal, /REFUSING to dispatch/);
  assert.match(refusal, /structurally disabled/);
  assert.match(refusal, /No provider call was made/);
  assert.deepEqual(auth.calls, [`read:${cohortId}`], 'the ONLY port interaction is the read');
  assert.deepEqual(d.storeCalls, [], 'no budget init, no claim, no dispatch-path store call');
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
  const { manifestPath, auth, cohortId } = await armed();
  const booted = cohortBoot({ manifestBytes: readFileSync(manifestPath, 'utf8') });
  const record = auth.records.get(cohortId)!;
  const expected = buildCampaignAuthorization({
    booted,
    observedCredentialedParticipantIds: ROSTER,
    armedAtMs: NOW,
    expiresAtMs: NOW + WEEK_MS,
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
  const { status, signal, out } = runCli(['arm', '--calls', '8', '--days', '1', '--start', '2027-01-01T00:00:00Z', '--emit', emitPath], PROBE_ENV, '\n');
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
  const { status, out } = runCli(['arm', '--calls', '8', '--days', '1', '--start', '2027-01-01T00:00:00Z', '--emit', emitPath], PROBE_ENV, '');
  assert.equal(status, 2, `EOF refuses with exit 2; out=${out}`);
  assert.ok(/confirmation stream closed \(EOF\)/.test(out), `the refusal names EOF; out=${out}`);
  assert.ok(!existsSync(emitPath), 'no manifest was written');
  assert.ok(!/NO standing authority/.test(out) && !/ARMED/.test(out), `the durable steps were never reached; out=${out}`);
});

test("spawned CLI: an explicit 'n' REFUSES with nothing durable", () => {
  const emitPath = join(mkdtempSync(join(tmpdir(), 'campaign-cli-n-')), 'campaign-manifest.json');
  const { status, out } = runCli(['arm', '--calls', '8', '--days', '1', '--start', '2027-01-01T00:00:00Z', '--emit', emitPath], PROBE_ENV, 'n\n');
  assert.equal(status, 2, `'n' refuses with exit 2; out=${out}`);
  assert.ok(/arming refused \(answer "n"\)/.test(out), `the refusal echoes the answer; out=${out}`);
  assert.ok(!existsSync(emitPath), 'no manifest was written');
});

test('spawned CLI: an OMITTED --start refuses before the prompt is ever shown', () => {
  const emitPath = join(mkdtempSync(join(tmpdir(), 'campaign-cli-nostart-')), 'campaign-manifest.json');
  const { status, out } = runCli(['arm', '--calls', '8', '--days', '1', '--emit', emitPath], PROBE_ENV, '\n');
  assert.equal(status, 2, `a missing --start refuses with exit 2; out=${out}`);
  assert.ok(/requires an explicit --start/.test(out), `the refusal names the requirement; out=${out}`);
  assert.ok(!out.includes('[Y/n]'), `the prompt was never shown; out=${out}`);
  assert.ok(!existsSync(emitPath), 'no manifest was written');
});
