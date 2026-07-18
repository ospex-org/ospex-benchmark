import type { CohortManifestV1 } from './manifest.js';
import { isFullBoardCohort, isMarketPolicyVersion, marketPolicyDigest } from './marketPolicy.js';
import { isBaselinePolicyVersion, isFullBoardBaselinePolicy } from './baselines.js';
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
 * later PR), `toolInferenceConfigSha256`, `repairPolicyVersion`,
 * `uncertaintyPolicyVersion`, `modelPriceTableVersion`/`modelPriceTableDigest`.
 * Credential presence is a live/boot concern (network), not this pure check.
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

  // Baseline policy: known version (baselines carry no digest concept), then the
  // dynamic-cohort coupling. A cohort whose effective board (sportAllowList ×
  // market policy) is SCOPED produces games carrying 1–2 markets, on which a
  // full-board baseline policy (v0.1/v0.2) fails closed — so such a cohort MUST
  // declare the scoped policy baselines-v0.3.0 (SPEC-prepared-request.md §3, §5-S3;
  // the runtime/scorer mirror this — a scoped artifact stamped v0.2 is refused).
  // The coupling is checked only when BOTH versions are known (an unknown market
  // policy version is already flagged above and would otherwise throw here).
  if (!isBaselinePolicyVersion(manifest.baselinePolicyVersion)) {
    violations.push(`unknown baselinePolicyVersion "${manifest.baselinePolicyVersion}"`);
  } else if (
    isMarketPolicyVersion(manifest.marketPolicyVersion) &&
    isFullBoardBaselinePolicy(manifest.baselinePolicyVersion) &&
    !isFullBoardCohort(manifest.sportAllowList, manifest.marketPolicyVersion)
  ) {
    violations.push(
      `baselinePolicyVersion "${manifest.baselinePolicyVersion}" requires a full three-market board, ` +
        `but this cohort's effective board (sportAllowList ${JSON.stringify(manifest.sportAllowList)} × ` +
        `${manifest.marketPolicyVersion}) is scoped; a dynamic cohort requires baselines-v0.3.0`,
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
