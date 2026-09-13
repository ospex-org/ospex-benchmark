import { canonicalize, sha256Hex } from './canonical.js';
import { deepFreeze } from './freeze.js';
import { priceForModel } from './modelPriceTable.js';
import { ceilDivUsdMicros } from './conservativeSpend.js';
import { buildUserMessage, SYSTEM_PROMPT } from './prompt.js';
import { easternCalendarDay } from './slateDate.js';
import { instantMs } from './time.js';
import type { PreparedMarketOpenRun } from './marketOpen.js';
import type { MarketOpenAttemptSlot, MarketOpenStoreSnapshot } from './marketOpenStore.js';

/** New policy only. None of these estimates is a per-request/event spend ceiling. */
export const MARKET_OPEN_DAILY_BUDGET_POLICY = deepFreeze({
  version: 'market-open-daily-budget-v1', timeZone: 'America/New_York', workers: 2,
  transportDeadline: 'first-pitch', maxOutputTokens: 6_000,
  accounting: 'actual-or-terminal-unknown-on-attempt-start-et-day-plus-inflight-estimates',
  admission: 'current-used-less-than-cap', unknownSpend: 'estimate-and-flag-continue',
  aboveEstimate: 'record-actual-and-flag-continue', recovery: 'never-replay-started-attempt',
  estimator: { version: 'prompt-bytes-request-bounds-v1', inputTokens: 'utf8-bytes',
    searchContextTokensPerSearch: 2_000, repairResponseBytesPerOutputToken: 4, repairInstructionBytes: 4_096 },
} as const);
export const MARKET_OPEN_DAILY_BUDGET_POLICY_SHA256 = sha256Hex(canonicalize(MARKET_OPEN_DAILY_BUDGET_POLICY));
export interface DailyAttemptEstimate { slot: MarketOpenAttemptSlot; usdMicros: number }
export interface DailyBudgetStatus {
  policyVersion: typeof MARKET_OPEN_DAILY_BUDGET_POLICY.version;
  timeZone: 'America/New_York'; etDate: string; capUsdMicros: number;
  actualUsdMicros: number; inflightEstimateUsdMicros: number; unknownEstimateUsdMicros: number;
  usedUsdMicros: number; remainingUsdMicros: number; reached: boolean;
  heldEvents: number; heldGames: number; nextFirstPitch: string | null; expiredHeldEvents: number;
  unknownCostAttempts: number; aboveEstimateAttempts: number; activeEvents: number;
  integrityHalt: string | null;
  dayET: string; accountedUsdMicros: number; settledUsdMicros: number; estimatedUsdMicros: number;
  gamesSent: number; reachedAt: string | null; reachedAmountUsdMicros: number | null;
}
export function assertDailyBudgetCap(cap: number): void {
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error('daily budget cap must be positive integer USD micros');
}
function safe(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('daily budget accounting overflow');
  return Number(value);
}

/** Prompt bytes + existing output/search request settings, not the legacy $100.
 * Search context and repair sizes are disclosed planning allowances. In particular
 * Google searches/xAI turns and provider reasoning do NOT have hard bill bounds. */
export function estimateMarketOpenDailyAttempts(run: PreparedMarketOpenRun): DailyAttemptEstimate[] {
  const policy = MARKET_OPEN_DAILY_BUDGET_POLICY;
  return run.provenance.policy.roster.flatMap((arm) => {
    const price = priceForModel(arm.requestedModelId, run.provenance.policy.priceVersion);
    if (price.searchUsdMicrosPerSearch === undefined) throw new Error('daily estimate requires search pricing');
    const promptBytes = Buffer.byteLength(SYSTEM_PROMPT + buildUserMessage({ ...arm,
      cohortId: run.cohort.cohortId, executionPolicy: 'fixed-moneyline-total', request: run.request }), 'utf8');
    return (['initial', 'repair'] as const).map((role) => {
      const searches = role === 'initial' ? run.provenance.policy.toolInferenceConfig.maxSearchesPerAttempt : 0;
      const inputTokens = promptBytes + searches * policy.estimator.searchContextTokensPerSearch +
        (role === 'repair' ? policy.maxOutputTokens * policy.estimator.repairResponseBytesPerOutputToken + policy.estimator.repairInstructionBytes : 0);
      const cost = ceilDivUsdMicros(BigInt(inputTokens) * BigInt(price.inputUsdMicrosPerMillionTokens) +
        BigInt(policy.maxOutputTokens) * BigInt(price.outputUsdMicrosPerMillionTokens)) +
        BigInt(searches) * BigInt(price.searchUsdMicrosPerSearch!);
      return { slot: { armId: arm.participantId, role, ordinal: role === 'initial' ? 0 : 1 }, usdMicros: safe(cost) };
    });
  });
}

/** Pure projection of durable evidence. Never resets or changes journal state.
 * Actual and terminal unknown estimates are charged to the attempt START day.
 * Still-active requests carry across midnight until settled. Unused slots release at event
 * terminal. Future-dated evidence is invalid, rather than silently discarded. */
export function computeDailyBudgetStatus(snapshot: MarketOpenStoreSnapshot, at: string, capUsdMicros: number): DailyBudgetStatus {
  assertDailyBudgetCap(capUsdMicros);
  if (snapshot.dailyBudget === undefined) throw new Error('not a daily budget ledger');
  const now = instantMs(at); const etDate = easternCalendarDay(at);
  let actual = 0n; let inflight = 0n; let unknown = 0n;
  let unknownCostAttempts = 0; let aboveEstimateAttempts = 0; let activeEvents = 0;
  for (const fire of snapshot.fires) {
    const active = fire.status === 'claimed' || fire.status === 'running';
    if (active) activeEvents++;
    const held = snapshot.dailyBudget.observations.find((o) => o.input.eventId === fire.claim.eventId);
    if (held === undefined || held.state !== 'admitted') throw new Error('daily fire lacks admitted observation');
    for (const estimate of held.estimates) {
      const attempt = fire.attempts.find((a) => canonicalize(a.slot) === canonicalize(estimate.slot));
      if (attempt === undefined) { if (active) inflight += BigInt(estimate.usdMicros); continue; }
      if (instantMs(attempt.startedAt) > now) throw new Error('daily budget clock precedes attempt');
      if (attempt.costUsdMicros !== null) {
        if (easternCalendarDay(attempt.startedAt) === etDate) {
          actual += BigInt(attempt.costUsdMicros);
          if (attempt.costUsdMicros > estimate.usdMicros) aboveEstimateAttempts++;
        }
      } else if (attempt.finishedAt !== null || !active) {
        if (easternCalendarDay(attempt.startedAt) === etDate) {
          unknown += BigInt(estimate.usdMicros); unknownCostAttempts++;
        }
      } else inflight += BigInt(estimate.usdMicros);
    }
  }
  const pending = snapshot.dailyBudget.observations.filter((o) => o.state === 'held' && o.budgetHeld);
  const eligible = pending.filter((o) => instantMs(o.input.preparation.game.matchTime) > now);
  const heldGames = new Set(eligible.map((o) => o.input.preparation.game.gameId)).size;
  const nextFirstPitch = eligible.map((o) => o.input.preparation.game.matchTime)
    .sort((a, b) => instantMs(a) - instantMs(b))[0] ?? null;
  const used = safe(actual + inflight + unknown);
  const reached = snapshot.dailyBudget.reaches.find((r) => r.dayET === etDate);
  const gamesSent = new Set(snapshot.fires.filter((f) => f.attempts.some((a) => easternCalendarDay(a.startedAt) === etDate))
    .map((f) => f.claim.preparation.game.gameId)).size;
  return { policyVersion: MARKET_OPEN_DAILY_BUDGET_POLICY.version, timeZone: 'America/New_York', etDate,
    capUsdMicros, actualUsdMicros: safe(actual), inflightEstimateUsdMicros: safe(inflight),
    unknownEstimateUsdMicros: safe(unknown), usedUsdMicros: used,
    remainingUsdMicros: Math.max(0, capUsdMicros - used), reached: used >= capUsdMicros,
    heldEvents: eligible.length, heldGames, nextFirstPitch, expiredHeldEvents: pending.length - eligible.length,
    unknownCostAttempts, aboveEstimateAttempts, activeEvents, integrityHalt: snapshot.halted,
    dayET: etDate, accountedUsdMicros: used, settledUsdMicros: safe(actual), estimatedUsdMicros: safe(inflight + unknown),
    gamesSent: reached?.gamesSent ?? gamesSent, reachedAt: reached?.at ?? null, reachedAmountUsdMicros: reached?.amountUsdMicros ?? null };
}
