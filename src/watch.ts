import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBaselines } from './baselines.js';
import { buildScopedResult, evaluateGameMarkets, FUTURE_QUOTE_SKEW_MS } from './bundle.js';
import { describeError } from './config.js';
import { MARKET_KEYS } from './markets.js';
import { checkProviderCollision } from './providers/family.js';
import {
  buildRecords,
  failuresByCode,
  reportedModelIdsByArm,
  unidentifiedResponsesByArm,
  writeNdjson,
  writeText,
} from './records.js';
import { runSlate } from './runner.js';
import { easternCalendarDay } from './slateDate.js';
import { buildSummaryMarkdown } from './summary.js';
import type { BuildResult, GameMarketsEval } from './bundle.js';
import type { RunContext, WatchProvenance } from './records.js';
import type {
  ArmOutcome,
  ArmSpec,
  CurrentOddsRow,
  GamesEndpointRow,
  MarketKey,
  ProviderAdapter,
  SlateInputs,
} from './types.js';

/**
 * Line-open watch mode — the speculation is the unit (docs/LINE_OPEN_RUNNER.md).
 *
 * Each market on each game is an independent entity: detected on its own,
 * gated on its own first appearance, claimed on its own, fired on its own, and
 * recorded on its own. A "game" is only a label some speculations share. There
 * is no game-level fire and no game-level readiness — those concepts were the
 * bug (a stale moneyline riding in on a fresh run line), and they are gone.
 *
 * Two layers that must never be conflated:
 *  - DETECTION is universal. Every market a league sends is detected,
 *    timestamped and recorded — moneyline, total, run line — no exceptions.
 *  - POLICY decides what to ACT ON. The MLB run line is detected and recorded
 *    `policy_disabled`; it is simply never dispatched to the participants.
 *
 * Firing stays fire-at-detection: the bundle is built from the same snapshot
 * detection reads and used at once, never frozen for later use. When two
 * enabled markets are ready in the same tick they share one dispatch as a
 * network optimization — but each is claimed, gated and recorded
 * independently, so a batched dispatch and N separate dispatches produce the
 * same per-speculation records. Nothing ever waits for another market.
 */

/**
 * The entry-honesty threshold: a market fires only if its OWN first board
 * appearance was within this window of detection. Committed constant, NOT a
 * CLI flag — a per-invocation lever over which openers are admitted would be a
 * cherry-pick surface. It is stamped into every run record and the scorer
 * checks each market's age against it.
 */
export const LATE_THRESHOLD_MS = 30 * 60_000;

/**
 * Per-tick dispatch circuit breaker (billing events, not speculations — a
 * batched dispatch of several markets is one bill of four model calls). Model
 * calls cost real money, so a surprise flood of openers must stop loudly. A
 * full MLB slate is ~15 games; the default clears that with margin.
 */
export const DEFAULT_MAX_DISPATCHES_PER_TICK = 20;

/** A tick's inputs age as sequential fires run; entries are never made on
 *  prices older than this — unclaimed candidates are re-DETECTED next tick. */
export const MAX_INPUT_AGE_MS = 10 * 60_000;
/** Fire on a CURRENT snapshot: the working inputs are re-fetched whenever they
 *  are older than this, so every fired speculation enters on seconds-old prices
 *  no matter how long earlier fires in the same tick took. */
export const FRESH_FIRE_MS = 30_000;

export class WatchUsageError extends Error {}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface WatchCliOptions {
  dryRun: boolean;
  once: boolean;
  /** Report-only: evaluate and print what WOULD fire, write no ledger, no
   *  run files, dispatch nothing. Mandatory before the first live boot. */
  rehearse: boolean;
  outDir: string;
  /** True when --out was passed explicitly (dry runs default elsewhere). */
  outDirExplicit: boolean;
  pollSeconds: number;
  windowHours: number;
  maxDispatchesPerTick: number;
  timeoutSeconds: number | null;
  maxOutputTokens: number;
}

export const WATCH_USAGE = `Usage: yarn watch [options]

Options:
  --dry-run              One pass against the fixture slate and mock providers
                         (no credentials, no network, implies --once).
  --rehearse             Report-only: evaluate every speculation and print what
                         WOULD fire, writing no ledger and dispatching nothing.
                         Mandatory before a first live boot (implies --once).
  --once                 Run a single watch pass and exit (external schedulers, tests).
  --out DIR              Output directory (run files + line-open-ledger/). Default: out/
  --poll-seconds N       Poll interval between passes. Default: 60, min 30.
  --window-hours N       Games-endpoint lookahead window. Default: 168, max 720.
  --max-dispatches-per-tick N
                         Circuit breaker on per-tick spend: once N game
                         dispatches fire in one tick, stop loudly; the rest
                         re-evaluate next tick. Default: 20.
  --timeout-seconds N    Per-provider-call timeout. Default: 300 live, 2 dry run.
  --max-output-tokens N  Output-token bound per provider call. Default: 16000.
  -h, --help             Show this help.

The late-detection threshold (${LATE_THRESHOLD_MS / 60_000} min) and the market
policy are committed constants, not flags — they are preregistration, not
runtime levers.`;

export function parseWatchArgs(argv: string[], onHelp: () => void): WatchCliOptions {
  const options: WatchCliOptions = {
    dryRun: false,
    once: false,
    rehearse: false,
    outDir: 'out',
    outDirExplicit: false,
    pollSeconds: 60,
    windowHours: 168,
    maxDispatchesPerTick: DEFAULT_MAX_DISPATCHES_PER_TICK,
    timeoutSeconds: null,
    maxOutputTokens: 16000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new WatchUsageError(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        options.once = true;
        break;
      case '--rehearse':
        options.rehearse = true;
        options.once = true;
        break;
      case '--once':
        options.once = true;
        break;
      case '--out':
        options.outDir = next();
        options.outDirExplicit = true;
        break;
      case '--poll-seconds': {
        const value = Number.parseInt(next(), 10);
        if (!Number.isInteger(value) || value < 30) {
          throw new WatchUsageError('--poll-seconds must be an integer >= 30');
        }
        options.pollSeconds = value;
        break;
      }
      case '--window-hours': {
        const value = Number.parseInt(next(), 10);
        if (!Number.isInteger(value) || value < 1 || value > 720) {
          throw new WatchUsageError('--window-hours must be an integer between 1 and 720');
        }
        options.windowHours = value;
        break;
      }
      case '--max-dispatches-per-tick': {
        const value = Number.parseInt(next(), 10);
        if (!Number.isInteger(value) || value < 1) {
          throw new WatchUsageError('--max-dispatches-per-tick must be a positive integer');
        }
        options.maxDispatchesPerTick = value;
        break;
      }
      case '--timeout-seconds': {
        const value = Number.parseInt(next(), 10);
        if (!Number.isInteger(value) || value <= 0) {
          throw new WatchUsageError('--timeout-seconds must be a positive integer');
        }
        options.timeoutSeconds = value;
        break;
      }
      case '--max-output-tokens': {
        const value = Number.parseInt(next(), 10);
        if (!Number.isInteger(value) || value <= 0) {
          throw new WatchUsageError('--max-output-tokens must be a positive integer');
        }
        options.maxOutputTokens = value;
        break;
      }
      case '-h':
      case '--help':
        onHelp();
        break;
      default:
        throw new WatchUsageError(`unknown argument: ${arg ?? ''}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Ledger + status
// ---------------------------------------------------------------------------

/**
 * A terminal decision for ONE speculation (game, market). Existence of its
 * ledger file means that speculation is handled forever — it fires at most
 * once, ever, across restarts. `fired` and `late_detection` are both terminal.
 */
export interface SpecLedgerEntry {
  gameId: string;
  slug: string;
  market: MarketKey;
  decision: 'fired' | 'late_detection';
  decidedAt: string;
  slateDate: string;
  scheduledStartUtc: string;
  firstAppearanceAt: string;
  openerAgeSeconds: number;
  gameSha256: string;
  requestSha256: string;
  /** Present on fired entries once the fire completes. */
  runId?: string | undefined;
  runFile?: string | undefined;
  armOutcomes?: Record<string, ArmOutcome> | undefined;
  baselineDecisions?: number | undefined;
  collisionFailed?: boolean | undefined;
  /** Present when the fire errored after the ledger claim. */
  fireError?: string | undefined;
}

/** The live state of one speculation this tick — the observability + (in
 *  PR B) denominator record. Distinct from the ledger, which holds only
 *  terminal decisions. */
export type SpecState = 'disabled' | 'blocked' | 'deferred' | 'ready' | 'fired' | 'late';

export interface SpecStatus {
  gameId: string;
  slug: string;
  league: string;
  market: MarketKey;
  state: SpecState;
  /** Machine-readable reason (policy_disabled, market_never_opened, one_sided,
   *  stale_quote, deferred, first_pitch_passed, late_detection, entered, …). */
  reason: string;
  firstAppearanceAt: string | null;
  openerAgeSeconds: number | null;
  scheduledStartUtc: string;
}

function specKey(gameId: string, market: MarketKey): string {
  return `${gameId}:${market}`;
}

function ledgerPath(ledgerDir: string, gameId: string, market: MarketKey): string {
  return join(ledgerDir, gameId, `${market}.json`);
}

export function persistLedgerEntry(ledgerDir: string, entry: SpecLedgerEntry): void {
  // writeText is the redaction chokepoint — every serialized byte passes
  // redactSecrets before touching disk, same as run records.
  writeText(
    ledgerPath(ledgerDir, entry.gameId, entry.market),
    `${JSON.stringify(entry, null, 2)}\n`,
  );
}

/**
 * Re-derive the handled set from disk (`<ledgerDir>/<gameId>/<market>.json`).
 * Existence of a file means that speculation is handled forever — a corrupt
 * file is treated as handled (the conservative reading: never risk a
 * double-fire; model calls bill money).
 */
export function loadLedger(
  ledgerDir: string,
  logError: (line: string) => void,
): Map<string, SpecLedgerEntry> {
  const ledger = new Map<string, SpecLedgerEntry>();
  if (!existsSync(ledgerDir)) return ledger;
  for (const gameId of readdirSync(ledgerDir)) {
    const gameDir = join(ledgerDir, gameId);
    let files: string[];
    try {
      files = readdirSync(gameDir);
    } catch {
      continue; // not a directory
    }
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      const market = name.slice(0, -'.json'.length) as MarketKey;
      if (!MARKET_KEYS.includes(market)) continue;
      const key = specKey(gameId, market);
      try {
        const parsed = JSON.parse(readFileSync(join(gameDir, name), 'utf8')) as SpecLedgerEntry;
        ledger.set(key, parsed);
      } catch (error) {
        logError(
          `ledger entry ${gameId}/${name} is unreadable (${describeError(error)}) — treating the speculation as handled`,
        );
        ledger.set(key, {
          gameId,
          slug: 'unknown',
          market,
          decision: 'fired',
          decidedAt: 'unknown',
          slateDate: 'unknown',
          scheduledStartUtc: 'unknown',
          firstAppearanceAt: 'unknown',
          openerAgeSeconds: -1,
          gameSha256: 'unknown',
          requestSha256: 'unknown',
          fireError: 'ledger entry unreadable; treated as handled to prevent a double-fire',
        });
      }
    }
  }
  return ledger;
}

// ---------------------------------------------------------------------------
// Fire path
// ---------------------------------------------------------------------------

/** Per-fire, per-game gate provenance handed to the fire path and recorded in
 *  run_meta so the entry-timing claim is verifiable per market. */
export interface WatchGateProvenance {
  detectedAt: string;
  lateThresholdSeconds: number;
  markets: Partial<Record<MarketKey, { firstAppearanceAt: string; openerAgeSeconds: number }>>;
}

export interface FireOutcome {
  runId: string;
  runFile: string;
  armOutcomes: Record<string, ArmOutcome>;
  baselineDecisions: number;
  collisionFailed: boolean;
}

export interface WatchDeps {
  fetchInputs: () => Promise<SlateInputs>;
  /** First board appearance for (game, market); null = history not yet visible. */
  fetchFirstBoardAppearance: (gameId: string, market: MarketKey) => Promise<string | null>;
  fireGame: (
    build: BuildResult,
    inputs: SlateInputs,
    slateDate: string,
    provenance: WatchGateProvenance,
  ) => Promise<FireOutcome>;
  ledgerDir: string;
  /** Handled speculations, pre-populated from disk BEFORE the first tick; keyed `${gameId}:${market}`. */
  ledger: Map<string, SpecLedgerEntry>;
  /** Cache of first-board-appearance instants (immutable once seen); keyed `${gameId}:${market}`. */
  boardFirstSeen: Map<string, string>;
  /** First time each speculation was deferred on a missing history row. */
  deferredSince: Map<string, number>;
  /** Speculations whose prolonged deferral has already been escalated. */
  deferralWarned: Set<string>;
  /** Observability sink for the per-speculation status snapshot each tick. */
  onStatuses?: ((statuses: SpecStatus[]) => void) | undefined;
  /** The markets a league dispatches — the committed allow-list in production
   *  (watchMain wires `enabledMarkets`); a seam so tests can exercise the
   *  fully-independent 3-market path without enabling a league in the real
   *  policy. NEVER a runtime lever: watchMain always passes the versioned map. */
  enabledMarketsFor: (league: string) => MarketKey[];
  nowMs: () => number;
  lateMs: number;
  maxDispatchesPerTick: number;
  maxInputAgeMs: number;
  /** Report-only: never claim, never dispatch, never write a ledger file. */
  rehearse: boolean;
  log: (line: string) => void;
  logError: (line: string) => void;
}

export interface TickSummary {
  gamesInWindow: number;
  /** (game, market) pairs evaluated this tick (excludes already-handled ones). */
  speculations: number;
  /** Speculations newly fired this tick. */
  fired: number;
  /** Billing events (batched dispatches) this tick. */
  dispatches: number;
  /** Speculations newly excluded late this tick. */
  late: number;
  /** Buildable speculations awaiting a first-appearance history row (transient). */
  deferred: number;
  /** Enabled speculations not fireable now (never opened / one-sided / stale / first pitch passed). */
  blocked: number;
  /** Speculations withheld by policy (e.g. the MLB run line). */
  disabled: number;
  /** Speculations already terminal in the ledger (skipped). */
  handled: number;
  /** Per-game failures (fire errors, ledger write failures, malformed rows). */
  failed: number;
  /** True when the per-tick dispatch cap stopped the loop with work remaining. */
  capHit: boolean;
  /** True in report-only mode: everything evaluated, nothing claimed or fired. */
  rehearsal: boolean;
}

function emptySummary(gamesInWindow: number, rehearse: boolean): TickSummary {
  return {
    gamesInWindow,
    speculations: 0,
    fired: 0,
    dispatches: 0,
    late: 0,
    deferred: 0,
    blocked: 0,
    disabled: 0,
    handled: 0,
    failed: 0,
    capHit: false,
    rehearsal: rehearse,
  };
}

/**
 * First board appearance for one (game, market), cached immutably. Returns
 * null while the history row is not yet visible (the ingest writes history
 * before the snapshot, so null is transient — retry next tick). An unparseable
 * or future stamp is refused (never cached, never fired): the runtime accepts
 * only what the scorer will.
 */
async function firstAppearance(
  deps: WatchDeps,
  gameId: string,
  market: MarketKey,
): Promise<string | null> {
  const cacheKey = specKey(gameId, market);
  const cached = deps.boardFirstSeen.get(cacheKey);
  if (cached !== undefined) return cached;
  const first = await deps.fetchFirstBoardAppearance(gameId, market);
  if (first === null) return null;
  if (!Number.isFinite(Date.parse(first))) {
    deps.logError(
      `unparseable first-appearance timestamp for ${gameId} ${market}: ${first} — deferring`,
    );
    return null;
  }
  if (Date.parse(first) > deps.nowMs() + FUTURE_QUOTE_SKEW_MS) {
    // A first appearance meaningfully after detection is rejected — fail
    // closed, never cached, never fired (a legitimately skewed stamp becomes
    // past within one tick). The small skew allowance mirrors the bundle's
    // future-quote tolerance so a cross-host clock jitter is not a stall.
    deps.logError(
      `future first-appearance timestamp for ${gameId} ${market}: ${first} — deferring, not caching`,
    );
    return null;
  }
  deps.boardFirstSeen.set(cacheKey, first);
  return first;
}

interface ReadyMarket {
  market: MarketKey;
  firstAppearanceAt: string;
  openerAgeSeconds: number;
}

interface GamePlan {
  row: GamesEndpointRow;
  slateDate: string;
  evaluation: GameMarketsEval;
  oddsRows: CurrentOddsRow[];
  ready: ReadyMarket[];
  statuses: SpecStatus[];
  /** The snapshot the plan was built from — the bundle's assembly instant. */
  fetchStartedAt: string;
  fetchCompletedAt: string;
}

/**
 * One watch pass: fetch fresh inputs, and for every game evaluate EVERY market
 * independently — universal detection produces a status for all three (a
 * policy-disabled market included), the enabled + buildable ones pass through
 * their own late gate, and the ready ones fire. Games are independent events;
 * one game's failure is logged and never stalls the rest.
 */
export async function watchTick(deps: WatchDeps): Promise<TickSummary> {
  const inputs = await deps.fetchInputs();
  const summary = emptySummary(inputs.gamesRows.length, deps.rehearse);
  const allStatuses: SpecStatus[] = [];

  // Dedupe by gameId; ordered chronologically by parsed first pitch
  // (unparseable last, gameId tiebreak).
  const seenThisTick = new Set<string>();
  const candidates = inputs.gamesRows
    .filter((row) => {
      if (seenThisTick.has(row.gameId)) return false;
      seenThisTick.add(row.gameId);
      return true;
    })
    .sort((a, b) => {
      const ta = Date.parse(a.matchTime);
      const tb = Date.parse(b.matchTime);
      const aBad = !Number.isFinite(ta);
      const bBad = !Number.isFinite(tb);
      if (aBad !== bBad) return aBad ? 1 : -1;
      if (!aBad && ta !== tb) return ta - tb;
      return a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0;
    });

  let currentInputs = inputs;

  // Ensure the working snapshot is fresh, then evaluate one game's markets and
  // classify every speculation. Returns null when the game has left the window.
  const planGame = async (gameId: string): Promise<GamePlan | 'stop' | null> => {
    if (deps.nowMs() - Date.parse(currentInputs.fetchCompletedAt) > FRESH_FIRE_MS) {
      currentInputs = await deps.fetchInputs();
    }
    const assembledAtMs = Date.parse(currentInputs.fetchCompletedAt);
    if (Number.isFinite(assembledAtMs) && deps.nowMs() - assembledAtMs > deps.maxInputAgeMs) {
      deps.logError('inputs still aged after refresh — stopping this tick');
      return 'stop';
    }
    const row = currentInputs.gamesRows.find((g) => g.gameId === gameId);
    if (row === undefined) return null; // left the window between snapshots

    const slateDate = easternCalendarDay(row.matchTime);
    const oddsRows = currentInputs.oddsRows.filter((o) => o.jsonodds_id === row.gameId);
    const oddsMap = new Map(oddsRows.map((o) => [o.market, o]));
    const league = row.sport;
    const enabledForLeague = deps.enabledMarketsFor(league);
    const evaluation = evaluateGameMarkets(row, oddsMap, assembledAtMs, {
      requireFuture: true,
      enabled: enabledForLeague,
    });

    const firstPitchPassed = Date.parse(row.matchTime) <= deps.nowMs();
    const enabled = new Set(enabledForLeague);
    const ready: ReadyMarket[] = [];
    const statuses: SpecStatus[] = [];

    for (const market of MARKET_KEYS) {
      const base = {
        gameId: row.gameId,
        slug: row.slug,
        league,
        market,
        scheduledStartUtc: row.matchTime,
        firstAppearanceAt: null as string | null,
        openerAgeSeconds: null as number | null,
      };

      // Handled forever: report the ledger's terminal decision, never re-fire.
      const handled = deps.ledger.get(specKey(row.gameId, market));
      if (handled !== undefined) {
        statuses.push({
          ...base,
          state: handled.decision === 'fired' ? 'fired' : 'late',
          reason: handled.decision === 'fired' ? 'entered' : 'late_detection',
          firstAppearanceAt: handled.firstAppearanceAt,
          openerAgeSeconds: handled.openerAgeSeconds,
        });
        continue;
      }

      // Universal detection: a policy-disabled market is still recorded.
      if (!enabled.has(market)) {
        statuses.push({ ...base, state: 'disabled', reason: 'policy_disabled' });
        continue;
      }

      if (firstPitchPassed) {
        statuses.push({ ...base, state: 'blocked', reason: 'first_pitch_passed' });
        continue;
      }

      // Not buildable at this snapshot (never opened / one-sided / stale / …).
      if (!evaluation.built.includes(market)) {
        statuses.push({
          ...base,
          state: 'blocked',
          reason: evaluation.reasons[market] ?? 'market_never_opened',
        });
        continue;
      }

      // Buildable → the per-market late gate needs the first appearance.
      const first = await firstAppearance(deps, row.gameId, market);
      const deferKey = specKey(row.gameId, market);
      if (first === null) {
        summary.deferred += 1;
        const since = deps.deferredSince.get(deferKey) ?? deps.nowMs();
        deps.deferredSince.set(deferKey, since);
        if (deps.nowMs() - since > deps.lateMs && !deps.deferralWarned.has(deferKey)) {
          deps.deferralWarned.add(deferKey);
          deps.logError(
            `${row.gameId} ${market} has been deferred longer than the late threshold — ` +
              'the first-appearance history read path may be broken (check the public read grants)',
          );
        }
        statuses.push({ ...base, state: 'deferred', reason: 'deferred' });
        continue;
      }
      deps.deferredSince.delete(deferKey);

      const openerAgeSeconds = Math.max(0, Math.round((deps.nowMs() - Date.parse(first)) / 1000));
      if (deps.nowMs() - Date.parse(first) > deps.lateMs) {
        statuses.push({
          ...base,
          state: 'late',
          reason: 'late_detection',
          firstAppearanceAt: first,
          openerAgeSeconds,
        });
        continue;
      }
      ready.push({ market, firstAppearanceAt: first, openerAgeSeconds });
      statuses.push({
        ...base,
        state: 'ready',
        reason: 'ready',
        firstAppearanceAt: first,
        openerAgeSeconds,
      });
    }

    return {
      row,
      slateDate,
      evaluation,
      oddsRows,
      ready,
      statuses,
      fetchStartedAt: currentInputs.fetchStartedAt,
      fetchCompletedAt: currentInputs.fetchCompletedAt,
    };
  };

  for (const candidate of candidates) {
    try {
      const plan = await planGame(candidate.gameId);
      if (plan === 'stop') break;
      if (plan === null) continue;

      // Tally the non-ready speculations from the plan's statuses.
      for (const status of plan.statuses) {
        // Already-handled speculations are census-only; count them separately.
        if (status.reason === 'entered' || status.reason === 'late_detection') {
          if (deps.ledger.has(specKey(status.gameId, status.market))) {
            summary.handled += 1;
            continue;
          }
        }
        summary.speculations += 1;
        if (status.state === 'disabled') summary.disabled += 1;
        else if (status.state === 'blocked') summary.blocked += 1;
        // 'deferred' already counted in planGame; 'ready'/'late' handled below.
      }

      // Late exclusions discovered this tick (fresh, not already handled): make
      // them terminal now so a stale opener is never entered on a later tick.
      for (const status of plan.statuses) {
        if (status.state !== 'late') continue;
        if (deps.ledger.has(specKey(status.gameId, status.market))) continue;
        summary.late += 1;
        if (deps.rehearse) {
          deps.log(
            `[rehearsal] would exclude ${plan.row.slug} ${status.market}: opener age ` +
              `${status.openerAgeSeconds}s exceeds ${Math.round(deps.lateMs / 1000)}s — late_detection`,
          );
          continue;
        }
        const entry: SpecLedgerEntry = {
          gameId: status.gameId,
          slug: status.slug,
          market: status.market,
          decision: 'late_detection',
          decidedAt: new Date(deps.nowMs()).toISOString(),
          slateDate: plan.slateDate,
          scheduledStartUtc: status.scheduledStartUtc,
          firstAppearanceAt: status.firstAppearanceAt ?? 'unknown',
          openerAgeSeconds: status.openerAgeSeconds ?? -1,
          gameSha256: 'unknown',
          requestSha256: 'unknown',
        };
        deps.ledger.set(specKey(status.gameId, status.market), entry);
        persistLedgerEntry(deps.ledgerDir, entry);
        deps.log(
          `late_detection ${status.slug} ${status.market}: opener age ${status.openerAgeSeconds}s — excluded, never fired`,
        );
      }

      allStatuses.push(...plan.statuses);

      if (plan.ready.length === 0) continue;

      if (deps.rehearse) {
        const list = plan.ready
          .map((r) => `${r.market} (opener ${r.openerAgeSeconds}s)`)
          .join(', ');
        deps.log(`[rehearsal] would fire ${plan.row.slug}: ${list}`);
        summary.fired += plan.ready.length;
        summary.dispatches += 1;
        continue;
      }

      if (summary.dispatches >= deps.maxDispatchesPerTick) {
        summary.capHit = true;
        deps.logError(
          `dispatch cap reached (${deps.maxDispatchesPerTick}) — stopping this tick; remaining speculations re-detected next tick`,
        );
        break;
      }

      await fireReadySpeculations(deps, plan, summary);
      summary.dispatches += 1;
    } catch (error) {
      summary.failed += 1;
      deps.logError(
        `game ${candidate.gameId} failed this tick (${describeError(error)}) — continuing`,
      );
    }
  }

  if (deps.onStatuses !== undefined) deps.onStatuses(allStatuses);
  return summary;
}

/**
 * Fire one game's ready speculations as a single dispatch. Each speculation is
 * claimed in the ledger — memory first, then disk — BEFORE any dispatch, so
 * neither a crash nor a restart can double-bill. The bundle carries exactly the
 * ready markets; the run file records each market's own gate provenance.
 */
async function fireReadySpeculations(
  deps: WatchDeps,
  plan: GamePlan,
  summary: TickSummary,
): Promise<void> {
  const detectedAtMs = deps.nowMs();
  const readyMarkets = plan.ready.map((r) => r.market);
  // The bundle is assembled from the snapshot the plan was built on — its
  // fetch-completion instant is the bundle timestamp, so detection (now, ≥ that
  // instant) never predates its inputs (the scorer verifies exactly that).
  const build = buildScopedResult({
    gameRow: plan.row,
    blocks: plan.evaluation.blocks,
    markets: readyMarkets,
    slug: plan.row.slug,
    slateDate: plan.slateDate,
    bundleTimestamp: plan.fetchCompletedAt,
    oddsRows: plan.oddsRows,
  });
  const request = build.requests[0];
  if (request === undefined) return; // unreachable: ready is non-empty

  const provenance: WatchGateProvenance = {
    detectedAt: new Date(detectedAtMs).toISOString(),
    lateThresholdSeconds: Math.round(deps.lateMs / 1000),
    markets: Object.fromEntries(
      plan.ready.map((r) => [
        r.market,
        { firstAppearanceAt: r.firstAppearanceAt, openerAgeSeconds: r.openerAgeSeconds },
      ]),
    ),
  };

  // Claim every ready speculation before dispatch (memory, then disk).
  const claimed: SpecLedgerEntry[] = [];
  for (const r of plan.ready) {
    const entry: SpecLedgerEntry = {
      gameId: plan.row.gameId,
      slug: plan.row.slug,
      market: r.market,
      decision: 'fired',
      decidedAt: provenance.detectedAt,
      slateDate: plan.slateDate,
      scheduledStartUtc: plan.row.matchTime,
      firstAppearanceAt: r.firstAppearanceAt,
      openerAgeSeconds: r.openerAgeSeconds,
      gameSha256: build.gameHashes[plan.row.gameId] ?? 'unknown',
      requestSha256: request.requestSha256,
    };
    deps.ledger.set(specKey(plan.row.gameId, r.market), entry);
    persistLedgerEntry(deps.ledgerDir, entry);
    claimed.push(entry);
  }

  deps.log(
    `firing ${plan.row.slug} [${readyMarkets.join(', ')}]: request sha256 ${request.requestSha256.slice(0, 16)}…`,
  );

  const fireInputs: SlateInputs = {
    gamesRows: [plan.row],
    oddsRows: plan.oddsRows,
    fetchStartedAt: plan.fetchStartedAt,
    fetchCompletedAt: plan.fetchCompletedAt,
  };
  try {
    const outcome = await deps.fireGame(build, fireInputs, plan.slateDate, provenance);
    for (const entry of claimed) {
      const completed: SpecLedgerEntry = {
        ...entry,
        runId: outcome.runId,
        runFile: outcome.runFile,
        armOutcomes: outcome.armOutcomes,
        baselineDecisions: outcome.baselineDecisions,
        collisionFailed: outcome.collisionFailed,
      };
      deps.ledger.set(specKey(entry.gameId, entry.market), completed);
      persistLedgerEntry(deps.ledgerDir, completed);
    }
    if (outcome.collisionFailed) {
      // A hard identity/collision failure: the file exists but is unscoreable.
      summary.failed += 1;
    } else {
      summary.fired += plan.ready.length;
    }
  } catch (error) {
    for (const entry of claimed) {
      const failed: SpecLedgerEntry = { ...entry, fireError: describeError(error) };
      deps.ledger.set(specKey(entry.gameId, entry.market), failed);
      persistLedgerEntry(deps.ledgerDir, failed);
    }
    summary.failed += 1;
    deps.logError(`fire failed for ${plan.row.slug} (${plan.row.gameId}): ${describeError(error)}`);
  }
}

// ---------------------------------------------------------------------------
// The per-fire decision event (real providers + baselines + records)
// ---------------------------------------------------------------------------

export interface FireConfig {
  arms: ArmSpec[];
  adapters: Map<string, ProviderAdapter>;
  approvedReportedModelIds: (participantId: string) => string[];
  outDir: string;
  timeoutMs: number;
  maxOutputTokens: number;
  mode: 'dry-run' | 'live';
  clockMode: 'wall' | 'synthetic-fixture';
  nowMs: () => number;
  log: (line: string) => void;
  logError: (line: string) => void;
}

export async function fireEligibleGame(
  build: BuildResult,
  inputs: SlateInputs,
  slateDate: string,
  provenance: WatchGateProvenance,
  cfg: FireConfig,
): Promise<FireOutcome> {
  const watch: WatchProvenance = {
    detectedAt: provenance.detectedAt,
    lateThresholdSeconds: provenance.lateThresholdSeconds,
    markets: provenance.markets,
  };
  const ctx: RunContext = {
    runId: `watch-v0-${slateDate}-${randomBytes(3).toString('hex')}`,
    cohortId: `watch-v0-${slateDate}`,
    mode: cfg.mode,
    slateDate,
    createdAt: new Date(cfg.nowMs()).toISOString(),
    executionPolicy: 'fixed-moneyline-total',
    timeoutMs: cfg.timeoutMs,
    maxOutputTokens: cfg.maxOutputTokens,
    fetchStartedAt: inputs.fetchStartedAt,
    fetchCompletedAt: inputs.fetchCompletedAt,
    clockMode: cfg.clockMode,
    watch,
  };

  const armGameResults = await runSlate(cfg.arms, cfg.adapters, build.requests, {
    cohortId: ctx.cohortId,
    timeoutMs: ctx.timeoutMs,
    maxOutputTokens: ctx.maxOutputTokens,
    nowMs: cfg.nowMs,
    onGameComplete: (line) => cfg.log(`  ${line}`),
  });

  const baselineDecisions = runBaselines(build.slateBundle);
  const reportedByArm = reportedModelIdsByArm(armGameResults);
  const unidentifiedByArm = unidentifiedResponsesByArm(armGameResults);
  const collision = checkProviderCollision(
    cfg.arms.map((arm) => ({
      participantId: arm.participantId,
      provider: arm.provider,
      requestedModelId: arm.requestedModelId,
      approvedReportedModelIds: cfg.approvedReportedModelIds(arm.participantId),
      reportedModelIds: reportedByArm.get(arm.participantId) ?? [],
      unidentifiedResponses: unidentifiedByArm.get(arm.participantId) ?? 0,
    })),
  );

  const records = buildRecords(ctx, build, armGameResults, baselineDecisions, collision);
  const runFile = join(cfg.outDir, `${ctx.runId}.ndjson`);
  writeNdjson(runFile, records);
  writeText(
    join(cfg.outDir, `${ctx.runId}-summary.md`),
    buildSummaryMarkdown(ctx, build, armGameResults, baselineDecisions, collision),
  );

  const armOutcomes: Record<string, ArmOutcome> = {};
  for (const result of armGameResults) {
    armOutcomes[result.arm.participantId] = result.outcome;
  }
  if (collision.failures.length > 0) {
    const codes = [...failuresByCode(collision.failures).keys()];
    cfg.logError(`!!! ${ctx.runId} FAILED — ${codes.join(' + ')} (file kept, permanently unscoreable) !!!`);
    for (const failure of collision.failures) cfg.logError(`  ${failure}`);
  }
  return {
    runId: ctx.runId,
    runFile,
    armOutcomes,
    baselineDecisions: baselineDecisions.length,
    collisionFailed: collision.failures.length > 0,
  };
}
