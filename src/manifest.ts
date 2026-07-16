import { z } from 'zod';
import { canonicalize, sha256Hex } from './canonical.js';

/**
 * `CohortManifestV1` — the precommitted parameters that can change the
 * statistical sample or model behavior (SPEC-line-open-evidence-model.md §2).
 *
 * The object is parsed STRICTLY: any unknown field fails, so no credential or
 * secret can ride along (there is no field for one, and extras are rejected).
 * `cohortId` is DERIVED from the canonical bytes of the strictly-parsed object
 * and is NOT a field inside the object it hashes.
 *
 * This first slice is the data model + strict structural parse + `cohortId`
 * only. The known-version / recomputed-digest checks, the full-roster / spend
 * boot gates, the canonical config-lock, and the public-Git publication
 * verification are deliberately DEFERRED to later slices — so this module
 * carries no cross-module or network dependency.
 */

// Lowercase canonical hex (matches sha256Hex output) so digests hashed into
// cohortId stay canonical; an uppercase-hex digest is non-canonical and rejected.
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

// Manifest integers must be JavaScript-SAFE: Zod v3 `.int()` alone accepts
// magnitudes beyond Number.MAX_SAFE_INTEGER, where two distinct JSON literals
// round to the same double — which would make cohortId ambiguous and the
// call/spend/timing arithmetic inexact. `.safe()` bounds every count to the
// exactly-representable range.
const positiveSafeInteger = z.number().int().safe().positive();
const nonnegativeSafeInteger = z.number().int().safe().nonnegative();

const expectedArmSchema = z
  .object({
    participantId: z.string().min(1),
    // Structural only — that `provider` names a real adapter is checked in a
    // later slice (roster validation), not here.
    provider: z.string().min(1),
    requestedModelId: z.string().min(1),
    approvedReportedModelIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

const constantsSchema = z
  .object({
    pollIntervalMs: positiveSafeInteger,
    cleanEntryWindowMs: positiveSafeInteger,
    gameDiscoveryWindowHours: positiveSafeInteger.max(720), // core-api /v1/games range (1..720)
    maxClockSkewMs: nonnegativeSafeInteger,
    freshFireMs: positiveSafeInteger,
    maxDispatchLagMs: positiveSafeInteger,
    historyReadTimeoutMs: positiveSafeInteger,
    providerCallTimeoutMs: positiveSafeInteger,
    maxOutputTokens: positiveSafeInteger,
    maxRepairAttemptsPerArm: nonnegativeSafeInteger,
    ingestionGraceMs: nonnegativeSafeInteger,
    scheduleChangeToleranceMs: nonnegativeSafeInteger,
    maxConcurrentProviderRequests: positiveSafeInteger,
    maxDispatchesPerTick: positiveSafeInteger,
  })
  .strict()
  // Poll cadence must be strictly under the clean-entry window (spec §2/§3).
  .refine((c) => c.pollIntervalMs < c.cleanEntryWindowMs, {
    message: 'pollIntervalMs must be < cleanEntryWindowMs',
  });

export const cohortManifestV1Schema = z
  .object({
    artifactSchemaVersion: z.literal(1),

    // Source / statistical scope
    network: z.string().min(1),
    sportAllowList: z.array(z.string().min(1)).min(1),
    windowStart: z.string().datetime({ offset: true }),
    windowEnd: z.string().datetime({ offset: true }),
    source: z.literal('jsonodds'),
    sourceQueryVersion: z.string().min(1),
    marketPolicyVersion: z.string().min(1),
    marketPolicyDigest: sha256HexSchema,

    // Model-facing configuration
    promptScaffoldSha256: sha256HexSchema,
    expectedArmRoster: z.array(expectedArmSchema).min(1),
    toolInferenceConfigSha256: sha256HexSchema,
    baselinePolicyVersion: z.string().min(1),
    repairPolicyVersion: z.string().min(1),
    scoringPolicyVersion: z.string().min(1),
    uncertaintyPolicyVersion: z.string().min(1),
    modelPriceTableVersion: z.string().min(1),
    modelPriceTableDigest: sha256HexSchema,
    runnerCommitSha: z.string().regex(/^[0-9a-f]{40}$/),

    constants: constantsSchema,

    cohortCallCap: nonnegativeSafeInteger,
    cohortSpendCapUsdMicros: nonnegativeSafeInteger,
  })
  .strict()
  // The observation window must be a real forward interval.
  .refine((m) => Date.parse(m.windowStart) < Date.parse(m.windowEnd), {
    message: 'windowStart must be strictly before windowEnd',
  });

export type CohortManifestV1 = z.infer<typeof cohortManifestV1Schema>;

/**
 * Strictly parse a raw manifest, throwing a descriptive error on any structural
 * violation (unknown field, wrong type, out-of-range, or a broken window/poll
 * invariant). A boot-time failure here is intended — an invalid manifest must
 * never run.
 */
export function parseManifest(raw: unknown): CohortManifestV1 {
  const result = cohortManifestV1Schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 20)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid cohort manifest: ${issues}`);
  }
  return result.data;
}

/**
 * The cohort identity — the SHA-256 of the canonical serialization of the
 * strictly-parsed manifest. Source key order is irrelevant (`canonicalize`
 * sorts keys), and `cohortId` is not a field inside the object it hashes
 * (spec §2).
 */
export function cohortId(manifest: CohortManifestV1): string {
  // Re-parse defensively so cohortId always hashes the strictly-parsed shape,
  // even if a caller reached here through an `as` cast that smuggled in extra
  // fields — identity must never depend on the caller having parsed cleanly.
  return sha256Hex(canonicalize(parseManifest(manifest)));
}
