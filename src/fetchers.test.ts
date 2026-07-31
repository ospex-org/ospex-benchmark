import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchClosingLines,
  fetchClosingLinesByMarket,
  fetchTotalsClosingLines,
  GAMES_TABLE_SELECT,
  keysetWalk,
} from './fetchers.js';
import { gamesTableRowSchema, parseGamesTableRows } from './wire.js';

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

// ---------------------------------------------------------------------------
// closing_lines enumeration — the market filter IS the completeness contract
// ---------------------------------------------------------------------------

/**
 * The whole-corpus audit and the totals dispersion snapshot share ONE walker,
 * and the only difference between them is this filter. That makes the filter
 * a completeness contract rather than a convenience: a whole-corpus walk that
 * silently narrowed to one market would still produce a perfectly
 * self-verifying dataset, because every count in the meta is derived from the
 * same fetch. The arithmetic cannot catch it — only this does.
 */
function stubFetch(pages: Record<string, unknown[][]>): {
  urls: string[];
  restore: () => void;
} {
  const urls: string[] = [];
  const original = globalThis.fetch;
  const counters = new Map<string, number>();
  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;
  globalThis.fetch = (async (input: FetchInput): Promise<FetchResponse> => {
    const url = String(input);
    urls.push(url);
    const key = Object.keys(pages).find((k) => url.includes(k)) ?? '';
    const list = pages[key] ?? [[]];
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    const body = list[index] ?? [];
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as FetchResponse;
  }) as typeof globalThis.fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

function closingWireRow(id: number, market: 'moneyline' | 'spread' | 'total'): Record<string, unknown> {
  return {
    id,
    network: 'polygon',
    jsonodds_id: `00000000-0000-4000-8000-00000000${String(id).padStart(4, '0')}`,
    market,
    line: market === 'moneyline' ? null : 8.5,
    away_odds_decimal: 1.9,
    home_odds_decimal: 1.9,
    away_p_novig: 0.5,
    home_p_novig: 0.5,
    value_captured_at: '2026-07-12T20:09:41+00:00',
    last_polled_at: '2026-07-12T20:09:41+00:00',
    lock_time: '2026-07-12T20:10:00+00:00',
    poll_gap_seconds: 19,
    confidence: 'fresh',
    source: 'jsonodds',
  };
}

test('fetchClosingLinesByMarket(null) issues NO market filter — the whole-corpus walk', async () => {
  const stub = stubFetch({
    closing_lines: [
      [closingWireRow(1, 'moneyline'), closingWireRow(2, 'spread'), closingWireRow(3, 'total')],
      [],
    ],
  });
  try {
    const rows = await fetchClosingLinesByMarket('https://db.example', 'anon-key', 'polygon', null);
    assert.equal(rows.length, 3, 'all three markets came back in one walk');
    assert.deepEqual(
      [...new Set(rows.map((r) => r.market))].sort(),
      ['moneyline', 'spread', 'total'],
    );
    assert.ok(stub.urls.length >= 1);
    for (const url of stub.urls) {
      assert.ok(!url.includes('market=eq.'), `no market filter in ${url}`);
      assert.ok(url.includes('network=eq.polygon'), 'the network filter is still applied');
      assert.ok(url.includes('order=id.asc'), 'keyset ordering on the identity PK');
      assert.ok(url.includes('lock_time'), 'the capture timestamps are selected');
      assert.ok(url.includes('poll_gap_seconds'), 'the poll gap is selected');
    }
  } finally {
    stub.restore();
  }
});

test('fetchClosingLinesByMarket narrows to exactly one market when asked', async () => {
  // NEGATIVE CONTROL for the test above: the filter is emitted when — and
  // only when — a market is supplied, for every market.
  for (const market of ['moneyline', 'spread', 'total'] as const) {
    const stub = stubFetch({ closing_lines: [[closingWireRow(1, market)], []] });
    try {
      const rows = await fetchClosingLinesByMarket('https://db.example', 'anon-key', 'polygon', market);
      assert.equal(rows.length, 1, market);
      for (const url of stub.urls) {
        assert.ok(url.includes(`&market=eq.${market}`), `${market}: filter present in ${url}`);
      }
    } finally {
      stub.restore();
    }
  }
});

test('fetchTotalsClosingLines is the totals-filtered case of the same walker', async () => {
  // The dispersion snapshot must keep its narrowing even though the walker
  // it now delegates to defaults to nothing.
  const stub = stubFetch({ closing_lines: [[closingWireRow(1, 'total')], []] });
  try {
    const rows = await fetchTotalsClosingLines('https://db.example', 'anon-key', 'polygon');
    assert.equal(rows.length, 1);
    assert.ok(stub.urls.every((url) => url.includes('&market=eq.total')));
  } finally {
    stub.restore();
  }
});

test('the closing-line walk continues past a short page — a whole-corpus audit cannot truncate', async () => {
  const stub = stubFetch({
    closing_lines: [
      [closingWireRow(1, 'total'), closingWireRow(2, 'moneyline')],
      [closingWireRow(3, 'spread')],
      [],
    ],
  });
  try {
    const rows = await fetchClosingLinesByMarket('https://db.example', 'anon-key', 'polygon', null);
    assert.equal(rows.length, 3, 'a short page is never end-of-data');
    assert.equal(stub.urls.length, 3, 'the walk ran to the empty page');
    assert.ok(stub.urls[1]?.includes('id=gt.2'), 'the second page resumes from the last id');
    assert.ok(stub.urls[2]?.includes('id=gt.3'));
  } finally {
    stub.restore();
  }
});

// ── canonical identity: both fetch paths filter AND verify ───────────────────

test('BOTH closing-line fetch paths filter on the canonical source', async () => {
  // The scoring path (fetchClosingLines) and the audit path
  // (fetchClosingLinesByMarket) are separate functions; the identity contract
  // has to hold on both, and only one of them was previously exercised here.
  const byMarket = stubFetch({ closing_lines: [[closingWireRow(1, 'total')], []] });
  try {
    await fetchClosingLinesByMarket('https://db.example', 'anon-key', 'polygon', null);
    assert.ok(
      byMarket.urls.every((u) => u.includes('source=eq.jsonodds')),
      `byMarket urls: ${byMarket.urls.join(' | ')}`,
    );
    assert.ok(byMarket.urls.every((u) => u.includes('network=eq.polygon')));
  } finally {
    byMarket.restore();
  }

  const byIds = stubFetch({ closing_lines: [[closingWireRow(1, 'total')]] });
  try {
    await fetchClosingLines('https://db.example', 'anon-key', 'polygon', [
      '00000000-0000-4000-8000-000000000001',
    ]);
    assert.ok(
      byIds.urls.every((u) => u.includes('source=eq.jsonodds')),
      `byIds urls: ${byIds.urls.join(' | ')}`,
    );
    assert.ok(byIds.urls.every((u) => u.includes('network=eq.polygon')));
  } finally {
    byIds.restore();
  }
});

test('a row the server returns in DEFIANCE of the filter is rejected, on both fetch paths', async () => {
  // The query filters server-side, but nothing verified the response honoured
  // it. Removing the filter and the check together left the suite green, so
  // the runtime guard was unpinned. These cases return a row that violates the
  // filter and assert the fetcher refuses rather than scoring another
  // network's book or another feed's prices.
  const cases = [
    { label: 'wrong network', patch: { network: 'amoy' }, pattern: /network "amoy"/ },
    { label: 'wrong source', patch: { source: 'rundown' }, pattern: /source "rundown"/ },
  ];
  for (const { label, patch, pattern } of cases) {
    const a = stubFetch({
      closing_lines: [[{ ...closingWireRow(1, 'total'), ...patch }], []],
    });
    try {
      await assert.rejects(
        () => fetchClosingLinesByMarket('https://db.example', 'anon-key', 'polygon', null),
        pattern,
        `fetchClosingLinesByMarket: ${label}`,
      );
    } finally {
      a.restore();
    }

    const b = stubFetch({ closing_lines: [[{ ...closingWireRow(1, 'total'), ...patch }]] });
    try {
      await assert.rejects(
        () =>
          fetchClosingLines('https://db.example', 'anon-key', 'polygon', [
            '00000000-0000-4000-8000-000000000001',
          ]),
        pattern,
        `fetchClosingLines: ${label}`,
      );
    } finally {
      b.restore();
    }
  }
});

test('NEGATIVE CONTROL: canonical rows pass both fetch paths untouched', async () => {
  const a = stubFetch({ closing_lines: [[closingWireRow(1, 'total')], []] });
  try {
    const rows = await fetchClosingLinesByMarket('https://db.example', 'anon-key', 'polygon', null);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.source, 'jsonodds');
  } finally {
    a.restore();
  }
  const b = stubFetch({ closing_lines: [[closingWireRow(1, 'total')]] });
  try {
    const rows = await fetchClosingLines('https://db.example', 'anon-key', 'polygon', [
      '00000000-0000-4000-8000-000000000001',
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.network, 'polygon');
  } finally {
    b.restore();
  }
});

test('a LOW id that commits after the cursor has passed it is MISSED — the walk is a lower bound', async () => {
  // Identity is allocated by a sequence BEFORE the inserting transaction
  // commits, and allocation order is not commit order. This models exactly
  // that: id 50 is allocated but still invisible while 51-53 commit and are
  // walked, then commits afterwards. Nothing on the public anon REST path can
  // close the gap — no transaction, no repeatable-read snapshot, no visibility
  // cursor — which is why the audit states a bound instead of claiming a
  // census.
  //
  // This test PINS A KNOWN LIMITATION. If it ever fails because the row is now
  // returned, the enumeration guarantee has changed and the artifact's
  // `enumerationSemantics` must be revisited rather than this test relaxed.
  const late: Row = { id: 50, name: 'row-50' };
  const early: Row[] = [51, 52, 53].map((id) => ({ id, name: `row-${id}` }));
  let served = 0;
  const fetchPage = async (afterId: number): Promise<Row[]> => {
    served += 1;
    const visible = served > 1 ? [late, ...early] : early;
    return visible.filter((row) => row.id > afterId).sort((a, b) => a.id - b.id);
  };

  const rows = await keysetWalk({ fetchPage, idOf: (row: Row) => row.id });
  assert.deepEqual(
    rows.map((r) => r.id),
    [51, 52, 53],
    'the cursor advanced past 50 before 50 became visible',
  );

  // ...and by the end it IS committed and visible, so this is a MISS rather
  // than an absence: a fresh walk from scratch now returns all four.
  const after = await fetchPage(0);
  assert.deepEqual(
    after.map((r) => r.id),
    [50, 51, 52, 53],
    'the delayed row is committed by the end of the walk',
  );
});

test('the games projection asks for exactly the columns the schema requires', () => {
  // THE FIXTURE BLIND SPOT THIS CLOSES. Every games-row test in this repo
  // constructs a `GamesTableRow` object directly, so none of them travel this
  // wire — dropping a column from the select is invisible to all of them and
  // would surface only as a production parse failure. Binding the projection
  // to the schema's own required keys makes either side going stale a test
  // failure here.
  const required = Object.keys(gamesTableRowSchema.shape).sort();
  const selected = GAMES_TABLE_SELECT.split(',').sort();
  assert.deepEqual(
    selected,
    required,
    'the PostgREST select and gamesTableRowSchema disagree about the games columns',
  );

  // Fail-closed, not fail-quiet: a row missing a required column is REFUSED at
  // parse rather than yielding an object with an undefined field.
  const { earliest_match_time: _dropped, ...withoutFloor } = {
    network: 'polygon',
    jsonodds_id: 'c0a2f8f0-0000-0000-0000-000000000001',
    sport: 'mlb',
    match_time: '2026-07-12T20:10:00+00:00',
    earliest_match_time: '2026-07-12T20:10:00+00:00',
    status: 'upcoming',
    home_score: null,
    away_score: null,
    final_type: null,
    score_captured: false,
  };
  assert.throws(() => parseGamesTableRows([withoutFloor]), /earliest_match_time/);
  // NEGATIVE CONTROLS: the complete row parses, and an explicit null floor is
  // a legitimate value rather than a missing one.
  assert.doesNotThrow(() =>
    parseGamesTableRows([{ ...withoutFloor, earliest_match_time: '2026-07-12T20:10:00+00:00' }]),
  );
  assert.doesNotThrow(() => parseGamesTableRows([{ ...withoutFloor, earliest_match_time: null }]));
});
