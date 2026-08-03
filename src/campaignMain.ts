import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isBaselinePolicyVersion } from './baselines.js';
import { buildCampaignAuthorization, resolveCampaignIntent } from './campaignAuthorization.js';
import type { CampaignAuthorizationPort } from './campaignAuthorization.js';
import { buildCampaignManifest, campaignBoundsViolations, projectCampaignCost } from './campaignProfile.js';
import { assertCohortBudgetInitialized, buildCohortBudgetInitRequest } from './cohortBudgetInit.js';
import { cohortBoot } from './cohortBoot.js';
import type { BootedCohort } from './cohortBoot.js';
import { gateRealCampaignAdapterCapability } from './cohortAdapterCapability.js';
import type { CohortAdapterCapability } from './cohortAdapterCapability.js';
import { runCohortTick } from './cohortRunner.js';
import type { CohortTickInput, CohortTickResult } from './cohortRunner.js';
import { decodeManifestText, formatTickResult, installedArtifactPaths, selfResolvePublication } from './cohortRunnerMain.js';
import { describeErrorWithStack, envValue } from './config.js';
import { printError, printLine } from './console.js';
import { loadDotEnv } from './env.js';
import { FireArtifactSink } from './fireArtifactSink.js';
import { StoreClaimPort } from './lineOpenClaim.js';
import { createDiscoverFn, createReadMarketEvidenceFn } from './lineOpenRead.js';
import { askLiveConfirmation, observeRealAdapterCredentials } from './liveIntent.js';
import { DEFAULT_OSPEX_API_URL } from './config.js';
import type { LineOpenReadConfig } from './lineOpenRead.js';
import type { CohortManifestV1 } from './manifest.js';
import type { LineOpenRunOptions } from './lineOpenSpine.js';
import type { AtomicStore } from './store/contract.js';
import { STORE_SCHEMA_VERSION } from './store/constants.js';

/**
 * The CAMPAIGN entrypoint — `arm`, `stop`, `tick`.
 *
 * The attended crossing authorized exactly one fire, with a human answering a prompt. A
 * scheduled benchmark cannot answer a prompt (and by design an unanswered prompt refuses), so
 * the confirmation MOVES rather than disappearing:
 *
 *   - `arm`  — ATTENDED, once per campaign. Boots the cohort, prints the exact terms
 *              (identity, window, size in calls and fires, and what that costs at both the
 *              observed rate and the committed conservative bound), takes the `[Y/n]`,
 *              initializes the cohort budget, and records the durable authorization.
 *   - `tick` — UNATTENDED, what cron calls. Resolves live intent by READING that record.
 *              Never prompts, never falls back to mock: it either holds a validated
 *              authorization or fires nothing and exits nonzero.
 *   - `stop` — revokes the authorization. Fail-safe: the next tick fires nothing.
 *
 * Three bounds hold an armed campaign, and only the first needs nobody's attention: the
 * store's cohort call/spend caps (enforced in a row lock, so no number of ticks can exceed
 * them), this authorization (expiring on its own and revocable at any moment), and the
 * manifest's observation window.
 *
 * A spend-guard ESCALATION auto-disarms the campaign. An escalation means the spend model is
 * not holding; ending only that tick would let a systematic mispricing repeat on the next
 * cron interval, so the campaign stops itself and requires a human to look.
 */

class UsageError extends Error {}

const USAGE = `Usage:
  yarn campaign:arm  --calls <n> --days <n> [--start <ISO>] [--dispatches <n>] [--emit <path>]
  yarn campaign:tick --manifest <path> [--out <dir>]
  yarn campaign:stop --manifest <path>

ARM (attended, once per campaign): builds a campaign manifest sized in provider CALLS,
prints the exact terms and their cost, asks for confirmation, initializes the cohort
budget, and records the durable authorization. Writes the manifest to --emit (default
./campaign-manifest.json) — every later tick and the stop must be given that same file,
because its bytes ARE the campaign's identity.

TICK (unattended): one cohort tick against the armed campaign. This is what cron calls.
Exits 0 when the tick ran (including when nothing was eligible), 2 when no live
authorization covers the cohort, and 1 on a loud failure.

STOP: revokes the authorization. The next tick fires nothing.

Needs STORE_DATABASE_URL, SUPABASE_URL + SUPABASE_ANON_KEY (and optionally OSPEX_API_URL).`;

interface CampaignOptions {
  command: 'arm' | 'tick' | 'stop';
  calls: number;
  days: number;
  startIso: string | null;
  dispatches: number;
  manifestPath: string | null;
  emitPath: string;
  outDir: string | null;
}

function parseArgs(argv: string[]): CampaignOptions {
  const command = argv[0];
  if (command === '-h' || command === '--help') {
    printLine(USAGE);
    process.exit(0);
  }
  if (command !== 'arm' && command !== 'tick' && command !== 'stop') {
    throw new UsageError(`unknown command: ${command ?? '(none)'}`);
  }
  const options: CampaignOptions = {
    command,
    calls: 0,
    days: 0,
    startIso: null,
    dispatches: 1,
    manifestPath: null,
    emitPath: './campaign-manifest.json',
    outDir: null,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} requires a value`);
      i += 1;
      return value;
    };
    const asCount = (raw: string, label: string): number => {
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value <= 0) throw new UsageError(`${label} must be a positive integer`);
      return value;
    };
    if (arg === '--calls') options.calls = asCount(next(), '--calls');
    else if (arg === '--days') options.days = asCount(next(), '--days');
    else if (arg === '--start') options.startIso = next();
    else if (arg === '--dispatches') options.dispatches = asCount(next(), '--dispatches');
    else if (arg === '--manifest') options.manifestPath = next();
    else if (arg === '--emit') options.emitPath = next();
    else if (arg === '--out') options.outDir = next();
    else if (arg === '-h' || arg === '--help') {
      printLine(USAGE);
      process.exit(0);
    } else throw new UsageError(`unknown argument: ${arg ?? ''}`);
  }
  return options;
}

/** The run options a tick derives from the booted manifest (mirrors the fixture runner). */
function deriveRunOptions(manifest: CohortManifestV1): LineOpenRunOptions {
  const baselinePolicyVersion = isBaselinePolicyVersion(manifest.baselinePolicyVersion)
    ? manifest.baselinePolicyVersion
    : undefined;
  return {
    timeoutMs: manifest.constants.providerCallTimeoutMs,
    maxOutputTokens: manifest.constants.maxOutputTokens,
    executionPolicy: 'fixed-moneyline-total',
    baselinePolicyVersion,
  };
}

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Injectable seams (so the whole owner-level flow is drivable without a database)
// ---------------------------------------------------------------------------

export interface CampaignDeps {
  readonly openStore: (
    databaseUrl: string,
  ) => Promise<{ store: AtomicStore; authorizations: CampaignAuthorizationPort; close: () => Promise<void> }>;
  readonly runTick: (input: CohortTickInput) => Promise<CohortTickResult>;
  readonly observeCredentials: (participantIds: readonly string[]) => ReadonlyMap<string, boolean>;
  readonly confirm: (prompt: string) => Promise<string | null>;
  readonly now: () => number;
}

// ---------------------------------------------------------------------------
// arm
// ---------------------------------------------------------------------------

/**
 * ARM a campaign: build the sized manifest, boot it, print the exact terms, take the
 * confirmation, initialize the cohort budget, and record the authorization. Nothing here
 * dispatches; the first fire happens on the first tick after the window opens.
 */
export async function armCampaign(options: CampaignOptions, deps: CampaignDeps): Promise<number> {
  if (options.calls <= 0 || options.days <= 0) {
    printError('arm requires --calls <n> and --days <n>');
    return 2;
  }
  const startMs = options.startIso === null ? deps.now() : Date.parse(options.startIso);
  if (!Number.isFinite(startMs)) {
    printError(`--start ${String(options.startIso)} is not a parseable instant`);
    return 2;
  }
  const windowForwardMs = options.days * 24 * 3_600_000;

  let built: ReturnType<typeof buildCampaignManifest>;
  try {
    built = buildCampaignManifest(startMs, {
      callCap: options.calls,
      windowForwardMs,
      maxDispatchesPerTick: options.dispatches,
    });
  } catch (error) {
    printError(`refusing to arm: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const booted = cohortBoot({ manifestBytes: built.bytes });
  const violations = campaignBoundsViolations(booted.manifest);
  if (violations.length > 0) {
    printError(`refusing to arm — the campaign shape is out of bounds: ${violations.join('; ')}`);
    return 2;
  }

  // Every roster credential must resolve NOW, or the campaign could never fire.
  const rosterIds = booted.manifest.expectedArmRoster.map((arm) => arm.participantId);
  const observed = deps.observeCredentials(rosterIds);
  const credentialed = rosterIds.filter((id) => observed.get(id) === true);
  if (credentialed.length !== rosterIds.length) {
    const missing = rosterIds.filter((id) => observed.get(id) !== true);
    printError(`refusing to arm — no usable credential for: ${missing.join(', ')}`);
    return 2;
  }

  const projection = projectCampaignCost(booted.manifest);
  const armedAtMs = deps.now();
  const expiresAtMs = startMs + windowForwardMs;

  printLine('ARM CAMPAIGN — real provider spend, unattended, on confirmation:');
  printLine(`  cohortId ${booted.cohortId}`);
  printLine(`  sports ${booted.manifest.sportAllowList.join(', ')}`);
  printLine(`  window ${booted.manifest.windowStart} → ${booted.manifest.windowEnd}`);
  printLine(`  size   at most ${projection.maxCalls} provider calls (${projection.maxFires} fires of 4 arms)`);
  printLine(`  cost   ≈ ${usd(projection.observedUsdMicros)} expected at the observed rate`);
  printLine(`         ≤ ${usd(projection.conservativeUsdMicros)} at the committed conservative worst case`);
  printLine(`  bounds ${booted.manifest.constants.maxDispatchesPerTick} fire(s)/tick; every attempt hard-stopped above $100`);
  printLine(`  expiry ${new Date(expiresAtMs).toISOString()} (the authorization stops on its own)`);
  printLine("  an EXPLICIT 'y' is required; Enter, any other answer, or EOF refuses");

  const answer = await deps.confirm('arm this campaign for unattended running? [y/N] ');
  if (answer === null) {
    printError('arming refused: the confirmation stream closed (EOF) before an answer');
    return 2;
  }
  const normalized = answer.trim().toLowerCase();
  if (normalized !== 'y' && normalized !== 'yes') {
    printError(`arming refused (answer ${JSON.stringify(answer)}); an explicit 'y' is required`);
    return 2;
  }

  const databaseUrl = envValue('STORE_DATABASE_URL');
  if (databaseUrl === undefined) {
    printError('arming needs STORE_DATABASE_URL');
    return 2;
  }
  const { store, authorizations, close } = await deps.openStore(databaseUrl);
  try {
    const initResult = await store.initCohortBudget(buildCohortBudgetInitRequest(booted));
    assertCohortBudgetInitialized(initResult);
    const record = buildCampaignAuthorization({
      booted,
      observedCredentialedParticipantIds: credentialed,
      armedAtMs,
      expiresAtMs,
    });
    const outcome = await authorizations.arm(record);
    if (outcome === 'already_armed') {
      printError(`a campaign is already armed for cohort ${booted.cohortId}; stop it before re-arming`);
      return 2;
    }
    writeFileSync(options.emitPath, built.bytes);
    printLine('');
    printLine(`ARMED. cohort budget initialized and authorization recorded.`);
    printLine(`manifest written to ${options.emitPath} — every tick and the stop need this exact file.`);
    return 0;
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

/**
 * One UNATTENDED tick. Resolves live intent from the durable record — no prompt, no mock
 * fallback — and on a spend-guard escalation DISARMS the campaign before returning, so a
 * systematic mispricing cannot repeat on the next cron interval.
 */
export async function tickCampaign(options: CampaignOptions, deps: CampaignDeps): Promise<number> {
  if (options.manifestPath === null) {
    printError('tick requires --manifest <path> (the exact manifest the campaign was armed with)');
    return 2;
  }
  const rawBytes = readFileSync(options.manifestPath);
  const booted = cohortBoot({ manifestBytes: decodeManifestText(rawBytes) });
  const publication = selfResolvePublication(rawBytes);

  const supabaseUrl = envValue('SUPABASE_URL');
  const anonKey = envValue('SUPABASE_ANON_KEY');
  const databaseUrl = envValue('STORE_DATABASE_URL');
  if (supabaseUrl === undefined || anonKey === undefined || databaseUrl === undefined) {
    printError('a tick needs SUPABASE_URL, SUPABASE_ANON_KEY, and STORE_DATABASE_URL');
    return 2;
  }

  const { store, authorizations, close } = await deps.openStore(databaseUrl);
  try {
    const stored = await authorizations.read(booted.cohortId);
    const resolution = resolveCampaignIntent({
      booted,
      stored,
      now: deps.now(),
      observeCredentials: deps.observeCredentials,
    });
    if (resolution.kind === 'Refused') {
      // NEVER a mock fallback: a tick with no live authorization fires nothing and says why.
      printError(`no live campaign authorization for cohort ${booted.cohortId}: ${resolution.violations.join('; ')}`);
      return 2;
    }

    // The gated producer independently re-validates the binding, the campaign bounds, and the
    // credentials before minting; a refusal throws loudly out of this tick.
    const capability: CohortAdapterCapability = gateRealCampaignAdapterCapability(booted, resolution.authorization);

    const now = deps.now;
    const config: LineOpenReadConfig = {
      apiUrl: envValue('OSPEX_API_URL') ?? DEFAULT_OSPEX_API_URL,
      supabaseUrl,
      anonKey,
      now,
    };
    const outDir = options.outDir ?? envValue('FIRE_ARTIFACTS_DIR') ?? './.fire-artifacts';
    const ownerId = `${hostname()}-${process.pid}-${randomUUID()}`;
    const result = await deps.runTick({
      booted,
      publication,
      discover: createDiscoverFn(config),
      readMarketEvidence: createReadMarketEvidenceFn(config),
      claimPort: new StoreClaimPort(store),
      capability,
      sink: new FireArtifactSink(outDir),
      runOptions: deriveRunOptions(booted.manifest),
      admission: { ownerId, expectedSchemaVersion: STORE_SCHEMA_VERSION },
      now,
    });

    for (const line of formatTickResult(result)) printLine(line);
    for (const path of installedArtifactPaths(result)) printLine(`  installed ${path}`);

    // A spend-guard escalation stops the CAMPAIGN, not merely this tick: the spend model is
    // not holding, and the next cron interval would otherwise repeat it.
    const escalated = result.fireOutcomes.filter((f) => f.outcome.kind === 'InstalledEscalated');
    if (escalated.length > 0) {
      const at = new Date(deps.now()).toISOString();
      await authorizations.disarm(booted.cohortId, at);
      printError(
        `spend-guard escalation on ${escalated.length} fire(s) — the campaign has been DISARMED at ${at}. ` +
          `Its evidence is installed; investigate before arming again.`,
      );
      return 1;
    }
    return 0;
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

/** Revoke the authorization. Fail-safe: the next tick resolves nothing and fires nothing. */
export async function stopCampaign(options: CampaignOptions, deps: CampaignDeps): Promise<number> {
  if (options.manifestPath === null) {
    printError('stop requires --manifest <path> (the exact manifest the campaign was armed with)');
    return 2;
  }
  const booted = cohortBoot({ manifestBytes: decodeManifestText(readFileSync(options.manifestPath)) });
  const databaseUrl = envValue('STORE_DATABASE_URL');
  if (databaseUrl === undefined) {
    printError('stop needs STORE_DATABASE_URL');
    return 2;
  }
  const { authorizations, close } = await deps.openStore(databaseUrl);
  try {
    const at = new Date(deps.now()).toISOString();
    const outcome = await authorizations.disarm(booted.cohortId, at);
    if (outcome === 'not_found') {
      printError(`no campaign was ever armed for cohort ${booted.cohortId}`);
      return 2;
    }
    printLine(`STOPPED. cohort ${booted.cohortId} is disarmed; the next tick will fire nothing.`);
    return 0;
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

const PRODUCTION_DEPS: CampaignDeps = {
  openStore: async (databaseUrl) => {
    const { Pool } = await import('pg');
    const { SqlAtomicStore, pgStoreQuery } = await import('./store/atomicStore.js');
    const { SqlCampaignAuthorizationPort } = await import('./store/campaignAuthStore.js');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const { readFileSync: read } = await import('node:fs');
      await pool.query(read(new URL('./store/schema.sql', import.meta.url), 'utf8'));
      await pool.query(read(new URL('./store/functions.sql', import.meta.url), 'utf8'));
    } catch (error) {
      await pool.end();
      throw error;
    }
    const query = pgStoreQuery(pool);
    return {
      store: new SqlAtomicStore(query),
      authorizations: new SqlCampaignAuthorizationPort(query),
      close: () => pool.end(),
    };
  },
  runTick: (input) => runCohortTick({ ...input, onStatus: (line) => printLine(`  ${line}`) }),
  observeCredentials: observeRealAdapterCredentials,
  confirm: askLiveConfirmation,
  now: () => Date.now(),
};

async function main(): Promise<number> {
  const loaded = loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  if (loaded.length > 0) printLine(`loaded ${loaded.length} env var(s) from .env: ${loaded.join(', ')}`);
  switch (options.command) {
    case 'arm':
      return armCampaign(options, PRODUCTION_DEPS);
    case 'tick':
      return tickCampaign(options, PRODUCTION_DEPS);
    case 'stop':
      return stopCampaign(options, PRODUCTION_DEPS);
    default: {
      const _exhaustive: never = options.command;
      return _exhaustive;
    }
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof UsageError) {
        printError(`error: ${error.message}`);
        printError('');
        printError(USAGE);
        process.exitCode = 2;
        return;
      }
      printError(describeErrorWithStack(error));
      process.exitCode = 1;
    });
}
