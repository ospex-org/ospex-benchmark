import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isBaselinePolicyVersion } from './baselines.js';
import { CohortBootError, cohortBoot } from './cohortBoot.js';
import { runCohortTick } from './cohortRunner.js';
import { DEFAULT_OSPEX_API_URL, describeErrorWithStack, envValue } from './config.js';
import { printError, printLine } from './console.js';
import { loadDotEnv } from './env.js';
import { RehearsalClaimPort } from './lineOpenClaim.js';
import { createDiscoverFn, createReadMarketEvidenceFn } from './lineOpenRead.js';
import { parseManifest } from './manifest.js';
import { checkPublication } from './manifestPublication.js';
import { createMockAdapters } from './mock.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import { STORE_SCHEMA_VERSION } from './store/constants.js';
import type { CohortManifestV1 } from './manifest.js';
import type { CohortTickInput, CohortTickResult } from './cohortRunner.js';
import type { LineOpenReadConfig } from './lineOpenRead.js';
import type { PublicationVerified } from './manifestPublication.js';
import type { ArtifactInstaller, LineOpenFireOutcome, LineOpenRunOptions } from './lineOpenSpine.js';

/**
 * The canonical line-open runner — REHEARSAL (dry-run) entrypoint. It boots a cohort
 * from a code-consistent manifest, wires the REAL read-only discovery/opener seams
 * (core-api `/v1/games` + PostgREST `current_odds`/`odds_history`), and runs ONE
 * `runCohortTick` with the report-only `RehearsalClaimPort` + mock adapters. The
 * rehearsal is structurally incapable of a paid dispatch or a durable artifact: the
 * claim port never admits, so every fire returns `NotAdmitted/WouldAdmit`, no mock
 * adapter is ever called, and the no-op sink is never invoked.
 *
 * `--live` is routed into `cohortBoot`, which hard-disables it (rejected). A
 * store-backed (`--store=postgres`) run, the real GitHub publication resolver, and
 * artifact writing are DEFERRED to later slices; this entry runs one tick, DB-free,
 * with no model spend and no artifacts written.
 *
 * The env/argv glue lives in `main`; the boot + seam construction + rendering are
 * extracted into pure, injectable helpers (`buildRehearsalTickInput`,
 * `selfResolvePublication`, `formatTickResult`) so they are unit-testable without
 * env or network.
 */

class UsageError extends Error {}

const USAGE = `Usage: yarn runner:dry [options]

Runs ONE line-open cohort tick in REHEARSAL mode: real read-only discovery/opener
reads, a report-only claim port (never admits), mock adapters (never called), and no
artifacts written. Reads need SUPABASE_URL + SUPABASE_ANON_KEY (and optionally
OSPEX_API_URL) in the environment or a local .env.

Options:
  --manifest <path>       Read the cohort manifest from a file. Default: generate a
                          code-consistent manifest in-process (now-relative window).
  --emit-manifest <path>  Generate the in-process manifest, prove it boots and its
                          publication self-resolves, WRITE it to <path>, and exit 0.
                          Performs NO network I/O (no core-api / Supabase reads).
  --store <mode>          rehearsal (default). postgres is not supported in this slice.
  --live                  Routed into cohortBoot, which hard-disables live firing
                          (always rejected in this build).
  -h, --help              Show this help.`;

interface CliOptions {
  manifestPath: string | null;
  emitManifestPath: string | null;
  store: string;
  live: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { manifestPath: null, emitManifestPath: null, store: 'rehearsal', live: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === '--manifest') {
      options.manifestPath = next();
    } else if (arg === '--emit-manifest') {
      options.emitManifestPath = next();
    } else if (arg === '--store') {
      options.store = next();
    } else if (arg !== undefined && arg.startsWith('--store=')) {
      options.store = arg.slice('--store='.length);
    } else if (arg === '--live') {
      options.live = true;
    } else if (arg === '-h' || arg === '--help') {
      printLine(USAGE);
      process.exit(0);
    } else {
      throw new UsageError(`unknown argument: ${arg ?? ''}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Testable core
// ---------------------------------------------------------------------------

/** A shape-valid but non-authoritative descriptor. In rehearsal the blob is the local
 *  manifest itself, so the descriptor's identity fields are cosmetic — the real GitHub
 *  precommitment resolver is deferred to the live path. */
const REHEARSAL_PUBLICATION_DESCRIPTOR = Object.freeze({
  repositoryOwner: 'ospex-org',
  repositoryName: 'ospex-benchmark',
  path: 'manifests/rehearsal-cohort.json',
  commitSha: '0'.repeat(40),
});

/**
 * Self-resolve the manifest's public-Git precommitment WITHOUT a GitHub resolver: the
 * "published" blob IS the local manifest bytes, and the committer timestamp is derived
 * to be strictly before `windowStart`. `checkPublication` is pure (no network) and still
 * enforces byte-equality, cohortId equality, and the committer-before-windowStart rule,
 * so it returns a genuine branded `PublicationVerified`. Honest for a rehearsal that
 * issues zero provider requests; a real GitHub precommitment is a live-path requirement.
 */
export function selfResolvePublication(manifestBytes: string): PublicationVerified {
  const localManifestBytes = new TextEncoder().encode(manifestBytes);
  const manifest = parseManifest(JSON.parse(manifestBytes) as unknown);
  const committerTimestamp = new Date(Date.parse(manifest.windowStart) - 1000).toISOString();
  return checkPublication({
    localManifestBytes,
    publication: { ...REHEARSAL_PUBLICATION_DESCRIPTOR },
    resolved: { blobBytes: localManifestBytes, committerTimestamp },
  });
}

/** The rehearsal run options, derived from the booted manifest constants. Every field is
 *  consumed only at dispatch — which a rehearsal never reaches — but the shape is real. */
function rehearsalRunOptions(manifest: CohortManifestV1, now: () => number): LineOpenRunOptions {
  const baselinePolicyVersion = isBaselinePolicyVersion(manifest.baselinePolicyVersion)
    ? manifest.baselinePolicyVersion
    : undefined;
  return {
    timeoutMs: manifest.constants.providerCallTimeoutMs,
    maxOutputTokens: manifest.constants.maxOutputTokens,
    executionPolicy: 'fixed-moneyline-total',
    baselinePolicyVersion,
    nowMs: now,
  };
}

/** The report-only sink: a rehearsal never admits, so `runOneFire` returns before it
 *  is reached. If it is ever called, that is a broken invariant — fail loud. */
const NO_OP_SINK: ArtifactInstaller = {
  install() {
    throw new Error('rehearsal installs no artifact — the claim port never admits a dispatch');
  },
};

export interface RehearsalTickParams {
  /** The manifest bytes — the SAME bytes fed to boot and to publication verification. */
  readonly manifestBytes: string;
  /** The real read-only seam config (core-api + PostgREST). */
  readonly config: LineOpenReadConfig;
  /** The tick clock (wall clock in production; injected in tests). */
  readonly now: () => number;
  /** The per-process owner identity (never used in rehearsal; carried for shape). */
  readonly ownerId: string;
}

/**
 * Assemble a rehearsal `CohortTickInput` from the manifest bytes + read config. Booting
 * and publication verification happen here (pure, no network); the discovery/opener seams
 * are the REAL factories over `config` but are not invoked until `runCohortTick` runs.
 */
export function buildRehearsalTickInput(params: RehearsalTickParams): CohortTickInput {
  const booted = cohortBoot({ live: false, manifestBytes: params.manifestBytes });
  const publication = selfResolvePublication(params.manifestBytes);
  return {
    booted,
    publication,
    discover: createDiscoverFn(params.config),
    readMarketEvidence: createReadMarketEvidenceFn(params.config),
    claimPort: new RehearsalClaimPort(),
    adapters: createMockAdapters({ simulateCollision: false }),
    sink: NO_OP_SINK,
    runOptions: rehearsalRunOptions(booted.manifest, params.now),
    admission: { ownerId: params.ownerId, expectedSchemaVersion: STORE_SCHEMA_VERSION },
    now: params.now,
  };
}

/** A one-line description of a fire outcome carrying its discriminating info (mirrors the
 *  runner's private `describeOutcome`): the kind plus a claim reason or completion status. */
function describeOutcome(outcome: LineOpenFireOutcome): string {
  if (outcome.kind === 'Installed') {
    return outcome.completion.status === 'settled'
      ? 'Installed/settled'
      : `Installed/unsettled(${outcome.completion.reason})`;
  }
  const claim = outcome.outcome;
  return 'reason' in claim ? `NotAdmitted/${claim.kind}(${claim.reason})` : `NotAdmitted/${claim.kind}`;
}

/** Render a `CohortTickResult` into human-readable lines: discovery count, one line per
 *  candidate disposition, one line per attempted fire outcome, and the admitted count. */
export function formatTickResult(result: CohortTickResult): string[] {
  const lines: string[] = [];
  lines.push(`discovered ${result.discoveredCount} candidate(s)`);
  lines.push(`dispositions (${result.dispositions.length}):`);
  for (const d of result.dispositions) {
    const reason = 'reason' in d ? `/${d.reason}` : '';
    lines.push(`  ${d.gameId} ${d.market}: ${d.outcome}${reason}`);
  }
  lines.push(`fire outcomes (${result.fireOutcomes.length}):`);
  for (const f of result.fireOutcomes) {
    lines.push(`  fire ${f.fireId} (${f.gameId} ${f.market}): ${describeOutcome(f.outcome)}`);
  }
  lines.push(`admitted ${result.admittedCount} fire(s)`);
  return lines;
}

// ---------------------------------------------------------------------------
// CLI glue
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const loaded = loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  printLine(
    'ospex-benchmark line-open runner — REHEARSAL (dry-run) — report-only claim, no store, no model spend, no artifacts',
  );
  if (loaded.length > 0) {
    printLine(`loaded ${loaded.length} env var(s) from .env: ${loaded.join(', ')}`);
  }

  if (options.store !== 'rehearsal') {
    printError(
      `--store=${options.store} is not supported in this slice — rehearsal only. ` +
        'The store-backed (postgres) runner is a separate slice.',
    );
    return 2;
  }

  // Read or generate the manifest bytes ONCE — the same bytes drive both cohortBoot
  // (string-decoded) and publication verification (as raw bytes).
  const now = (): number => Date.now();
  let manifestBytes: string;
  if (options.manifestPath !== null) {
    manifestBytes = readFileSync(options.manifestPath, 'utf8');
    printLine(`manifest: read ${manifestBytes.length} byte(s) from ${options.manifestPath}`);
  } else {
    manifestBytes = buildRehearsalManifest(now()).bytes;
    printLine('manifest: generated in-process (code-consistent, now-relative observation window)');
  }

  // `--live` is routed into cohortBoot, which hard-disables it. Surface the refusal.
  if (options.live) {
    try {
      cohortBoot({ live: true, manifestBytes });
    } catch (error) {
      if (error instanceof CohortBootError) {
        printError(`--live rejected by cohortBoot: ${error.message}`);
        return 2;
      }
      throw error;
    }
    // Unreachable: cohortBoot always throws on live===true.
    printError('unexpected: --live was not rejected');
    return 1;
  }

  // --emit-manifest: prove the manifest boots and its publication self-resolves, then
  // write it and exit — NO network I/O.
  if (options.emitManifestPath !== null) {
    const booted = cohortBoot({ live: false, manifestBytes });
    selfResolvePublication(manifestBytes);
    writeFileSync(options.emitManifestPath, manifestBytes);
    printLine(`[rehearsal] cohort booted: cohortId ${booted.cohortId}`);
    printLine(
      '[rehearsal] publication self-resolved (blob == local manifest); real GitHub precommitment deferred to the live path',
    );
    printLine(`manifest written to ${options.emitManifestPath} (${manifestBytes.length} bytes) — no network I/O`);
    return 0;
  }

  // Real read-only config from the environment (mirrors the live watch/smoke path).
  const supabaseUrl = envValue('SUPABASE_URL');
  const anonKey = envValue('SUPABASE_ANON_KEY');
  const missing = [
    ...(supabaseUrl === undefined ? ['SUPABASE_URL'] : []),
    ...(anonKey === undefined ? ['SUPABASE_ANON_KEY'] : []),
  ];
  if (supabaseUrl === undefined || anonKey === undefined) {
    printError(`rehearsal reads need the public read path configured — missing env: ${missing.join(', ')}`);
    printError('set SUPABASE_URL and SUPABASE_ANON_KEY (and optionally OSPEX_API_URL) in .env or the environment.');
    return 2;
  }
  const apiUrl = envValue('OSPEX_API_URL') ?? DEFAULT_OSPEX_API_URL;
  const config: LineOpenReadConfig = { apiUrl, supabaseUrl, anonKey, now };

  const ownerId = `${hostname()}-${process.pid}-${randomUUID()}`;
  const input = buildRehearsalTickInput({ manifestBytes, config, now, ownerId });
  printLine(`[rehearsal] cohort booted: cohortId ${input.booted.cohortId}`);
  printLine(
    '[rehearsal] publication self-resolved (blob == local manifest); real GitHub precommitment deferred to the live path',
  );
  printLine(`reading MLB slate via ${apiUrl} + PostgREST current_odds/odds_history (read-only) ...`);

  const result = await runCohortTick({ ...input, onStatus: (line) => printLine(`  ${line}`) });

  printLine('');
  for (const line of formatTickResult(result)) printLine(line);
  return 0;
}

/** True only when this module is the process entry point — so importing it (e.g. in a
 *  unit test, to reach the exported helpers) never runs the CLI `main`. */
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
