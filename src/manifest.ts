import { z } from 'zod';
import { canonicalize, sha256Hex } from './canonical.js';
import { configurationViolations } from './participantConfiguration.js';
import type { JsonValue } from './participantConfiguration.js';

/**
 * `CohortManifestV1` — the precommitted parameters that can change the
 * statistical sample or model behavior (SPEC-line-open-evidence-model.md §2).
 *
 * The object is parsed STRICTLY: any unknown field fails, so no credential or
 * secret can ride along (there is no field for one, and extras are rejected).
 * `cohortId` is DERIVED from the canonical bytes of the strictly-parsed object
 * and is NOT a field inside the object it hashes.
 *
 * This module intentionally owns only the data model, strict structural parse, and
 * `cohortId`. Known-version/digest checks, full-roster/spend boot gates, config locking,
 * and public-Git publication verification are owned by their dedicated boot/publication
 * modules, so this parser retains no cross-module or network dependency.
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

/**
 * A participant's configuration is arbitrary JSON BY DESIGN — it is each lab's
 * own vocabulary and a new dimension is a new key — which makes it the one
 * field in a strictly-parsed manifest that accepts names this schema has never
 * seen. Two things keep that from reopening the hole `.strict()` closes.
 *
 * The value space is restricted to JSON scalars, arrays and plain objects, so
 * nothing `canonicalize` would refuse — a non-finite number, an `undefined`, a
 * class instance — can reach `cohortId` and throw at boot instead of being
 * rejected at parse.
 *
 * And `configurationViolations` runs on every entry below, bounding the size
 * and refusing `__proto__`; `manifestValidate` adds the checks that need the
 * wider program (that the code's roster declares the same configuration, and
 * that none of it is a credential). That last one matters more here than
 * anywhere else in this file: the manifest is hashed into the cohort identity
 * AND published verbatim to a public Git repository, so a secret riding along
 * in this field would be published, not merely stored.
 */
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const participantConfigurationSchema = z.record(jsonValueSchema);

const expectedArmSchema = z
  .object({
    participantId: z.string().min(1),
    // Structural only — that `provider` names a real adapter is checked in a
    // later slice (roster validation), not here.
    provider: z.string().min(1),
    requestedModelId: z.string().min(1),
    approvedReportedModelIds: z.array(z.string().min(1)).min(1),
    /**
     * REQUIRED, with `{}` the real "this arm sets no knobs" value.
     *
     * Two reasons, and the first is narrower than it first appears. A bare
     * `.optional()` does split cohort identity — measured: an omitted field
     * canonicalizes to `{"a":1}` where an explicit `{}` gives `{"a":1,"c":{}}`,
     * so one cohort would mint two ids. But `.optional().default({})` does NOT,
     * because `cohortId` hashes the PARSED output and the default lands in it.
     *
     * The reason that covers both forms is the second one: this document exists
     * to precommit, and an omission is not a precommitment. A manifest that
     * simply forgot the field would be read as declaring "this arm sets no
     * knobs" — a claim nobody made, published, and hashed into the cohort
     * identity. Silence is refused instead.
     */
    configuration: participantConfigurationSchema,
  })
  .strict()
  .superRefine((arm, ctx) => {
    // Checked HERE rather than at boot because `cohortId` re-parses
    // defensively before hashing: a configuration this refuses can never be
    // part of a cohort identity.
    for (const violation of configurationViolations(arm.configuration, {
      // The serving table keys an entrant on (lab_id, model_id, configuration)
      // and bounds the three together; `provider` is the lab.
      labId: arm.provider,
      modelId: arm.requestedModelId,
    })) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['configuration'], message: violation });
    }
  });

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
    // The fixed per-provider-HTTP-attempt spend reservation, in integer USD-micros. It is
    // directly visible in the hashed manifest (no separate digest); canonical boot
    // cross-checks it against the code-owned spendReservationPolicyVersion amount.
    providerAttemptReservationUsdMicros: positiveSafeInteger,
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
    spendReservationPolicyVersion: z.string().min(1),
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
/**
 * The path of an own `__proto__` key anywhere in the RAW input, or null.
 *
 * Run before zod, because zod's object and record parsers DROP such a key
 * rather than reject it. Nothing is polluted by that — but this manifest is a
 * public precommitment whose raw bytes are compared at publication, and
 * `cohortId` hashes the PARSED value. Silently dropping a key therefore lets
 * two different published byte sequences boot as the same cohort, and lets the
 * run stamp a configuration that is not the one published. It also skips the
 * post-parse configuration checks entirely, since by then the key is gone.
 *
 * The raw object is walked with `getOwnPropertyNames` and the key is returned
 * WITHOUT reading its value, because reading `__proto__` is the very thing
 * that behaves differently from an ordinary member.
 */
function rawProtoKeyPath(value: unknown, path: string): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = rawProtoKeyPath(value[index], `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  for (const key of Object.getOwnPropertyNames(value)) {
    const here = path === '' ? key : `${path}.${key}`;
    if (key === '__proto__') return here;
    const found = rawProtoKeyPath((value as Record<string, unknown>)[key], here);
    if (found !== null) return found;
  }
  return null;
}

export function parseManifest(raw: unknown): CohortManifestV1 {
  const protoAt = rawProtoKeyPath(raw, '(root)');
  if (protoAt !== null) {
    throw new Error(
      `invalid cohort manifest: ${protoAt} uses the reserved key "__proto__", which the parser would ` +
        'silently drop — the published bytes and the hashed cohort identity would then disagree',
    );
  }
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
