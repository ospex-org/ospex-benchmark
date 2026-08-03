import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isBaselinePolicyVersion } from './baselines.js';
import { assertCohortBudgetInitialized, buildCohortBudgetInitRequest } from './cohortBudgetInit.js';
import { cohortBoot } from './cohortBoot.js';
import { runCohortTick } from './cohortRunner.js';
import { DEFAULT_OSPEX_API_URL, describeErrorWithStack, envValue } from './config.js';
import { printError, printLine } from './console.js';
import { buildCrossingManifest } from './crossingProfile.js';
import { buildDemoFixture, buildFixtureSeams } from './demoFixture.js';
import { loadDotEnv } from './env.js';
import { FireArtifactSink } from './fireArtifactSink.js';
import { RehearsalClaimPort, StoreClaimPort } from './lineOpenClaim.js';
import { createDiscoverFn, createReadMarketEvidenceFn } from './lineOpenRead.js';
import { askLiveConfirmation, observeRealAdapterCredentials, resolveLiveIntent } from './liveIntent.js';
import { parseManifest } from './manifest.js';
import { checkPublication } from './manifestPublication.js';
import {
  createCohortMockAdapterCapability,
  gateRealCohortAdapterCapability,
} from './cohortAdapterCapability.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import { SqlAtomicStore, pgStoreQuery } from './store/atomicStore.js';
import { STORE_SCHEMA_VERSION } from './store/constants.js';
import type { BootedCohort } from './cohortBoot.js';
import type { CohortAdapterCapability } from './cohortAdapterCapability.js';
import type { FixtureSeams } from './demoFixture.js';
import type { CohortManifestV1 } from './manifest.js';
import type { CohortTickInput, CohortTickResult } from './cohortRunner.js';
import type { AtomicStore } from './store/contract.js';
import type { LineOpenReadConfig } from './lineOpenRead.js';
import type { LiveIntentResolution } from './liveIntent.js';
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
 * A store-backed (`--store=postgres`) run additionally admits a real fire: over
 * `--fixture` (a now-relative synthetic candidate that passes the projector against the
 * wall clock) it boots the cohort, applies + initializes the atomic store, runs one tick
 * with a genuine `StoreClaimPort` + mock adapters (zero provider spend) + a durable
 * `FireArtifactSink`, and installs one real artifact — the deterministic "see it fire"
 * demo. Real GitHub publication resolution stays self-resolved.
 *
 * `--live` requests the ATTENDED crossing on that same store-backed fixture path, and is
 * resolved TRI-STATE (`resolveLiveIntent`): without `--live` the mock capability is
 * selected exactly as before; with `--live`, the run either (a) fully authorizes — the
 * pinned crossing-profile cohort, every roster credential observed, the exact terms
 * printed, and an explicit operator confirmation — and mints REAL billable adapters via
 * the gated producer, or (b) refuses NONZERO. A live request is NEVER silently downgraded
 * to mock.
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
  --live                  Request the ATTENDED live crossing (REAL provider adapters, real
                          spend). Requires --store=postgres --fixture, the pinned crossing
                          profile, every roster credential, and an explicit confirmation;
                          any missing prerequisite fails NONZERO (never mock fallback).
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
 *  they drive the real mock dispatch. Shared by both paths so the shape is single-sourced. The
 *  dispatch clock is NOT carried here — it is the one tick clock threaded via `CohortTickInput.now`
 *  (see `LineOpenRunOptions`, which omits `nowMs`). */
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

/** The report-only sink: a rehearsal never admits, so `runOneFire` returns before it
 *  is reached. If it is ever called, that is a broken invariant — fail loud. */
const NO_OP_SINK: ArtifactInstaller = {
  install() {
    throw new Error('rehearsal installs no artifact — the claim port never admits a dispatch');
  },
  installSpendEscalationSidecar() {
    throw new Error('rehearsal installs no sidecar — the claim port never admits a dispatch');
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
  const booted = cohortBoot({ manifestBytes: decodeManifestText(params.manifestBytes) });
  const publication = selfResolvePublication(params.manifestBytes);
  return {
    booted,
    publication,
    discover: createDiscoverFn(params.config),
    readMarketEvidence: createReadMarketEvidenceFn(params.config),
    claimPort: new RehearsalClaimPort(),
    // The production capability producer constructs its OWN mock adapters (known-zero) —
    // no raw map, no caller-supplied billing label; the rehearsal never dispatches at all.
    capability: createCohortMockAdapterCapability({ simulateCollision: false }),
    sink: NO_OP_SINK,
    runOptions: deriveRunOptions(booted.manifest),
    admission: { ownerId: params.ownerId, expectedSchemaVersion: STORE_SCHEMA_VERSION },
    now: params.now,
  };
}

/** A one-line description of a fire outcome carrying its discriminating info (mirrors the
 *  runner's private `describeOutcome`): the kind plus a claim reason, completion status, or
 *  pre-claim `CoverageMiss` reason. Exhaustive switch with a `never` default — the `CoverageMiss`
 *  case is handled BEFORE any `outcome.outcome` read (a `CoverageMiss` has no `.outcome`, so the
 *  legacy `'reason' in claim` path would throw on it). */
function describeOutcome(outcome: LineOpenFireOutcome): string {
  switch (outcome.kind) {
    case 'Installed':
      return outcome.completion.status === 'settled'
        ? 'Installed/settled'
        : `Installed/unsettled(${outcome.completion.reason})`;
    case 'InstalledEscalated':
      // An escalation, not a success: the artifact IS durably installed, but the spend guard
      // refused settlement and the tick stopped admitting. Name the reason and every offender.
      return `InstalledEscalated/${outcome.reason} (${outcome.offenders.length} offending attempt(s))`;
    case 'CoverageMiss':
      return `CoverageMiss/${outcome.reason}`;
    case 'NotAdmitted': {
      const claim = outcome.outcome;
      return 'reason' in claim ? `NotAdmitted/${claim.kind}(${claim.reason})` : `NotAdmitted/${claim.kind}`;
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
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
    if (f.outcome.kind === 'InstalledEscalated') {
      // The operator report carries the durable escalation evidence: sidecar path + hash.
      lines.push(`    sidecar: ${f.outcome.sidecar.path} sha256 ${f.outcome.sidecar.sha256}`);
    }
  }
  lines.push(`admitted ${result.admittedCount} fire(s)`);
  return lines;
}

/** The durable path of every fire this tick actually installed. BOTH installed kinds carry one:
 *  a clean `Installed`, and an `InstalledEscalated` — the whole point of post-install escalation
 *  is that the evidence durably exists, so dropping the escalated fire's path here would erase
 *  exactly the artifact an operator most needs to find. Empty when nothing installed. */
export function installedArtifactPaths(result: CohortTickResult): string[] {
  const paths: string[] = [];
  for (const f of result.fireOutcomes) {
    if (f.outcome.kind === 'Installed' || f.outcome.kind === 'InstalledEscalated') {
      paths.push(f.outcome.install.path);
    }
  }
  return paths;
}

/**
 * Classify a store-backed fire's tick result for the `runner:fire` exit code. The promised demo
 * COMPLETED — and the process may exit 0 — ONLY when the tick attempted exactly ONE fire, that fire
 * durably installed (`outcome.kind === 'Installed'`) AND confirmed settlement
 * (`completion.status === 'settled'`), and it left exactly ONE installed artifact path. Every other
 * shape is a demo that did NOT complete: zero fire outcomes, any `NotAdmitted` (all-claimed / defer /
 * refused / rehearsal `WouldAdmit`), an `Installed` that could not settle (`unsettled`), or a
 * fire/artifact-path count other than exactly one. Pure — it reads only the frozen result, so the
 * caller prints the outcomes first and lets this decide the exit code.
 */
export function classifyStoreFireResult(
  result: CohortTickResult,
): { ok: true } | { ok: false; reason: string } {
  const outcomes = result.fireOutcomes;
  if (outcomes.length === 0) {
    return { ok: false, reason: 'no fire was attempted this tick (zero fire outcomes)' };
  }
  if (outcomes.length !== 1) {
    return { ok: false, reason: `expected exactly one fire, got ${outcomes.length}` };
  }
  const only = outcomes[0]!;
  if (only.outcome.kind === 'InstalledEscalated') {
    // Loud and non-clean, with an honest message: the artifact DID durably install — what failed
    // is settlement, refused by the spend guard. This branch is the store/`runner:fire` path's
    // nonzero-exit owner for an escalation.
    return {
      ok: false,
      reason: `the fire installed its evidence but the spend guard refused settlement: ${describeOutcome(only.outcome)}`,
    };
  }
  if (only.outcome.kind !== 'Installed') {
    return { ok: false, reason: `the fire installed no artifact: ${describeOutcome(only.outcome)}` };
  }
  if (only.outcome.completion.status !== 'settled') {
    return { ok: false, reason: `the fire installed but did not settle: ${describeOutcome(only.outcome)}` };
  }
  const paths = installedArtifactPaths(result);
  if (paths.length !== 1) {
    return { ok: false, reason: `expected exactly one installed artifact path, got ${paths.length}` };
  }
  return { ok: true };
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
 * The DB-bound seams of the store-backed fire, injected so the owner-level flow — the up-front
 * option refusal, boot, budget init, the tick, the result classification, and the exit code — is
 * drivable WITHOUT a database. `openStore` provisions the durable store; `runTick` runs ONE cohort
 * tick. The production default (below) is the live `runner:fire` behavior, unchanged.
 */
export interface StoreFireDeps {
  /** Open the durable store for `databaseUrl`, returning it plus an idempotent close. */
  readonly openStore: (databaseUrl: string) => Promise<{ store: AtomicStore; close: () => Promise<void> }>;
  /** Run ONE cohort tick over the assembled input. */
  readonly runTick: (input: CohortTickInput) => Promise<CohortTickResult>;
  /**
   * Resolve the invocation's tri-state live intent against the booted cohort. The
   * production default wires `resolveLiveIntent` with the real credential probe, the
   * CLI printer, and the attended stdin confirmation; tests inject scripted
   * resolutions. The RESOLUTION selects; the gated producer (NOT injectable here)
   * still independently re-validates the cohort binding, crossing pins, and
   * credentials before any billable mint — the attended confirmation itself is the
   * resolution's own gate (see the `liveIntent` module header), which is why an
   * injected resolution is trusted exactly as far as the coherence guard and the
   * producer's re-validation allow.
   */
  readonly resolveLive: (request: { live: boolean; booted: BootedCohort }) => Promise<LiveIntentResolution>;
}

/**
 * The production store-fire seams. `openStore` imports `pg` DYNAMICALLY — so the rehearsal path and
 * the importable pure helpers never pull a database driver — builds the Pool, applies the idempotent
 * schema (closing the Pool if that fails, so the driver is never leaked, matching the original inline
 * `finally`), then wraps it as the atomic store. `runTick` runs the real cohort tick, echoing each
 * fire's status line — byte-identical to the previous inline call.
 */
const PRODUCTION_STORE_FIRE_DEPS: StoreFireDeps = {
  openStore: async (databaseUrl) => {
    // `pg` is imported dynamically so the rehearsal path (and the importable pure helpers) never
    // pull a database driver; only the store-backed branch constructs a Pool.
    const { Pool } = await import('pg');
    const pool: Pool = new Pool({ connectionString: databaseUrl });
    try {
      // Make the store self-contained: apply the idempotent DDL (no drop) before wrapping it.
      await applyStoreSchema(pool);
    } catch (error) {
      // A schema-apply failure must not leak the Pool — close it before propagating (the original
      // inline path closed the Pool in its `finally` on this same failure).
      await pool.end();
      throw error;
    }
    return { store: new SqlAtomicStore(pgStoreQuery(pool)), close: () => pool.end() };
  },
  runTick: (input) => runCohortTick({ ...input, onStatus: (line) => printLine(`  ${line}`) }),
  resolveLive: ({ live, booted }) =>
    resolveLiveIntent({
      live,
      booted,
      observeCredentials: observeRealAdapterCredentials,
      print: printLine,
      confirm: askLiveConfirmation,
    }),
};

/**
 * Run the store-backed fixture fire: resolve the tri-state live intent, apply + initialize the
 * atomic store, boot the now-relative synthetic cohort, then run ONE tick with a genuine
 * `StoreClaimPort` (real admission), the selected adapter capability, and a durable
 * `FireArtifactSink`. On an admitted candidate this dispatches the roster, produces + installs
 * one artifact, and settles the claim. Returns the process exit code; the store is always closed.
 *
 * Adapter selection is owned by the tri-state resolution: `MockRequested` selects the known-zero
 * mock capability (the unchanged "see it fire" demo, zero provider spend); `LiveAuthorized` mints
 * REAL billable adapters through the gated producer (which independently re-validates the
 * authorization against the booted crossing cohort); `LiveRefused` exits NONZERO before any DB
 * work — a live request never falls back to mock. Under `--live` the fixture boots the pinned
 * one-fire CROSSING manifest instead of the demo manifest ($800 spend cap, call cap 8, one
 * dispatch, conservative guard price table, production provider timeout).
 *
 * The DB-bound seams (`openStore`, `runTick`) and the live resolution (`resolveLive`) are
 * injected with production defaults so the whole owner-level flow is drivable without a database;
 * the default no-`--live` path is the live `runner:fire` behavior, unchanged.
 */
export async function runStoreBackedFire(
  options: CliOptions,
  deps: StoreFireDeps = PRODUCTION_STORE_FIRE_DEPS,
): Promise<number> {
  if (!options.fixture) {
    printError(
      '--store=postgres requires --fixture: real MLB discovery at line-open is always ' +
        'stale-rejected (the runner refuses stale openers), so the demo needs the synthetic candidate.',
    );
    return 2;
  }
  const databaseUrl = envValue('STORE_DATABASE_URL') ?? DEFAULT_STORE_DATABASE_URL;
  const outDir = options.outDir ?? envValue('FIRE_ARTIFACTS_DIR') ?? DEFAULT_FIRE_ARTIFACTS_DIR;

  // (0) Boot the cohort and RESOLVE LIVE INTENT — all BEFORE any DB work, so a refused
  //     live request touches nothing. The mock demo builds its whole fixture (manifest +
  //     read seams) at one anchor, unchanged; the live crossing boots ONLY the crossing
  //     MANIFEST here — its hours-wide, now-relative window tolerates the unbounded
  //     attended confirmation — and anchors the read SEAMS separately below, AFTER
  //     authorization, because the projector's snapshot-freshness gate (`freshFireMs`,
  //     30s in these manifests) measures detection against the seams' fetch instant: seams
  //     anchored before the prompt would go stale while the operator reads the terms.
  const bootAnchorMs = Date.now();
  const demoFixture = options.live ? null : buildDemoFixture(bootAnchorMs);
  const manifestBytes: Uint8Array =
    demoFixture === null
      ? new TextEncoder().encode(buildCrossingManifest(bootAnchorMs).bytes)
      : demoFixture.manifestBytes;
  const booted = cohortBoot({ manifestBytes: decodeManifestText(manifestBytes) });
  const publication = selfResolvePublication(manifestBytes);

  const resolution = await deps.resolveLive({ live: options.live, booted });
  // Coherence guard: the resolution must AGREE with the invocation's live flag in both
  // directions. `MockRequested` for a live request is the banned silent downgrade (a mock
  // run reported as the crossing); a non-mock resolution for a mock request would escalate
  // an invocation the operator never armed. The production resolver cannot produce either,
  // so this guards the injectable seam — the banner and dispatch labels below key on
  // `options.live`, and this is what makes that equivalent to keying on the resolution.
  if (options.live !== (resolution.kind !== 'MockRequested')) {
    printError(
      `live-intent resolution is incoherent with the invocation (--live=${String(options.live)}, ` +
        `resolution ${resolution.kind}); refusing — a live request is never downgraded to mock, ` +
        `and a mock request never escalates`,
    );
    return 1;
  }
  let capability: CohortAdapterCapability;
  switch (resolution.kind) {
    case 'LiveRefused':
      // NONZERO, before any store/DB/artifact work. NEVER reinterpreted as mock: a silently
      // downgraded run would report a rehearsal as if it were the crossing.
      printError(`--live refused — no mock fallback: ${resolution.violations.join('; ')}`);
      return 2;
    case 'LiveAuthorized':
      // The gated producer independently re-validates the authorization (cohort binding,
      // crossing pins, credential observation) before minting billable adapters; a producer
      // refusal throws loudly out of this function.
      capability = gateRealCohortAdapterCapability(booted, resolution.authorization);
      break;
    case 'MockRequested':
      // The store-backed fixture demo dispatches through the production mock capability —
      // producer-constructed adapters, known-zero provenance, zero real spend.
      capability = createCohortMockAdapterCapability({ simulateCollision: false });
      break;
    default: {
      const _exhaustive: never = resolution;
      return _exhaustive;
    }
  }

  // The synthetic read seams. The mock demo reuses its fixture's boot-anchored seams (the
  // sub-second store open below spends from the 30s freshness budget — fine locally); the
  // live crossing anchors FRESH seams now, after the confirmation, so the freshness gate
  // measures milliseconds rather than human reading time.
  const seams: FixtureSeams = demoFixture ?? buildFixtureSeams(Date.now());

  // (1) Open the durable store (production: a pg Pool + idempotent DDL, no drop); the seam is
  //     injectable so the owner-level flow is drivable without a database. Always closed below.
  const { store, close } = await deps.openStore(databaseUrl);
  try {
    printLine('store schema + functions applied idempotently (no destructive drop)');
    printLine(`[fixture] cohort booted: cohortId ${booted.cohortId}`);

    // (2) Pin the cohort's caps + constants in the store BEFORE the tick — every admit refuses
    //     `not_initialized` otherwise. The request is derived from authenticated boot identity.
    const initResult = await store.initCohortBudget(buildCohortBudgetInitRequest(booted));
    assertCohortBudgetInitialized(initResult);
    printLine('[fixture] cohort budget initialized in the store');

    // (3) One tick on the wall clock: genuine admission, the selected capability, durable sink.
    const now = (): number => Date.now();
    const ownerId = `${hostname()}-${process.pid}-${randomUUID()}`;
    const input: CohortTickInput = {
      booted,
      publication,
      discover: seams.discover,
      readMarketEvidence: seams.readMarketEvidence,
      claimPort: new StoreClaimPort(store),
      capability,
      sink: new FireArtifactSink(outDir),
      runOptions: deriveRunOptions(booted.manifest),
      admission: { ownerId, expectedSchemaVersion: STORE_SCHEMA_VERSION },
      now,
    };
    printLine(
      options.live
        ? `dispatching the LIVE crossing fire (REAL provider adapters, artifacts → ${outDir}) ...`
        : `dispatching the synthetic fire (mock adapters, artifacts → ${outDir}) ...`,
    );

    const result = await deps.runTick(input);

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

    // The promised "see it fire" demo only succeeds when EXACTLY ONE fire installed AND settled with
    // exactly one artifact path; anything else (nothing admitted, an unsettled completion, or a
    // non-unit cardinality) exits NONZERO so `runner:fire` cannot report success on a fire that did
    // not actually complete. The outcomes + paths are already printed above; this only decides the code.
    const classification = classifyStoreFireResult(result);
    if (!classification.ok) {
      printError(`store-backed fire did not complete the promised demo: ${classification.reason}`);
      return 1;
    }
    return 0;
  } finally {
    await close();
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

  // Reject incompatible option combinations UP FRONT — before the dynamic `pg` import, any DB /
  // artifact work, the store-backed branch, or the emit branch. `--emit-manifest` proves + writes a
  // manifest performing NO network/DB I/O, so it can never combine with the store-backed fire (a live
  // database path). `--fixture` is meaningful ONLY for that store-backed fire — real discovery at
  // line-open is always stale-rejected — so it is refused in any other mode. Both are usage errors (2).
  if (options.emitManifestPath !== null && options.store === 'postgres') {
    printError(
      '--emit-manifest cannot combine with --store=postgres: --emit-manifest performs no network/DB I/O, ' +
        'while the store-backed fire is a live database path. Run one or the other.',
    );
    return 2;
  }
  if (options.fixture && options.store !== 'postgres') {
    printError(
      `--fixture is only valid with --store=postgres (the store-backed fixture fire); --store=${options.store} does not use it.`,
    );
    return 2;
  }
  // `--live` is meaningful ONLY on the store-backed crossing path; anywhere else it is refused
  // NONZERO up front. It is deliberately NEVER ignored or downgraded: an operator who typed
  // --live intended a paid run, and silently running the rehearsal instead would misreport it.
  if (options.live && options.store !== 'postgres') {
    printError(
      '--live is only valid on the store-backed crossing path (--store=postgres --fixture); it never ' +
        'applies to the rehearsal path and is never silently ignored. Remove --live, or run the crossing.',
    );
    return 2;
  }

  printLine(
    options.store === 'postgres'
      ? options.live
        ? 'ospex-benchmark line-open runner — STORE-BACKED LIVE CROSSING (postgres + fixture + --live) — real admission, REAL provider adapters on attended confirmation, durable artifact'
        : 'ospex-benchmark line-open runner — STORE-BACKED FIRE (postgres + fixture) — real admission, mock dispatch (zero model spend), durable artifact'
      : 'ospex-benchmark line-open runner — REHEARSAL (dry-run) — report-only claim, no store, no model spend, no artifacts',
  );
  if (loaded.length > 0) {
    printLine(`loaded ${loaded.length} env var(s) from .env: ${loaded.join(', ')}`);
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
    const booted = cohortBoot({ manifestBytes: manifestText });
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
