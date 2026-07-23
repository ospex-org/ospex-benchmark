import { canonicalize } from './canonical.js';
import { parseManifest } from './manifest.js';
import type { CohortManifestV1 } from './manifest.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { MODEL_PRICE_TABLE_DIGEST, MODEL_PRICE_TABLE_VERSION } from './modelPriceTable.js';
import { SOURCE_QUERY_VERSION } from './oddsHistory.js';
import { promptScaffoldSha256 } from './prompt.js';
import { CODE_MAX_REPAIRS_PER_ARM, REPAIR_POLICY_VERSION } from './repairPolicy.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import {
  PROVIDER_ATTEMPT_RESERVATION_USD_MICROS,
  SPEND_RESERVATION_POLICY_VERSION,
} from './spendReservationPolicy.js';

/**
 * A code-consistent rehearsal `CohortManifestV1`, generated in-process rather than
 * committed as a static JSON file. Every code-owned field — the market-policy /
 * model-price digests, the prompt-scaffold hash, the scoring / repair / spend
 * versions, and the expected arm roster — is IMPORTED from the running code, so
 * the manifest can never drift out of sync with what `cohortBoot`
 * (`validateManifestAgainstCode`) will accept: if a digest, version, or roster
 * changes in code, this manifest changes with it. A committed static manifest
 * would silently rot the next time any of those changed.
 *
 * The observation window is NOW-RELATIVE: `windowStart = now − gameDiscoveryWindowHours`
 * and `windowEnd = now + a few hours`, so a rehearsal run's wall clock is always
 * inside the window and today's live games can be in-window. This is a REHEARSAL
 * manifest only — the runner boots it with `--live` hard-disabled and the report-only
 * claim port, so it never authorizes a paid dispatch.
 */

const HOUR_MS = 3_600_000;

export interface RehearsalManifestOptions {
  /** Discovery/observation lookback window in hours (schema max 720). Default 168 (7 days). */
  readonly gameDiscoveryWindowHours?: number;
  /** How far past `now` the observation window extends. Default 6 hours. */
  readonly windowForwardMs?: number;
  /**
   * Per-provider-HTTP-attempt timeout (ms). Default 300000 (the production rehearsal value).
   * A store-backed FIXTURE fire that dispatches the mock roster needs a SMALL value so the
   * always-timing-out mock arm settles in seconds rather than ~5 minutes; overriding it here
   * changes only this generated manifest's pinned constant, never any production default.
   */
  readonly providerCallTimeoutMs?: number;
}

export interface RehearsalManifest {
  /** The strictly-parsed manifest. */
  readonly manifest: CohortManifestV1;
  /** The canonical JSON bytes (UTF-8 text) — the SAME bytes fed to `cohortBoot`
   *  (string-decoded) and to publication verification (as `Uint8Array`). */
  readonly bytes: string;
}

/**
 * Build a code-consistent rehearsal manifest anchored at `now` (epoch ms). Returns
 * the strictly-parsed manifest and its canonical serialization; the bytes are the
 * single source both `cohortBoot` and the self-resolved publication check consume.
 */
export function buildRehearsalManifest(now: number, opts: RehearsalManifestOptions = {}): RehearsalManifest {
  const gameDiscoveryWindowHours = opts.gameDiscoveryWindowHours ?? 168;
  const windowForwardMs = opts.windowForwardMs ?? 6 * HOUR_MS;
  const providerCallTimeoutMs = opts.providerCallTimeoutMs ?? 300_000;
  const arms = defaultExpectedArms();

  const windowStart = new Date(now - gameDiscoveryWindowHours * HOUR_MS).toISOString();
  const windowEnd = new Date(now + windowForwardMs).toISOString();

  const raw: Record<string, unknown> = {
    artifactSchemaVersion: 1,
    network: 'polygon',
    sportAllowList: ['mlb'],
    windowStart,
    windowEnd,
    source: 'jsonodds',
    sourceQueryVersion: SOURCE_QUERY_VERSION,
    marketPolicyVersion: MARKET_POLICY_VERSION,
    marketPolicyDigest: MARKET_POLICY_DIGEST,
    promptScaffoldSha256: promptScaffoldSha256(),
    expectedArmRoster: arms.map((a) => ({
      participantId: a.participantId,
      provider: a.provider,
      requestedModelId: a.requestedModelId,
      approvedReportedModelIds: [...a.approvedReportedModelIds],
    })),
    // Not yet code-validated (no module owns them at boot); any well-formed value.
    toolInferenceConfigSha256: 'b'.repeat(64),
    // A line-open cohort fires markets independently, so it MUST declare a
    // scoped-capable baseline policy — the full-board default (v0.2) is refused
    // by the dynamic-cohort gate in `validateManifestAgainstCode`.
    baselinePolicyVersion: 'baselines-v0.3.0',
    repairPolicyVersion: REPAIR_POLICY_VERSION,
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: MODEL_PRICE_TABLE_VERSION,
    modelPriceTableDigest: MODEL_PRICE_TABLE_DIGEST,
    spendReservationPolicyVersion: SPEND_RESERVATION_POLICY_VERSION,
    runnerCommitSha: '0'.repeat(40),
    constants: {
      pollIntervalMs: 30_000,
      cleanEntryWindowMs: 120_000, // strictly > pollIntervalMs (schema refine)
      gameDiscoveryWindowHours,
      maxClockSkewMs: 5_000,
      freshFireMs: 30_000,
      maxDispatchLagMs: 10_000,
      historyReadTimeoutMs: 30_000,
      providerCallTimeoutMs,
      maxOutputTokens: 16_000,
      maxRepairAttemptsPerArm: CODE_MAX_REPAIRS_PER_ARM,
      providerAttemptReservationUsdMicros: PROVIDER_ATTEMPT_RESERVATION_USD_MICROS,
      ingestionGraceMs: 900_000,
      scheduleChangeToleranceMs: 60_000,
      // The scheduler must be able to launch the whole roster concurrently.
      maxConcurrentProviderRequests: Math.max(8, arms.length),
      maxDispatchesPerTick: 8,
    },
    cohortCallCap: 1_000,
    cohortSpendCapUsdMicros: 1_000_000_000,
  };

  const bytes = canonicalize(raw);
  const manifest = parseManifest(raw);
  return { manifest, bytes };
}
