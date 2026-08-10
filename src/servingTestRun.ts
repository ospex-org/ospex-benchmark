import { readFileSync } from 'node:fs';
import { buildBundle } from './bundle.js';
import { fireEligibleGame } from './watch.js';
import { makeValidResponse, TEST_ARM } from './testFactories.js';
import { ARMS } from './providers/index.js';
import { parseRunArtifact } from './servingProjection.js';
import { SqlBenchmarkServingPort } from './servingStore.js';
import type { JsonRecord } from './servingProjection.js';
import type { BuildResult } from './bundle.js';
import type { WatchGateProvenance } from './watch.js';
import type {
  CurrentOddsRow,
  GamesEndpointRow,
  MarketKey,
  ProviderAdapter,
  ProviderResponse,
  SlateInputs,
} from './types.js';

/**
 * Fires one game for real and hands back the artifact it wrote.
 *
 * Shared by the projection and publisher suites because both must read a file
 * the RUNNER produced rather than one a test author typed. The reader's only
 * contract is with `buildRecords`, and a hand-written fixture would keep
 * passing on the day a field there is renamed — which is exactly the failure
 * that would silently empty the projection.
 */

const GAME_ID = '00000000-0000-4000-8000-0000000prj01';
const FETCH_COMPLETED_AT = '2026-07-20T12:00:00.000Z';
const MATCH_TIME = '2026-07-20T23:10:00+00:00';
const QUOTE_AT = '2026-07-20T11:55:00.000Z';
const NOW_MS = Date.parse('2026-07-20T12:00:30.000Z');

export const TEST_SLATE_DATE = '2026-07-20';
export const TEST_COHORT_ID = `watch-v0-${TEST_SLATE_DATE}`;

function gamesRow(): GamesEndpointRow {
  return {
    gameId: GAME_ID,
    slug: 'mil-pit-2026-07-20',
    sport: 'mlb',
    matchTime: MATCH_TIME,
    status: 'upcoming',
    homeTeam: { name: 'Pittsburgh Pirates', abbreviation: 'PIT' },
    awayTeam: { name: 'Milwaukee Brewers', abbreviation: 'MIL' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: false,
    externalIds: { jsonodds: GAME_ID, sportspage: null, rundown: null },
  };
}

function oddsRow(market: MarketKey, line: number | null): CurrentOddsRow {
  return {
    network: 'polygon',
    jsonodds_id: GAME_ID,
    market,
    line,
    away_odds_american: market === 'moneyline' ? -135 : 122,
    home_odds_american: market === 'moneyline' ? 122 : -152,
    upstream_last_updated: QUOTE_AT,
    poll_captured_at: QUOTE_AT,
    changed_at: QUOTE_AT,
  };
}

export function fullBoardInputs(): SlateInputs {
  return {
    gamesRows: [gamesRow()],
    oddsRows: [oddsRow('moneyline', null), oddsRow('spread', 1.5), oddsRow('total', 8.5)],
    fetchStartedAt: '2026-07-20T11:59:58.000Z',
    fetchCompletedAt: FETCH_COMPLETED_AT,
  };
}

function stubAdapter(build: BuildResult, cohortId: string): ProviderAdapter {
  return {
    provider: TEST_ARM.provider,
    requestedModelId: TEST_ARM.requestedModelId,
    credentialEnvVar: TEST_ARM.credentialEnvVar,
    hasCredential: () => true,
    chat(): Promise<ProviderResponse> {
      return Promise.resolve({
        rawText: JSON.stringify(makeValidResponse(build.requests[0]!, TEST_ARM, cohortId)),
        reportedModelId: 'stub-model-1',
        providerResponseId: 'stub-response',
        httpStatus: 200,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        usageRaw: { prompt_tokens: 100, completion_tokens: 50 },
        requestParams: { stub: true },
        searchAudit: null,
      });
    },
  };
}

export interface FiredRun {
  readonly runFile: string;
  readonly records: readonly JsonRecord[];
  readonly cohortId: string;
}

export interface FireOptions {
  readonly outDir: string;
  /**
   * Relabel the fired arm as a production one.
   *
   * `TEST_ARM` is deliberately absent from the projection's registry, so a run
   * fired under it publishes no model rows — which is itself under test. A case
   * that needs published model rows sets this.
   */
  readonly enrolled?: boolean;
  readonly mode?: 'live' | 'dry-run';
}

export async function firedRun(options: FireOptions): Promise<FiredRun> {
  const inputs = fullBoardInputs();
  const build = buildBundle(inputs, TEST_SLATE_DATE, { requireFuture: false });
  const provenance: WatchGateProvenance = {
    detectedAt: new Date(NOW_MS).toISOString(),
    boardCompletedAt: '2026-07-20T11:50:00.000Z',
    openerAgeMinutes: 10,
    lateThresholdMinutes: 60,
  };
  let clock = NOW_MS;
  const outcome = await fireEligibleGame(build, inputs, TEST_SLATE_DATE, provenance, {
    arms: [TEST_ARM],
    adapters: new Map([[TEST_ARM.participantId, stubAdapter(build, TEST_COHORT_ID)]]),
    approvedReportedModelIds: () => ['stub-model-1'],
    outDir: options.outDir,
    timeoutMs: 60_000,
    maxOutputTokens: 16000,
    mode: options.mode ?? 'live',
    clockMode: 'wall',
    // Monotonic, so recorded instants are ordered and latency is exact.
    nowMs: () => (clock += 5),
    log: () => undefined,
    logError: () => undefined,
    serving: new SqlBenchmarkServingPort(null),
  });

  const raw = parseRunArtifact(readFileSync(outcome.runFile, 'utf8'));
  return {
    runFile: outcome.runFile,
    records: options.enrolled === true ? asEnrolled(raw) : raw,
    cohortId: TEST_COHORT_ID,
  };
}

/** Rewrite the fired arm's id to a registered one, leaving every other byte. */
export function asEnrolled(records: readonly JsonRecord[], index = 0): JsonRecord[] {
  const enrolled = ARMS[index]!.participantId;
  return records.map((record) =>
    record['participantId'] === TEST_ARM.participantId
      ? { ...record, participantId: enrolled }
      : record,
  );
}
