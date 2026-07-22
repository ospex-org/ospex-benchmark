import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cohortBoot } from './cohortBoot.js';
import { discover } from './lineOpenRead.js';
import { projectPreparedFires } from './lineOpenProject.js';
import { assertPreparedFireSnapshot } from './preparedFire.js';
import { checkPublication } from './manifestPublication.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { MODEL_PRICE_TABLE_DIGEST, MODEL_PRICE_TABLE_VERSION } from './modelPriceTable.js';
import { promptScaffoldSha256 } from './prompt.js';
import { REPAIR_POLICY_VERSION } from './repairPolicy.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import type { BootedCohort } from './cohortBoot.js';
import type { DiscoveryReads, DiscoverySnapshot, MarketEvidenceRead } from './lineOpenRead.js';
import type { CandidateOutcome } from './lineOpenProject.js';
import type { PublicationVerified } from './manifestPublication.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { PreparedFireSnapshot } from './preparedFire.js';
import type { CurrentOddsRow, GamesEndpointRow, MarketKey } from './types.js';

/**
 * The line-open prepare / reconcile / order / seal projector. Every test drives real
 * code end to end: a genuine `cohortBoot` cohort, a genuine `checkPublication` record,
 * a genuine branded `discover` snapshot, and the real detection / reconciliation / seal.
 * MLB's market policy enables moneyline + total; the run line (`spread`) is OFF.
 */

// --- aligned time constants -------------------------------------------------

const WINDOW_START = '2026-07-18T00:00:00.000Z';
const WINDOW_END = '2026-07-19T00:00:00.000Z';
const COMMITTER_TS = '2026-07-17T23:00:00+00:00'; // strictly before windowStart
const DISCO_MS = Date.parse('2026-07-18T12:00:00.000Z'); // discovery fetchCompletedAt
const DETECT_MS = DISCO_MS + 5_000; // detection instant (delta 5 s, fresh)
const OPENER_AT = '2026-07-18T11:59:05.000Z'; // 60 s before detection; in window
const QUOTE_AT = '2026-07-18T11:59:00+00:00'; // current_odds upstream_last_updated (fresh at disco)
const MATCH_TIME = '2026-07-18T20:00:00+00:00'; // first pitch (ET slate day 2026-07-18)

const CODE_ARMS = defaultExpectedArms();

// --- manifest / boot / publication ------------------------------------------

function manifestObject(over: {
  network?: string | undefined;
  constants?: Record<string, number> | undefined;
} = {}): Record<string, unknown> {
  return {
    artifactSchemaVersion: 1,
    network: over.network ?? 'polygon',
    sportAllowList: ['mlb'],
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    source: 'jsonodds',
    sourceQueryVersion: 'source-query-v1',
    marketPolicyVersion: MARKET_POLICY_VERSION,
    marketPolicyDigest: MARKET_POLICY_DIGEST,
    promptScaffoldSha256: promptScaffoldSha256(),
    expectedArmRoster: CODE_ARMS.map((a) => ({
      participantId: a.participantId,
      provider: a.provider,
      requestedModelId: a.requestedModelId,
      approvedReportedModelIds: [...a.approvedReportedModelIds],
    })),
    toolInferenceConfigSha256: 'c'.repeat(64),
    baselinePolicyVersion: 'baselines-v0.3.0',
    repairPolicyVersion: REPAIR_POLICY_VERSION,
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: MODEL_PRICE_TABLE_VERSION,
    modelPriceTableDigest: MODEL_PRICE_TABLE_DIGEST,
    spendReservationPolicyVersion: 'fixed-attempt-v1',
    runnerCommitSha: 'e'.repeat(40),
    constants: {
      pollIntervalMs: 30_000,
      cleanEntryWindowMs: 120_000,
      gameDiscoveryWindowHours: 168,
      maxClockSkewMs: 5_000,
      freshFireMs: 30_000,
      maxDispatchLagMs: 10_000,
      historyReadTimeoutMs: 30_000,
      providerCallTimeoutMs: 300_000,
      maxOutputTokens: 16_000,
      maxRepairAttemptsPerArm: 1,
      providerAttemptReservationUsdMicros: 100_000_000,
      ingestionGraceMs: 900_000,
      scheduleChangeToleranceMs: 60_000,
      maxConcurrentProviderRequests: Math.max(8, CODE_ARMS.length),
      maxDispatchesPerTick: 8,
      ...over.constants,
    },
    cohortCallCap: 1_000,
    cohortSpendCapUsdMicros: 1_000_000,
  };
}

function manifestJson(over?: { network?: string | undefined; constants?: Record<string, number> | undefined }): string {
  return JSON.stringify(manifestObject(over));
}

function bootFrom(json: string): BootedCohort {
  return cohortBoot({ live: false, manifestBytes: json });
}

function publicationFor(json: string): PublicationVerified {
  const bytes = new TextEncoder().encode(json);
  return checkPublication({
    localManifestBytes: bytes,
    publication: {
      repositoryOwner: 'ospex-org',
      repositoryName: 'ospex-benchmark',
      path: 'manifests/cohort.json',
      commitSha: 'a'.repeat(40),
    },
    resolved: { blobBytes: bytes, committerTimestamp: COMMITTER_TS },
  });
}

// --- read-path row fixtures -------------------------------------------------

function makeGame(over: Partial<GamesEndpointRow> = {}): GamesEndpointRow {
  const gameId = over.gameId ?? 'g1';
  return {
    gameId,
    slug: `slug-${gameId}`,
    sport: 'mlb',
    matchTime: MATCH_TIME,
    status: 'upcoming',
    homeTeam: { name: 'Home Nine', abbreviation: 'HOM' },
    awayTeam: { name: 'Away Nine', abbreviation: 'AWY' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: true,
    externalIds: { jsonodds: gameId, sportspage: null, rundown: null },
    ...over,
  };
}

/** A current_odds row. Moneyline defaults are -120 / 110; total / spread callers
 *  pass their own `line` + prices. Quote fields MATCH `makeHistory` so a fresh,
 *  eligible candidate reconciles unless a test deliberately drifts the current row. */
function makeOdds(over: Partial<CurrentOddsRow> = {}): CurrentOddsRow {
  return {
    network: 'polygon',
    jsonodds_id: 'g1',
    market: 'moneyline',
    line: null,
    away_odds_american: -120,
    home_odds_american: 110,
    upstream_last_updated: QUOTE_AT,
    poll_captured_at: QUOTE_AT,
    changed_at: QUOTE_AT,
    ...over,
  };
}

/** A two-sided history row whose quote matches `makeOdds` for the same market. */
function makeHistory(gameId: string, market: MarketKey, over: Partial<TwoSidedHistoryRow> = {}): TwoSidedHistoryRow {
  const quote =
    market === 'moneyline'
      ? { line: null, away_odds_american: -120, away_odds_decimal: 1.83333, home_odds_american: 110, home_odds_decimal: 2.1 }
      : market === 'total'
        ? { line: 8.5, away_odds_american: -115, away_odds_decimal: 1.86957, home_odds_american: -105, home_odds_decimal: 1.95238 }
        : { line: -1.5, away_odds_american: -110, away_odds_decimal: 1.90909, home_odds_american: -110, home_odds_decimal: 1.90909 };
  const captured_at = over.captured_at ?? OPENER_AT;
  return {
    id: 1,
    jsonodds_id: gameId,
    market,
    source: 'jsonodds',
    ...quote,
    ...over,
    captured_at,
    captured_at_ms: over.captured_at_ms ?? Date.parse(captured_at),
  };
}

function makeEvidence(
  gameId: string,
  market: MarketKey,
  rows: readonly TwoSidedHistoryRow[],
  watermark: number | null = null,
): MarketEvidenceRead {
  return { gameId, market, historyRows: rows, historyWatermark: watermark, readCompletedAt: '2026-07-18T12:00:01.000Z' };
}

function evidenceMap(entries: Array<[string, MarketEvidenceRead]>): Map<string, MarketEvidenceRead> {
  return new Map(entries);
}

/** Discovery deps that read the supplied games (filtered by sport) and odds. */
function discoveryReads(games: GamesEndpointRow[], odds: CurrentOddsRow[], nowMs = DISCO_MS): DiscoveryReads {
  return {
    readGames: async (sport) => games.filter((g) => g.sport === sport),
    readCurrentOdds: async () => odds,
    now: () => nowMs,
  };
}

/** Discovery deps that return the supplied games regardless of sport — used to let a
 *  wrong-case sport (`MLB`) reach the projector's sport join. */
function discoveryReadsRaw(games: GamesEndpointRow[], odds: CurrentOddsRow[], nowMs = DISCO_MS): DiscoveryReads {
  return {
    readGames: async () => games,
    readCurrentOdds: async () => odds,
    now: () => nowMs,
  };
}

/** A stateful injected clock returning a fixed sequence (repeating the last value
 *  once exhausted), counting reads. */
function seqClock(values: readonly number[]): { now: () => number; reads: () => number } {
  let i = 0;
  return {
    now: () => {
      const v = values[Math.min(i, values.length - 1)];
      i += 1;
      if (v === undefined) throw new Error('seqClock has no values');
      return v;
    },
    reads: () => i,
  };
}

async function baseSetup(
  games: GamesEndpointRow[],
  odds: CurrentOddsRow[],
  opts: { network?: string | undefined; constants?: Record<string, number> | undefined; discoMs?: number | undefined } = {},
): Promise<{ booted: BootedCohort; publication: PublicationVerified; discovery: DiscoverySnapshot }> {
  const json = manifestJson({ network: opts.network, constants: opts.constants });
  const booted = bootFrom(json);
  const publication = publicationFor(json);
  const discovery = await discover(booted, discoveryReads(games, odds, opts.discoMs));
  return { booted, publication, discovery };
}

const ISO = (ms: number): string => new Date(ms).toISOString();

// ===========================================================================
// happy path — the single-market seal
// ===========================================================================

test('projects a single-market prepared fire for an eligible, fresh, reconciled candidate', async () => {
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })]);
  const evidence = evidenceMap([['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])]]);
  const { fires, dispositions } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS, DETECT_MS + 1_000]).now });

  assert.equal(fires.length, 1);
  const fire = fires[0]!;
  assert.doesNotThrow(() => assertPreparedFireSnapshot(fire));
  assert.deepEqual([...fire.proposedMarkets], ['moneyline']);
  assert.equal(fire.perMarket.length, 1);
  assert.equal(fire.perMarket[0]!.market, 'moneyline');
  assert.equal(fire.detectedAt, ISO(DETECT_MS));
  assert.deepEqual(dispositions.map((d) => ({ ...d })), [{ gameId: 'g1', market: 'moneyline', outcome: 'prepared' }]);
});

// ===========================================================================
// candidate input is the full manifest-derived shape
// ===========================================================================

test('candidate input is the full manifest-derived shape', async () => {
  // Distinctive (non-default) window constants so a hard-coded operand would fail.
  const constants = { cleanEntryWindowMs: 90_000, maxClockSkewMs: 7_000 };
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })], { constants });
  const evidence = evidenceMap([['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])]]);
  const { fires } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS, DETECT_MS + 1_000]).now });

  const ci = fires[0]!.perMarket[0]!.candidateInput;
  assert.equal(ci.windowStart, booted.manifest.windowStart);
  assert.equal(ci.windowEnd, booted.manifest.windowEnd);
  assert.equal(ci.cleanEntryWindowMs, 90_000);
  assert.equal(ci.maxClockSkewMs, 7_000);
  assert.deepEqual([...ci.sportAllowList], [...booted.manifest.sportAllowList]);
  assert.equal(ci.marketPolicyVersion, booted.manifest.marketPolicyVersion);
  assert.equal(ci.detectedAt, ISO(DETECT_MS));
});

// ===========================================================================
// sport joined from the game row, case-exact
// ===========================================================================

test('candidate sport is joined from the game row, case-exact', async () => {
  const json = manifestJson();
  const booted = bootFrom(json);
  const publication = publicationFor(json);
  // A wrong-case sport ('MLB') reaches the projector via the raw reads.
  const discovery = await discover(booted, discoveryReadsRaw([makeGame({ gameId: 'g1', sport: 'MLB' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })]));
  const evidence = evidenceMap([['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])]]);
  const { fires, dispositions } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS]).now });

  assert.equal(fires.length, 0);
  assert.deepEqual(dispositions.map((d) => ({ ...d })), [{ gameId: 'g1', market: 'moneyline', outcome: 'reject', reason: 'not_enabled' }]);
});

// ===========================================================================
// a policy-disabled market is rejected and its sibling still processed
// ===========================================================================

test('a policy-disabled market is rejected and its sibling still processed', async () => {
  const odds = [
    makeOdds({ jsonodds_id: 'g1', market: 'moneyline' }),
    makeOdds({ jsonodds_id: 'g1', market: 'spread', line: -1.5, away_odds_american: -110, home_odds_american: -110 }),
  ];
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], odds);
  const evidence = evidenceMap([
    ['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])],
    ['g1::spread', makeEvidence('g1', 'spread', [makeHistory('g1', 'spread')])],
  ]);
  const { fires, dispositions } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS, DETECT_MS + 1_000]).now });

  assert.equal(fires.length, 1);
  assert.equal(fires[0]!.perMarket[0]!.market, 'moneyline');
  const byMarket = new Map(dispositions.map((d) => [d.market, { ...d }]));
  assert.equal(byMarket.get('moneyline')!.outcome, 'prepared');
  assert.deepEqual(byMarket.get('spread'), { gameId: 'g1', market: 'spread', outcome: 'reject', reason: 'not_enabled' });
});

// ===========================================================================
// an invisible opener defers
// ===========================================================================

test('an invisible opener defers the candidate', async () => {
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })]);
  const evidence = evidenceMap([['g1::moneyline', makeEvidence('g1', 'moneyline', [])]]);
  const { fires, dispositions } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS]).now });

  assert.equal(fires.length, 0);
  assert.deepEqual(dispositions.map((d) => ({ ...d })), [{ gameId: 'g1', market: 'moneyline', outcome: 'defer', reason: 'opener_not_visible' }]);
});

// ===========================================================================
// all candidates share the one invocation detection instant
// ===========================================================================

test('all candidates share the one invocation detection instant', async () => {
  const games = [makeGame({ gameId: 'g1' }), makeGame({ gameId: 'g2' })];
  const odds = [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' }), makeOdds({ jsonodds_id: 'g2', market: 'moneyline' })];
  const { booted, publication, discovery } = await baseSetup(games, odds);
  const evidence = evidenceMap([
    ['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])],
    ['g2::moneyline', makeEvidence('g2', 'moneyline', [makeHistory('g2', 'moneyline')])],
  ]);
  const { fires } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS, DETECT_MS + 1_000, DETECT_MS + 2_000]).now });

  assert.equal(fires.length, 2);
  const detected = ISO(DETECT_MS);
  for (const f of fires) assert.equal(f.perMarket[0]!.candidateInput.detectedAt, detected);
  for (const f of fires) assert.equal(f.detectedAt, detected);
});

// ===========================================================================
// the freshness gate throws on a regressed clock and seals at delta zero
// ===========================================================================

test('the freshness gate throws on a regressed clock and seals at delta zero', async () => {
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })]);
  const evidence = evidenceMap([['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])]]);

  // delta < 0 — detection precedes discovery completion → throw (zero-fire path).
  assert.throws(
    () => projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DISCO_MS - 1]).now }),
    /precedes discovery completion/,
  );
  // delta == 0 — detection exactly at discovery completion → fresh, seals.
  const { fires } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DISCO_MS, DISCO_MS + 1_000]).now });
  assert.equal(fires.length, 1);
  assert.equal(fires[0]!.detectedAt, ISO(DISCO_MS));
});

// ===========================================================================
// a stale snapshot defers otherwise-eligible candidates and seals nothing
// ===========================================================================

test('a stale snapshot defers otherwise-eligible candidates and seals nothing', async () => {
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })]);
  const evidence = evidenceMap([['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])]]);
  const freshFireMs = booted.manifest.constants.freshFireMs;

  // delta == freshFireMs — the inclusive boundary is fresh → seals.
  const atBoundary = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DISCO_MS + freshFireMs, DISCO_MS + freshFireMs + 1_000]).now });
  assert.equal(atBoundary.fires.length, 1);

  // delta == freshFireMs + 1 — one past the boundary is stale → defer, no fire.
  const stale = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DISCO_MS + freshFireMs + 1]).now });
  assert.equal(stale.fires.length, 0);
  assert.deepEqual(stale.dispositions.map((d) => ({ ...d })), [{ gameId: 'g1', market: 'moneyline', outcome: 'defer', reason: 'snapshot_stale' }]);
});

// ===========================================================================
// stable candidate truth precedes snapshot_stale
// ===========================================================================

test('stable candidate truth precedes snapshot_stale', async () => {
  const odds = [
    makeOdds({ jsonodds_id: 'g1', market: 'moneyline' }),
    makeOdds({ jsonodds_id: 'g1', market: 'spread', line: -1.5, away_odds_american: -110, home_odds_american: -110 }),
  ];
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], odds);
  const evidence = evidenceMap([
    ['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])],
    ['g1::spread', makeEvidence('g1', 'spread', [makeHistory('g1', 'spread')])],
  ]);
  const freshFireMs = booted.manifest.constants.freshFireMs;
  const { fires, dispositions } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DISCO_MS + freshFireMs + 1]).now });

  assert.equal(fires.length, 0);
  const byMarket = new Map(dispositions.map((d) => [d.market, { ...d }]));
  // The disabled market stays a terminal reject even though the snapshot is stale.
  assert.deepEqual(byMarket.get('spread'), { gameId: 'g1', market: 'spread', outcome: 'reject', reason: 'not_enabled' });
  assert.deepEqual(byMarket.get('moneyline'), { gameId: 'g1', market: 'moneyline', outcome: 'defer', reason: 'snapshot_stale' });
});

// ===========================================================================
// a crossed genuine discovery/cohort root fails at entry
// ===========================================================================

test('a crossed genuine discovery/cohort root fails at entry', async () => {
  const jsonA = manifestJson({ network: 'polygon' });
  const jsonB = manifestJson({ network: 'polygon-amoy' });
  const bootedA = bootFrom(jsonA);
  const bootedB = bootFrom(jsonB);
  const publicationA = publicationFor(jsonA);
  const publicationB = publicationFor(jsonB);

  // Discovery produced for cohort A + booted B → throws even with ZERO candidates.
  const discoveryEmptyA = await discover(bootedA, discoveryReads([makeGame({ gameId: 'g1' })], []));
  assert.equal(discoveryEmptyA.candidates.length, 0);
  assert.throws(
    () => projectPreparedFires({ discovery: discoveryEmptyA, booted: bootedB, publication: publicationB, evidence: new Map(), now: seqClock([DETECT_MS]).now }),
    /different cohort/,
  );
  // A publication verified for a DIFFERENT cohort is rejected too.
  assert.throws(
    () => projectPreparedFires({ discovery: discoveryEmptyA, booted: bootedA, publication: publicationB, evidence: new Map(), now: seqClock([DETECT_MS]).now }),
    /not this cohort/,
  );
  void publicationA;
});

// ===========================================================================
// pair-misbound evidence throws; an empty correctly-bound read defers
// ===========================================================================

test('a pair-misbound evidence entry fails, an empty correctly-bound read defers', async () => {
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })]);

  // Keyed correctly, but the VALUE's gameId disagrees with the candidate.
  const misbound = evidenceMap([['g1::moneyline', makeEvidence('OTHER', 'moneyline', [makeHistory('g1', 'moneyline')])]]);
  assert.throws(
    () => projectPreparedFires({ discovery, booted, publication, evidence: misbound, now: seqClock([DETECT_MS]).now }),
    /does not bind to candidate/,
  );
  // An empty correctly-bound read → opener_not_visible defer.
  const empty = evidenceMap([['g1::moneyline', makeEvidence('g1', 'moneyline', [])]]);
  const { fires, dispositions } = projectPreparedFires({ discovery, booted, publication, evidence: empty, now: seqClock([DETECT_MS]).now });
  assert.equal(fires.length, 0);
  assert.deepEqual(dispositions.map((d) => ({ ...d })), [{ gameId: 'g1', market: 'moneyline', outcome: 'defer', reason: 'opener_not_visible' }]);
});

// ===========================================================================
// a missing evidence entry fails closed
// ===========================================================================

test('a missing evidence entry fails closed', async () => {
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })]);
  assert.throws(
    () => projectPreparedFires({ discovery, booted, publication, evidence: new Map(), now: seqClock([DETECT_MS]).now }),
    /no market evidence supplied/,
  );
});

// ===========================================================================
// the evidence relation is captured before the clock can mutate the source
// ===========================================================================

test('the evidence relation is captured before the clock can mutate the source', async () => {
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })]);
  const sourceRows = [makeHistory('g1', 'moneyline')];
  const sourceRead: MarketEvidenceRead = { gameId: 'g1', market: 'moneyline', historyRows: sourceRows, historyWatermark: null, readCompletedAt: '2026-07-18T12:00:01.000Z' };
  const evidence = new Map<string, MarketEvidenceRead>([['g1::moneyline', sourceRead]]);

  let attacked = false;
  const clock = (): number => {
    if (!attacked) {
      attacked = true;
      // On the FIRST (detection) read — after capture — attack every source form.
      evidence.delete('g1::moneyline');
      (sourceRead as { gameId: string }).gameId = 'HACK';
      (sourceRead as { market: MarketKey }).market = 'total';
      (sourceRead as { historyRows: readonly TwoSidedHistoryRow[] }).historyRows = [makeHistory('HACK', 'total', { away_odds_american: 999, home_odds_american: 888 })];
      sourceRows[0]!.away_odds_american = 424_242;
    }
    return DETECT_MS;
  };
  const { fires } = projectPreparedFires({ discovery, booted, publication, evidence, now: clock });

  // The detached pre-clock snapshot was used — the sealed history is the ORIGINAL.
  assert.equal(fires.length, 1);
  const rows = fires[0]!.perMarket[0]!.historyRows;
  assert.equal(rows[0]!.away_odds_american, -120, 'sealed history used the pre-clock capture');
  assert.equal(rows[0]!.jsonodds_id, 'g1');
});

// ===========================================================================
// bundle assembled at the discovery instant, not a fresh clock
// ===========================================================================

test('the sealed bundle is assembled at the discovery instant, not a fresh clock', async () => {
  // Retained quote is fresh at fetchCompletedAt (25 min old) but would be STALE (>30 min)
  // if the bundle were assembled at a much-later per-fire clock read.
  const quoteAt = ISO(DISCO_MS - 25 * 60 * 1000);
  const odds = [makeOdds({ jsonodds_id: 'g1', market: 'moneyline', upstream_last_updated: quoteAt })];
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], odds);
  const evidence = evidenceMap([['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])]]);
  const farLater = DISCO_MS + 20 * 60 * 1000; // +20 min; would make the quote 45 min old if misused

  const { fires } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DISCO_MS, farLater]).now });
  assert.equal(fires.length, 1, 'built at the discovery instant despite a far-later per-fire clock');
  assert.equal(fires[0]!.prepared.requestBundle.bundleTimestamp, discovery.fetchCompletedAt);
});

// ===========================================================================
// the bundle is built from the exact retained row selected by pair key
// ===========================================================================

test('the bundle is built from the exact retained row selected by pair key', async () => {
  const odds = [
    makeOdds({ jsonodds_id: 'g1', market: 'total', line: 8.5, away_odds_american: -115, home_odds_american: -105 }),
    makeOdds({ jsonodds_id: 'g1', market: 'moneyline', away_odds_american: -120, home_odds_american: 110 }),
  ];
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], odds);
  const evidence = evidenceMap([
    ['g1::total', makeEvidence('g1', 'total', [makeHistory('g1', 'total')])],
    ['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])],
  ]);
  const { fires } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS, DETECT_MS + 1_000, DETECT_MS + 2_000]).now });
  const byMarket = new Map(fires.map((f) => [f.proposedMarkets[0]!, f]));

  const totalBundle = byMarket.get('total')!.prepared.requestBundle.games[0]!;
  assert.ok(totalBundle.markets.total);
  assert.equal(totalBundle.markets.total!.line, 8.5);
  assert.equal(totalBundle.markets.moneyline, undefined, 'the total fire carries only its own market');

  const mlBundle = byMarket.get('moneyline')!.prepared.requestBundle.games[0]!;
  assert.ok(mlBundle.markets.moneyline);
  assert.equal(mlBundle.markets.total, undefined, 'the moneyline fire carries only its own market');
});

// ===========================================================================
// each single-market fire proposes exactly its accepted market
// ===========================================================================

test('each single-market fire proposes exactly its accepted market', async () => {
  const games = [makeGame({ gameId: 'g1' }), makeGame({ gameId: 'g2' })];
  const odds = [
    makeOdds({ jsonodds_id: 'g1', market: 'moneyline' }), // reconciles
    makeOdds({ jsonodds_id: 'g2', market: 'moneyline', away_odds_american: -140 }), // drifted from history
  ];
  const { booted, publication, discovery } = await baseSetup(games, odds);
  const evidence = evidenceMap([
    ['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])],
    ['g2::moneyline', makeEvidence('g2', 'moneyline', [makeHistory('g2', 'moneyline')])],
  ]);
  const { fires, dispositions } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS, DETECT_MS + 1_000]).now });

  assert.equal(fires.length, 1);
  const fire = fires[0]!;
  assert.deepEqual([...fire.proposedMarkets], ['moneyline']);
  assert.ok(fire.prepared.requestBundle.games[0]!.markets.moneyline, 'bundle present-scope == proposed');
  const byGame = new Map(dispositions.map((d) => [d.gameId, { ...d }]));
  assert.equal(byGame.get('g1')!.outcome, 'prepared');
  assert.deepEqual(byGame.get('g2'), { gameId: 'g2', market: 'moneyline', outcome: 'defer', reason: 'quote_moved' });
});

// ===========================================================================
// each per-market entry carries the full history bound to its pair
// ===========================================================================

test('each per-market entry carries the full history bound to its pair', async () => {
  // Two same-quote rows so the as-of matches the current row whichever is latest; the
  // seal must retain BOTH (the full history), not just the opener.
  const rows = [
    makeHistory('g1', 'moneyline', { id: 1, captured_at: '2026-07-18T11:59:00.000Z' }),
    makeHistory('g1', 'moneyline', { id: 2, captured_at: '2026-07-18T11:59:05.000Z' }),
  ];
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })]);
  const evidence = evidenceMap([['g1::moneyline', makeEvidence('g1', 'moneyline', rows)]]);
  const { fires } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS, DETECT_MS + 1_000]).now });

  const perMarket = fires[0]!.perMarket[0]!;
  assert.equal(perMarket.historyRows.length, 2, 'the FULL history reached the seal');
  for (const r of perMarket.historyRows) {
    assert.equal(r.jsonodds_id, 'g1');
    assert.equal(r.market, 'moneyline');
  }
  assert.equal(perMarket.candidateInput.detectedAt, ISO(DETECT_MS));
});

// ===========================================================================
// slug and slate day are sourced from the game row; empty slug falls back
// ===========================================================================

test('slug and slate day are sourced from the game row, empty slug falls back', async () => {
  // A 9:40pm ET game on Jul 18 that starts at 01:40 UTC Jul 19 — the slate day is the
  // ET day (2026-07-18), never the UTC prefix.
  const matchTime = '2026-07-19T01:40:00+00:00';
  const withSlug = await baseSetup([makeGame({ gameId: 'g1', slug: 'mil-pit', matchTime })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })]);
  const ev1 = evidenceMap([['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])]]);
  const r1 = projectPreparedFires({ discovery: withSlug.discovery, booted: withSlug.booted, publication: withSlug.publication, evidence: ev1, now: seqClock([DETECT_MS, DETECT_MS + 1_000]).now });
  assert.equal(r1.fires[0]!.prepared.slug, 'mil-pit');
  assert.equal(r1.fires[0]!.prepared.requestBundle.slateDate, '2026-07-18');

  // Empty slug falls back to the gameId.
  const emptySlug = await baseSetup([makeGame({ gameId: 'g2', slug: '', matchTime })], [makeOdds({ jsonodds_id: 'g2', market: 'moneyline' })]);
  const ev2 = evidenceMap([['g2::moneyline', makeEvidence('g2', 'moneyline', [makeHistory('g2', 'moneyline')])]]);
  const r2 = projectPreparedFires({ discovery: emptySlug.discovery, booted: emptySlug.booted, publication: emptySlug.publication, evidence: ev2, now: seqClock([DETECT_MS, DETECT_MS + 1_000]).now });
  assert.equal(r2.fires[0]!.prepared.slug, 'g2');
});

// ===========================================================================
// the bundle-built instant is the exact injected value; equality accepted
// ===========================================================================

test('the bundle-built instant is the exact injected value and same-ms equality is accepted', async () => {
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })]);
  const evidence = evidenceMap([['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])]]);

  // (a) A distinctive LATER value proves a fresh bundle clock read is used.
  const laterMs = DETECT_MS + 7_777;
  const later = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS, laterMs]).now });
  assert.equal(later.fires[0]!.bundleBuiltAt, ISO(laterMs));
  assert.notEqual(later.fires[0]!.bundleBuiltAt, later.fires[0]!.detectedAt);

  // (b) An EQUAL value proves same-millisecond equality is accepted (not a fault).
  const equal = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS, DETECT_MS]).now });
  assert.equal(equal.fires.length, 1);
  assert.equal(equal.fires[0]!.bundleBuiltAt, ISO(DETECT_MS));
  assert.equal(equal.fires[0]!.bundleBuiltAt, equal.fires[0]!.detectedAt);
});

// ===========================================================================
// prepared fires are ordered by their own candidate key
// ===========================================================================

test('prepared fires are ordered by their own candidate key', async () => {
  // gameId order (g-aaa < g-bbb) DISAGREES with opener order (g-bbb's opener is earlier).
  const games = [makeGame({ gameId: 'g-aaa' }), makeGame({ gameId: 'g-bbb' })];
  const odds = [
    makeOdds({ jsonodds_id: 'g-aaa', market: 'moneyline' }),
    makeOdds({ jsonodds_id: 'g-aaa', market: 'spread', line: -1.5, away_odds_american: -110, home_odds_american: -110 }), // rejected sibling
    makeOdds({ jsonodds_id: 'g-bbb', market: 'moneyline' }),
  ];
  const { booted, publication, discovery } = await baseSetup(games, odds);
  const evidence = evidenceMap([
    ['g-aaa::moneyline', makeEvidence('g-aaa', 'moneyline', [makeHistory('g-aaa', 'moneyline', { id: 5, captured_at: '2026-07-18T11:59:40.000Z' })])], // later opener
    ['g-aaa::spread', makeEvidence('g-aaa', 'spread', [makeHistory('g-aaa', 'spread')])],
    ['g-bbb::moneyline', makeEvidence('g-bbb', 'moneyline', [makeHistory('g-bbb', 'moneyline', { id: 9, captured_at: '2026-07-18T11:59:00.000Z' })])], // earlier opener
  ]);
  const { fires } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS, DETECT_MS + 1_000, DETECT_MS + 2_000]).now });

  assert.equal(fires.length, 2);
  // Ordered by opener captured_at_ms: g-bbb (earlier opener) FIRST, though its gameId is larger.
  // The rejected spread sibling consumed no per-fire clock and did not shift the order.
  assert.deepEqual(fires.map((f) => f.perMarket[0]!.candidateInput.gameId), ['g-bbb', 'g-aaa']);
});

// ===========================================================================
// every discovered candidate appears once with a discriminated outcome
// ===========================================================================

test('every discovered candidate appears once with a discriminated outcome', async () => {
  const games = [makeGame({ gameId: 'g1' }), makeGame({ gameId: 'g2' }), makeGame({ gameId: 'g3' })];
  const odds = [
    makeOdds({ jsonodds_id: 'g1', market: 'moneyline' }), // prepared
    makeOdds({ jsonodds_id: 'g2', market: 'moneyline', away_odds_american: -140 }), // quote_moved
    makeOdds({ jsonodds_id: 'g1', market: 'spread', line: -1.5, away_odds_american: -110, home_odds_american: -110 }), // not_enabled
    makeOdds({ jsonodds_id: 'g3', market: 'moneyline' }), // opener_not_visible
  ];
  const { booted, publication, discovery } = await baseSetup(games, odds);
  const evidence = evidenceMap([
    ['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])],
    ['g2::moneyline', makeEvidence('g2', 'moneyline', [makeHistory('g2', 'moneyline')])],
    ['g1::spread', makeEvidence('g1', 'spread', [makeHistory('g1', 'spread')])],
    ['g3::moneyline', makeEvidence('g3', 'moneyline', [])],
  ]);
  const { dispositions } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS, DETECT_MS + 1_000]).now });

  assert.equal(dispositions.length, discovery.candidates.length);
  const keys = dispositions.map((d) => `${d.gameId}::${d.market}`);
  assert.equal(new Set(keys).size, keys.length, 'exactly one disposition per pair');

  const by = new Map(dispositions.map((d) => [`${d.gameId}::${d.market}`, d]));
  const g1ml = by.get('g1::moneyline')!;
  assert.equal(g1ml.outcome, 'prepared');
  assert.equal('reason' in g1ml, false);
  const g2ml = by.get('g2::moneyline')!;
  assert.equal(g2ml.outcome === 'defer' ? g2ml.reason : null, 'quote_moved');
  const g1sp = by.get('g1::spread')!;
  assert.equal(g1sp.outcome === 'reject' ? g1sp.reason : null, 'not_enabled');
  const g3ml = by.get('g3::moneyline')!;
  assert.equal(g3ml.outcome === 'defer' ? g3ml.reason : null, 'opener_not_visible');
});

// ===========================================================================
// only fresh eligible candidates are reconciled or sealed
// ===========================================================================

test('only fresh eligible candidates are reconciled or sealed', async () => {
  // A not_enabled candidate whose current quote WOULD reconcile (matches its as-of) is
  // still excluded — reconciliation never runs for a non-eligible candidate.
  const odds = [makeOdds({ jsonodds_id: 'g1', market: 'spread', line: -1.5, away_odds_american: -110, home_odds_american: -110 })];
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], odds);
  const evidence = evidenceMap([['g1::spread', makeEvidence('g1', 'spread', [makeHistory('g1', 'spread', { line: -1.5, away_odds_american: -110, home_odds_american: -110 })])]]);
  const { fires, dispositions } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS]).now });

  assert.equal(fires.length, 0);
  assert.deepEqual(dispositions.map((d) => ({ ...d })), [{ gameId: 'g1', market: 'spread', outcome: 'reject', reason: 'not_enabled' }]);
});

// ===========================================================================
// the projection output and every disposition are frozen and detached
// ===========================================================================

test('the projection output and every disposition are frozen and detached', async () => {
  const games = [makeGame({ gameId: 'g1' }), makeGame({ gameId: 'g2' })];
  const odds = [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' }), makeOdds({ jsonodds_id: 'g2', market: 'moneyline', away_odds_american: -140 })];
  const { booted, publication, discovery } = await baseSetup(games, odds);
  const evidence = evidenceMap([
    ['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])],
    ['g2::moneyline', makeEvidence('g2', 'moneyline', [makeHistory('g2', 'moneyline')])],
  ]);
  const { fires, dispositions } = projectPreparedFires({ discovery, booted, publication, evidence, now: seqClock([DETECT_MS, DETECT_MS + 1_000]).now });

  assert.ok(Object.isFrozen(fires));
  assert.ok(Object.isFrozen(dispositions));
  for (const d of dispositions) assert.ok(Object.isFrozen(d));
  assert.throws(() => (fires as PreparedFireSnapshot[]).push(fires[0]!));
  assert.throws(() => (dispositions as CandidateOutcome[]).push(dispositions[0]!));

  // Detached — mutating a source input after projection leaves the output unchanged.
  const g1fire = fires.find((f) => f.perMarket[0]!.candidateInput.gameId === 'g1')!;
  const before = g1fire.perMarket[0]!.historyRows[0]!.away_odds_american;
  (evidence.get('g1::moneyline')!.historyRows[0] as { away_odds_american: number }).away_odds_american = 314_159;
  assert.equal(g1fire.perMarket[0]!.historyRows[0]!.away_odds_american, before);
});

// ===========================================================================
// projection is pure and uses only the injected clock
// ===========================================================================

test('projection is pure and uses only the injected clock', async () => {
  const { booted, publication, discovery } = await baseSetup([makeGame({ gameId: 'g1' })], [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })]);
  const evidence = evidenceMap([['g1::moneyline', makeEvidence('g1', 'moneyline', [makeHistory('g1', 'moneyline')])]]);
  const clock = seqClock([DETECT_MS, DETECT_MS + 500]);
  const result = projectPreparedFires({ discovery, booted, publication, evidence, now: clock.now });

  // Synchronous (not a promise), and the injected clock is the sole time source.
  assert.equal(typeof (result as { then?: unknown }).then, 'undefined');
  assert.equal(result.fires[0]!.detectedAt, ISO(DETECT_MS));
  // Exactly two clock reads: one detection + one per fire.
  assert.equal(clock.reads(), 2);
});

// ===========================================================================
// the output is permutation-invariant across reversed discovery input order
// ===========================================================================

test('the output is permutation-invariant across reversed discovery input order', async () => {
  const games = [makeGame({ gameId: 'g-aaa' }), makeGame({ gameId: 'g-bbb' })];
  const oddsAB = [makeOdds({ jsonodds_id: 'g-aaa', market: 'moneyline' }), makeOdds({ jsonodds_id: 'g-bbb', market: 'moneyline' })];
  const oddsBA = [makeOdds({ jsonodds_id: 'g-bbb', market: 'moneyline' }), makeOdds({ jsonodds_id: 'g-aaa', market: 'moneyline' })];
  const json = manifestJson();
  const booted = bootFrom(json);
  const publication = publicationFor(json);

  // Two GENUINE branded snapshots whose candidate order is genuinely reversed.
  const discoveryAB = await discover(booted, discoveryReads(games, oddsAB));
  const discoveryBA = await discover(booted, discoveryReads(games, oddsBA));
  assert.deepEqual(discoveryAB.candidates.map((c) => c.gameId), ['g-aaa', 'g-bbb']);
  assert.deepEqual(discoveryBA.candidates.map((c) => c.gameId), ['g-bbb', 'g-aaa']);

  const evidenceEntries: Array<[string, MarketEvidenceRead]> = [
    ['g-aaa::moneyline', makeEvidence('g-aaa', 'moneyline', [makeHistory('g-aaa', 'moneyline', { id: 1, captured_at: '2026-07-18T11:59:00.000Z' })])],
    ['g-bbb::moneyline', makeEvidence('g-bbb', 'moneyline', [makeHistory('g-bbb', 'moneyline', { id: 2, captured_at: '2026-07-18T11:59:10.000Z' })])],
  ];
  const clockSeq = [DETECT_MS, DETECT_MS + 1_000, DETECT_MS + 2_000];

  const outAB = projectPreparedFires({ discovery: discoveryAB, booted, publication, evidence: new Map(evidenceEntries), now: seqClock(clockSeq).now });
  const outBA = projectPreparedFires({ discovery: discoveryBA, booted, publication, evidence: new Map(evidenceEntries), now: seqClock(clockSeq).now });

  assert.deepEqual(outAB.fires, outBA.fires);
  assert.deepEqual(outAB.dispositions, outBA.dispositions);
});
