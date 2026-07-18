import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBaselines } from './baselines.js';
import { buildBundle } from './bundle.js';
import { describeError } from './config.js';
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
import type { BuildResult } from './bundle.js';
import type { RunContext } from './records.js';
import type {
  ArmOutcome,
  ArmSpec,
  MarketKey,
  ProviderAdapter,
  SlateInputs,
} from './types.js';

/**
 * Line-open watch mode — fire-at-detection only (docs/LINE_OPEN_RUNNER.md).
 *
 * The watcher polls the same public read path the smoke uses and, the moment
 * a game becomes ELIGIBLE (the existing bundle builder yields a request for
 * it — full board, two-sided, fresh quotes), it assembles, hashes, and fires
 * that one game to all twelve participants in the same breath, then records it
 * in a per-game ledger and never touches it again.
 *
 * There is deliberately NO separate detection predicate: eligibility is
 * "buildBundle produced a GameRequest", so detection can never drift from
 * what participants are actually given. And there is deliberately NO
 * deferred firing: a bundle is used the instant it is built or not at all —
 * a harness that fires later has watched the line move in between, which is
 * a cherry-pick surface no matter how honest the operator.
 *
 * Entry honesty is enforced by the late-detection gate: at detection the
 * watcher computes the board-completion instant (the NEWEST of the three
 * markets' first board appearances) and games whose boards completed more
 * than the late threshold ago are recorded as `late_detection` and never
 * fired — watcher downtime and first boot against an already-open board
 * exclude stale opportunities rather than entering them late.
 */

export const WATCH_MARKETS: readonly MarketKey[] = ['moneyline', 'spread', 'total'];

export class WatchUsageError extends Error {}

export interface WatchCliOptions {
  dryRun: boolean;
  once: boolean;
  outDir: string;
  /** True when --out was passed explicitly (dry runs default elsewhere). */
  outDirExplicit: boolean;
  pollSeconds: number;
  windowHours: number;
  lateMinutes: number;
  maxFiresPerTick: number;
  timeoutSeconds: number | null;
  maxOutputTokens: number;
}

export const WATCH_USAGE = `Usage: yarn watch [options]

Options:
  --dry-run              One pass against the fixture slate and mock providers
                         (no credentials, no network, implies --once).
  --once                 Run a single watch pass and exit (external schedulers, tests).
  --out DIR              Output directory (run files + watch-ledger/). Default: out/
  --poll-seconds N       Poll interval between passes. Default: 300, min 30.
  --window-hours N       Games-endpoint lookahead window. Default: 168, max 720.
  --late-minutes N       Late-detection threshold: a game whose full board completed
                         more than N minutes before detection is excluded (recorded
                         as late_detection, never fired). Default: 60, max 1440.
  --max-fires-per-tick N Circuit breaker on per-tick spend: once N games have fired
                         in one tick, stop loudly; the rest re-evaluate next tick.
                         Default: 10.
  --timeout-seconds N    Per-provider-call timeout. Default: 300 live, 2 dry run.
  --max-output-tokens N  Output-token bound per provider call. Default: 16000.
  -h, --help             Show this help.`;

/** Parse watch CLI args. `onHelp` is invoked for -h/--help; the CLI prints
 *  usage and exits, tests pass a spy. Throws WatchUsageError on bad input. */
export function parseWatchArgs(argv: string[], onHelp: () => void): WatchCliOptions {
  const options: WatchCliOptions = {
    dryRun: false,
    once: false,
    outDir: 'out',
    outDirExplicit: false,
    pollSeconds: 300,
    windowHours: 168,
    lateMinutes: 60,
    maxFiresPerTick: DEFAULT_MAX_FIRES_PER_TICK,
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
      case '--late-minutes': {
        const value = Number.parseInt(next(), 10);
        if (!Number.isInteger(value) || value < 1 || value > 1440) {
          throw new WatchUsageError('--late-minutes must be an integer between 1 and 1440');
        }
        options.lateMinutes = value;
        break;
      }
      case '--max-fires-per-tick': {
        const value = Number.parseInt(next(), 10);
        if (!Number.isInteger(value) || value < 1) {
          throw new WatchUsageError('--max-fires-per-tick must be a positive integer');
        }
        options.maxFiresPerTick = value;
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

export interface LedgerEntry {
  gameId: string;
  slug: string;
  decision: 'fired' | 'late_detection';
  decidedAt: string;
  slateDate: string;
  scheduledStartUtc: string;
  /** Newest first-board-appearance across the three markets. */
  boardCompletedAt: string;
  openerAgeMinutes: number;
  gameSha256: string;
  requestSha256: string;
  /** Present on fired entries. */
  runId?: string | undefined;
  runFile?: string | undefined;
  /** Per-participant outcomes; present once a fire completes. */
  armOutcomes?: Record<string, ArmOutcome> | undefined;
  baselineDecisions?: number | undefined;
  /** True when the fired game's run file carries run_failure records. */
  collisionFailed?: boolean | undefined;
  /** Present when the fire path errored after the ledger claim. */
  fireError?: string | undefined;
}

/** Watch-gate provenance, recorded into run_meta so the entry-timing claim
 *  is verifiable from the artifact (the scorer fail-closes on it). */
export interface WatchGateProvenance {
  detectedAt: string;
  boardCompletedAt: string;
  openerAgeMinutes: number;
  lateThresholdMinutes: number;
}

/** The pick-recording seam: when wallets and a book to bet into exist, the
 *  validated picks recorded by the fire path become signed on-chain
 *  commitments here — nothing upstream of this point changes. */
export interface FireOutcome {
  runId: string;
  runFile: string;
  armOutcomes: Record<string, ArmOutcome>;
  baselineDecisions: number;
  collisionFailed: boolean;
}

/** Default per-tick fire circuit breaker — model calls bill real money, so a
 *  surprise flood of "eligible" games must stop loudly, not spend quietly. */
export const DEFAULT_MAX_FIRES_PER_TICK = 10;
/** A tick's inputs age as sequential fires run; entries must never be made on
 *  prices older than this. Unclaimed candidates are simply re-DETECTED next
 *  tick from fresh inputs (nothing built is retained — this is re-detection,
 *  not deferred firing). */
export const MAX_INPUT_AGE_MS = 10 * 60_000;
/** Fire-at-detection means firing on a CURRENT snapshot: before evaluating
 *  each candidate, the working inputs are re-fetched whenever they are older
 *  than this, so every fired game's entry is built on seconds-old prices no
 *  matter how long earlier fires in the same tick took. */
export const FRESH_FIRE_MS = 30_000;

export interface WatchDeps {
  fetchInputs: () => Promise<SlateInputs>;
  /** First board appearance for (game, market); null = history not yet visible (transient). */
  fetchFirstBoardAppearance: (gameId: string, market: MarketKey) => Promise<string | null>;
  fireGame: (
    build: BuildResult,
    inputs: SlateInputs,
    slateDate: string,
    provenance: WatchGateProvenance,
  ) => Promise<FireOutcome>;
  ledgerDir: string;
  /** In-memory handled set, pre-populated from disk BEFORE the first tick. */
  ledger: Map<string, LedgerEntry>;
  /** Cache of first-board-appearance instants (immutable once seen). */
  boardFirstSeen: Map<string, string>;
  /** First time each game was deferred on a missing history row, for escalation. */
  deferredSince: Map<string, number>;
  /** Games whose prolonged deferral has already been escalated (log once). */
  deferralWarned: Set<string>;
  nowMs: () => number;
  lateMs: number;
  maxFiresPerTick: number;
  maxInputAgeMs: number;
  log: (line: string) => void;
  logError: (line: string) => void;
}

export interface TickSummary {
  gamesInWindow: number;
  watched: number;
  fired: number;
  late: number;
  deferred: number;
  /** Per-game failures (fire errors, ledger write failures, malformed rows).
   *  Surfaced so schedulers and --once can distinguish a healthy pass. */
  failed: number;
  /** True when the per-tick spend cap stopped the loop with work remaining —
   *  by design, but never silently: schedulers see a non-healthy pass. */
  capHit: boolean;
}

function ledgerPath(ledgerDir: string, gameId: string): string {
  return join(ledgerDir, `${gameId}.json`);
}

export function persistLedgerEntry(ledgerDir: string, entry: LedgerEntry): void {
  // writeText is the redaction chokepoint — every serialized byte passes
  // redactSecrets before touching disk, same as run records.
  writeText(ledgerPath(ledgerDir, entry.gameId), `${JSON.stringify(entry, null, 2)}\n`);
}

/**
 * Re-derive the handled set from disk. Existence of a ledger file means the
 * game is handled forever — a corrupt file is treated as handled (the
 * conservative reading: never risk a double-fire; model calls bill money).
 */
export function loadLedger(ledgerDir: string, logError: (line: string) => void): Map<string, LedgerEntry> {
  const ledger = new Map<string, LedgerEntry>();
  if (!existsSync(ledgerDir)) return ledger;
  for (const name of readdirSync(ledgerDir)) {
    if (!name.endsWith('.json')) continue;
    const gameId = name.slice(0, -'.json'.length);
    try {
      const parsed = JSON.parse(readFileSync(join(ledgerDir, name), 'utf8')) as LedgerEntry;
      ledger.set(gameId, parsed);
    } catch (error) {
      logError(
        `ledger entry ${name} is unreadable (${describeError(error)}) — treating the game as handled`,
      );
      ledger.set(gameId, {
        gameId,
        slug: 'unknown',
        decision: 'fired',
        decidedAt: 'unknown',
        slateDate: 'unknown',
        scheduledStartUtc: 'unknown',
        boardCompletedAt: 'unknown',
        openerAgeMinutes: -1,
        gameSha256: 'unknown',
        requestSha256: 'unknown',
        fireError: 'ledger entry unreadable; treated as handled to prevent a double-fire',
      });
    }
  }
  return ledger;
}

/**
 * Board-completion instant for an eligible game: the NEWEST of the three
 * markets' first board appearances. Returns null while any market's history
 * row is not yet visible (the ingest writes history before the snapshot, so
 * this is transient — the caller retries next tick).
 */
async function boardCompletedAt(
  deps: WatchDeps,
  gameId: string,
): Promise<string | null> {
  let newest: string | null = null;
  for (const market of WATCH_MARKETS) {
    const cacheKey = `${gameId}:${market}`;
    let first = deps.boardFirstSeen.get(cacheKey) ?? null;
    if (first === null) {
      first = await deps.fetchFirstBoardAppearance(gameId, market);
      if (first !== null && !Number.isFinite(Date.parse(first))) {
        // Never cache an unparseable instant — surfacing it each tick beats
        // silently deferring the game forever on a poisoned cache entry.
        deps.logError(
          `unparseable first-appearance timestamp for ${gameId} ${market}: ${first} — deferring`,
        );
        return null;
      }
      if (first !== null && Date.parse(first) > deps.nowMs()) {
        // ANY appearance after detection is rejected — fail closed, never
        // cached, never fired. The runtime and the scorer must accept the
        // same domain (the scorer rejects negative opener ages), and a
        // legitimately skewed stamp becomes past within one tick anyway.
        deps.logError(
          `future first-appearance timestamp for ${gameId} ${market}: ${first} — deferring, not caching`,
        );
        return null;
      }
      if (first !== null) deps.boardFirstSeen.set(cacheKey, first);
    }
    if (first === null) return null;
    const firstMs = Date.parse(first);
    if (newest === null || firstMs > Date.parse(newest)) newest = first;
  }
  return newest;
}

/**
 * One watch pass: fetch fresh inputs, and for every unhandled game that the
 * bundle builder deems eligible, apply the late-detection gate and either
 * fire it immediately or ledger it as late. Games are independent events —
 * one game's failure is logged and never stalls the rest.
 */
export async function watchTick(deps: WatchDeps): Promise<TickSummary> {
  const inputs = await deps.fetchInputs();
  const summary: TickSummary = {
    gamesInWindow: inputs.gamesRows.length,
    watched: 0,
    fired: 0,
    late: 0,
    deferred: 0,
    failed: 0,
    capHit: false,
  };

  // Dedupe by gameId (offset pagination under concurrent upstream writes can
  // repeat a row) and drop handled games; ordered chronologically by parsed
  // first pitch (NOT lexically — mixed UTC offsets are valid), unparseable
  // last, gameId as the deterministic tiebreak.
  const seenThisTick = new Set<string>();
  const candidates = inputs.gamesRows
    .filter((row) => {
      if (deps.ledger.has(row.gameId) || seenThisTick.has(row.gameId)) return false;
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

  // The working snapshot: refreshed per candidate whenever it is older than
  // FRESH_FIRE_MS, so every game is evaluated AND fired on current prices no
  // matter how long earlier fires in this tick took — fire-at-detection
  // holds per game, not merely per tick.
  let currentInputs = inputs;
  // The spend cap bounds dispatch ATTEMPTS (claims), not successes — a
  // failing fire may already have billed providers.
  let fireAttempts = 0;

  interface Prepared {
    row: (typeof candidates)[number];
    slateDate: string;
    singleInputs: SlateInputs;
    build: BuildResult;
    request: NonNullable<BuildResult['requests'][number]>;
  }

  // Ensure the working snapshot is fresh, locate the game in it, and verify
  // eligibility + first pitch. Called immediately before the gate AND again
  // after the (potentially slow) board-history reads, so the inputs a game
  // actually fires on are always seconds old.
  const prepare = async (gameId: string): Promise<Prepared | 'watched' | 'stop'> => {
    if (deps.nowMs() - Date.parse(currentInputs.fetchCompletedAt) > FRESH_FIRE_MS) {
      currentInputs = await deps.fetchInputs();
    }
    // Backstop only — the refresh above keeps the snapshot young. If the
    // fetch itself returns aged stamps, entries must still never be made.
    const assembledAtMs = Date.parse(currentInputs.fetchCompletedAt);
    if (Number.isFinite(assembledAtMs) && deps.nowMs() - assembledAtMs > deps.maxInputAgeMs) {
      deps.logError('inputs still aged after refresh — stopping this tick');
      return 'stop';
    }
    const row = currentInputs.gamesRows.find((g) => g.gameId === gameId);
    if (row === undefined) return 'watched'; // left the window between snapshots
    const slateDate = easternCalendarDay(row.matchTime);
    const singleInputs: SlateInputs = {
      gamesRows: [row],
      oddsRows: currentInputs.oddsRows.filter((o) => o.jsonodds_id === row.gameId),
      fetchStartedAt: currentInputs.fetchStartedAt,
      fetchCompletedAt: currentInputs.fetchCompletedAt,
    };
    let build: BuildResult;
    try {
      build = buildBundle(singleInputs, slateDate, { requireFuture: true });
    } catch (error) {
      // The expected signal: not yet eligible (incomplete board, one-sided
      // or stale quotes, non-upcoming status, ...). No ledger entry — the
      // game stays watched. Anything else is surfaced, never swallowed.
      if (!(error instanceof Error && error.message.startsWith('no eligible games'))) {
        deps.logError(`bundle build failed unexpectedly for ${gameId}: ${describeError(error)}`);
      }
      return 'watched';
    }
    const request = build.requests[0];
    if (request === undefined) return 'watched';
    // First pitch may have passed while earlier candidates fired — never
    // claim (and burn) a game whose decision window is already gone.
    if (Date.parse(row.matchTime) <= deps.nowMs()) return 'watched';
    return { row, slateDate, singleInputs, build, request };
  };

  for (const candidate of candidates) {
    try {
      // Never-double-fire is enforced at the consumption site too, not just
      // in the upfront filter.
      if (deps.ledger.has(candidate.gameId)) continue;

      // Circuit breaker: model calls bill real money. Unclaimed candidates
      // are re-evaluated next tick, where the late gate re-applies. Hitting
      // the cap is surfaced to schedulers (summary.capHit → nonzero exit).
      if (fireAttempts >= deps.maxFiresPerTick) {
        summary.capHit = true;
        deps.logError(
          `fire cap reached (${deps.maxFiresPerTick} attempts) — stopping this tick; remaining candidates re-detected next tick`,
        );
        break;
      }

      let prep = await prepare(candidate.gameId);
      if (prep === 'stop') break;
      if (prep === 'watched') {
        summary.watched += 1;
        continue;
      }

      let completedAt: string | null;
      try {
        completedAt = await boardCompletedAt(deps, candidate.gameId);
      } catch (error) {
        // A THROWN read is a failure (network/permission), not the benign
        // history-lags-snapshot deferral — schedulers must see it.
        summary.failed += 1;
        deps.logError(
          `board-appearance read failed for ${candidate.gameId} (${describeError(error)}) — retrying next tick`,
        );
        continue;
      }
      if (completedAt === null) {
        // History rows lag the snapshot by less than one ingest cycle — a
        // PROLONGED deferral means the history read path itself is broken
        // (e.g. a permission regression reads as 200-with-empty-array), so
        // escalate once instead of looking healthy while firing nothing.
        summary.deferred += 1;
        const since = deps.deferredSince.get(candidate.gameId) ?? deps.nowMs();
        deps.deferredSince.set(candidate.gameId, since);
        if (deps.nowMs() - since > deps.lateMs && !deps.deferralWarned.has(candidate.gameId)) {
          deps.deferralWarned.add(candidate.gameId);
          deps.logError(
            `${candidate.gameId} has been deferred longer than the late threshold — ` +
              'the first-appearance history read path may be broken (check the public read grants)',
          );
        }
        continue;
      }
      deps.deferredSince.delete(candidate.gameId);

      // The board-history reads above can be slow (up to three network
      // round-trips on a game's first evaluation). Detection is what fires,
      // so re-ensure the snapshot is fresh and the game still eligible on
      // the inputs that will actually be dispatched. Board data is cached,
      // so this re-preparation costs no history reads.
      if (deps.nowMs() - Date.parse(currentInputs.fetchCompletedAt) > FRESH_FIRE_MS) {
        prep = await prepare(candidate.gameId);
        if (prep === 'stop') break;
        if (prep === 'watched') {
          summary.watched += 1;
          continue;
        }
      }
      const { row, slateDate, singleInputs, build, request } = prep;

      // The detection instant: taken AFTER the final preparation, so
      // bundle-assembly ≤ detection ≤ dispatch holds by construction (the
      // scorer verifies exactly this chain from the artifact).
      const detectedAtMs = deps.nowMs();
      const openerAgeMs = detectedAtMs - Date.parse(completedAt);
      const openerAgeMinutes = Math.max(0, Math.round(openerAgeMs / 60_000));
      const base: LedgerEntry = {
        gameId: row.gameId,
        slug: row.slug,
        decision: 'late_detection',
        decidedAt: new Date(detectedAtMs).toISOString(),
        slateDate,
        scheduledStartUtc: row.matchTime,
        boardCompletedAt: completedAt,
        openerAgeMinutes,
        gameSha256: build.gameHashes[row.gameId] ?? 'unknown',
        requestSha256: request.requestSha256,
      };

      if (openerAgeMs > deps.lateMs) {
        // Entry honesty: a stale opportunity is excluded, never entered late.
        deps.ledger.set(row.gameId, base);
        persistLedgerEntry(deps.ledgerDir, base);
        summary.late += 1;
        deps.log(
          `late_detection ${row.slug} (${row.gameId}): board completed ${openerAgeMinutes}m ago — excluded, never fired`,
        );
        continue;
      }

      // Fire-at-detection. The claim is taken BEFORE dispatch — in memory
      // first (so nothing in this process can re-enter), then on disk (so a
      // restart cannot re-fire). A crash mid-fire loses one game's data;
      // double-billing is the failure mode that must never happen. If the
      // disk claim itself fails, the in-memory claim stands and no dispatch
      // happens — no spend, and a later process re-detects the game.
      const claimed: LedgerEntry = { ...base, decision: 'fired' };
      fireAttempts += 1;
      deps.ledger.set(row.gameId, claimed);
      persistLedgerEntry(deps.ledgerDir, claimed);
      deps.log(
        `firing ${row.slug} (${row.gameId}): board completed ${openerAgeMinutes}m ago, ` +
          `first pitch ${row.matchTime}, request sha256 ${request.requestSha256.slice(0, 16)}…`,
      );
      const provenance: WatchGateProvenance = {
        detectedAt: base.decidedAt,
        boardCompletedAt: completedAt,
        openerAgeMinutes,
        lateThresholdMinutes: Math.round(deps.lateMs / 60_000),
      };
      try {
        const outcome = await deps.fireGame(build, singleInputs, slateDate, provenance);
        const completed: LedgerEntry = {
          ...claimed,
          runId: outcome.runId,
          runFile: outcome.runFile,
          armOutcomes: outcome.armOutcomes,
          baselineDecisions: outcome.baselineDecisions,
          collisionFailed: outcome.collisionFailed,
        };
        deps.ledger.set(row.gameId, completed);
        persistLedgerEntry(deps.ledgerDir, completed);
        if (outcome.collisionFailed) {
          // A hard identity/collision failure is a FAILED pass, exactly as
          // the smoke CLI treats it — the file exists but is unscoreable.
          summary.failed += 1;
        } else {
          summary.fired += 1;
        }
      } catch (error) {
        const failed: LedgerEntry = { ...claimed, fireError: describeError(error) };
        deps.ledger.set(row.gameId, failed);
        persistLedgerEntry(deps.ledgerDir, failed);
        summary.failed += 1;
        deps.logError(`fire failed for ${row.slug} (${row.gameId}): ${describeError(error)}`);
      }
    } catch (error) {
      // Per-game isolation: one malformed row or failed ledger write must
      // never stall the rest of the tick (or recur as a tick-killer) — but
      // it is a FAILURE, and the summary says so.
      summary.failed += 1;
      deps.logError(
        `game ${candidate.gameId} failed this tick (${describeError(error)}) — continuing`,
      );
    }
  }

  return summary;
}

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

/**
 * The per-game decision event: dispatch all arms concurrently, run every
 * baseline against the same frozen bundle, and write ONE self-contained run
 * file the existing scorer consumes unchanged. Mirrors the smoke tail for a
 * single game.
 */
export async function fireEligibleGame(
  build: BuildResult,
  inputs: SlateInputs,
  slateDate: string,
  provenance: WatchGateProvenance,
  cfg: FireConfig,
): Promise<FireOutcome> {
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
    // Recorded in run_meta so the entry-timing claim is verifiable from the
    // artifact itself; the scorer fail-closes on it for watch runs.
    watch: provenance,
  };

  const env = await runSlate(cfg.arms, cfg.adapters, build.requests, {
    cohortId: ctx.cohortId,
    timeoutMs: ctx.timeoutMs,
    maxOutputTokens: ctx.maxOutputTokens,
    executionPolicy: ctx.executionPolicy,
    nowMs: cfg.nowMs,
    onGameComplete: (line) => cfg.log(`  ${line}`),
  });
  const armGameResults = env.results;

  // buildRecords/buildSummaryMarkdown derive baselines from the sealed snapshot
  // under the same authenticated envelope version; this copy is only for the
  // fire-outcome count reported to schedulers.
  const baselineDecisions = runBaselines(env.snapshot.slate, env.baselinePolicyVersion);
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

  const records = buildRecords(env, ctx, build, collision);
  const runFile = join(cfg.outDir, `${ctx.runId}.ndjson`);
  writeNdjson(runFile, records);
  writeText(
    join(cfg.outDir, `${ctx.runId}-summary.md`),
    buildSummaryMarkdown(env, ctx, build, collision),
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
