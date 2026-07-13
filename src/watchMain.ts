import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_OSPEX_API_URL, describeErrorWithStack, envValue } from './config.js';
import { printError, printLine } from './console.js';
import { loadDotEnv } from './env.js';
import { fetchFirstBoardAppearance, fetchLiveInputs } from './fetchers.js';
import { createFixtureClock, createMockAdapters, loadFixtureInputs } from './mock.js';
import { approvedReportedModelIds, ARMS, createRealAdapters } from './providers/index.js';
import {
  fireEligibleGame,
  loadLedger,
  MAX_INPUT_AGE_MS,
  parseWatchArgs,
  WATCH_USAGE,
  WatchUsageError,
  watchTick,
} from './watch.js';
import type { FireConfig, WatchDeps } from './watch.js';

/**
 * Line-open watch mode CLI — fire-at-detection only. See
 * docs/LINE_OPEN_RUNNER.md for the full contract; the testable core lives in
 * src/watch.ts (this entry file only wires real dependencies and loops).
 *
 * Output remains labeled SMOKE_V0_NOT_A_COHORT (the record label is typed
 * and hash-load-bearing); watch runs are identified by the watch-v0 runId /
 * cohortId prefix and are plumbing validation, not a cohort.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  const loaded = loadDotEnv();
  const options = parseWatchArgs(process.argv.slice(2), () => {
    printLine(WATCH_USAGE);
    process.exit(0);
  });
  const mode = options.dryRun ? 'dry-run' : 'live';
  printLine(
    `ospex-benchmark line-open watch — ${mode} — fire-at-detection only — label SMOKE_V0_NOT_A_COHORT`,
  );
  if (loaded.length > 0) {
    printLine(`loaded ${loaded.length} env var(s) from .env: ${loaded.join(', ')}`);
  }

  let fetchInputs: WatchDeps['fetchInputs'];
  let firstBoardAppearance: WatchDeps['fetchFirstBoardAppearance'];
  let nowMs: () => number;
  const adapters = options.dryRun
    ? createMockAdapters({ simulateCollision: false })
    : createRealAdapters();

  // Dry runs are repeatable demos: unless --out was passed explicitly, they
  // write into an ephemeral directory so synthetic fixture entries never
  // intermix with (or pre-handle games in) the live audit ledger.
  const outDir =
    options.dryRun && !options.outDirExplicit
      ? mkdtempSync(join(tmpdir(), 'watch-dry-run-'))
      : options.outDir;
  if (outDir !== options.outDir) {
    printLine(`dry run: writing to ephemeral ${outDir}`);
  }

  if (options.dryRun) {
    // Fixture inputs + mock providers + one synthetic clock anchored at the
    // fixture capture instant, mirroring the smoke's dry-run story. The
    // fixture board "just completed": every first appearance is the fixture
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
      `watching MLB via ${apiUrl} (window ${options.windowHours}h, poll ${options.pollSeconds}s, late ${options.lateMinutes}m)`,
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

  const ledgerDir = join(outDir, 'watch-ledger');
  const ledger = loadLedger(ledgerDir, printError);
  printLine(`ledger: ${ledger.size} game(s) already handled (${ledgerDir})`);

  const deps: WatchDeps = {
    fetchInputs,
    fetchFirstBoardAppearance: firstBoardAppearance,
    fireGame: (build, inputs, slateDate, provenance) =>
      fireEligibleGame(build, inputs, slateDate, provenance, fireConfig),
    ledgerDir,
    ledger,
    boardFirstSeen: new Map(),
    deferredSince: new Map(),
    deferralWarned: new Set(),
    nowMs,
    lateMs: options.lateMinutes * 60_000,
    maxFiresPerTick: options.maxFiresPerTick,
    maxInputAgeMs: MAX_INPUT_AGE_MS,
    log: printLine,
    logError: printError,
  };

  for (;;) {
    // The same injected clock stamps the banner that drives enforcement and
    // records — never a second clock.
    const startedAt = new Date(nowMs()).toISOString();
    let tickFailed = false;
    try {
      const summary = await watchTick(deps);
      printLine(
        `tick ${startedAt}: ${summary.gamesInWindow} in window · ${summary.watched} watched · ` +
          `${summary.fired} fired · ${summary.late} late · ${summary.deferred} deferred · ` +
          `${summary.failed} failed${summary.capHit ? ' · CAP HIT' : ''}`,
      );
      // Per-game failures are isolated inside the tick but they are still
      // failures — and a hit spend cap left work undone. Neither is a
      // healthy pass.
      if (summary.failed > 0 || summary.capHit) tickFailed = true;
    } catch (error) {
      // A tick failure (fetch outage, transient API error) is logged and the
      // loop keeps watching — per-game failures are already isolated inside
      // the tick and can never reach here.
      tickFailed = true;
      printError(`tick ${startedAt} failed: ${describeErrorWithStack(error)}`);
    }
    if (options.once) {
      // External schedulers need the pass/fail distinction by exit code.
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
