import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { nodeArtifactFs } from './fireArtifactSink.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { MarketOpenStore, type MarketOpenClaimInput, type MarketOpenStoreConfig } from './marketOpenStore.js';
import { MARKET_OPEN_DAILY_BUDGET_POLICY_SHA256 } from './marketOpenDailyBudget.js';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX durability required' : false };
const AT = '2026-09-10T14:05:00.000Z';
const origin = (syntheticAdapters: boolean) => ({ version: 'market-open-adapter-origin-v1' as const, syntheticAdapters });
const SLOT = { armId: 'arm-a', role: 'initial' as const, ordinal: 0 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'market-open-store-'));
  const config: MarketOpenStoreConfig = { root, name: 'fixture', slateDate: '2026-09-10',
    policySha256: 'a'.repeat(64), admissionPolicySha256: 'd'.repeat(64), cohortId: 'fixture-cohort', capUsdMicros: 100 };
  const claim = (gameId = 'game-a'): MarketOpenClaimInput => ({
    eventId: sha256Hex(canonicalize({ cohortId: config.cohortId, gameId, market: 'moneyline' })),
    runId: `market-open-v1-${sha256Hex(canonicalize({ cohortId: config.cohortId, gameId, market: 'moneyline' }))}`,
    sourceSha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64), gameSha256: 'd'.repeat(64), policySha256: config.policySha256,
    reservationUsdMicros: 60, slots: [SLOT, { ...SLOT, role: 'repair', ordinal: 1 }],
    preparation: { name: config.name, slateDate: config.slateDate, market: 'moneyline', observedAt: AT,
      historyRows: [{ id: 1, source: 'synthetic' }], game: { gameId, slug: 'a-b', sport: 'mlb',
        matchTime: '2026-09-10T20:00:00Z', status: 'upcoming', homeTeam: { name: 'A', abbreviation: 'A' },
        awayTeam: { name: 'B', abbreviation: 'B' }, hasOdds: true, contestCreated: false, contestId: null,
        canCreateContest: true, externalIds: { jsonodds: gameId, sportspage: null, rundown: null } } },
  });
  return { config, claim, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('new tagged stores reject origin changes or omission, including daily-ledger cohort rollover', posixOnly, () => {
  for (const daily of [false, true]) for (const synthetic of [true, false]) for (const omit of [false, true]) {
    const f = fixture();
    try {
      const config = { ...f.config, cohortOrigin: origin(synthetic),
        ...(daily ? { dailyBudgetVersion: 'market-open-daily-budget-v1' as const,
          admissionPolicySha256: MARKET_OPEN_DAILY_BUDGET_POLICY_SHA256 } : {}) };
      new MarketOpenStore(config).close();
      new MarketOpenStore(config).close();
      const changed = { ...config, ...(daily ? { name: 'next-name', slateDate: '2026-09-11' } : {}) };
      if (omit) delete (changed as Partial<typeof changed>).cohortOrigin;
      else changed.cohortOrigin = origin(!synthetic);
      assert.throws(() => new MarketOpenStore(changed), /origin.*conflict/);
    } finally { f.cleanup(); }
  }
});

test('historical config and journal bytes survive matching automatic origin on reopen', posixOnly, () => {
  const f = fixture();
  try {
    new MarketOpenStore(f.config).close();
    const paths = [join(f.config.root, 'config.json'), join(f.config.root, 'journal', '0000000000.json')];
    const before = paths.map(path => readFileSync(path));
    new MarketOpenStore({ ...f.config, cohortOrigin: origin(false) }).close();
    assert.deepEqual(paths.map(path => readFileSync(path)), before);
    assert.throws(() => new MarketOpenStore({ ...f.config, cohortOrigin: origin(true) }), /origin.*conflict/);
  } finally { f.cleanup(); }
});

test('atomic claim reserves once; exact replay preserves first observation and original input', posixOnly, () => {
  const f = fixture();
  try {
    let store = new MarketOpenStore(f.config);
    const input = f.claim();
    assert.equal(store.claim(input).created, true);
    assert.equal(store.claim(input).created, false);
    assert.equal(store.snapshot().reservedUsdMicros, 60);
    assert.throws(() => store.claim({ ...input, preparation: { ...input.preparation, observedAt: '2026-09-10T14:06:00Z' } }), /conflict/);
    store.close();
    store = new MarketOpenStore(f.config);
    assert.deepEqual(store.getFire(input.eventId)?.claim, input);
    assert.equal(store.getFire(input.eventId)?.status, 'claimed');
    assert.equal(store.claim(f.claim('game-b')).fire.status, 'refused');
    assert.equal(store.snapshot().reservedUsdMicros, 60);
    store.close();
  } finally { f.cleanup(); }
});

test('settlement-time cohort cap marks the second in-flight fire breached even within its own reservation', posixOnly, () => {
  const f = fixture();
  try {
    const store = new MarketOpenStore(f.config);
    const a = { ...f.claim('game-a'), reservationUsdMicros: 50 };
    const b = { ...f.claim('game-b'), reservationUsdMicros: 50 };
    store.claim(a); store.claim(b);
    for (const c of [a, b]) store.beginAttempt({ eventId: c.eventId, slot: SLOT, startedAt: AT });
    store.finishAttempt({ eventId: a.eventId, slot: SLOT, finishedAt: AT, costUsdMicros: 60, evidence: { billable: true } });
    assert.equal(store.getFire(a.eventId)?.reason, 'spend_breach');
    assert.equal(store.getFire(b.eventId)?.status, 'running');
    // Already-sent B must still settle after A halts new work: 60 + 50 > 100,
    // while B's 50 does NOT exceed its own 50 reservation.
    store.finishAttempt({ eventId: b.eventId, slot: SLOT, finishedAt: AT, costUsdMicros: 50, evidence: { billable: true } });
    assert.equal(store.snapshot().knownCostUsdMicros, 110);
    assert.equal(store.snapshot().reservedUsdMicros, 100);
    assert.equal(store.getFire(b.eventId)?.knownCostUsdMicros, 50);
    assert.equal(store.getFire(b.eventId)?.status, 'unknown');
    assert.equal(store.getFire(b.eventId)?.reason, 'spend_breach');
    assert.equal(store.snapshot().halted, 'spend_breach');
    store.close();
  } finally { f.cleanup(); }
});

test('causal timestamps and sent-fire evidence cannot be rewritten as an unsent refusal', posixOnly, () => {
  const f = fixture();
  try {
    const store = new MarketOpenStore(f.config); const c = f.claim(); store.claim(c);
    assert.throws(() => store.beginAttempt({ eventId: c.eventId, slot: SLOT,
      startedAt: '2026-09-10T14:04:59.999Z' }), /attempt predates observation/);
    assert.equal(store.getFire(c.eventId)?.attempts.length, 0);
    store.beginAttempt({ eventId: c.eventId, slot: SLOT, startedAt: AT });
    store.finishAttempt({ eventId: c.eventId, slot: SLOT, finishedAt: AT, costUsdMicros: 1, evidence: { retained: true } });
    const before = store.snapshot();
    assert.throws(() => store.refuse(c.eventId, 'fabricated-unsent'), /cannot refuse sent fire/);
    assert.deepEqual(store.snapshot(), before);
    store.close();
  } finally { f.cleanup(); }
});

test('exclusive writer and malformed owner records never grant a takeover', posixOnly, () => {
  const f = fixture();
  try {
    const store = new MarketOpenStore(f.config);
    assert.throws(() => new MarketOpenStore(f.config), /writer lock/);
    store.close();
    const reopened = new MarketOpenStore(f.config);
    // Removing the owner payload cannot turn an occupied lock into permission.
    writeFileSync(join(f.config.root, '.writer-lock', 'owner.json'), '{"pid":99999999}');
    assert.throws(() => new MarketOpenStore(f.config), /writer lock/);
    assert.throws(() => reopened.claim(f.claim()), /lock|poison/);
  } finally { f.cleanup(); }
});

test('durable attempt start precedes evidence; initial plus repair costs survive restart', posixOnly, () => {
  const f = fixture();
  try {
    const c = f.claim();
    const code = `
      import assert from 'node:assert/strict';
      import { writeFileSync } from 'node:fs';
      import { MarketOpenStore } from ${JSON.stringify(new URL('./marketOpenStore.ts', import.meta.url).href)};
      const store = new MarketOpenStore(${JSON.stringify(f.config)});
      const c = ${JSON.stringify(c)}, repair = c.slots[1], SLOT = ${JSON.stringify(SLOT)}, AT = ${JSON.stringify(AT)};
      store.claim(c);
      assert.throws(() => store.beginAttempt({ eventId: c.eventId, slot: repair, startedAt: AT }), /initial/);
      store.beginAttempt({ eventId: c.eventId, slot: SLOT, startedAt: AT });
      assert.throws(() => store.beginAttempt({ eventId: c.eventId, slot: SLOT, startedAt: AT }), /already/);
      store.finishAttempt({ eventId: c.eventId, slot: SLOT, finishedAt: AT, costUsdMicros: 20, evidence: { usage: 1, response: 'initial' } });
      store.beginAttempt({ eventId: c.eventId, slot: repair, startedAt: AT });
      store.finishAttempt({ eventId: c.eventId, slot: repair, finishedAt: AT, costUsdMicros: 10, evidence: { search: 1, response: 'repair' } });
      const path = ${JSON.stringify(join(f.config.root, 'terminal.json'))}; writeFileSync(path, 'terminal bytes');
      assert.throws(() => store.complete(c.eventId, { path, sha256: 'd'.repeat(64) }), /artifact/);
      assert.throws(() => store.close(), /poison/);
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    // Owner process really exited: no deletion of a live poisoned owner's lock.
    const store = new MarketOpenStore(f.config);
    assert.equal(store.snapshot().knownCostUsdMicros, 30);
    assert.equal(store.snapshot().reservedUsdMicros, 60);
    assert.equal(store.getFire(c.eventId)?.status, 'unknown');
    assert.deepEqual(store.getFire(c.eventId)?.attempts[1]?.evidence, { search: 1, response: 'repair' });
    store.close();
  } finally { f.cleanup(); }
});

test('unknown cost retains evidence and blocks every later send, including repairs', posixOnly, () => {
  const f = fixture();
  try {
    const store = new MarketOpenStore(f.config); const c = f.claim(); store.claim(c);
    store.beginAttempt({ eventId: c.eventId, slot: SLOT, startedAt: AT });
    store.finishAttempt({ eventId: c.eventId, slot: SLOT, finishedAt: AT, costUsdMicros: null, evidence: { response: 'unpriced' } });
    assert.equal(store.getFire(c.eventId)?.status, 'unknown');
    assert.equal(store.snapshot().halted, 'unknown_attempt_cost');
    const reserved = store.snapshot().reservedUsdMicros;
    const next = store.claim({ ...f.claim('game-b'), reservationUsdMicros: 1 }).fire;
    assert.equal(next.status, 'refused');
    assert.equal(next.admitted, false);
    assert.equal(next.reason, 'unknown_attempt_cost');
    assert.equal(store.snapshot().reservedUsdMicros, reserved);
    assert.throws(() => store.beginAttempt({ eventId: c.eventId, slot: c.slots[1]!, startedAt: AT }), /halted/);
    store.close();
  } finally { f.cleanup(); }
});

test('replay rejects changed bytes and missing journal prefixes without resetting reservations', posixOnly, () => {
  for (const mutate of ['bytes', 'gap']) {
    const f = fixture();
    try {
      const store = new MarketOpenStore(f.config); store.claim(f.claim()); store.close();
      const files = readdirSync(join(f.config.root, 'journal')).filter((p) => p.endsWith('.json')).sort();
      const path = join(f.config.root, 'journal', files[0]!);
      if (mutate === 'gap') rmSync(path);
      else writeFileSync(path, readFileSync(path, 'utf8').replace('"init"', '"oops"'));
      assert.throws(() => new MarketOpenStore(f.config), /journal|replay|validation|shape/i);
    } finally { f.cleanup(); }
  }
});
