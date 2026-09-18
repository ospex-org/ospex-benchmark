import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalize } from './canonical.js';
import { nodeArtifactFs } from './fireArtifactSink.js';
import { MarketOpenStore, type MarketOpenStoreConfig } from './marketOpenStore.js';

const linuxOnly = { skip: process.platform !== 'linux' ? 'Linux process identity required' : false };
const bootId = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const startTicks = () => readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(/\) /).at(-1)!.split(' ')[19]!;
const owner = () => ({ nonce: 'a'.repeat(64), pid: process.pid, bootId: bootId(), processStartTicks: startTicks() });
const otherBoot = () => bootId() === '00000000-0000-0000-0000-000000000000'
  ? '11111111-1111-1111-1111-111111111111' : '00000000-0000-0000-0000-000000000000';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'market-open-lock-recovery-'));
  const config: MarketOpenStoreConfig = { root, name: 'lock-fixture', slateDate: '2026-09-18',
    policySha256: 'a'.repeat(64), admissionPolicySha256: 'd'.repeat(64), cohortId: 'lock-fixture', capUsdMicros: 100 };
  new MarketOpenStore(config).close();
  const lock = join(root, '.writer-lock');
  const history = join(root, '.writer-lock-recoveries');
  return { root, config, lock, history,
    seed(previous: unknown) { mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), canonicalize(previous)); },
    records() { return readdirSync(history).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(history, name), 'utf8'))); },
    cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

for (const kind of ['previous-boot', 'pid-absent', 'pid-reused', 'legacy-pid-absent'] as const) {
  test(`writer starts unattended after ${kind}; recovery is recorded once and journal stays exact`, linuxOnly, () => {
    const f = fixture();
    try {
      // Linux pid_max never reaches this safe integer. Verify the premise, do not assume it.
      assert.throws(() => process.kill(2_000_000_000, 0), { code: 'ESRCH' });
      const previous = kind === 'previous-boot' ? { ...owner(), bootId: otherBoot() }
        : kind === 'pid-reused' ? { ...owner(), processStartTicks: (BigInt(startTicks()) + 1n).toString() }
        : kind === 'legacy-pid-absent' ? { nonce: 'b'.repeat(64), pid: 2_000_000_000 }
        : { ...owner(), pid: 2_000_000_000 };
      const journal = join(f.root, 'journal', '0000000000.json');
      const before = readFileSync(journal);
      f.seed(previous);
      const since = Date.now();
      let store = new MarketOpenStore(f.config);
      const current = JSON.parse(readFileSync(join(f.lock, 'owner.json'), 'utf8'));
      assert.equal(current.bootId, bootId());
      assert.equal(current.processStartTicks, startTicks());
      assert.equal(current.pid, process.pid);
      assert.deepEqual(readFileSync(journal), before);
      assert.equal(store.snapshot().reservedUsdMicros, 0);
      const records = f.records();
      assert.equal(records.length, 1);
      assert.deepEqual(records[0].previousOwner, previous);
      assert.equal(records[0].reason, kind);
      assert.ok(Date.parse(records[0].recoveredAt) >= since && Date.parse(records[0].recoveredAt) <= Date.now());
      const recorded = canonicalize(records);
      store.close(); store = new MarketOpenStore(f.config); store.close();
      assert.equal(canonicalize(f.records()), recorded);
      const archived = readdirSync(f.history).filter(name => name.endsWith('.lock'));
      assert.equal(archived.length, 1);
      assert.deepEqual(JSON.parse(readFileSync(join(f.history, archived[0]!, 'owner.json'), 'utf8')), previous);
    } finally { f.cleanup(); }
  });
}

test('live owners, legacy live PIDs and missing/malformed records refuse with the actual cause', linuxOnly, () => {
  for (const [previous, message] of [
    [owner(), /owner process .* is still running/],
    [{ nonce: 'a'.repeat(64), pid: process.pid }, /cannot prove.*dead.*boot ID or process start time is missing/],
    [{ nonce: 'a'.repeat(64), pid: process.pid, bootId: bootId() }, /cannot prove.*dead/],
    [{ nonce: 'a'.repeat(64), pid: process.pid, processStartTicks: startTicks() }, /cannot prove.*dead/],
    [{ ...owner(), processStartTicks: `0${startTicks()}` }, /owner record is invalid/],
    [{ ...owner(), bootId: bootId().toUpperCase() }, /owner record is invalid/],
    [{ pid: 2_000_000_000 }, /owner record is invalid/],
  ] as const) {

    const f = fixture();
    try {
      f.seed(previous);
      const before = readFileSync(join(f.lock, 'owner.json'));
      utimesSync(f.lock, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
      assert.throws(() => new MarketOpenStore(f.config), message);
      assert.deepEqual(readFileSync(join(f.lock, 'owner.json')), before);
    } finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    mkdirSync(f.lock);
    assert.throws(() => new MarketOpenStore(f.config), /owner record is missing/);
  } finally { f.cleanup(); }
});

test('same-process live writer holds the kernel guard until clean close', linuxOnly, () => {
  const f = fixture();
  try {
    const store = new MarketOpenStore(f.config);
    assert.throws(() => new MarketOpenStore(f.config), /writer lock.*another process holds the kernel guard/);
    store.close(); new MarketOpenStore(f.config).close();
  } finally { f.cleanup(); }
});

test('actual SIGKILL releases kernel exclusion and dead owner is recovered without manual deletion', linuxOnly, () => {
  const f = fixture();
  try {
    const code = `import { MarketOpenStore } from ${JSON.stringify(new URL('./marketOpenStore.ts', import.meta.url).href)};
      new MarketOpenStore(${JSON.stringify(f.config)}); process.kill(process.pid, 'SIGKILL');`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    new MarketOpenStore(f.config).close();
    assert.equal(f.records().length, 1);
    assert.equal(f.records()[0].previousOwner.pid, child.pid);
    assert.equal(f.records()[0].reason, 'pid-absent');
  } finally { f.cleanup(); }
});

test('write-ahead recovery survives failure before archive without a second record or changed timestamp', linuxOnly, () => {
  const f = fixture(), syncDir = nodeArtifactFs.syncDir;
  try {
    f.seed({ ...owner(), pid: 2_000_000_000 });
    let failed = false;
    nodeArtifactFs.syncDir = (path) => {
      syncDir(path);
      if (path === f.history && f.records().length === 1 && existsSync(f.lock) && !failed) {
        failed = true; throw Object.assign(new Error('synthetic record fsync ambiguity'), { code: 'EIO' });
      }
    };
    assert.throws(() => new MarketOpenStore(f.config), /persisting the dead-owner recovery record: disk input\/output failure \(EIO\)/);
    assert.equal(failed, true); assert.equal(existsSync(f.lock), true);
    const before = canonicalize(f.records());
    nodeArtifactFs.syncDir = syncDir;
    new MarketOpenStore(f.config).close();
    assert.equal(canonicalize(f.records()), before);
    assert.equal(readdirSync(f.history).filter(n => n.endsWith('.lock')).length, 1);
  } finally { nodeArtifactFs.syncDir = syncDir; f.cleanup(); }
});

test('symlinked markers/guards refuse; replacing a live guard poisons the old handle and cannot admit a second writer', linuxOnly, () => {
  for (const name of ['.writer-lock', '.writer-lock.guard']) {
    const f = fixture();
    try {
      const target = join(f.root, name);
      rmSync(target, { force: true }); symlinkSync(f.root, target);
      assert.throws(() => new MarketOpenStore(f.config), /writer lock:/);
      assert.equal(readdirSync(f.root).includes('journal'), true);
    } finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    const store = new MarketOpenStore(f.config);
    unlinkSync(join(f.root, '.writer-lock.guard'));
    assert.throws(() => new MarketOpenStore(f.config), /owner process .* is still running/);
    assert.throws(() => store.snapshot(), /kernel guard identity changed/);
    assert.throws(() => store.close(), /poison/);
  } finally { f.cleanup(); }
});

test('simultaneous reclaimers admit one real writer, never two; one recovery record', { ...linuxOnly, timeout: 20_000 }, async () => {
  for (const stale of [false, true]) {
    const f = fixture();
    const children = [0, 1].map(() => fork(new URL('./testFixtures/localProcessLockWorker.ts', import.meta.url), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }));
    const exits = children.map(child => once(child, 'exit'));
    try {
      if (stale) f.seed({ ...owner(), bootId: otherBoot() });
      await Promise.all(children.map(child => once(child, 'message')));
      const results = children.map(child => once(child, 'message'));
      for (const child of children) child.send(f.config);
      const reports = (await Promise.all(results)).map(([message]) => message as { acquired: boolean; error?: string });
      assert.equal(reports.filter(report => report.acquired).length, 1, JSON.stringify(reports));
      assert.match(reports.find(report => !report.acquired)!.error!, /another process holds the kernel guard/);
      if (stale) assert.equal(f.records().length, 1);
      for (const child of children) child.send('close');
      await Promise.all(exits);
      new MarketOpenStore(f.config).close();
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.all(exits); f.cleanup();
    }
  }
});
