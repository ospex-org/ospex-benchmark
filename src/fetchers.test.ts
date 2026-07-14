import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keysetWalk } from './fetchers.js';

/**
 * Keyset-pagination invariants. The fake below emulates PostgREST semantics
 * over a mutable table (`order=id.asc&id=gt.N&limit=pageSize`) so the
 * insertion race that breaks offset pagination — a concurrent insert shifts
 * page boundaries, duplicating one row and dropping another — can be
 * reproduced deterministically against the walker.
 */

interface Row {
  id: number;
  name: string;
}

function pageSource(table: Row[], pageSize: number, onPage?: (pageIndex: number) => void) {
  let pageIndex = 0;
  return async (afterId: number): Promise<Row[]> => {
    onPage?.(pageIndex);
    pageIndex += 1;
    return table
      .filter((row) => row.id > afterId)
      .sort((a, b) => a.id - b.id)
      .slice(0, pageSize);
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
    pageSize: 10,
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    table.map((row) => row.id),
  );
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
    pageSize: 100,
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
      pageSize: 10,
    }),
    /non-increasing id/,
  );
});

test('keysetWalk refuses unsafe ids and runaway result sets', async () => {
  await assert.rejects(
    keysetWalk({
      fetchPage: async () => [{ id: Number.NaN, name: 'bad' }],
      idOf: (row: Row) => row.id,
      pageSize: 10,
    }),
    /non-increasing id/,
  );
  const table = makeTable(50);
  await assert.rejects(
    keysetWalk({
      fetchPage: pageSource(table, 10),
      idOf: (row: Row) => row.id,
      pageSize: 10,
      maxRows: 25,
    }),
    /did not terminate/,
  );
});
