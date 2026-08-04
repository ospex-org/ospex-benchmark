import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCampaignAuthorization, classifyCampaignAuthorization, resolveCampaignIntent } from './campaignAuthorization.js';
import type { CampaignAuthorization, CampaignAuthorizationPort } from './campaignAuthorization.js';
import { OBSERVED_USD_MICROS_PER_ATTEMPT, buildCampaignManifest, campaignBoundsViolations, projectCampaignCost } from './campaignProfile.js';
import { assertCohortBudgetInitialized, buildCohortBudgetInitRequest } from './cohortBudgetInit.js';
import { cohortBoot } from './cohortBoot.js';
import type { BootedCohort } from './cohortBoot.js';
import { decodeManifestText } from './cohortRunnerMain.js';
import { describeErrorWithStack, envValue } from './config.js';
import { printError, printLine } from './console.js';
import { loadDotEnv } from './env.js';
import { ByteDifferentCollisionError, installBytesNoClobber, nodeArtifactFs } from './fireArtifactSink.js';
import type { ArtifactFs } from './fireArtifactSink.js';
import { askLiveConfirmation, observeRealAdapterCredentials } from './liveIntent.js';
import { PublicationError, parseManifestPublication, verifyPublication } from './manifestPublication.js';
import type { ManifestPublicationV1, ResolvedPublication } from './manifestPublication.js';
import { instantMs, isParseableInstant } from './time.js';
import type { AtomicStore } from './store/contract.js';
import type { CampaignStatusReadPort } from './store/campaignStatusRead.js';

/**
 * The CAMPAIGN entrypoint — `arm`, `tick`, `stop`.
 *
 * The attended crossing authorized exactly one fire, with a human answering a prompt. A
 * scheduled benchmark cannot answer a prompt (and by design an unanswered prompt refuses), so
 * the confirmation MOVES rather than disappearing:
 *
 *   - `arm`  — ATTENDED, once per campaign, with a REQUIRED `--start` (the campaign's
 *              identity anchor, so the identical command stays byte-identical across
 *              retries). Boots the cohort, prints the exact terms (identity, window, size
 *              in calls and fires, and what that costs at both the observed rate and the
 *              committed conservative bound), takes the standard `[Y/n]` confirmation, and
 *              then makes the durable writes in AUTHORITY ORDER: the manifest file first
 *              (the fire-artifact sink's durable temp + atomic no-clobber hard-link +
 *              directory-sync loop, plus a final read-back), the cohort budget next
 *              (durable but NOT authorizing), and the authorization record LAST — the
 *              single authorizing transition. A failed arm therefore never leaves standing
 *              authority without its manifest on disk, and re-running the same arm
 *              reconciles any intermediate failure.
 *   - `tick` — UNATTENDED, what a scheduler will call. Resolves live intent by READING that
 *              record — never prompts, never falls back to mock — and then REFUSES to
 *              dispatch: scheduled activation is structurally disabled in this build (no
 *              code path in this entrypoint constructs a provider adapter or reaches a
 *              dispatch). What must land before that flips — real public-Git publication
 *              evidence for the campaign manifest and a durable escalation latch checked
 *              before every dispatch — is specified in docs/CAMPAIGN-ACTIVATION.md.
 *   - `status` — READ-ONLY, what monitoring calls. Reports the durable state (the
 *              authorization classified by the same strict validator the tick uses, budget
 *              consumption with reservations labeled as reservations, fires/claims/leases)
 *              and the verdict the next tick would reach. Performs no write; its exit code
 *              mirrors the next tick's resolution so monitoring can alert on it.
 *   - `stop` — revokes the authorization. Fail-safe: the next tick resolves nothing.
 *
 * Three bounds hold an armed campaign, and only the first needs nobody's attention: the
 * store's cohort call/spend caps (enforced in a row lock, so no number of ticks can exceed
 * them), this authorization (expiring on its own and revocable at any moment), and the
 * manifest's observation window.
 *
 * A cohort is armed at most once, EVER: its authorization record is immutable history
 * (revocation stamps it; nothing rewrites or replaces it). Running another campaign means
 * building a NEW manifest — a new window gives a new cohortId — and arming that.
 */

class UsageError extends Error {}

const USAGE = `Usage:
  yarn campaign:arm    --calls <n> --days <n> --start <ISO> [--dispatches <n>] [--emit <path>]
  yarn campaign:tick   --manifest <path> [--publication <path>]
  yarn campaign:status --manifest <path>
  yarn campaign:stop   --manifest <path>

ARM (attended, once per campaign): builds a campaign manifest sized in provider CALLS,
prints the exact terms and their cost, asks the standard [Y/n] confirmation (Enter or
'y' proceeds; 'n', any other answer, or EOF refuses), then makes the durable writes in
AUTHORITY ORDER: the manifest file first (published complete via a same-directory fsync'd
temp and an atomic no-clobber hard link, parent directory sync'd where the platform
supports it, then read back), the cohort budget next, and the durable authorization
LAST — so a failed arm never leaves standing authority, and re-running the same arm
reconciles any intermediate failure. --start is REQUIRED and must be an offset-qualified
ISO-8601 instant: it is part of the campaign identity, which is what keeps the identical
command byte-identical across retries. The manifest is written to --emit (default
./campaign-manifest.json); every later tick and the stop must be given that same file,
because its bytes ARE the campaign's identity. A cohort is armed at most once, ever —
running another campaign means a new manifest (a new window gives a new cohortId).

TICK (unattended, what a scheduler will call): validates the armed authorization END TO
END — the durable record, its liveness at this clock, its exact binding to this
manifest, and a fresh credential observation — and then REFUSES to dispatch: scheduled
activation is structurally disabled in this build (see docs/CAMPAIGN-ACTIVATION.md).
With --publication <path> (a JSON descriptor: repositoryOwner, repositoryName, path,
commitSha — the full 40-hex commit the manifest bytes were published at), the tick also
verifies the public-Git precommitment: byte-identical published blob, same cohortId,
committer strictly before windowStart. ANY publication failure — including a network
failure or the all-zeros rehearsal commit — refuses the tick (exit 2); without the flag
the tick reports the evidence as not configured (activation will require it).
Never prompts, never falls back to mock. Exits 3 when the authorization is valid
(activation refused), 2 when no live authorization covers the cohort, 1 on a loud
failure.

STATUS (read-only, what monitoring calls): reports the campaign's durable state — the
authorization (armed/disarmed/expired and its instants), calls reserved vs cap and
attempts actually started, money as labeled RESERVATIONS (not invoices) plus an
estimated invoice at the observed per-attempt rate, fires/claims/active leases — and
the verdict the NEXT tick would reach, including a fresh credential observation.
Performs no write of any kind: it opens its own connection with NO schema bootstrap and
a server-enforced read-only session (a read-only role suffices to run it), so schema
ownership stays with the mutating commands. Exits 0 when the next tick would hold a live
authorization (which in this build still refuses to dispatch, exit 3), 2 when it would
refuse, 1 on a loud failure. Per-tick observations (when the last tick ran, deferrals
by reason) require the scheduler's durable journal and land with the activation slice.

STOP: revokes the authorization. The next tick fires nothing.

Needs STORE_DATABASE_URL.`;

interface CampaignOptions {
  command: 'arm' | 'tick' | 'stop' | 'status';
  calls: number;
  days: number;
  startIso: string | null;
  dispatches: number;
  manifestPath: string | null;
  emitPath: string;
  publicationPath: string | null;
}

function parseArgs(argv: string[]): CampaignOptions {
  const command = argv[0];
  if (command === '-h' || command === '--help') {
    printLine(USAGE);
    process.exit(0);
  }
  if (command !== 'arm' && command !== 'tick' && command !== 'stop' && command !== 'status') {
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
    publicationPath: null,
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
    else if (arg === '--publication') options.publicationPath = next();
    else if (arg === '-h' || arg === '--help') {
      printLine(USAGE);
      process.exit(0);
    } else throw new UsageError(`unknown argument: ${arg ?? ''}`);
  }
  return options;
}

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/**
 * TOTAL over `unknown`: rendering a thrown value must never itself throw, because every
 * authority-outcome guard in this module reports through it — a hostile rejection value
 * (a revoked Proxy, a throwing `message` getter, a throwing coercion) must degrade to a
 * fixed literal rather than let the reporting failure escape and replace an
 * already-classified outcome.
 */
function messageOf(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') {
      return error.message;
    }
  } catch {
    // A revoked Proxy or hostile message getter is not safe to inspect.
  }

  try {
    return String(error);
  } catch {
    return '<unprintable thrown value>';
  }
}

/**
 * Close the store AFTER the command's outcome is already decided. Cleanup must never
 * falsify a classified authority transition: a confirmed ARMED/STOPPED, a reconciled
 * standing authorization, a validated refusal, a named pre-authority error, or the
 * unknown-commit recovery message all remain authoritative. A close failure is therefore
 * reported as a warning and swallowed — it can neither replace the primary error nor turn
 * a confirmed outcome into a generic failure exit.
 */
async function closeQuietly(close: () => Promise<void>): Promise<void> {
  try {
    await close();
  } catch (error) {
    printError(
      `warning: closing the store connection failed AFTER the outcome was decided — the reported ` +
        `outcome stands: ${messageOf(error)}`,
    );
  }
}

/**
 * Scheduled activation is STRUCTURALLY disabled: no code path in this entrypoint constructs
 * a provider adapter or reaches a dispatch, so a valid authorization proves the arming state
 * machine end to end while spending nothing. A valid authorization therefore exits 3 — never
 * 0 — so any scheduler pointed at this build notices instead of no-op looping.
 */
const ACTIVATION_DISABLED =
  'REFUSING to dispatch: scheduled campaign activation is structurally disabled in this build. ' +
  'Dispatching additionally requires real public-Git publication evidence for the campaign manifest ' +
  'and a durable escalation latch checked before every dispatch (see docs/CAMPAIGN-ACTIVATION.md). ' +
  'No provider call was made.';

// ---------------------------------------------------------------------------
// Injectable seams (so the whole owner-level flow is drivable without a database)
// ---------------------------------------------------------------------------

export interface CampaignDeps {
  /** The MUTATING open: applies the idempotent schema/function bootstrap and constructs the
   *  full store. Owned by the commands that are allowed to write (arm, tick, stop). */
  readonly openStore: (databaseUrl: string) => Promise<{
    store: AtomicStore;
    authorizations: CampaignAuthorizationPort;
    close: () => Promise<void>;
  }>;
  /** The READ-ONLY open for the status surface: constructs only the read ports, applies NO
   *  schema/function bootstrap, and (in production) forces the session read-only at the
   *  server — so `status` structurally cannot write: its seam carries no store, and even a
   *  regression that smuggled a statement through would be refused by PostgreSQL itself. */
  readonly openReads: (databaseUrl: string) => Promise<{
    authorizations: CampaignAuthorizationPort;
    statusReads: CampaignStatusReadPort;
    close: () => Promise<void>;
  }>;
  readonly observeCredentials: (participantIds: readonly string[]) => ReadonlyMap<string, boolean>;
  readonly confirm: (prompt: string) => Promise<string | null>;
  readonly now: () => number;
  /** Resolve a public-Git precommitment descriptor to its blob bytes + committer instant
   *  (production: the GitHub resolver). Injected so every publication failure mode is
   *  drivable without a network; a rejection is always a refusal, never a pass. */
  readonly resolvePublication: (publication: ManifestPublicationV1) => Promise<ResolvedPublication>;
}

// ---------------------------------------------------------------------------
// Manifest installation — durable, no-clobber, verified
// ---------------------------------------------------------------------------

export type ManifestInstallOutcome =
  | { readonly kind: 'installed' }
  | { readonly kind: 'already_installed' }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Install the campaign manifest at `path` BEFORE any authority exists, riding the SAME
 * durable write path as every other durable file this repo installs — the fire-artifact
 * sink's {@link installBytesNoClobber} loop: a same-directory exclusive temp, a checked
 * complete-write loop (zero/invalid progress fails loudly), temp fsync, close with
 * write-beats-close error precedence, an atomic no-clobber hard-link publication (the final
 * name either does not exist or refers to a complete fsynced file — never a partial), a
 * parent-directory fsync (POSIX; Windows exposes no directory fsync and is a documented
 * no-op in `nodeArtifactFs.syncDir`), and best-effort temp cleanup that never masks the
 * primary result. A directory-sync failure is an UNKNOWN-persistence state and reports
 * `failed`; the identical re-run reconciles through the byte-identity path, which re-runs
 * the directory sync. This wrapper then adds a final read-back byte compare — the last
 * verification before the caller may create any authority.
 *
 * Outcomes: fresh publication → `installed`; an existing byte-identical file →
 * `already_installed` (the re-run of an arm that failed after this step); an existing
 * byte-different file → `conflict`, untouched; anything else → `failed`, and the caller
 * must not create authority.
 */
export function installManifestNoClobber(
  path: string,
  bytes: Buffer,
  fsx: ArtifactFs = nodeArtifactFs,
): ManifestInstallOutcome {
  let created: boolean;
  try {
    created = installBytesNoClobber(fsx, {
      dir: dirname(path),
      finalPath: path,
      tmpStem: basename(path),
      buffer: bytes,
      label: 'campaign manifest',
    }).created;
  } catch (error) {
    if (error instanceof ByteDifferentCollisionError) {
      return {
        kind: 'conflict',
        message:
          `refusing to overwrite ${path}: it already holds DIFFERENT bytes (another campaign's ` +
          `manifest?) — pass a different --emit path or move the file aside`,
      };
    }
    return { kind: 'failed', message: messageOf(error) };
  }
  let readBack: Buffer;
  try {
    readBack = fsx.readFile(path);
  } catch (error) {
    return { kind: 'failed', message: `read-back of ${path} failed: ${messageOf(error)}` };
  }
  if (!readBack.equals(bytes)) {
    return { kind: 'failed', message: `read-back verification failed for ${path} — the durable bytes do not match; delete the file and re-run` };
  }
  return created ? { kind: 'installed' } : { kind: 'already_installed' };
}

// ---------------------------------------------------------------------------
// arm
// ---------------------------------------------------------------------------

/**
 * A second arm found a standing record for this exact cohort. A cohort is armed at most
 * once, EVER — the record is immutable history — so this is either the benign re-run of an
 * interrupted arm (the standing record still validates: reconcile, succeed, change nothing)
 * or a dead campaign (disarmed/expired/divergent: refuse, and running again means a NEW
 * manifest — a new window gives a new cohortId — never a rewrite of this one).
 */
async function reconcileExistingAuthorization(
  authorizations: CampaignAuthorizationPort,
  booted: BootedCohort,
  deps: CampaignDeps,
): Promise<number> {
  const stored = await authorizations.read(booted.cohortId);
  const resolution = resolveCampaignIntent({
    booted,
    stored,
    now: deps.now(),
    observeCredentials: deps.observeCredentials,
  });
  if (resolution.kind === 'Authorized') {
    printLine('');
    printLine(
      `cohort ${booted.cohortId} was ALREADY armed; the standing authorization validates ` +
        `against this manifest and stands unchanged.`,
    );
    return 0;
  }
  printError(
    `cohort ${booted.cohortId} was already armed once and its record no longer authorizes ticks: ` +
      resolution.violations.join('; '),
  );
  printError(
    'a cohort is armed at most once, ever. To run another campaign, build a NEW manifest ' +
      '(a new --start gives a new window and a new cohortId) and arm that.',
  );
  return 2;
}

/**
 * ARM a campaign. Everything is built and validated FIRST — the manifest, the boot, the
 * bounds, the credentials, the full authorization record, the database URL — so nothing
 * after the confirmation can refuse for a reason that was knowable before it. Then the
 * durable writes run in AUTHORITY ORDER: manifest file (no-clobber, verified), cohort
 * budget (idempotent for identical pins), and the authorization record LAST as the single
 * authorizing transition. Nothing here dispatches; the first fire would happen on a
 * scheduled tick once activation lands (docs/CAMPAIGN-ACTIVATION.md).
 */
export async function armCampaign(options: CampaignOptions, deps: CampaignDeps): Promise<number> {
  // ---- Build + validate everything. Nothing in this block is durable. ----
  if (options.calls <= 0 || options.days <= 0) {
    printError('arm requires --calls <n> and --days <n>');
    return 2;
  }
  // --start is REQUIRED: it is part of the campaign IDENTITY. Deriving it from a moving
  // clock would make "re-running the same arm reconciles" false — one minute later the
  // identical public command would build a different window, different bytes, and a
  // different cohortId, then refuse on the installed manifest instead of reconciling the
  // standing authorization. Refused here, before the prompt, the filesystem, or the store.
  if (options.startIso === null) {
    printError(
      'arm requires an explicit --start <ISO> (offset-qualified, e.g. 2026-08-05T17:00:00Z): ' +
        'the start is part of the campaign identity, so a retried arm must rebuild the ' +
        'IDENTICAL manifest rather than a new one from a moving clock',
    );
    return 2;
  }
  if (!isParseableInstant(options.startIso)) {
    printError(
      `--start ${JSON.stringify(options.startIso)} must be an offset-qualified ISO-8601 instant ` +
        `(e.g. 2026-08-05T17:00:00Z)`,
    );
    return 2;
  }
  const startMs = instantMs(options.startIso);
  const windowForwardMs = options.days * 24 * 3_600_000;

  let built: ReturnType<typeof buildCampaignManifest>;
  try {
    built = buildCampaignManifest(startMs, {
      callCap: options.calls,
      windowForwardMs,
      maxDispatchesPerTick: options.dispatches,
    });
  } catch (error) {
    printError(`refusing to arm: ${messageOf(error)}`);
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

  const databaseUrl = envValue('STORE_DATABASE_URL');
  if (databaseUrl === undefined) {
    printError('arming needs STORE_DATABASE_URL');
    return 2;
  }

  const armedAtMs = deps.now();
  const expiresAtMs = startMs + windowForwardMs;
  let record: CampaignAuthorization;
  try {
    record = buildCampaignAuthorization({
      booted,
      observedCredentialedParticipantIds: credentialed,
      armedAtMs,
      expiresAtMs,
    });
  } catch (error) {
    printError(`refusing to arm: ${messageOf(error)}`);
    return 2;
  }

  const projection = projectCampaignCost(booted.manifest);
  printLine('ARM CAMPAIGN — real provider spend, unattended, on confirmation:');
  printLine(`  cohortId ${booted.cohortId}`);
  printLine(`  sports ${booted.manifest.sportAllowList.join(', ')}`);
  printLine(`  window ${booted.manifest.windowStart} → ${booted.manifest.windowEnd}`);
  printLine(`  size   at most ${projection.maxCalls} provider calls (${projection.maxFires} fires of 4 arms)`);
  printLine(`  cost   ≈ ${usd(projection.observedUsdMicros)} expected at the observed rate`);
  printLine(`         ≤ ${usd(projection.conservativeUsdMicros)} at the committed conservative worst case`);
  printLine(`  bounds ${booted.manifest.constants.maxDispatchesPerTick} fire(s)/tick; every attempt hard-stopped above $100`);
  printLine(`  expiry ${record.expiresAt} (the authorization stops on its own)`);
  printLine("  Enter or 'y' proceeds; 'n', any other answer, or EOF refuses");

  // The standard [Y/n] confirmation. EOF is refused BEFORE normalization — a stream that
  // closes without producing a line is not Enter, while an actual empty line (interactive
  // or deliberately piped) is Enter and accepts the default.
  const answer = await deps.confirm('arm this campaign for unattended running? [Y/n] ');
  if (answer === null) {
    printError('arming refused: the confirmation stream closed (EOF) before an answer');
    return 2;
  }
  const normalized = answer.trim().toLowerCase();
  if (normalized !== '' && normalized !== 'y' && normalized !== 'yes') {
    printError(`arming refused (answer ${JSON.stringify(answer)}); Enter or 'y' proceeds`);
    return 2;
  }

  // ---- Durable writes, in AUTHORITY ORDER. (1) The manifest file: no-clobber + fsync +
  // read-back, BEFORE any store write, so standing authority always implies its manifest
  // is on disk (`stop` needs that file). (2) The cohort budget: durable but NOT
  // authorizing — a budget with no authorization arms nothing, and re-initializing with
  // identical pins reconciles. (3) The authorization record LAST: the single authorizing
  // transition. ----
  const manifestBytes = Buffer.from(built.bytes, 'utf8');
  const install = installManifestNoClobber(options.emitPath, manifestBytes);
  if (install.kind === 'conflict') {
    printError(install.message);
    return 2;
  }
  if (install.kind === 'failed') {
    printError(`arming FAILED before any authority was created: ${install.message}`);
    return 1;
  }
  if (install.kind === 'already_installed') {
    printLine(`manifest already installed at ${options.emitPath} (byte-identical) — continuing`);
  }

  let opened: Awaited<ReturnType<CampaignDeps['openStore']>> | null = null;
  let authorizing = false;
  try {
    opened = await deps.openStore(databaseUrl);
    const initResult = await opened.store.initCohortBudget(buildCohortBudgetInitRequest(booted));
    assertCohortBudgetInitialized(initResult);
    authorizing = true;
    const outcome = await opened.authorizations.arm(record);
    if (outcome === 'already_armed') {
      return await reconcileExistingAuthorization(opened.authorizations, booted, deps);
    }
    printLine('');
    printLine('ARMED. cohort budget initialized and authorization recorded.');
    printLine(`manifest at ${options.emitPath} — every tick and the stop need this exact file.`);
    return 0;
  } catch (error) {
    if (!authorizing) {
      printError(`arming FAILED before the authorizing step — NO standing authority was created: ${messageOf(error)}`);
      printError(`the manifest at ${options.emitPath} grants nothing by itself; re-running the same arm reconciles.`);
      return 1;
    }
    printError(`the authorizing write FAILED with its commit status UNKNOWN: ${messageOf(error)}`);
    printError(
      `re-run the same arm to reconcile (a standing record is verified, never overwritten), or run ` +
        `campaign:stop --manifest ${options.emitPath} to revoke whatever may have been recorded.`,
    );
    return 1;
  } finally {
    if (opened !== null) await closeQuietly(opened.close);
  }
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

/**
 * One UNATTENDED tick. Resolves live intent from the durable record — no prompt, no mock
 * fallback — and then refuses to dispatch, because scheduled activation is structurally
 * disabled in this build: this function validates the whole authorization chain and owns
 * no path to a provider adapter, a claim, or a dispatch.
 */
export async function tickCampaign(options: CampaignOptions, deps: CampaignDeps): Promise<number> {
  if (options.manifestPath === null) {
    printError('tick requires --manifest <path> (the exact manifest the campaign was armed with)');
    return 2;
  }
  const rawManifestBytes = readFileSync(options.manifestPath);
  const booted = cohortBoot({ manifestBytes: decodeManifestText(rawManifestBytes) });

  // Public-Git precommitment evidence. When a descriptor is supplied, it must verify —
  // real repository, full commit, byte-identical blob, committer strictly before
  // windowStart — and ANY failure (including a network failure) is a refusal, never a
  // pass-through. The all-zeros rehearsal sentinel is rejected STRUCTURALLY, before any
  // network request: it is the self-resolver's marker and can never be evidence. When no
  // descriptor is supplied, the tick says so — activation will make it mandatory.
  if (options.publicationPath !== null) {
    let descriptor: ManifestPublicationV1;
    try {
      descriptor = parseManifestPublication(JSON.parse(readFileSync(options.publicationPath, 'utf8')));
    } catch (error) {
      printError(`publication descriptor at ${options.publicationPath} is unusable: ${messageOf(error)}`);
      return 2;
    }
    if (descriptor.commitSha === '0'.repeat(40)) {
      printError(
        'publication descriptor carries the all-zeros rehearsal commit — the self-resolved ' +
          'rehearsal marker is not publication evidence; refusing before any resolution',
      );
      return 2;
    }
    try {
      const verified = await verifyPublication({
        localManifestBytes: rawManifestBytes,
        publication: descriptor,
        resolver: { resolve: deps.resolvePublication },
      });
      printLine(
        `publication evidence VERIFIED — ${descriptor.repositoryOwner}/${descriptor.repositoryName}:` +
          `${descriptor.path} @ ${descriptor.commitSha} (committed ${verified.committerTimestamp})`,
      );
    } catch (error) {
      const detail = error instanceof PublicationError ? error.violations.join('; ') : messageOf(error);
      printError(`publication evidence REFUSED — the precommitment did not verify: ${detail}`);
      return 2;
    }
  } else {
    printLine('publication evidence NOT CONFIGURED (--publication) — required before activation');
  }

  const databaseUrl = envValue('STORE_DATABASE_URL');
  if (databaseUrl === undefined) {
    printError('a tick needs STORE_DATABASE_URL');
    return 2;
  }
  const { authorizations, close } = await deps.openStore(databaseUrl);
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
    printLine(
      `campaign authorization VALID for cohort ${booted.cohortId} ` +
        `(${resolution.authorization.observedCredentialedParticipantIds.length}/${resolution.authorization.participantIds.length} ` +
        `roster credentials observed now)`,
    );
    printError(ACTIVATION_DISABLED);
    return 3;
  } finally {
    await closeQuietly(close);
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * The READ-ONLY monitoring surface: report the campaign's durable state — authorization
 * (classified by the same strict validator the tick uses), budget consumption (calls are
 * the real money lever; reservations are labeled as reservations, never as invoices),
 * fires/claims/leases — and the verdict the NEXT tick would reach, computed by the exact
 * `resolveCampaignIntent` the tick runs (including a fresh credential observation, so a
 * key rotated mid-campaign shows up here first). Performs no write of any kind.
 *
 * The exit code mirrors the next tick's resolution so monitoring can alert on it: 0 =
 * a live authorization would resolve (and, in this build, then refuse to dispatch —
 * activation is structurally disabled), 2 = the next tick would refuse, 1 = a loud
 * failure, including the integrity anomaly of standing authority without a budget row.
 */
export async function statusCampaign(options: CampaignOptions, deps: CampaignDeps): Promise<number> {
  if (options.manifestPath === null) {
    printError('status requires --manifest <path> (the exact manifest the campaign was armed with)');
    return 2;
  }
  const booted = cohortBoot({ manifestBytes: decodeManifestText(readFileSync(options.manifestPath)) });
  const databaseUrl = envValue('STORE_DATABASE_URL');
  if (databaseUrl === undefined) {
    printError('status needs STORE_DATABASE_URL');
    return 2;
  }
  // The READ-ONLY open: no schema bootstrap, no store, and (in production) a server-enforced
  // read-only session. A status read against a database whose schema was never applied fails
  // loudly — bootstrap belongs to the mutating commands, never to monitoring.
  const { authorizations, statusReads, close } = await deps.openReads(databaseUrl);
  try {
    const manifest = booted.manifest;
    const projection = projectCampaignCost(manifest);
    printLine(`CAMPAIGN STATUS — cohort ${booted.cohortId}`);
    printLine(`  sports ${manifest.sportAllowList.join(', ')}`);
    printLine(`  window ${manifest.windowStart} → ${manifest.windowEnd}`);
    printLine(`  size   at most ${projection.maxCalls} provider calls (${projection.maxFires} fires of 4 arms)`);

    // The durable authorization, classified by the SAME strict validator the tick uses.
    const stored = await authorizations.read(booted.cohortId);
    const classification = classifyCampaignAuthorization(stored, deps.now());
    switch (classification.kind) {
      case 'absent':
        printLine('  authorization NOT ARMED — no record exists for this cohort');
        break;
      case 'malformed':
        printLine(`  authorization MALFORMED — ${classification.violations.join('; ')}`);
        break;
      case 'live':
        printLine(`  authorization LIVE — armed ${classification.record.armedAt}, expires ${classification.record.expiresAt}`);
        break;
      case 'disarmed':
        printLine(
          `  authorization DISARMED at ${String(classification.record.disarmedAt)} ` +
            `(armed ${classification.record.armedAt})`,
        );
        break;
      case 'expired':
        printLine(`  authorization EXPIRED at ${classification.record.expiresAt} (armed ${classification.record.armedAt})`);
        break;
      default: {
        const _exhaustive: never = classification;
        return _exhaustive;
      }
    }

    // Durable budget + fire consumption. Calls are the real money lever; reservations are
    // consumed in full per fire by design and are NOT invoices — label them so.
    const budget = await statusReads.budget(booted.cohortId);
    if (budget === null) {
      if (classification.kind !== 'absent') {
        // Authority implies its budget was initialized first (the arming order). A record
        // without a budget row means the store lost state — a loud anomaly, not a report.
        printError(
          `INTEGRITY ANOMALY: an authorization record exists for cohort ${booted.cohortId} but no cohort ` +
            `budget row does — arming initializes the budget BEFORE the authorization, so the store has ` +
            `lost state. Investigate before arming anything further.`,
        );
        return 1;
      }
      printLine('  budget none — no cohort budget initialized (this cohort was never armed)');
    } else {
      const fires = await statusReads.fires(booted.cohortId);
      printLine(`  calls  ${budget.callsReserved} reserved of ${budget.callCap} cap; ${fires.callsMade} attempt(s) actually started`);
      printLine(
        `  money  reservations ${usd(budget.spendReservedUsdMicros)} of ${usd(budget.spendCapUsdMicros)} cap ` +
          `(reservations are consumed in full per fire — NOT invoices); ` +
          `≈ ${usd(fires.callsMade * OBSERVED_USD_MICROS_PER_ATTEMPT)} expected invoice for the started attempts ` +
          `at the observed rate (an estimate)`,
      );
      printLine(
        `  fires  ${fires.firesAdmitted} admitted (${fires.firesCompleted} completed, ${fires.firesPending} pending); ` +
          `claims ${fires.claimsCompleted} completed, ${fires.claimsPending} pending; ` +
          `${fires.activeLeases} active lease(s)`,
      );
      printLine(`  last   fire admitted ${fires.lastAdmittedAt ?? 'never'}`);
    }

    // The verdict the NEXT tick would reach — the exact resolution the tick runs,
    // including a fresh independent credential observation.
    const resolution = resolveCampaignIntent({
      booted,
      stored,
      now: deps.now(),
      observeCredentials: deps.observeCredentials,
    });
    if (resolution.kind === 'Refused') {
      printLine(`  next tick would REFUSE: ${resolution.violations.join('; ')}`);
      return 2;
    }
    printLine(
      '  next tick would AUTHORIZE — and then refuse to dispatch: activation is structurally ' +
        'disabled in this build (exit 3; see docs/CAMPAIGN-ACTIVATION.md)',
    );
    return 0;
  } finally {
    await closeQuietly(close);
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
    await closeQuietly(close);
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
  openReads: async (databaseUrl) => {
    const { Pool } = await import('pg');
    const { pgStoreQuery } = await import('./store/atomicStore.js');
    const { SqlCampaignAuthorizationPort } = await import('./store/campaignAuthStore.js');
    const { SqlCampaignStatusReadPort } = await import('./store/campaignStatusRead.js');
    // NO schema/function bootstrap here — a monitoring read must not mutate catalog state —
    // and the session itself is forced read-only at the SERVER, so even a statement smuggled
    // through this path in the future is refused by PostgreSQL rather than trusted to prose.
    const pool = new Pool({ connectionString: databaseUrl, options: '-c default_transaction_read_only=on' });
    const query = pgStoreQuery(pool);
    return {
      authorizations: new SqlCampaignAuthorizationPort(query),
      statusReads: new SqlCampaignStatusReadPort(query),
      close: () => pool.end(),
    };
  },
  observeCredentials: observeRealAdapterCredentials,
  confirm: askLiveConfirmation,
  now: () => Date.now(),
  resolvePublication: async (publication) => {
    const { GitHubPublicationResolver } = await import('./gitHubPublicationResolver.js');
    return new GitHubPublicationResolver().resolve(publication);
  },
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
    case 'status':
      return statusCampaign(options, PRODUCTION_DEPS);
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
