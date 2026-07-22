import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CohortBootError, assertBootedCohort, cohortBoot } from './cohortBoot.js';
import { runCohortTick } from './cohortRunner.js';
import {
  buildRehearsalTickInput,
  formatTickResult,
  selfResolvePublication,
} from './cohortRunnerMain.js';
import { RehearsalClaimPort } from './lineOpenClaim.js';
import { discover } from './lineOpenRead.js';
import { assertPublicationVerified } from './manifestPublication.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import { defaultExpectedArms } from './scoring.js';
import { STORE_SCHEMA_VERSION } from './store/constants.js';
import type { CohortTickInput } from './cohortRunner.js';
import type { DiscoverFn, DiscoveryReads, ReadMarketEvidenceFn } from './lineOpenRead.js';
import type { LineOpenReadConfig } from './lineOpenRead.js';
import type { CurrentOddsRow, GamesEndpointRow, MarketKey } from './types.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';

/**
 * The rehearsal (dry-run) runner entrypoint core, driven WITHOUT env or network: the
 * in-process manifest boots, its publication self-resolves through the pure check, and
 * a full `runCohortTick` runs over genuinely-branded discovery (the real `discover` seam
 * with injected fake reads) + the report-only claim port. Every fire is a `WouldAdmit`
 * rehearsal outcome; nothing is admitted or installed.
 */

// Times aligned so the fixture rows fall inside the manifest's now-relative window.
const FIXED_NOW = Date.parse('2026-07-18T12:00:40.000Z');
const DISCO_MS = Date.parse('2026-07-18T12:00:00.000Z');
const DETECT_MS = DISCO_MS + 5_000;
const OPENER_AT = '2026-07-18T11:59:05.000Z';
const QUOTE_AT = '2026-07-18T11:59:00+00:00';
const MATCH_TIME = '2026-07-18T20:00:00+00:00';

const DUMMY_CONFIG: LineOpenReadConfig = {
  apiUrl: 'http://unused.invalid',
  supabaseUrl: 'http://unused.invalid',
  anonKey: 'unused',
};

// --- read-path row fixtures (mirrors cohortRunner.test.ts) ------------------

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

function makeHistory(gameId: string, market: MarketKey): TwoSidedHistoryRow {
  return {
    id: 1,
    jsonodds_id: gameId,
    market,
    source: 'jsonodds',
    line: null,
    away_odds_american: -120,
    away_odds_decimal: 1.83333,
    home_odds_american: 110,
    home_odds_decimal: 2.1,
    captured_at: OPENER_AT,
    captured_at_ms: Date.parse(OPENER_AT),
  };
}

function discoveryReads(games: GamesEndpointRow[], odds: CurrentOddsRow[]): DiscoveryReads {
  return {
    readGames: async (sport) => games.filter((g) => g.sport === sport),
    readCurrentOdds: async () => odds,
    now: () => DISCO_MS,
  };
}

function fixtureDiscoverFn(games: GamesEndpointRow[], odds: CurrentOddsRow[]): DiscoverFn {
  return (booted) => discover(booted, discoveryReads(games, odds));
}

function fixtureEvidenceReader(): ReadMarketEvidenceFn {
  return async (_booted, gameId, market) => ({
    gameId,
    market,
    historyRows: [makeHistory(gameId, market)],
    historyWatermark: null,
    readCompletedAt: '2026-07-18T12:00:01.000Z',
  });
}

function tickClock(): () => number {
  const values = [DETECT_MS, DETECT_MS + 1_000, DETECT_MS + 2_000, DETECT_MS + 3_000];
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

/** A rehearsal tick input with the two read seams overridden by genuinely-branded
 *  fixtures, so the whole tick runs with NO network. */
function fixtureTickInput(bytes: string, games: GamesEndpointRow[], odds: CurrentOddsRow[]): CohortTickInput {
  const base = buildRehearsalTickInput({
    manifestBytes: bytes,
    config: DUMMY_CONFIG,
    now: tickClock(),
    ownerId: 'test-owner',
  });
  return { ...base, discover: fixtureDiscoverFn(games, odds), readMarketEvidence: fixtureEvidenceReader() };
}

// ===========================================================================

test('selfResolvePublication yields a genuine PublicationVerified bound to the booted cohort', () => {
  const { bytes } = buildRehearsalManifest(FIXED_NOW);
  const booted = cohortBoot({ live: false, manifestBytes: bytes });
  const publication = selfResolvePublication(bytes);
  assert.doesNotThrow(() => assertPublicationVerified(publication));
  assert.equal(publication.cohortId, booted.cohortId, 'publication is verified for THIS cohort');
  assert.ok(
    Date.parse(publication.committerTimestamp) < Date.parse(booted.manifest.windowStart),
    'committer timestamp is strictly before windowStart',
  );
});

test('buildRehearsalTickInput wires a report-only claim, a no-op sink, a full roster, and derived options', () => {
  const { bytes, manifest } = buildRehearsalManifest(FIXED_NOW);
  const input = buildRehearsalTickInput({ manifestBytes: bytes, config: DUMMY_CONFIG, now: () => FIXED_NOW, ownerId: 'owner-x' });

  assert.doesNotThrow(() => assertBootedCohort(input.booted));
  assert.doesNotThrow(() => assertPublicationVerified(input.publication));
  assert.ok(input.claimPort instanceof RehearsalClaimPort, 'the claim port is report-only');
  // The sink is a never-called no-op: invoking it is a broken invariant and throws.
  assert.throws(() => (input.sink.install as unknown as () => never)());
  // The adapter map covers the whole expected roster (required for the pre-claim plan build).
  for (const arm of defaultExpectedArms()) {
    assert.ok(input.adapters.has(arm.participantId), `adapter present for ${arm.participantId}`);
  }
  // Run options + admission are derived from the booted manifest / store constants.
  assert.equal(input.runOptions.timeoutMs, manifest.constants.providerCallTimeoutMs);
  assert.equal(input.runOptions.maxOutputTokens, manifest.constants.maxOutputTokens);
  assert.equal(input.runOptions.baselinePolicyVersion, 'baselines-v0.3.0');
  assert.equal(input.admission.expectedSchemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(input.admission.ownerId, 'owner-x');
});

test('a rehearsal tick discovers, projects one prepared candidate, and reports it as WouldAdmit', async () => {
  const { bytes } = buildRehearsalManifest(FIXED_NOW);
  const games = [makeGame({ gameId: 'g1' })];
  const odds = [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })];

  const result = await runCohortTick(fixtureTickInput(bytes, games, odds));

  assert.equal(result.discoveredCount, 1);
  assert.deepEqual(
    result.dispositions.map((d) => ({ ...d })),
    [{ gameId: 'g1', market: 'moneyline', outcome: 'prepared' }],
  );
  assert.equal(result.fireOutcomes.length, 1);
  assert.equal(result.fireOutcomes[0]!.outcome.kind, 'NotAdmitted');
  assert.equal(result.admittedCount, 0, 'a rehearsal admits nothing');

  const rendered = formatTickResult(result);
  assert.ok(rendered.some((l) => /discovered 1 candidate/.test(l)));
  assert.ok(rendered.some((l) => /g1 moneyline: prepared/.test(l)), 'the prepared disposition renders');
  assert.ok(rendered.some((l) => /NotAdmitted\/WouldAdmit/.test(l)), 'the WouldAdmit rehearsal line renders');
  assert.ok(rendered.some((l) => /admitted 0 fire/.test(l)));
});

test('a rehearsal tick over an empty discovery renders a zero-candidate result (no network)', async () => {
  const { bytes } = buildRehearsalManifest(FIXED_NOW);
  const result = await runCohortTick(fixtureTickInput(bytes, [], []));

  assert.equal(result.discoveredCount, 0);
  assert.equal(result.dispositions.length, 0);
  assert.equal(result.fireOutcomes.length, 0);
  assert.equal(result.admittedCount, 0);
  assert.ok(formatTickResult(result).some((l) => /discovered 0 candidate/.test(l)));
});

test('--live is rejected by cohortBoot (the mechanism the CLI routes into)', () => {
  const { bytes } = buildRehearsalManifest(FIXED_NOW);
  assert.throws(
    () => cohortBoot({ live: true, manifestBytes: bytes }),
    (e: unknown) => e instanceof CohortBootError && /--live is hard-disabled/.test(e.violations.join('; ')),
  );
});
