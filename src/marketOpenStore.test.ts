import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { nodeArtifactFs } from './fireArtifactSink.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { MarketOpenStore, type MarketOpenClaimInput, type MarketOpenStoreConfig } from './marketOpenStore.js';

const AT = '2026-09-10T14:05:00.000Z';
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

test('atomic claim reserves once; exact replay preserves first observation and original input', () => {
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

test('exclusive writer and stale lock never automatically stolen', () => {
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

test('durable attempt start precedes evidence; initial plus repair costs survive restart', () => {
  const f = fixture();
  try {
    let store = new MarketOpenStore(f.config);
    const c = f.claim(); store.claim(c);
    const repair = c.slots[1]!;
    assert.throws(() => store.beginAttempt({ eventId: c.eventId, slot: repair, startedAt: AT }), /initial/);
    store.beginAttempt({ eventId: c.eventId, slot: SLOT, startedAt: AT });
    assert.throws(() => store.beginAttempt({ eventId: c.eventId, slot: SLOT, startedAt: AT }), /already/);
    store.finishAttempt({ eventId: c.eventId, slot: SLOT, finishedAt: AT, costUsdMicros: 20, evidence: { usage: 1, response: 'initial' } });
    store.beginAttempt({ eventId: c.eventId, slot: repair, startedAt: AT });
    store.finishAttempt({ eventId: c.eventId, slot: repair, finishedAt: AT, costUsdMicros: 10, evidence: { search: 1, response: 'repair' } });
    const path = join(f.config.root, 'terminal.json'); writeFileSync(path, 'terminal bytes');
    assert.throws(() => store.complete(c.eventId, { path, sha256: 'd'.repeat(64) }), /artifact/);
    // Artifact uncertainty poisons the handle; no clean unlock after failed verification.
    assert.throws(() => store.close(), /poison/);
    rmSync(join(f.config.root, '.writer-lock'), { recursive: true }); // OFFLINE synthetic recovery only
    store = new MarketOpenStore(f.config);
    assert.equal(store.snapshot().knownCostUsdMicros, 30);
    assert.equal(store.snapshot().reservedUsdMicros, 60);
    assert.equal(store.getFire(c.eventId)?.status, 'unknown');
    assert.deepEqual(store.getFire(c.eventId)?.attempts[1]?.evidence, { search: 1, response: 'repair' });
    store.close();
  } finally { f.cleanup(); }
});

test('unknown cost retains evidence and blocks every later send, including repairs', () => {
  const f = fixture();
  try {
    const store = new MarketOpenStore(f.config); const c = f.claim(); store.claim(c);
    store.beginAttempt({ eventId: c.eventId, slot: SLOT, startedAt: AT });
    store.finishAttempt({ eventId: c.eventId, slot: SLOT, finishedAt: AT, costUsdMicros: null, evidence: { response: 'unpriced' } });
    assert.equal(store.getFire(c.eventId)?.status, 'unknown');
    assert.ok(store.snapshot().halted);
    assert.throws(() => store.beginAttempt({ eventId: c.eventId, slot: c.slots[1]!, startedAt: AT }), /halted/);
    store.close();
  } finally { f.cleanup(); }
});

test('replay rejects changed bytes and missing journal prefixes without resetting reservations', () => {
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
