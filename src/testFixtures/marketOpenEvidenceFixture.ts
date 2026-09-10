import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planArmRequest } from '../providers/index.js';
import { deriveFireSpendReservationUsdMicros } from '../spendReservationPolicy.js';
import { MARKET_OPEN_POLICY } from '../marketOpen.js';
import { MarketOpenProducer } from '../marketOpenProducer.js';
import type { MarketOpenObservation } from '../marketOpenProducer.js';
import { parseRequestPayload, buildValidResponse } from '../mock.js';
import { sealResponseEnvelope } from '../providers/responseEnvelope.js';
import type { ProviderAdapter, ProviderResponse } from '../types.js';

export const MARKET_OPEN_FIXTURE_OBSERVED_AT = '2026-09-10T14:05:00.000Z';
export const MARKET_OPEN_FIXTURE_GAME_ID = '00000000-0000-4000-8000-000000000004';
export interface MarketOpenEvidenceFixtureOptions {
  markets?: readonly ('moneyline' | 'total')[];
  market?: 'moneyline' | 'total';
  repair?: boolean;
  failedArm?: boolean | string;
  observedAt?: string;
  openerCapturedAt?: string;
  sendAt?: string;
  attemptStepMs?: number;
  name?: string;
}
export function marketOpenEvidenceObservation(market: 'moneyline' | 'total' = 'moneyline',
  options: Pick<MarketOpenEvidenceFixtureOptions, 'observedAt' | 'openerCapturedAt'> = {}): MarketOpenObservation {
  const gameId = MARKET_OPEN_FIXTURE_GAME_ID;
  return { observedAt: options.observedAt ?? MARKET_OPEN_FIXTURE_OBSERVED_AT, market,
    game: { gameId, slug: 'mil-pit', sport: 'mlb', matchTime: '2026-09-10T20:00:00.000Z', status: 'upcoming',
      homeTeam: { name: 'Pirates', abbreviation: 'PIT' }, awayTeam: { name: 'Brewers', abbreviation: 'MIL' },
      hasOdds: true, contestCreated: false, contestId: null, canCreateContest: true,
      externalIds: { jsonodds: gameId, sportspage: null, rundown: null } },
    historyRows: [{ id: market === 'moneyline' ? 10 : 11, jsonodds_id: gameId, source: 'jsonodds', market,
      line: market === 'total' ? 8.5 : null, away_odds_decimal: 1 + 100 / 110, home_odds_decimal: 1 + 100 / 105,
      away_odds_american: -110, home_odds_american: -105,
      captured_at: options.openerCapturedAt ?? '2026-09-10T11:00:00.000Z' }] };
}
const usage: Record<string, unknown> = {
  openai: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  anthropic: { input_tokens: 10, output_tokens: 10, server_tool_use: { web_search_requests: 1 } },
  google: { promptTokenCount: 10, candidatesTokenCount: 10, thoughtsTokenCount: 0, totalTokenCount: 20 },
  xai: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, completion_tokens_details: { reasoning_tokens: 0 } },
};

/** Actual B2 producer, runner, billable accounting and durable POSIX sink.
 * Only transports/clocks are synthetic. Never reads credentials or calls a provider.
 * Pass markets:[] for an initialized root with no work. Caller owns cleanup(). */
export async function createMarketOpenEvidenceFixture(options: MarketOpenEvidenceFixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'market-open-evidence-'));
  let clock = Date.parse(options.sendAt ?? options.observedAt ?? MARKET_OPEN_FIXTURE_OBSERVED_AT);
  let producer: MarketOpenProducer;
  const calls: Array<{ armId: string; market: string; role: 'initial' | 'repair' }> = [];
  const adapters = new Map<string, ProviderAdapter>();
  const target = MARKET_OPEN_POLICY.roster[0]!.participantId;
  for (const arm of MARKET_OPEN_POLICY.roster) adapters.set(arm.participantId, {
    provider: arm.provider, requestedModelId: arm.requestedModelId, credentialEnvVar: 'SYNTHETIC_UNUSED', hasCredential: () => true,
    async chat(turns, _timeout, callOptions) {
      const { payload, gameId } = parseRequestPayload(turns);
      const market = payload.bundle.games[0]!.markets.total === undefined ? 'moneyline' : 'total';
      const role = turns.length > 2 ? 'repair' : 'initial';
      const fire = producer.snapshot().fires.find((f) => f.claim.preparation.game.gameId === gameId && f.claim.preparation.market === market);
      assert.ok(fire?.attempts.some((a) => a.slot.armId === arm.participantId && a.slot.role === role && a.finishedAt === null), 'durable intent precedes synthetic transport');
      calls.push({ armId: arm.participantId, market, role });
      let rawText = JSON.stringify(buildValidResponse(payload));
      if (options.failedArm && arm.participantId === (typeof options.failedArm === 'string' ? options.failedArm : target)) rawText = '{}';
      else if (options.repair && arm.participantId === target && role === 'initial') rawText = rawText.replace(/"cohortId":"[^"]*"/, '"cohortId":"wrong"');
      const response: ProviderResponse = { rawText, reportedModelId: arm.requestedModelId,
        providerResponseId: `synthetic-${arm.participantId}-${market}-${role}`,
        responseEnvelope: sealResponseEnvelope(JSON.stringify({ synthetic: true, usage: usage[arm.provider] })), httpStatus: 200,
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20, reasoningTokens: 0, billableOutputTokens: 10 },
        usageRaw: structuredClone(usage[arm.provider]), requestParams: structuredClone(planArmRequest(arm, turns, callOptions).requestParams),
        searchAudit: { queries: [{ query: `${role} synthetic query` }], results: [{ url: 'https://example.invalid/synthetic', title: 'synthetic' }], searchCount: 1, incomplete: [] } };
      clock += options.attemptStepMs ?? 0;
      return response;
    },
  });
  const producerOptions = { root, name: options.name ?? 'evidence-test', slateDate: '2026-09-10', capUsdMicros: deriveFireSpendReservationUsdMicros({ rosterSize: MARKET_OPEN_POLICY.roster.length, maxRepairsPerArm: 1, version: MARKET_OPEN_POLICY.spendReservationPolicyVersion }) * 8,
    adapters, nowMs: () => clock };
  producer = new MarketOpenProducer(producerOptions);
  const cleanup = async () => { try { await producer.close(); } finally { rmSync(root, { recursive: true, force: true }); } };
  try {
    const results = [];
    for (const market of options.markets ?? [options.market ?? 'moneyline']) {
      results.push(await producer.observe(marketOpenEvidenceObservation(market, options)));
    }
    const artifactPaths = results.flatMap((r) => 'artifactPath' in r && r.artifactPath ? [r.artifactPath] : []);
    const artifacts = artifactPaths.map((path) => JSON.parse(readFileSync(path, 'utf8')) as { records: Record<string, unknown>[] });
    return { root, producer, producerOptions, calls, results, artifactPaths, artifacts,
      artifactPath: artifactPaths[0], records: artifacts[0]?.records ?? [],
      setClock: (at: string | number) => { clock = typeof at === 'string' ? Date.parse(at) : at; }, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
