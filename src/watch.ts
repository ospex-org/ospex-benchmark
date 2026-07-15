import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runBaselines } from './baselines.js';
import { buildScopedResult, evaluateGameMarkets } from './bundle.js';
import { describeError } from './config.js';
import { LATE_THRESHOLD_MS } from './marketPolicy.js';
import { MARKET_KEYS } from './markets.js';
import { checkProviderCollision } from './providers/family.js';
import {
  buildRecords,
  failuresByCode,
  reportedModelIdsByArm,
  unidentifiedResponsesByArm,
  writeNdjson,
  writeText,
  writeTextExclusive,
} from './records.js';
import { runSlate } from './runner.js';
import { easternCalendarDay } from './slateDate.js';
import { buildSummaryMarkdown } from './summary.js';
import type { BuildResult, GameMarketsEval } from './bundle.js';
import type { RunContext, SpeculationDisposition, WatchProvenance } from './records.js';
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

/** The committed entry-honesty threshold lives in marketPolicy (the frozen-
 *  preregistration home) so the watcher AND the scorer pin to ONE constant.
 *  Re-exported here for the watcher's existing consumers. NOT a CLI flag. */
export { LATE_THRESHOLD_MS };

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
  /** Explicit acknowledgement of the DESTRUCTIVE live path (real fires, real
   *  spend, irreversible ledger claims). Required to fire; plain `yarn watch`
   *  is fail-closed and refuses without it. */
  live: boolean;
  outDir: string;
  /** True when --out was passed explicitly (dry runs default elsewhere). */
  outDirExplicit: boolean;
  pollSeconds: number;
  windowHours: number;
  maxDispatchesPerTick: number;
  timeoutSeconds: number | null;
  maxOutputTokens: number;
}

export const WATCH_USAGE = `Usage: yarn watch (--live | --rehearse | --dry-run) [options]

A mode is REQUIRED — plain \`yarn watch\` is fail-closed and refuses, because the
live path fires real model calls, bills real money, and makes irreversible
ledger claims. Run --rehearse first and review its output before --live.

Modes:
  --live                 DESTRUCTIVE: real fires against live data. Validates
                         every model-provider credential before any claim and
                         refuses to boot if one is missing.
  --dry-run              One pass against the fixture slate and mock providers
                         (no credentials, no network, implies --once).
  --rehearse             Report-only: evaluate every speculation and print what
                         WOULD fire, writing no ledger and dispatching nothing.
                         Mandatory before a first live boot (implies --once).

Options:
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
    live: false,
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
      case '--live':
        options.live = true;
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
  /** The dispatch lifecycle of a `fired` claim, so a crash in the tiny
   *  claim→dispatch gap is DURABLE and detectable on restart:
   *   - `'pending'`   claimed, provider dispatch not yet completed (written at
   *                   claim time). A claim stranded in this state is a crash
   *                   between claim and dispatch — terminal, but `fire_interrupted`,
   *                   NEVER a clean `entered`.
   *   - `'completed'` the dispatch produced a scoreable cohort — a clean entry.
   *   - `'failed'`    the dispatch billed but produced no scoreable cohort
   *                   (collision / credential-missing / dud / thrown / stale) —
   *                   terminal `fire_failed`.
   *  Absent on `late_detection` entries (they never dispatch). */
  dispatchStatus?: 'pending' | 'completed' | 'failed' | undefined;
}

/**
 * A `fired` ledger entry is a CLEAN entry (renders `entered`) only if its
 * dispatch durably COMPLETED without a failure signal. Completion evidence is
 * `dispatchStatus === 'completed'` (or, for an entry adopted from another
 * instance / a legacy file, a recorded `runId`). Anything else — a `pending`
 * claim (crash in the claim→dispatch gap), an explicit `'failed'`, a
 * `fireError`, or a collision — is terminal but is NOT a clean entry.
 */
export function firedEntryIsCleanEntry(entry: SpecLedgerEntry): boolean {
  if (entry.decision !== 'fired') return false;
  if (entry.fireError !== undefined) return false;
  if (entry.collisionFailed === true) return false;
  if (entry.dispatchStatus === 'pending' || entry.dispatchStatus === 'failed') return false;
  return entry.dispatchStatus === 'completed' || entry.runId !== undefined;
}

/**
 * A `fired` claim whose dispatch never completed and carries no explicit
 * failure signal — a crash between the (durable) claim and the dispatch. It is
 * terminal (never re-fired: providers may already have been billed) but renders
 * `fire_interrupted`, distinct from a `fire_failed` dispatch that ran and failed.
 */
export function firedEntryInterrupted(entry: SpecLedgerEntry): boolean {
  return (
    entry.decision === 'fired' &&
    !firedEntryIsCleanEntry(entry) &&
    entry.fireError === undefined &&
    entry.collisionFailed !== true &&
    entry.dispatchStatus !== 'failed'
  );
}

/** The live state of one speculation this tick — the observability + (in
 *  PR B) denominator record. Distinct from the ledger, which holds only
 *  terminal decisions. */
export type SpecState = 'disabled' | 'blocked' | 'deferred' | 'ready' | 'fired' | 'late' | 'failed';

export interface SpecStatus {
  gameId: string;
  slug: string;
  league: string;
  market: MarketKey;
  state: SpecState;
  /** Machine-readable reason (policy_disabled, market_never_opened, one_sided,
   *  stale_quote, deferred, first_pitch_passed, late_detection, entered, …). */
  reason: string;
  /** First BOARD appearance from odds_history (read only for enabled markets we
   *  act on). Null for markets we never gate (disabled / not-yet-built). */
  firstAppearanceAt: string | null;
  openerAgeSeconds: number | null;
  /** Whether the market was PRESENT in this tick's current-odds snapshot, and
   *  its quote timestamp if so — universal-detection evidence for markets we do
   *  NOT read history for (a policy-disabled run line that appeared is
   *  distinguishable from one that never did). Null = absent from the snapshot. */
  snapshotObservedAt: string | null;
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
 * Exclusive-create claim: writes the initial claim file only if it does not yet
 * exist, returning true iff THIS call won the claim. On a shared filesystem two
 * watcher instances cannot both win, so they cannot both dispatch (double-bill)
 * the speculation — the "one instance" rule becomes a billing-safety guarantee,
 * not just an operator convention. Later writes (completion, failure) overwrite.
 */
export function claimLedgerEntryExclusive(ledgerDir: string, entry: SpecLedgerEntry): boolean {
  return writeTextExclusive(
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
      if (!MARKET_KEYS.includes(market)) {
        // A ledger file with an unrecognized market stem is a migration or
        // corruption signal — surface it rather than silently ignoring it.
        logError(
          `ledger entry ${gameId}/${name} has an unrecognized market name — skipped (migration or corruption?)`,
        );
        continue;
      }
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
  /** True when the fire did not produce a scoreable cohort — a required arm was
   *  credential-missing (a structural config error, not a transient miss) or no
   *  arm produced a valid response at all. Such a fire is durably FAILED, never
   *  a clean entry, and it exits `--once` nonzero. Optional so synthetic test
   *  outcomes may omit it (treated as false). */
  fireFailed?: boolean | undefined;
  failureReason?: string | undefined;
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
    dispositions: SpeculationDisposition[],
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
  if (Date.parse(first) > deps.nowMs()) {
    // ANY first appearance after the current instant is rejected — never
    // cached, never fired. This is STRICT (no future-skew grace) so the runtime
    // accepts only what the scorer will: the scorer refuses a firstAppearance
    // after detection outright, and detection is sampled no earlier than this
    // read, so a stamp we fire on is always ≤ detectedAt. A legitimately
    // cross-clock-skewed stamp simply becomes past within one poll and fires
    // then — deferring it one tick is safe; firing it stale is not.
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
  // classify every speculation. PURE with respect to the tick summary — it has
  // NO summary side effects (so it can be safely re-run to re-prepare on a
  // fresh snapshot); the caller tallies from the returned statuses. Returns
  // null when the game has left the window.
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
      // Universal-detection evidence, read for FREE from the snapshot: whether
      // this market appeared at all, and its quote time if so. Recorded for
      // every market — including ones we never read history for (a disabled run
      // line that appeared is now distinguishable from one that never did).
      const base = {
        gameId: row.gameId,
        slug: row.slug,
        league,
        market,
        scheduledStartUtc: row.matchTime,
        firstAppearanceAt: null as string | null,
        openerAgeSeconds: null as number | null,
        snapshotObservedAt: oddsMap.get(market)?.upstream_last_updated ?? null,
      };

      // Handled forever: report the ledger's terminal decision, never re-fire.
      // A `fired` claim is a clean `entered` only if its dispatch durably
      // COMPLETED. A stranded `pending` claim (a crash in the claim→dispatch
      // gap) renders `fire_interrupted`; a dispatch that ran and failed renders
      // `fire_failed`. Neither ever re-appears as `entered` in the durable
      // coverage, and neither is ever re-fired.
      const handled = deps.ledger.get(specKey(row.gameId, market));
      if (handled !== undefined) {
        const clean = firedEntryIsCleanEntry(handled);
        const interrupted = firedEntryInterrupted(handled);
        const isLate = handled.decision === 'late_detection';
        statuses.push({
          ...base,
          state: isLate ? 'late' : clean ? 'fired' : 'failed',
          reason: isLate
            ? 'late_detection'
            : clean
              ? 'entered'
              : interrupted
                ? 'fire_interrupted'
                : 'fire_failed',
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

      // Not buildable at this snapshot. A game-level exclusion (a non-upcoming
      // status) is the true reason and takes precedence over the per-market
      // fallback, so the denominator records `status:postponed` rather than a
      // misleading `market_never_opened`.
      if (!evaluation.built.includes(market)) {
        statuses.push({
          ...base,
          state: 'blocked',
          reason:
            evaluation.gameExcludedReason ??
            evaluation.reasons[market] ??
            'market_never_opened',
        });
        continue;
      }

      // Buildable → the per-market late gate needs the first appearance. A
      // THROWN read (network/permission) is fault-isolated to THIS market: it
      // is a failure, but the game's other markets still evaluate and the
      // game still yields a plan (so its denominator/coverage is never lost).
      const deferKey = specKey(row.gameId, market);
      let first: string | null;
      try {
        first = await firstAppearance(deps, row.gameId, market);
      } catch (error) {
        deps.logError(
          `board-appearance read failed for ${row.gameId} ${market} (${describeError(error)}) — market excluded this tick`,
        );
        statuses.push({ ...base, state: 'blocked', reason: 'board_read_failed' });
        continue;
      }
      if (first === null) {
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

  // Re-fetch ONLY the price snapshot — never the board — so a fire enters on the
  // freshest prices the feed can provide, even when THIS game's board reads were
  // slow enough to age the snapshot it was planned on. First appearances are
  // cached and immutable, so this does NO history read: a slow or deferred
  // sibling market (an uncached null/failed read) can never re-stale the
  // refreshed snapshot (the bug a re-plan through planGame reintroduced —
  // planGame re-reads every market, re-hanging on the uncached one). Returns the
  // plan UNCHANGED when the feed cannot produce anything newer (a fixed dry-run
  // fixture / stuck feed — its capturedAt does not advance, so there is nothing
  // fresher to fire on); 'stop' when even the refreshed snapshot is beyond
  // maxInputAge; or null if the game left the window during the refresh.
  const refreshPricesForFire = async (plan: GamePlan): Promise<GamePlan | 'stop' | null> => {
    const fresh = await deps.fetchInputs();
    const freshMs = Date.parse(fresh.fetchCompletedAt);
    if (!(Number.isFinite(freshMs) && freshMs > Date.parse(plan.fetchCompletedAt))) {
      return plan; // feed can't get fresher — fire on the freshest snapshot it has
    }
    currentInputs = fresh;
    if (deps.nowMs() - freshMs > deps.maxInputAgeMs) {
      deps.logError('inputs still aged after refresh — stopping this tick');
      return 'stop';
    }
    const row = fresh.gamesRows.find((g) => g.gameId === plan.row.gameId);
    if (row === undefined) return null; // left the window during the refresh
    const oddsRows = fresh.oddsRows.filter((o) => o.jsonodds_id === row.gameId);
    const oddsMap = new Map(oddsRows.map((o) => [o.market, o]));
    const evaluation = evaluateGameMarkets(row, oddsMap, freshMs, {
      requireFuture: true,
      enabled: deps.enabledMarketsFor(row.sport),
    });
    // Fire only markets STILL buildable on the fresh prices; a ready market whose
    // fresh quote vanished or went stale is dropped (never fired on a stale
    // price) and its status re-flagged from the fresh evaluation. The gate
    // (opener age, from the immutable first appearance) is recomputed at
    // detection in prepareFire, so it is unaffected by the price refresh.
    const built = new Set(evaluation.built);
    const ready = plan.ready.filter((r) => built.has(r.market));
    const statuses: SpecStatus[] = plan.statuses.map((s) => {
      const snapshotObservedAt = oddsMap.get(s.market)?.upstream_last_updated ?? null;
      if (s.state === 'ready' && !built.has(s.market)) {
        return {
          ...s,
          state: 'blocked',
          reason: evaluation.gameExcludedReason ?? evaluation.reasons[s.market] ?? 'market_never_opened',
          snapshotObservedAt,
        };
      }
      return { ...s, snapshotObservedAt };
    });
    return {
      ...plan,
      row,
      oddsRows,
      evaluation,
      ready,
      statuses,
      fetchStartedAt: fresh.fetchStartedAt,
      fetchCompletedAt: fresh.fetchCompletedAt,
    };
  };

  /** Tally every non-fire counter from a plan's statuses. Any status derived
   *  from a ledger entry is already handled (census-only). Fire counters are
   *  set at the dispatch site. */
  const tally = (plan: GamePlan): void => {
    for (const status of plan.statuses) {
      if (deps.ledger.has(specKey(status.gameId, status.market))) {
        summary.handled += 1;
        continue;
      }
      summary.speculations += 1;
      if (status.state === 'disabled') summary.disabled += 1;
      else if (status.state === 'deferred') summary.deferred += 1;
      else if (status.state === 'blocked' && status.reason === 'board_read_failed') {
        summary.failed += 1;
      } else if (status.state === 'blocked') summary.blocked += 1;
      // 'ready' → dispatch; 'late' → the late loop below.
    }
  };

  // Serial plan+claim, but each game's dispatch is LAUNCHED immediately (never
  // deferred to a second phase) and collected — so a later game's slow board
  // read can never delay an earlier, already-claimed game's in-flight fire, and
  // the claim→dispatch gap for any game is a single synchronous step with no
  // await, minimizing the window in which a crash could strand a `pending` claim
  // (which, if it happens anyway, restarts as `fire_interrupted`, never entered).
  const dispatchPromises: Array<Promise<void>> = [];
  for (const candidate of candidates) {
    try {
      let plan = await planGame(candidate.gameId);
      if (plan === 'stop') break;
      if (plan === null) continue;

      // Fire-at-detection: the board reads can be slow; if they aged the
      // snapshot and this game has ready work, refresh the PRICES on a fresh
      // snapshot so the fire enters on current prices — WITHOUT re-reading the
      // board (which would re-hang on an uncached deferred market and re-stale
      // the snapshot). The tally runs on the final (refreshed) plan only.
      if (
        !deps.rehearse &&
        plan.ready.length > 0 &&
        deps.nowMs() - Date.parse(plan.fetchCompletedAt) > FRESH_FIRE_MS
      ) {
        const refreshed = await refreshPricesForFire(plan);
        if (refreshed === 'stop') break;
        if (refreshed === null) continue; // left the window during the refresh
        plan = refreshed;
      }

      tally(plan);

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

      if (plan.ready.length === 0) {
        allStatuses.push(...plan.statuses);
        continue;
      }

      if (deps.rehearse) {
        const list = plan.ready.map((r) => `${r.market} (opener ${r.openerAgeSeconds}s)`).join(', ');
        deps.log(`[rehearsal] would fire ${plan.row.slug}: ${list}`);
        summary.fired += plan.ready.length;
        summary.dispatches += 1;
        allStatuses.push(...plan.statuses);
        continue;
      }

      if (summary.dispatches >= deps.maxDispatchesPerTick) {
        summary.capHit = true;
        deps.logError(
          `dispatch cap reached (${deps.maxDispatchesPerTick}) — stopping this tick; remaining speculations re-detected next tick`,
        );
        allStatuses.push(...plan.statuses);
        break;
      }

      const ctx = prepareFire(deps, plan, summary);
      if (ctx === null) {
        // Nothing dispatched (all gated markets aged out, or all claims lost) —
        // no dispatch counter increment.
        allStatuses.push(...plan.statuses);
        continue;
      }
      summary.dispatches += 1; // a real dispatch happens as soon as it's launched below

      // Launch the dispatch NOW — concurrently with the rest of the loop,
      // including the next game's board read. Its statuses are pushed AFTER the
      // dispatch reconciles fired/failed, so the snapshot never shows a stale
      // `ready` for a market that has already fired.
      dispatchPromises.push(
        (async (fireCtx: FireContext): Promise<void> => {
          try {
            const { fired, failed } = await dispatchFire(deps, fireCtx, summary);
            const firedSet = new Set(fired);
            const failedSet = new Set(failed);
            for (const status of fireCtx.plan.statuses) {
              if (firedSet.has(status.market)) {
                status.state = 'fired';
                status.reason = 'entered';
              } else if (failedSet.has(status.market)) {
                status.state = 'failed';
                status.reason = 'fire_failed';
              }
            }
          } catch (error) {
            summary.failed += 1;
            deps.logError(`dispatch failed for ${fireCtx.plan.row.slug} (${describeError(error)})`);
          }
          allStatuses.push(...fireCtx.plan.statuses);
        })(ctx),
      );
    } catch (error) {
      summary.failed += 1;
      deps.logError(`game ${candidate.gameId} failed this tick (${describeError(error)}) — continuing`);
    }
  }

  // Await every launched dispatch before publishing the status snapshot.
  await Promise.all(dispatchPromises);

  // Publish the per-speculation status snapshot / coverage denominator. A
  // failure in this sink (e.g. a coverage-log append that cannot be persisted)
  // is NOT swallowed: it fails the tick — nonzero `--once`, observably failed in
  // the long-running loop — so the published denominator can never silently go
  // missing while the pass still reports success.
  if (deps.onStatuses !== undefined) {
    try {
      deps.onStatuses(allStatuses);
    } catch (error) {
      summary.failed += 1;
      deps.logError(`status/coverage sink failed this tick (${describeError(error)}) — tick marked failed`);
    }
  }
  return summary;
}

/** A claimed, built, ready-to-dispatch fire — the output of the SERIAL prepare
 *  phase, dispatched CONCURRENTLY so no game waits on another's provider call. */
interface FireContext {
  plan: GamePlan;
  build: BuildResult;
  provenance: WatchGateProvenance;
  dispositions: SpeculationDisposition[];
  claimed: Array<{ market: MarketKey; entry: SpecLedgerEntry }>;
}

/**
 * SERIAL phase: gate on ONE detection instant, EXCLUSIVE-CREATE-claim the won
 * speculations, build the scoped bundle, and assemble the denominator. Returns
 * null when nothing is claimed (all gated markets aged out, or all claims lost
 * to another instance). Pure/synchronous and fast (board data is cached, claims
 * are local disk), so a slate's games are all prepared quickly — the slow
 * provider dispatch is deferred to the concurrent phase.
 */
function prepareFire(deps: WatchDeps, plan: GamePlan, summary: TickSummary): FireContext | null {
  // ONE detection instant, and every market's opener age recomputed against it,
  // so the recorded provenance is internally consistent (the scorer recomputes
  // openerAge = detectedAt − firstAppearance). A ready market that aged past the
  // gate during the (network) board reads is DROPPED, never fired stale.
  const detectedAtMs = deps.nowMs();
  const detectedAt = new Date(detectedAtMs).toISOString();
  const gated = plan.ready
    .map((r) => ({ market: r.market, firstAppearanceAt: r.firstAppearanceAt, ageMs: detectedAtMs - Date.parse(r.firstAppearanceAt) }))
    .filter((r) => r.ageMs <= deps.lateMs)
    .map((r) => ({ market: r.market, firstAppearanceAt: r.firstAppearanceAt, openerAgeSeconds: Math.max(0, Math.round(r.ageMs / 1000)) }));
  if (gated.length === 0) return null;

  const claimed: FireContext['claimed'] = [];
  const claimedInfo = new Map<MarketKey, { firstAppearanceAt: string; openerAgeSeconds: number }>();
  try {
    for (const r of gated) {
      const key = specKey(plan.row.gameId, r.market);
      if (deps.ledger.has(key)) continue; // already handled in-process
      const entry: SpecLedgerEntry = {
        gameId: plan.row.gameId,
        slug: plan.row.slug,
        market: r.market,
        decision: 'fired',
        decidedAt: detectedAt,
        slateDate: plan.slateDate,
        scheduledStartUtc: plan.row.matchTime,
        firstAppearanceAt: r.firstAppearanceAt,
        openerAgeSeconds: r.openerAgeSeconds,
        gameSha256: 'pending',
        requestSha256: 'pending',
        // Written to disk NOW, before any provider call: a crash before dispatch
        // completes leaves this `pending` claim, which restarts as
        // `fire_interrupted`, never a clean `entered`.
        dispatchStatus: 'pending',
      };
      if (!claimLedgerEntryExclusive(deps.ledgerDir, entry)) {
        // Another instance owns this claim — adopt its record, never retry.
        try {
          deps.ledger.set(key, JSON.parse(readFileSync(ledgerPath(deps.ledgerDir, entry.gameId, entry.market), 'utf8')) as SpecLedgerEntry);
        } catch {
          deps.ledger.set(key, { ...entry, fireError: 'claimed by another instance' });
        }
        deps.logError(`claim for ${plan.row.slug} ${r.market} lost to another instance — skipped`);
        continue;
      }
      deps.ledger.set(key, entry);
      claimed.push({ market: r.market, entry });
      claimedInfo.set(r.market, { firstAppearanceAt: r.firstAppearanceAt, openerAgeSeconds: r.openerAgeSeconds });
    }
  } catch (error) {
    for (const c of claimed) {
      deps.ledger.delete(specKey(c.entry.gameId, c.entry.market));
      try {
        rmSync(ledgerPath(deps.ledgerDir, c.entry.gameId, c.entry.market), { force: true });
      } catch {
        // best-effort rollback; the surfaced failure is the signal
      }
    }
    summary.failed += 1;
    deps.logError(`claim failed for ${plan.row.slug} (${plan.row.gameId}) — rolled back, nothing dispatched: ${describeError(error)}`);
    return null;
  }
  if (claimed.length === 0) return null;

  const wonMarkets = claimed.map((c) => c.market);
  const wonSet = new Set(wonMarkets);
  const build = buildScopedResult({
    gameRow: plan.row,
    blocks: plan.evaluation.blocks,
    markets: wonMarkets,
    slug: plan.row.slug,
    slateDate: plan.slateDate,
    bundleTimestamp: plan.fetchCompletedAt,
    oddsRows: plan.oddsRows,
  });
  const request = build.requests[0];
  if (request === undefined) return null;

  const gameSha = build.gameHashes[plan.row.gameId] ?? 'unknown';
  for (const c of claimed) {
    c.entry.gameSha256 = gameSha;
    c.entry.requestSha256 = request.requestSha256;
    try {
      persistLedgerEntry(deps.ledgerDir, c.entry);
    } catch {
      // the exclusive claim file already exists; hashes are informational
    }
  }

  const provenance: WatchGateProvenance = {
    detectedAt,
    lateThresholdSeconds: Math.round(deps.lateMs / 1000),
    markets: Object.fromEntries(
      claimed.map((c) => {
        const info = claimedInfo.get(c.market);
        return [c.market, { firstAppearanceAt: info?.firstAppearanceAt ?? 'unknown', openerAgeSeconds: info?.openerAgeSeconds ?? -1 }];
      }),
    ),
  };

  const dispositions: SpeculationDisposition[] = plan.statuses.map((status) => {
    const entered = wonSet.has(status.market);
    return {
      gameId: status.gameId,
      slug: status.slug,
      league: status.league,
      market: status.market,
      decision: entered ? 'entered' : 'not_entered',
      reason: entered ? 'entered' : status.state === 'ready' ? 'late_detection' : status.reason,
      firstAppearanceAt: status.firstAppearanceAt,
      openerAgeSeconds: status.openerAgeSeconds,
      snapshotObservedAt: status.snapshotObservedAt,
      scheduledStartUtc: status.scheduledStartUtc,
    };
  });

  return { plan, build, provenance, dispositions, claimed };
}

/**
 * CONCURRENT phase: dispatch one prepared fire and finalize its ledger.
 * Returns which markets fired vs failed, for status-snapshot reconciliation.
 * Games' dispatches run concurrently, so a slow provider call on one game never
 * delays another game's fire past its own opener.
 */
async function dispatchFire(
  deps: WatchDeps,
  ctx: FireContext,
  summary: TickSummary,
): Promise<{ fired: MarketKey[]; failed: MarketKey[] }> {
  const { plan, build, provenance, dispositions, claimed } = ctx;
  const wonMarkets = claimed.map((c) => c.market);
  deps.log(
    `firing ${plan.row.slug} [${wonMarkets.join(', ')}]: request sha256 ${build.requests[0]?.requestSha256.slice(0, 16) ?? '????'}…`,
  );
  const fireInputs: SlateInputs = {
    gamesRows: [plan.row],
    oddsRows: plan.oddsRows,
    fetchStartedAt: plan.fetchStartedAt,
    fetchCompletedAt: plan.fetchCompletedAt,
  };

  // Secondary guard on the CLAIM→DISPATCH gap, immediately before the provider
  // call. Price freshness itself is guaranteed upstream by refreshPricesForFire
  // (the fire enters on the freshest snapshot the feed can provide); this only
  // backstops the gap between the claim's detection instant and the dispatch.
  // Dispatch is launched synchronously right after the claim, so the gap is ~0 —
  // but if a future change ever reintroduced an await there, a snapshot could
  // stale in the gap, and that must NEVER be entered. If the gap exceeds
  // FRESH_FIRE_MS the claim is a durable FAILED fire (no provider call, no
  // billing) — recorded honestly, not entered on stale prices.
  if (deps.nowMs() - Date.parse(provenance.detectedAt) > FRESH_FIRE_MS) {
    const reason = 'dispatch lagged the claim by more than FRESH_FIRE_MS — the snapshot may have staled; not entered';
    for (const c of claimed) {
      const staled: SpecLedgerEntry = { ...c.entry, dispatchStatus: 'failed', fireError: reason };
      deps.ledger.set(specKey(c.entry.gameId, c.entry.market), staled);
      try {
        persistLedgerEntry(deps.ledgerDir, staled);
      } catch {
        // the claim already prevents a re-fire this process
      }
    }
    summary.failed += 1;
    deps.logError(`fire aborted for ${plan.row.slug} (${plan.row.gameId}): ${reason}`);
    return { fired: [], failed: wonMarkets };
  }

  let outcome: FireOutcome;
  try {
    outcome = await deps.fireGame(build, fireInputs, plan.slateDate, provenance, dispositions);
  } catch (error) {
    // A terminal fire FAILURE gets its own durable reason AND a `failed`
    // dispatch status — it must never later render as a clean `entered`.
    for (const c of claimed) {
      const failed: SpecLedgerEntry = { ...c.entry, dispatchStatus: 'failed', fireError: describeError(error) };
      deps.ledger.set(specKey(c.entry.gameId, c.entry.market), failed);
      try {
        persistLedgerEntry(deps.ledgerDir, failed);
      } catch {
        // the claim already prevents a re-fire this process
      }
    }
    summary.failed += 1;
    deps.logError(`fire failed for ${plan.row.slug} (${plan.row.gameId}): ${describeError(error)}`);
    return { fired: [], failed: wonMarkets };
  }

  // The dispatch completed — providers were billed. But it is a clean ENTRY
  // only if the cohort is scoreable: a provider collision, a credential-missing
  // arm, or a total dud is a FAILED fire, recorded with durable failure evidence
  // (`fireError`) so it renders `fire_failed`, never a clean `entered`, on any
  // later tick. A completion-write failure alone does NOT downgrade a real fire.
  const unscoreable = outcome.collisionFailed || outcome.fireFailed;
  const failureReason =
    outcome.failureReason ?? (outcome.collisionFailed ? 'provider collision (unscoreable)' : undefined);
  for (const c of claimed) {
    const completed: SpecLedgerEntry = {
      ...c.entry,
      runId: outcome.runId,
      runFile: outcome.runFile,
      armOutcomes: outcome.armOutcomes,
      baselineDecisions: outcome.baselineDecisions,
      collisionFailed: outcome.collisionFailed,
      // The dispatch ran: `completed` (clean, scoreable) or `failed` (billed but
      // unscoreable). Either way the claim leaves `pending`, so a crash can no
      // longer be mistaken for a clean entry.
      dispatchStatus: unscoreable ? 'failed' : 'completed',
      ...(unscoreable ? { fireError: failureReason } : {}),
    };
    deps.ledger.set(specKey(c.entry.gameId, c.entry.market), completed);
    try {
      persistLedgerEntry(deps.ledgerDir, completed);
    } catch (error) {
      deps.logError(
        `completion-write failed for ${plan.row.slug} ${c.market} (run ${outcome.runFile}) — ledger link may be stale: ${describeError(error)}`,
      );
    }
  }
  if (unscoreable) {
    summary.failed += 1;
    return { fired: [], failed: wonMarkets };
  }
  summary.fired += wonMarkets.length;
  return { fired: wonMarkets, failed: [] };
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
  dispositions: SpeculationDisposition[] = [],
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

  // Terminal fire validity, computed BEFORE the records are written. A fire is
  // a clean entry only if it produced a scoreable cohort: a credential-missing
  // arm is a STRUCTURAL failure (that arm never participated — a misconfig, not
  // a transient miss), and a fire in which NO arm produced a valid response is a
  // total dud. Either is a FAILED fire, never a clean entry. A single transient
  // miss while other arms succeed is a normal partial fire and still counts.
  const credentialMissing = armGameResults.filter((r) => r.outcome === 'credential_missing');
  const anyValid = armGameResults.some((r) => r.outcome === 'valid');
  const fireFailed = credentialMissing.length > 0 || !anyValid;
  const failureReason =
    credentialMissing.length > 0
      ? `credential_missing: ${credentialMissing.map((r) => r.arm.participantId).join(', ')}`
      : !anyValid
        ? 'no arm produced a valid response'
        : undefined;
  // Record the terminal failure IN THE ARTIFACT (a FIRE_FAILED run_failure) so
  // the scorer refuses it on the file alone — the ledger is a separate,
  // runner-local audit trail that a published/archived run file does not carry.
  const terminalFailures = fireFailed
    ? [{ code: 'FIRE_FAILED', failures: [failureReason ?? 'fire produced no scoreable cohort'] }]
    : [];

  const records = buildRecords(
    ctx,
    build,
    armGameResults,
    baselineDecisions,
    collision,
    dispositions,
    terminalFailures,
  );
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
  if (fireFailed) {
    cfg.logError(`!!! ${ctx.runId} FIRE FAILED — ${failureReason} (board claimed, no scoreable cohort) !!!`);
  }

  return {
    runId: ctx.runId,
    runFile,
    armOutcomes,
    baselineDecisions: baselineDecisions.length,
    collisionFailed: collision.failures.length > 0,
    fireFailed,
    failureReason,
  };
}
