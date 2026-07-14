import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keysetWalk } from './fetchers.js';

/**
 * Keyset-pagination invariants. The fake below emulates PostgREST semantics
 * over a mutable table (`order=id.asc&id=gt.N`) with a SERVER-enforced page
 * cap the walker does not know about, so both failure classes are
 * reproduced deterministically:
 *
 * 1. the insertion race that breaks offset pagination (a concurrent insert
 *    shifts page boundaries, duplicating one row and dropping another), and
 * 2. short-page truncation (a server row cap below the requested limit
 *    makes every page "short"; a walker that treats a short page as
 *    end-of-data silently truncates).
 */

interface Row {
  id: number;
  name: string;
}

function pageSource(table: Row[], serverCap: number, onPage?: (pageIndex: number) => void) {
  let pageIndex = 0;
  return async (afterId: number): Promise<Row[]> => {
    onPage?.(pageIndex);
    pageIndex += 1;
    return table
      .filter((row) => row.id > afterId)
      .sort((a, b) => a.id - b.id)
      .slice(0, serverCap);
  };
}

function makeTable(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `row-${i + 1}` }));
}

test('keysetWalk returns every row exactly once across multiple pages', async () => {
  const table = makeTable(25);
  const rows = await keysetWalk({
    fetchPage: pageSource(table, 10),
    idOf: (row: Row) => row.id,
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    table.map((row) => row.id),
  );
});

test('REGRESSION: a server page cap below the requested size must not truncate the walk', async () => {
  // 120 rows behind a server that caps every response at 50 rows. A walker
  // that treats a short page as end-of-data returns 50 and stops; the walk
  // must instead continue to the empty page and return all 120.
  const table = makeTable(120);
  const rows = await keysetWalk({
    fetchPage: pageSource(table, 50),
    idOf: (row: Row) => row.id,
  });
  assert.equal(rows.length, 120, 'every row returned despite the server cap');
  assert.equal(new Set(rows.map((row) => row.id)).size, 120, 'no duplicates');
});

test('REGRESSION: a row inserted mid-walk never duplicates or drops a pre-existing row', async () => {
  // The scenario that broke offset pagination: 1,000+ rows, one row inserted
  // between page fetches. With offset paging the insert shifts boundaries
  // (a boundary row comes back twice and the count still matches); with
  // keyset paging every pre-existing row must appear exactly once, and the
  // appended row is simply included.
  const table = makeTable(1000);
  const originalIds = new Set(table.map((row) => row.id));
  const rows = await keysetWalk({
    fetchPage: pageSource(table, 100, (pageIndex) => {
      if (pageIndex === 5) table.push({ id: 1001, name: 'inserted-mid-walk' });
    }),
    idOf: (row: Row) => row.id,
  });
  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  for (const id of originalIds) {
    assert.ok(ids.includes(id), `pre-existing row ${id} present`);
  }
  assert.equal(ids.length, 1001, 'the appended row is included too');
});

test('keysetWalk refuses non-increasing ids (duplicate or disordered pages)', async () => {
  const table = [
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
    { id: 2, name: 'b-duplicate' },
  ];
  await assert.rejects(
    keysetWalk({
      fetchPage: async () => table,
      idOf: (row: Row) => row.id,
    }),
    /non-increasing id/,
  );
});

test('keysetWalk refuses unsafe ids', async () => {
  await assert.rejects(
    keysetWalk({
      fetchPage: async () => [{ id: Number.NaN, name: 'bad' }],
      idOf: (row: Row) => row.id,
    }),
    /non-increasing id/,
  );
});

test('maxRows is enforced on EVERY page, including a short final one', async () => {
  // 29 rows in server pages of 10 against maxRows 25: the bound must refuse
  // on the final (short) page, never return 29 rows through an early exit.
  const shortFinal = makeTable(29);
  await assert.rejects(
    keysetWalk({
      fetchPage: pageSource(shortFinal, 10),
      idOf: (row: Row) => row.id,
      maxRows: 25,
    }),
    /unbounded walk/,
  );
  const runaway = makeTable(50);
  await assert.rejects(
    keysetWalk({
      fetchPage: pageSource(runaway, 10),
      idOf: (row: Row) => row.id,
      maxRows: 25,
    }),
    /unbounded walk/,
  );
});
