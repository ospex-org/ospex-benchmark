import { buildGameBundle } from './bundle.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { deepFreeze } from './freeze.js';
import { MARKET_POLICY_VERSION, MARKET_POLICY_DIGEST, effectiveEnabled } from './marketPolicy.js';
import { SPEND_GUARD_PRICE_TABLE_VERSION, modelPriceTableDigest } from './modelPriceTable.js';
import { firstTwoSided, parseTwoSidedHistoryRows, SOURCE_QUERY_VERSION } from './oddsHistory.js';
import { prepareGameRequest } from './preparedRequest.js';
import { PROMPT_SCAFFOLD_VERSION, promptScaffoldSha256 } from './prompt.js';
import { ARMS } from './providers/index.js';
import { CURRENT_RESPONSE_SCHEMA_VERSION } from './schema.js';
import { buildGameRequest } from './scopedRequest.js';
import { easternCalendarDay, isValidSlateDate } from './slateDate.js';
import { deriveFireSpendReservationUsdMicros, SPEND_RESERVATION_POLICY_VERSION } from './spendReservationPolicy.js';
import { instantMs } from './time.js';
import { TOOL_INFERENCE_CONFIG } from './toolInferenceConfig.js';
import type { BuildResult, BundleQuote } from './bundle.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { PreparedGameRequest } from './preparedRequest.js';
import type { RunContext } from './records.js';
import type { RunEnvelope } from './runner.js';
import type { GamesEndpointRow, MarketKey } from './types.js';

/** B1 is preparation, not a scheduler or a billable dispatch capability. */
export const MARKET_OPEN_POLICY = deepFreeze({
  namespace: 'market-open-v1',
  forecastScope: 'event-market-only',
  paidDispatch: 'blocked-until-b2',
  sportAllowList: ['mlb'],
  marketPolicyVersion: MARKET_POLICY_VERSION,
  marketPolicyDigest: MARKET_POLICY_DIGEST,
  sourceQueryVersion: SOURCE_QUERY_VERSION,
  baselinePolicyVersion: 'baselines-v0.3.0',
  // Existing response wire token; singleton scope is bound by the prepared request.
  executionPolicy: 'fixed-moneyline-total',
  responseSchemaVersion: CURRENT_RESPONSE_SCHEMA_VERSION,
  promptScaffoldVersion: PROMPT_SCAFFOLD_VERSION,
  promptScaffoldSha256: promptScaffoldSha256(),
  roster: structuredClone(ARMS),
  toolInferenceConfig: structuredClone(TOOL_INFERENCE_CONFIG),
  spendReservationPolicyVersion: SPEND_RESERVATION_POLICY_VERSION,
  priceVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
  priceDigest: modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION),
  maxRepairsPerArm: 1,
} as const);
const policySha256 = sha256Hex(canonicalize(MARKET_OPEN_POLICY));

export interface MarketOpenCohort {
  readonly cohortId: string;
  readonly name: string;
  readonly slateDate: string;
  readonly policySha256: string;
}
const cohorts = new WeakSet<MarketOpenCohort>();

/** A new, policy-bound namespace; never relabel a historical watch-v0 cohort. */
export function createMarketOpenCohort(input: { name: string; slateDate: string }): MarketOpenCohort {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name) || input.name.length > 64 || !isValidSlateDate(input.slateDate)) {
    throw new Error('invalid market-open cohort name or slate date');
  }
  const cohort = deepFreeze({
    name: input.name, slateDate: input.slateDate, policySha256,
    cohortId: `market-open-v1-${input.name}-${input.slateDate}-${policySha256}`,
  });
  cohorts.add(cohort);
  return cohort;
}

/** A claim REQUEST only: B2 must atomically persist it before any billable send. */
export interface MarketOpenClaim {
  readonly state: 'required-before-send';
  readonly key: string;
  readonly sourceSha256: string;
  readonly requestSha256: string;
  readonly atomicWith: readonly ['budget-reservation', 'attempt-slots'];
  readonly paidDispatch: 'blocked-until-b2';
}
export interface MarketOpenProvenance {
  readonly version: 'market-open-v1';
  readonly runId: string;
  readonly event: { readonly eventId: string; readonly cohortId: string; readonly gameId: string; readonly market: MarketKey };
  readonly observedAt: string;
  readonly source: {
    readonly relation: 'odds_history'; readonly openerId: number; readonly openedAt: string;
    readonly row: TwoSidedHistoryRow; readonly sha256: string; readonly droppedRows: number;
  };
  readonly policy: typeof MARKET_OPEN_POLICY;
  readonly policySha256: string;
  readonly requestSha256: string;
  readonly gameSha256: string;
  readonly reservationUsdMicros: number;
  readonly claim: MarketOpenClaim;
}
export interface PreparedMarketOpenRun {
  readonly cohort: MarketOpenCohort;
  readonly request: PreparedGameRequest;
  readonly build: BuildResult;
  readonly provenance: MarketOpenProvenance;
}
const preparedRuns = new WeakSet<PreparedMarketOpenRun>();
const provenanceRuns = new WeakMap<MarketOpenProvenance, PreparedMarketOpenRun>();

/**
 * Pure single-market preparation from a COMPLETE per-pair history read. The B2
 * reader owns completeness and first-observation persistence; this function does
 * not claim that caller-supplied rows authenticate a database read. No current
 * quote or sibling-board gate is involved. The selected immutable opener is the
 * reference quote, even if the current market has subsequently moved.
 */
export function prepareMarketOpenRun(input: {
  cohort: MarketOpenCohort; game: GamesEndpointRow; market: MarketKey;
  historyRows: unknown; observedAt: string;
}): { state: 'prepared'; run: PreparedMarketOpenRun } | { state: 'refused'; reason: string } {
  if (!cohorts.has(input.cohort)) throw new Error('market-open cohort was not created by this policy');
  const game = structuredClone(input.game);
  const { cohort, market, observedAt } = input;
  const observedMs = instantMs(observedAt);
  const startMs = instantMs(game.matchTime);
  const refuse = (reason: string) => ({ state: 'refused' as const, reason });
  if (!effectiveEnabled(MARKET_OPEN_POLICY.sportAllowList, game.sport, market)) return refuse('market_disabled');
  if (game.status !== 'upcoming') return refuse('game_not_upcoming');
  if (observedMs >= startMs) return refuse('at_or_after_first_pitch');
  if (easternCalendarDay(game.matchTime) !== cohort.slateDate) return refuse('wrong_slate_date');
  const parsed = parseTwoSidedHistoryRows(input.historyRows);
  const byId = new Map<number, string>();
  for (const row of parsed.rows) {
    if (row.jsonodds_id !== game.gameId || row.market !== market) throw new Error('market-open source identity mismatch');
    const bytes = canonicalize(row);
    if (byId.has(row.id) && byId.get(row.id) !== bytes) throw new Error('conflicting market-open source row');
    byId.set(row.id, bytes);
  }
  const opener = firstTwoSided(parsed.rows);
  if (opener === undefined) return refuse('opener_missing');
  if (opener.captured_at_ms > observedMs) return refuse('opener_future');
  // Adapt only the builder's quote INPUT vocabulary, never claim this is a
  // current_odds observation. Builder freshness is checked at the opener instant;
  // provenance below retains the history row and real, separate observation time.
  const quote: BundleQuote = {
    line: opener.line,
    away_odds_american: opener.away_odds_american, home_odds_american: opener.home_odds_american,
    upstream_last_updated: opener.captured_at,
  };
  const bundled = buildGameBundle(game, new Map([[market, quote]]), opener.captured_at_ms, [market]);
  if ('reason' in bundled) return refuse(bundled.reason);
  const gameRequest = buildGameRequest(bundled.bundle, game.slug, cohort.slateDate, observedAt);
  const request = prepareGameRequest(gameRequest);
  const eventId = sha256Hex(canonicalize({ cohortId: cohort.cohortId, gameId: game.gameId, market }));
  const sourceSha256 = sha256Hex(canonicalize(opener));
  const provenance: MarketOpenProvenance = deepFreeze({
    version: 'market-open-v1', runId: `market-open-v1-${eventId}`,
    event: { eventId, cohortId: cohort.cohortId, gameId: game.gameId, market }, observedAt,
    source: { relation: 'odds_history', openerId: opener.id, openedAt: opener.captured_at,
      row: opener, sha256: sourceSha256, droppedRows: parsed.dropped },
    policy: MARKET_OPEN_POLICY, policySha256,
    requestSha256: request.requestSha256, gameSha256: request.gameSha256,
    reservationUsdMicros: deriveFireSpendReservationUsdMicros({
      rosterSize: MARKET_OPEN_POLICY.roster.length, maxRepairsPerArm: MARKET_OPEN_POLICY.maxRepairsPerArm,
      version: MARKET_OPEN_POLICY.spendReservationPolicyVersion,
    }),
    claim: { state: 'required-before-send', key: eventId,
      sourceSha256, requestSha256: request.requestSha256,
      atomicWith: ['budget-reservation', 'attempt-slots'], paidDispatch: 'blocked-until-b2' },
  });
  const build: BuildResult = deepFreeze({
    slateBundle: request.requestBundle, slateSha256: request.requestSha256,
    requests: [gameRequest], gameHashes: { [game.gameId]: request.gameSha256 }, excluded: [],
    provenance: { [game.gameId]: { slug: game.slug, oddsRows: [] } },
  });
  const run = deepFreeze({ cohort, request, build, provenance });
  preparedRuns.add(run);
  provenanceRuns.set(provenance, run);
  return { state: 'prepared', run };
}

export function assertPreparedMarketOpenRun(run: PreparedMarketOpenRun): void {
  if (!preparedRuns.has(run)) throw new Error('market-open run was not prepared by this policy');
}

/** Additive record boundary; legacy runs are unchanged. Not a disk replay API. */
export function assertMarketOpenRecordContext(env: RunEnvelope, ctx: RunContext, build: BuildResult): void {
  const p = ctx.marketOpen;
  if (p === undefined && !ctx.cohortId.startsWith('market-open-')) return;
  const run = p === undefined ? undefined : provenanceRuns.get(p);
  if (run === undefined || p === undefined || ctx.watch !== undefined || ctx.mode !== 'dry-run' ||
      ctx.clockMode !== 'synthetic-fixture' || ctx.runId !== p.runId || ctx.cohortId !== p.event.cohortId ||
      ctx.fetchStartedAt !== p.observedAt || ctx.fetchCompletedAt !== p.observedAt ||
      env.baselinePolicyVersion !== MARKET_OPEN_POLICY.baselinePolicyVersion || build !== run.build ||
      env.snapshot.prepared.length !== 1 || env.snapshot.prepared[0]?.requestSha256 !== p.requestSha256 ||
      canonicalize(env.results.map((r) => r.arm)) !== canonicalize(MARKET_OPEN_POLICY.roster)) {
    throw new Error('market-open record context does not match its prepared event (B1 is fixture-only)');
  }
}
