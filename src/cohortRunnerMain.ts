import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isBaselinePolicyVersion } from './baselines.js';
import { assertCohortBudgetInitialized, buildCohortBudgetInitRequest } from './cohortBudgetInit.js';
import { CohortBootError, cohortBoot } from './cohortBoot.js';
import { runCohortTick } from './cohortRunner.js';
import { DEFAULT_OSPEX_API_URL, describeErrorWithStack, envValue } from './config.js';
import { printError, printLine } from './console.js';
import { buildDemoFixture } from './demoFixture.js';
import { loadDotEnv } from './env.js';
import { FireArtifactSink } from './fireArtifactSink.js';
import { RehearsalClaimPort, StoreClaimPort } from './lineOpenClaim.js';
import { createDiscoverFn, createReadMarketEvidenceFn } from './lineOpenRead.js';
import { parseManifest } from './manifest.js';
import { checkPublication } from './manifestPublication.js';
import { createMockAdapters } from './mock.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import { SqlAtomicStore, pgStoreQuery } from './store/atomicStore.js';
import { STORE_SCHEMA_VERSION } from './store/constants.js';
import type { CohortManifestV1 } from './manifest.js';
import type { CohortTickInput, CohortTickResult } from './cohortRunner.js';
import type { LineOpenReadConfig } from './lineOpenRead.js';
import type { PublicationVerified } from './manifestPublication.js';
import type { ArtifactInstaller, LineOpenFireOutcome, LineOpenRunOptions } from './lineOpenSpine.js';
import type { Pool } from 'pg';

/** The scratch Postgres the store-backed demo defaults to (mirrors the adapter conformance
 *  harness). Real environments set STORE_DATABASE_URL; nothing points at production here. */
const DEFAULT_STORE_DATABASE_URL = 'postgres://postgres:spike@localhost:5433/store_spike';
/** The default durable artifact output root — a scratch dir under the repo (gitignored). */
const DEFAULT_FIRE_ARTIFACTS_DIR = './.fire-artifacts';

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
 * store-backed (`--store=postgres`) run additionally admits a real fire: over
 * `--fixture` (a now-relative synthetic candidate that passes the projector against the
 * wall clock) it boots the cohort, applies + initializes the atomic store, runs one tick
 * with a genuine `StoreClaimPort` + mock adapters (zero provider spend) + a durable
 * `FireArtifactSink`, and installs one real artifact — the deterministic "see it fire"
 * demo. Real GitHub publication resolution stays self-resolved; `--live` is still
 * unreachable.
 *
 * The env/argv glue lives in `main`; the boot + seam construction + rendering are
 * extracted into pure, injectable helpers (`buildRehearsalTickInput`,
 * `selfResolvePublication`, `formatTickResult`) so they are unit-testable without
 * env or network.
 */

class UsageError extends Error {}

const USAGE = `Usage: yarn runner:dry [options]   |   yarn runner:fire

REHEARSAL (default, --store=rehearsal): runs ONE line-open cohort tick with real
read-only discovery/opener reads, a report-only claim port (never admits), mock
adapters (never called), and no artifacts written. Reads need SUPABASE_URL +
SUPABASE_ANON_KEY (and optionally OSPEX_API_URL) in the environment or a local .env.

STORE-BACKED FIRE (--store=postgres --fixture): admits a real fire against a Postgres
store using a now-relative synthetic candidate and mock adapters (zero provider spend),
producing + installing one durable artifact. Needs STORE_DATABASE_URL (default a local
scratch Postgres); the schema + functions are applied idempotently on boot.

Options:
  --manifest <path>       Read the cohort manifest from a file. Default: generate a
                          code-consistent manifest in-process (now-relative window).
                          (Ignored under --store=postgres, which uses the fixture manifest.)
  --emit-manifest <path>  Generate the in-process manifest, prove it boots and its
                          publication self-resolves, WRITE it to <path>, and exit 0.
                          Performs NO network I/O (no core-api / Supabase reads).
  --store <mode>          rehearsal (default) | postgres (the store-backed fixture fire).
  --fixture               Use the deterministic synthetic candidate. REQUIRED under
                          --store=postgres (real MLB discovery is always stale-rejected).
  --out <dir>             Durable artifact output root for the fire (default ${DEFAULT_FIRE_ARTIFACTS_DIR},
                          or FIRE_ARTIFACTS_DIR). Only used under --store=postgres.
  --live                  Routed into cohortBoot, which hard-disables live firing
                          (always rejected in this build).
  -h, --help              Show this help.`;

interface CliOptions {
  manifestPath: string | null;
  emitManifestPath: string | null;
  store: string;
  fixture: boolean;
  outDir: string | null;
  live: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    manifestPath: null,
    emitManifestPath: null,
    store: 'rehearsal',
    fixture: false,
    outDir: null,
    live: false,
  };
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
    } else if (arg === '--fixture') {
      options.fixture = true;
    } else if (arg === '--out') {
      options.outDir = next();
    } else if (arg !== undefined && arg.startsWith('--out=')) {
      options.outDir = arg.slice('--out='.length);
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
 * Fatal UTF-8 decode: an invalid byte sequence THROWS rather than being silently
 * replaced with U+FFFD. The manifest bytes ARE the cohort identity AND the publication
 * precommitment blob, so a corrupted manifest must fail loudly — never be normalized
 * (rewriting `0xff` into the 3-byte U+FFFD) and then booted under a rewritten identity.
 */
const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

/** Decode raw manifest bytes to text, throwing on any invalid UTF-8. */
export function decodeManifestText(rawBytes: Uint8Array): string {
  return utf8Fatal.decode(rawBytes);
}

/**
 * Self-resolve the manifest's public-Git precommitment WITHOUT a GitHub resolver: the
 * "published" blob IS the RAW local manifest bytes (never a re-encoded string), and the
 * committer timestamp is derived to be strictly before `windowStart`. The bytes are
 * fatal-decoded + parsed ONLY to read `windowStart`; the raw bytes themselves are what
 * the check binds as both the local manifest and the blob. `checkPublication` is pure (no
 * network) and enforces byte-equality, cohortId equality, and the committer-before-
 * windowStart rule, so it returns a genuine branded `PublicationVerified`. Honest for a
 * rehearsal that issues zero provider requests; a real GitHub precommitment is a live-path
 * requirement. Throws on invalid-UTF-8 bytes (the fatal decode below).
 */
export function selfResolvePublication(manifestBytes: Uint8Array): PublicationVerified {
  const manifest = parseManifest(JSON.parse(decodeManifestText(manifestBytes)) as unknown);
  const committerTimestamp = new Date(Date.parse(manifest.windowStart) - 1000).toISOString();
  return checkPublication({
    localManifestBytes: manifestBytes,
    publication: { ...REHEARSAL_PUBLICATION_DESCRIPTOR },
    resolved: { blobBytes: manifestBytes, committerTimestamp },
  });
}

/** The run options, derived from the booted manifest constants. In a rehearsal every field is
 *  consumed only at a dispatch the report-only claim never reaches; in the store-backed fire
 *  they drive the real mock dispatch. Shared by both paths so the shape is single-sourced. */
function deriveRunOptions(manifest: CohortManifestV1, now: () => number): LineOpenRunOptions {
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
  /** The RAW manifest bytes — the single source fed (fatal-decoded) to boot and (as raw
   *  bytes) to publication verification, so a byte-corrupted manifest fails loudly. */
  readonly manifestBytes: Uint8Array;
  /** The real read-only seam config (core-api + PostgREST). */
  readonly config: LineOpenReadConfig;
  /** The tick clock (wall clock in production; injected in tests). */
  readonly now: () => number;
  /** The per-process owner identity (never used in rehearsal; carried for shape). */
  readonly ownerId: string;
}

/**
 * Assemble a rehearsal `CohortTickInput` from the RAW manifest bytes + read config. The
 * bytes are fatal-decoded once (throwing on invalid UTF-8) and the decoded string boots
 * the cohort, while the raw bytes verify the publication precommitment — so boot identity
 * and precommitment blob are the exact same bytes. Booting + verification are pure (no
 * network); the discovery/opener seams are the REAL factories over `config` but are not
 * invoked until `runCohortTick` runs.
 */
export function buildRehearsalTickInput(params: RehearsalTickParams): CohortTickInput {
  const booted = cohortBoot({ live: false, manifestBytes: decodeManifestText(params.manifestBytes) });
  const publication = selfResolvePublication(params.manifestBytes);
  return {
    booted,
    publication,
    discover: createDiscoverFn(params.config),
    readMarketEvidence: createReadMarketEvidenceFn(params.config),
    claimPort: new RehearsalClaimPort(),
    adapters: createMockAdapters({ simulateCollision: false }),
    sink: NO_OP_SINK,
    runOptions: deriveRunOptions(booted.manifest, params.now),
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

/** The durable path of every fire this tick actually installed (an `Installed` outcome carries
 *  the canonical artifact path). Empty when nothing admitted. */
export function installedArtifactPaths(result: CohortTickResult): string[] {
  const paths: string[] = [];
  for (const f of result.fireOutcomes) {
    if (f.outcome.kind === 'Installed') paths.push(f.outcome.install.path);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Store-backed "see it fire" path (--store=postgres --fixture)
// ---------------------------------------------------------------------------

/**
 * Idempotently (re)apply the store schema + functions to `pool`. The checked-in DDL is
 * idempotent (`create schema/table/index if not exists`, `create or replace function`), so
 * this is safe to run on every boot WITHOUT any destructive `drop` — it makes the demo
 * self-contained against a fresh or already-provisioned scratch database.
 */
async function applyStoreSchema(pool: Pool): Promise<void> {
  const schemaSql = readFileSync(new URL('./store/schema.sql', import.meta.url), 'utf8');
  const functionsSql = readFileSync(new URL('./store/functions.sql', import.meta.url), 'utf8');
  await pool.query(schemaSql);
  await pool.query(functionsSql);
}

/**
 * Run the store-backed fixture fire: apply + initialize the atomic store, boot the now-relative
 * synthetic cohort, then run ONE tick with a genuine `StoreClaimPort` (real admission), mock
 * adapters (zero provider spend), and a durable `FireArtifactSink`. On an admitted candidate this
 * dispatches the roster, produces + installs one artifact, and settles the claim. Returns the
 * process exit code; the pool is always closed.
 */
async function runStoreBackedFire(options: CliOptions): Promise<number> {
  if (!options.fixture) {
    printError(
      '--store=postgres requires --fixture: real MLB discovery at line-open is always ' +
        'stale-rejected (the runner refuses stale openers), so the demo needs the synthetic candidate.',
    );
    return 2;
  }
  const databaseUrl = envValue('STORE_DATABASE_URL') ?? DEFAULT_STORE_DATABASE_URL;
  const outDir = options.outDir ?? envValue('FIRE_ARTIFACTS_DIR') ?? DEFAULT_FIRE_ARTIFACTS_DIR;

  // `pg` is imported dynamically so the rehearsal path (and the importable pure helpers) never
  // pull a database driver; only the store-backed branch constructs a Pool.
  const { Pool } = await import('pg');
  const pool: Pool = new Pool({ connectionString: databaseUrl });
  try {
    // (1) Make the store self-contained: apply the idempotent DDL (no drop), then wrap it.
    await applyStoreSchema(pool);
    printLine('store schema + functions applied idempotently (no destructive drop)');
    const store = new SqlAtomicStore(pgStoreQuery(pool));

    // (2) Anchor the synthetic candidate at NOW, boot the cohort, and self-resolve publication.
    const anchorMs = Date.now();
    const fixture = buildDemoFixture(anchorMs);
    const manifestText = decodeManifestText(fixture.manifestBytes);
    const booted = cohortBoot({ live: false, manifestBytes: manifestText });
    const publication = selfResolvePublication(fixture.manifestBytes);
    printLine(`[fixture] cohort booted: cohortId ${booted.cohortId}`);

    // (3) Pin the cohort's caps + constants in the store BEFORE the tick — every admit refuses
    //     `not_initialized` otherwise. The request is derived from authenticated boot identity.
    const initResult = await store.initCohortBudget(buildCohortBudgetInitRequest(booted));
    assertCohortBudgetInitialized(initResult);
    printLine('[fixture] cohort budget initialized in the store');

    // (4) One tick on the wall clock: genuine admission, mock dispatch (zero spend), durable sink.
    const now = (): number => Date.now();
    const ownerId = `${hostname()}-${process.pid}-${randomUUID()}`;
    const input: CohortTickInput = {
      booted,
      publication,
      discover: fixture.discover,
      readMarketEvidence: fixture.readMarketEvidence,
      claimPort: new StoreClaimPort(store),
      adapters: createMockAdapters({ simulateCollision: false }),
      sink: new FireArtifactSink(outDir),
      runOptions: deriveRunOptions(booted.manifest, now),
      admission: { ownerId, expectedSchemaVersion: STORE_SCHEMA_VERSION },
      now,
    };
    printLine(`dispatching the synthetic fire (mock adapters, artifacts → ${outDir}) ...`);

    const result = await runCohortTick({ ...input, onStatus: (line) => printLine(`  ${line}`) });

    printLine('');
    for (const line of formatTickResult(result)) printLine(line);
    const paths = installedArtifactPaths(result);
    if (paths.length > 0) {
      printLine('');
      printLine(`installed ${paths.length} artifact(s):`);
      for (const p of paths) printLine(`  ${p}`);
    } else {
      printLine('');
      printLine('no artifact installed — the candidate did not admit a fire (see dispositions above)');
    }
    return 0;
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// CLI glue
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const loaded = loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  // The store mode is validated up front so an unknown value fails before any work.
  if (options.store !== 'rehearsal' && options.store !== 'postgres') {
    printError(
      `--store=${options.store} is not supported — use 'rehearsal' (default) or 'postgres' (the store-backed fixture fire).`,
    );
    return 2;
  }

  printLine(
    options.store === 'postgres'
      ? 'ospex-benchmark line-open runner — STORE-BACKED FIRE (postgres + fixture) — real admission, mock dispatch (zero model spend), durable artifact'
      : 'ospex-benchmark line-open runner — REHEARSAL (dry-run) — report-only claim, no store, no model spend, no artifacts',
  );
  if (loaded.length > 0) {
    printLine(`loaded ${loaded.length} env var(s) from .env: ${loaded.join(', ')}`);
  }

  // `--live` is hard-disabled by cohortBoot in EVERY mode; it rejects before the manifest is
  // even parsed, so surface the refusal without needing real manifest bytes.
  if (options.live) {
    try {
      cohortBoot({ live: true, manifestBytes: '{}' });
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

  // The store-backed fixture fire is its own self-contained path (a synthetic candidate + a
  // Postgres store; no Supabase reads, no supplied manifest).
  if (options.store === 'postgres') {
    return runStoreBackedFire(options);
  }

  // --- REHEARSAL path ---------------------------------------------------------
  // Obtain the manifest as RAW bytes ONCE — a supplied file is read as raw bytes (NO
  // 'utf8', so Node cannot silently replace invalid UTF-8), and the generated default is
  // encoded from its canonical string. These exact raw bytes ARE the cohort identity + the
  // publication precommitment blob.
  const now = (): number => Date.now();
  let rawBytes: Uint8Array;
  if (options.manifestPath !== null) {
    rawBytes = readFileSync(options.manifestPath);
    printLine(`manifest: read ${rawBytes.length} byte(s) from ${options.manifestPath}`);
  } else {
    rawBytes = new TextEncoder().encode(buildRehearsalManifest(now()).bytes);
    printLine('manifest: generated in-process (code-consistent, now-relative observation window)');
  }

  // Fatal-decode the raw bytes EARLY — an invalid-UTF-8 manifest throws HERE (flowing to
  // main's catch → nonzero exit) before any boot, emit, or read work. cohortBoot consumes
  // this decoded string; publication verification consumes the raw bytes.
  const manifestText = decodeManifestText(rawBytes);

  // --emit-manifest: prove the manifest boots and its publication self-resolves, then
  // write the EXACT accepted raw bytes and exit — NO network I/O.
  if (options.emitManifestPath !== null) {
    const booted = cohortBoot({ live: false, manifestBytes: manifestText });
    selfResolvePublication(rawBytes);
    writeFileSync(options.emitManifestPath, rawBytes);
    printLine(`[rehearsal] cohort booted: cohortId ${booted.cohortId}`);
    printLine(
      '[rehearsal] publication self-resolved (blob == local manifest); real GitHub precommitment deferred to the live path',
    );
    printLine(`manifest written to ${options.emitManifestPath} (${rawBytes.length} bytes) — no network I/O`);
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
  const input = buildRehearsalTickInput({ manifestBytes: rawBytes, config, now, ownerId });
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
