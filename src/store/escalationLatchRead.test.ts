import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqlUnresolvedFireReadPort } from './escalationLatchRead.js';
import type { StoreQuery } from './atomicStore.js';

/**
 * The unresolved-fire read over a scripted `StoreQuery`: the predicate's load-bearing SQL
 * elements are pinned (pending status, the NOT EXISTS live-lease anti-join with the
 * store's own liveness filter), the wire mapping is exact (`fire_id` string,
 * `admitted_at` Date → ISO), and every malformed wire shape or query failure is loud.
 * The SQL's behaviour against real tables — release-to-latch, settle-to-clear, expiry —
 * is proven by `yarn store:campaign-auth` conformance, which a scripted query cannot.
 */

const COHORT = 'c'.repeat(64);

function scripted(rows: ReadonlyArray<Record<string, unknown>>): {
  port: SqlUnresolvedFireReadPort;
  calls: Array<{ sql: string; params: readonly unknown[] }>;
} {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const query: StoreQuery = async (sql, params) => {
    calls.push({ sql, params });
    return rows;
  };
  return { port: new SqlUnresolvedFireReadPort(query), calls };
}

test('the ONE statement carries the whole predicate: pending fires, minus any fire holding a live lease', async () => {
  const { port, calls } = scripted([]);
  assert.deepEqual(await port.unresolvedFires(COHORT), []);
  assert.equal(calls.length, 1, 'one SELECT, no lock, no write');
  const { sql, params } = calls[0]!;
  assert.deepEqual(params, [COHORT]);
  assert.match(sql, /from store\.fires/);
  assert.match(sql, /status = 'pending'/);
  assert.match(sql, /not exists/);
  assert.match(sql, /store\.concurrency_leases/);
  // The SAME liveness filter as the store's own capacity read: a lease is live only when
  // it is unreleased AND unexpired — dropping either half would blind the latch to
  // released or expired leases.
  assert.match(sql, /released_at is null/);
  assert.match(sql, /expires_at > now\(\)/);
  assert.doesNotMatch(sql, /update|insert|delete|for update/i, 'a read, never a write or a lock');
});

test('rows map exactly: fire_id as-is, admitted_at Date → ISO, in returned order', async () => {
  const { port } = scripted([
    { fire_id: 'a'.repeat(64), admitted_at: new Date('2026-08-05T12:00:00.000Z') },
    { fire_id: 'b'.repeat(64), admitted_at: new Date('2026-08-05T13:30:00.500Z') },
  ]);
  assert.deepEqual(await port.unresolvedFires(COHORT), [
    { fireId: 'a'.repeat(64), admittedAt: '2026-08-05T12:00:00.000Z' },
    { fireId: 'b'.repeat(64), admittedAt: '2026-08-05T13:30:00.500Z' },
  ]);
});

test('wire surprises are LOUD, never a silently wrong latch row', async () => {
  await assert.rejects(
    scripted([{ fire_id: 42, admitted_at: new Date() }]).port.unresolvedFires(COHORT),
    /fire_id is not a non-empty string/,
  );
  await assert.rejects(
    scripted([{ fire_id: '', admitted_at: new Date() }]).port.unresolvedFires(COHORT),
    /fire_id is not a non-empty string/,
  );
  await assert.rejects(
    scripted([{ fire_id: 'a'.repeat(64), admitted_at: '2026-08-05T12:00:00.000Z' }]).port.unresolvedFires(COHORT),
    /admitted_at is not a timestamp/,
    'pg returns timestamptz as Date; a string is a wire surprise, refused rather than trusted',
  );
  await assert.rejects(
    scripted([{ fire_id: 'a'.repeat(64) }]).port.unresolvedFires(COHORT),
    /admitted_at is not a timestamp/,
  );
});

test('a query failure propagates — fail closed, never an empty (clear) read', async () => {
  const failing: StoreQuery = async () => {
    throw new Error('connection reset');
  };
  await assert.rejects(new SqlUnresolvedFireReadPort(failing).unresolvedFires(COHORT), /connection reset/);
});
