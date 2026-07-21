import type { CohortManifestV1 } from './manifest.js';
import { isMarketPolicyVersion, marketPolicyDigest } from './marketPolicy.js';
import { isModelPriceTableVersion, modelPriceTableDigest } from './modelPriceTable.js';
import { CODE_MAX_REPAIRS_PER_ARM, isRepairPolicyVersion } from './repairPolicy.js';
import { isBaselinePolicyVersion, supportsScopedInput } from './baselines.js';
import { promptScaffoldSha256 } from './prompt.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';

/**
 * Semantic validation of a strictly-parsed `CohortManifestV1` against the
 * running code — the known-version / recomputed-digest rule (spec §2) plus the
 * roster and full-roster-capacity checks. Pure and I/O-free: it returns a
 * violations array (empty = valid), mirroring `verifyRunIntegrity`, so the
 * caller decides how to refuse a mismatched manifest. The boot wiring that
 * calls this (and the canonical config-lock and `--live` hard-disable) is a
 * separate slice.
 *
 * Every check here recomputes/looks up against real code, so a manifest that
 * pins a version or digest the runner cannot actually honor fails closed rather
 * than running a cohort whose declared policy differs from what executes.
 *
 * Deliberately NOT checked (no code module exists yet — validated when their
 * module lands): `sourceQueryVersion` (its finalizer/history predicate is a
 * later PR), `toolInferenceConfigSha256`, and `uncertaintyPolicyVersion`.
 * Credential presence is a live/boot concern
 * (network), not this pure check.
 */
export function validateManifestAgainstCode(manifest: CohortManifestV1): string[] {
  const violations: string[] = [];

  // Market policy: known version, then recomputed digest must match.
  if (!isMarketPolicyVersion(manifest.marketPolicyVersion)) {
    violations.push(`unknown marketPolicyVersion "${manifest.marketPolicyVersion}"`);
  } else {
    const recomputed = marketPolicyDigest(manifest.marketPolicyVersion);
    if (recomputed !== manifest.marketPolicyDigest) {
      violations.push(
        `marketPolicyDigest mismatch: manifest "${manifest.marketPolicyDigest}" != recomputed "${recomputed}"`,
      );
    }
  }

  // Model price table: known version, then recomputed digest must match. An
  // unknown version does not also produce a digest mismatch — the else branch
  // never calls the digest accessor.
  if (!isModelPriceTableVersion(manifest.modelPriceTableVersion)) {
    violations.push(`unknown modelPriceTableVersion "${manifest.modelPriceTableVersion}"`);
  } else {
    const recomputed = modelPriceTableDigest(manifest.modelPriceTableVersion);
    if (recomputed !== manifest.modelPriceTableDigest) {
      violations.push(
        `modelPriceTableDigest mismatch: manifest "${manifest.modelPriceTableDigest}" != recomputed "${recomputed}"`,
      );
    }
  }

  // Repair policy: known version, AND the manifest's max-repairs cap must equal the
  // runner's audited one-repair capability. The store's call reservation and the
  // spend estimator both derive from `maxRepairAttemptsPerArm`, so a divergent cap
  // would mis-reserve. The two checks are independent — an unknown version does not
  // suppress the cap check, and vice versa.
  if (!isRepairPolicyVersion(manifest.repairPolicyVersion)) {
    violations.push(`unknown repairPolicyVersion "${manifest.repairPolicyVersion}"`);
  }
  if (manifest.constants.maxRepairAttemptsPerArm !== CODE_MAX_REPAIRS_PER_ARM) {
    violations.push(
      `maxRepairAttemptsPerArm (${manifest.constants.maxRepairAttemptsPerArm}) ` +
        `does not match code repair capability (${CODE_MAX_REPAIRS_PER_ARM})`,
    );
  }

  // Baseline policy: known version (baselines carry no digest concept), then the
  // dynamic-cohort capability gate. A CohortManifestV1 governs the per-market,
  // no-wait line-open runner: each (gameId, market) is an independent firing unit
  // and a ready market never waits for a sibling (evidence spec §0, §3), so a
  // dispatch carries only the markets ready and claimed at that instant — one, two,
  // or three — regardless of how many the market policy enables. Every such cohort
  // therefore produces SCOPED fires, on which a full-board baseline policy fails
  // closed, so a dynamic cohort MUST declare a scoped-capable baseline policy
  // (baselines-v0.3.0) — SPEC-prepared-request.md §3, §5-S3; the scorer mirrors this
  // (a scoped artifact stamped v0.2 is refused). The gate reads baseline CAPABILITY
  // (`supportsScopedInput`, a positive fail-closed classification), NEVER the market
  // policy's enabled set — the policy's maximum board does not bound dispatch
  // cardinality, so it can neither require nor relax this.
  if (!isBaselinePolicyVersion(manifest.baselinePolicyVersion)) {
    violations.push(`unknown baselinePolicyVersion "${manifest.baselinePolicyVersion}"`);
  } else if (!supportsScopedInput(manifest.baselinePolicyVersion)) {
    violations.push(
      `baselinePolicyVersion "${manifest.baselinePolicyVersion}" is not scoped-capable, but a ` +
        `line-open cohort fires markets independently (a dispatch may carry a single market); ` +
        `a dynamic cohort requires a scoped-capable baseline policy (baselines-v0.3.0)`,
    );
  }

  // Prompt scaffold: the manifest digest must equal the code's scaffold hash.
  const scaffold = promptScaffoldSha256();
  if (manifest.promptScaffoldSha256 !== scaffold) {
    violations.push(
      `promptScaffoldSha256 mismatch: manifest "${manifest.promptScaffoldSha256}" != recomputed "${scaffold}"`,
    );
  }

  // Scoring policy: equality only — no historical-version guard exists yet.
  if (manifest.scoringPolicyVersion !== SCORING_POLICY_VERSION) {
    violations.push(
      `scoringPolicyVersion "${manifest.scoringPolicyVersion}" != code "${SCORING_POLICY_VERSION}"`,
    );
  }

  // Roster: the manifest roster must EQUAL the code's expected arm set — every
  // code arm present, each with a matching provider, requested model, and
  // approved-reported-model set, with no unknown participant and no duplicate id.
  // A subset/superset is rejected: the runner and scorer currently drive off the
  // full code roster, so a divergent manifest roster would validate here yet fail
  // at scoring. When the roster threads through dispatch + scoring, this can relax
  // to allow a precommitted subset.
  const codeArms = new Map(defaultExpectedArms().map((a) => [a.participantId, a]));
  const seen = new Set<string>();
  for (const arm of manifest.expectedArmRoster) {
    if (seen.has(arm.participantId)) {
      violations.push(`duplicate roster participantId "${arm.participantId}"`);
      continue;
    }
    seen.add(arm.participantId);
    const code = codeArms.get(arm.participantId);
    if (!code) {
      violations.push(`roster arm "${arm.participantId}" is not a code-supported participant`);
      continue;
    }
    if (arm.provider !== code.provider) {
      violations.push(
        `roster arm "${arm.participantId}" provider "${arm.provider}" != code "${code.provider}"`,
      );
    }
    if (arm.requestedModelId !== code.requestedModelId) {
      violations.push(
        `roster arm "${arm.participantId}" requestedModelId "${arm.requestedModelId}" != code "${code.requestedModelId}"`,
      );
    }
    if (!sameStringSet(arm.approvedReportedModelIds, code.approvedReportedModelIds)) {
      violations.push(`roster arm "${arm.participantId}" approvedReportedModelIds do not match code`);
    }
  }
  for (const participantId of codeArms.keys()) {
    if (!seen.has(participantId)) {
      violations.push(`expected code arm "${participantId}" is missing from the roster`);
    }
  }

  // Full-roster capacity: the scheduler must be able to launch the entire
  // expected roster concurrently (spec §3), or an arm could be starved into a
  // false dispatch-lag failure.
  if (manifest.constants.maxConcurrentProviderRequests < manifest.expectedArmRoster.length) {
    violations.push(
      `maxConcurrentProviderRequests (${manifest.constants.maxConcurrentProviderRequests}) < expectedArmRoster.length (${manifest.expectedArmRoster.length})`,
    );
  }

  return violations;
}

/** Set equality (order- and duplicate-independent on both sides). */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}
