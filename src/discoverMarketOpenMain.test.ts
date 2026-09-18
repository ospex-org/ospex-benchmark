import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverScoreableMarketOpenRuns, runMarketOpenDiscoveryCli } from './discoverMarketOpenMain.js';
import { createMarketOpenEvidenceFixture } from './testFixtures/marketOpenEvidenceFixture.js';

const posix = { skip: process.platform === 'win32' ? 'B2 durable producer requires POSIX' : false };
const entry = fileURLToPath(new URL('./discoverMarketOpenMain.ts', import.meta.url));
function cli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], {
    cwd: resolve(fileURLToPath(new URL('..', import.meta.url))), encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env['PATH'] ?? '/usr/bin', HOME: tmpdir() },
  });
}

test('market-open discovery executable refuses bad arguments rather than silently doing nothing', () => {
  const result = cli([]); assert.equal(result.status, 1); assert.match(result.stderr, /Usage: discover:market-open/);
  assert.throws(() => runMarketOpenDiscoveryCli(['--newest', '/tmp']), /Usage/);
});

test('market-open discovery CLI prints every sibling artifact once, in replay-stable order', posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture({ markets: ['moneyline', 'total'], sendAt: '2026-09-10T19:00:00.000Z' });
  try {
    const expected = discoverScoreableMarketOpenRuns(fixture.root);
    assert.equal(expected.length, 2); assert.deepEqual(expected.map((r) => r.market).sort(), ['moneyline', 'total']);
    assert.equal(new Set(expected.map((r) => r.eventId)).size, 2);
    const first = cli(['--evidence-root', fixture.root]); const second = cli(['--evidence-root', fixture.root]);
    assert.equal(first.status, 0, first.stderr); assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.deepEqual(first.stdout.trim().split('\n').map((s) => JSON.parse(s)), expected);
    assert(expected.every((r) => r.mode === 'live' && r.clockMode === 'wall' && r.status === 'completed'));
  } finally { await fixture.cleanup(); }
});

test('market-open discovery preserves installed failed-arm outcome instead of silently dropping its denominators', posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture({ failedArm: true });
  try {
    const rows = discoverScoreableMarketOpenRuns(fixture.root);
    assert.equal(rows.length, 1); assert.equal(rows[0]!.status, 'failed'); assert.equal(rows[0]!.reason, 'arm_outcome_failure');
  } finally { await fixture.cleanup(); }
});

test('multi-artifact discovery admits the root exactly once per invocation', posix, async (t) => {
  const fixture = await createMarketOpenEvidenceFixture({ markets: ['moneyline', 'total'] });
  const original = fs.readFileSync;
  let admissions = 0;
  const spy = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === resolve(fixture.root, 'config.json')) admissions++;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(discoverScoreableMarketOpenRuns(fixture.root).length, 2);
    assert.equal(admissions, 1);
    assert.equal(discoverScoreableMarketOpenRuns(fixture.root).length, 2);
    assert.equal(admissions, 2, 'a new invocation re-verifies the root');
  } finally { spy.mock.restore(); syncBuiltinESMExports(); await fixture.cleanup(); }
});

test('market-open discovery empty initialized root emits no descriptors', posix, async () => {
  const fixture = await createMarketOpenEvidenceFixture({ markets: [] });
  try {
    const lines: string[] = [];
    assert.equal(runMarketOpenDiscoveryCli(['--evidence-root', fixture.root], (s) => { lines.push(s); }), 0);
    assert.deepEqual(lines, []);
  } finally { await fixture.cleanup(); }
});
