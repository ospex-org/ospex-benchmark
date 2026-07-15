import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_OSPEX_API_URL, describeErrorWithStack, envValue } from './config.js';
import { printError, printLine } from './console.js';
import { loadDotEnv } from './env.js';
import { fetchFirstBoardAppearance, fetchLiveInputs } from './fetchers.js';
import { enabledMarkets, MARKET_POLICY, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { createFixtureClock, createMockAdapters, loadFixtureInputs } from './mock.js';
import { approvedReportedModelIds, ARMS, createRealAdapters } from './providers/index.js';
import { appendNdjson, writeText } from './records.js';
import {
  fireEligibleGame,
  LATE_THRESHOLD_MS,
  loadLedger,
  MAX_INPUT_AGE_MS,
  parseWatchArgs,
  WATCH_USAGE,
  WatchUsageError,
  watchTick,
} from './watch.js';
import type { FireConfig, SpecStatus, WatchDeps } from './watch.js';

/**
 * Line-open watch mode CLI — the speculation is the unit; fire-at-detection
 * only. See docs/LINE_OPEN_RUNNER.md for the full contract; the testable core
 * lives in src/watch.ts (this entry file only wires real dependencies + loops).
 *
 * Output remains labeled SMOKE_V0_NOT_A_COHORT (the record label is typed and
 * hash-load-bearing); watch runs are identified by the watch-v0 runId /
 * cohortId prefix and are plumbing validation, not a cohort.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Print the enabled market policy on boot so "what will it act on" is
 *  answerable in one screen without a database client. */
function printPolicyBanner(): void {
  const entries = Object.entries(MARKET_POLICY);
  printLine(`market policy ${MARKET_POLICY_VERSION} (detection is universal; these are ACTED ON):`);
  if (entries.length === 0) {
    printLine('  (no league enabled — nothing will be dispatched)');
    return;
  }
  for (const [league, markets] of entries) {
    printLine(`  ${league}: ${markets.join(', ')}`);
  }
}

async function main(): Promise<number> {
  const loaded = loadDotEnv();
  const options = parseWatchArgs(process.argv.slice(2), () => {
    printLine(WATCH_USAGE);
    process.exit(0);
  });
  const mode = options.dryRun ? 'dry-run' : 'live';
  const modeLabel = options.rehearse ? `${mode} — REHEARSAL (report-only)` : mode;
  printLine(
    `ospex-benchmark line-open watch — ${modeLabel} — the speculation is the unit — label SMOKE_V0_NOT_A_COHORT`,
  );
  if (loaded.length > 0) {
    printLine(`loaded ${loaded.length} env var(s) from .env: ${loaded.join(', ')}`);
  }
  printPolicyBanner();
  printLine(`late-detection threshold: ${LATE_THRESHOLD_MS / 60_000} min (committed constant, not a flag)`);

  let fetchInputs: WatchDeps['fetchInputs'];
  let firstBoardAppearance: WatchDeps['fetchFirstBoardAppearance'];
  let nowMs: () => number;
  const adapters = options.dryRun
    ? createMockAdapters({ simulateCollision: false })
    : createRealAdapters();

  // Dry runs are repeatable demos: unless --out was passed explicitly, they
  // write into an ephemeral directory so synthetic fixture entries never
  // intermix with (or pre-handle speculations in) the live audit ledger.
  const outDir =
    options.dryRun && !options.outDirExplicit
      ? mkdtempSync(join(tmpdir(), 'watch-dry-run-'))
      : options.outDir;
  if (outDir !== options.outDir) {
    printLine(`dry run: writing to ephemeral ${outDir}`);
  }

  if (options.dryRun) {
    // Fixture inputs + mock providers + one synthetic clock anchored at the
    // fixture capture instant. Every first appearance is the fixture
    // fetch-completion instant, so the late gate reads an age of ~zero.
    const fixture = loadFixtureInputs();
    fetchInputs = () => Promise.resolve(fixture);
    firstBoardAppearance = () => Promise.resolve(fixture.fetchCompletedAt);
    nowMs = createFixtureClock();
  } else {
    const supabaseUrl = envValue('SUPABASE_URL');
    const supabaseAnonKey = envValue('SUPABASE_ANON_KEY');
    const missing = [
      ...(supabaseUrl === undefined ? ['SUPABASE_URL'] : []),
      ...(supabaseAnonKey === undefined ? ['SUPABASE_ANON_KEY'] : []),
    ];
    if (supabaseUrl === undefined || supabaseAnonKey === undefined) {
      throw new WatchUsageError(
        `live mode needs the public read path configured — missing env: ${missing.join(', ')}`,
      );
    }
    const apiUrl = envValue('OSPEX_API_URL') ?? DEFAULT_OSPEX_API_URL;
    printLine(
      `watching MLB via ${apiUrl} (window ${options.windowHours}h, poll ${options.pollSeconds}s)`,
    );
    fetchInputs = () =>
      fetchLiveInputs({ apiUrl, supabaseUrl, supabaseAnonKey, windowHours: options.windowHours });
    firstBoardAppearance = (gameId, market) =>
      fetchFirstBoardAppearance(supabaseUrl, supabaseAnonKey, gameId, market);
    nowMs = (): number => Date.now();
  }

  const fireConfig: FireConfig = {
    arms: ARMS,
    adapters,
    approvedReportedModelIds,
    outDir,
    timeoutMs: (options.timeoutSeconds ?? (options.dryRun ? 2 : 300)) * 1000,
    maxOutputTokens: options.maxOutputTokens,
    mode,
    clockMode: options.dryRun ? 'synthetic-fixture' : 'wall',
    nowMs,
    log: printLine,
    logError: printError,
  };

  const ledgerDir = join(outDir, 'line-open-ledger');
  const ledger = loadLedger(ledgerDir, printError);
  printLine(`ledger: ${ledger.size} speculation(s) already handled (${ledgerDir})`);

  // Observability: each tick's per-speculation status snapshot to disk, so
  // "is it working / why is this only blocked" is answerable from a file
  // rather than inferred from the tick counters. Skipped in rehearsal.
  const statusFile = join(outDir, 'line-open-status.json');
  // The published denominator, part 2: an append-only coverage log of every
  // (game, market) disposition, emitted on state CHANGE. Fired games record
  // their full denominator in the run file; this log covers games that never
  // fire any market (no run file), so their negative space is not invisible.
  const coverageFile = join(outDir, 'line-open-coverage.ndjson');
  // Seed the state-change dedup from the existing coverage log so a restart
  // does not re-append an unchanged disposition for every already-logged
  // speculation (the log is append-only and survives restarts, like the ledger).
  const lastDisposition = new Map<string, string>();
  if (!options.rehearse && existsSync(coverageFile)) {
    for (const line of readFileSync(coverageFile, 'utf8').split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        const rec = JSON.parse(line) as {
          gameId?: string;
          market?: string;
          state?: string;
          reason?: string;
          snapshotObservedAt?: string | null;
        };
        if (rec.gameId && rec.market && rec.state && rec.reason) {
          const presence = rec.snapshotObservedAt == null ? 'absent' : 'present';
          lastDisposition.set(`${rec.gameId}:${rec.market}`, `${rec.state}:${rec.reason}:${presence}`);
        }
      } catch {
        // a corrupt line just means that key re-emits once — harmless
      }
    }
  }
  const onStatuses = options.rehearse
    ? undefined
    : (statuses: SpecStatus[]): void => {
        const snapshotAt = new Date(nowMs()).toISOString();
        writeText(statusFile, `${JSON.stringify({ snapshotAt, statuses }, null, 2)}\n`);
        // A disposition changed if its state/reason OR its snapshot-presence
        // changed — so a market that moves from absent→present while staying
        // policy_disabled still produces a durable coverage record.
        const dispKey = (s: SpecStatus): string =>
          `${s.state}:${s.reason}:${s.snapshotObservedAt === null ? 'absent' : 'present'}`;
        const changed = statuses.filter(
          (s) => lastDisposition.get(`${s.gameId}:${s.market}`) !== dispKey(s),
        );
        try {
          appendNdjson(
            coverageFile,
            changed.map((s) => ({
              recordType: 'coverage_status',
              snapshotAt,
              gameId: s.gameId,
              slug: s.slug,
              league: s.league,
              market: s.market,
              state: s.state,
              reason: s.reason,
              firstAppearanceAt: s.firstAppearanceAt,
              openerAgeSeconds: s.openerAgeSeconds,
              // Durable universal-detection evidence in the append-only log.
              snapshotObservedAt: s.snapshotObservedAt,
              scheduledStartUtc: s.scheduledStartUtc,
            })),
          );
          // Only advance the dedup map AFTER a successful append — a transient
          // append failure must not suppress the retry on the next tick.
          for (const s of changed) lastDisposition.set(`${s.gameId}:${s.market}`, dispKey(s));
        } catch (error) {
          printError(`coverage-log append failed (will retry next tick): ${describeErrorWithStack(error)}`);
        }
      };

  const deps: WatchDeps = {
    fetchInputs,
    fetchFirstBoardAppearance: firstBoardAppearance,
    fireGame: (build, inputs, slateDate, provenance, dispositions) =>
      fireEligibleGame(build, inputs, slateDate, provenance, fireConfig, dispositions),
    ledgerDir,
    ledger,
    boardFirstSeen: new Map(),
    deferredSince: new Map(),
    deferralWarned: new Set(),
    onStatuses,
    enabledMarketsFor: enabledMarkets,
    nowMs,
    lateMs: LATE_THRESHOLD_MS,
    maxDispatchesPerTick: options.maxDispatchesPerTick,
    maxInputAgeMs: MAX_INPUT_AGE_MS,
    rehearse: options.rehearse,
    log: printLine,
    logError: printError,
  };

  for (;;) {
    const startedAt = new Date(nowMs()).toISOString();
    let tickFailed = false;
    try {
      const s = await watchTick(deps);
      printLine(
        `tick ${startedAt}: ${s.gamesInWindow} games · ${s.speculations} specs · ` +
          `${s.fired} fired (${s.dispatches} dispatch${s.dispatches === 1 ? '' : 'es'}) · ` +
          `${s.late} late · ${s.deferred} deferred · ${s.blocked} blocked · ` +
          `${s.disabled} disabled · ${s.handled} handled · ${s.failed} failed` +
          `${s.capHit ? ' · CAP HIT' : ''}${s.rehearsal ? ' · REHEARSAL' : ''}`,
      );
      // Per-speculation failures are isolated inside the tick but they are
      // still failures — and a hit dispatch cap left work undone.
      if (s.failed > 0 || s.capHit) tickFailed = true;
    } catch (error) {
      tickFailed = true;
      printError(`tick ${startedAt} failed: ${describeErrorWithStack(error)}`);
    }
    if (options.once) {
      return tickFailed ? 1 : 0;
    }
    await sleep(options.pollSeconds * 1000);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof WatchUsageError) {
      printError(`error: ${error.message}`);
      printError('');
      printError(WATCH_USAGE);
      process.exitCode = 2;
      return;
    }
    printError(describeErrorWithStack(error));
    process.exitCode = 1;
  });
