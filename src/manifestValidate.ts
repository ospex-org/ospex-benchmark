import type { CohortManifestV1 } from './manifest.js';
import { isMarketPolicyVersion, marketPolicyDigest } from './marketPolicy.js';
import { SOURCE_QUERY_VERSION, isSourceQueryVersion } from './oddsHistory.js';
import { isModelPriceTableVersion, modelPriceTableDigest } from './modelPriceTable.js';
import { CODE_MAX_REPAIRS_PER_ARM, isRepairPolicyVersion } from './repairPolicy.js';
import { isSpendReservationPolicyVersion, spendReservationPolicyForVersion } from './spendReservationPolicy.js';
import { isBaselinePolicyVersion, supportsScopedInput } from './baselines.js';
import { promptScaffoldSha256 } from './prompt.js';
import { toolInferenceConfigSha256 } from './toolInferenceConfig.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import { describeError, redactSecrets } from './config.js';
import { ARMS, planArmRequest } from './providers/index.js';
import {
  canonicalConfigurationText,
  configurationSha256,
} from './participantConfiguration.js';
import type { ParticipantConfiguration } from './participantConfiguration.js';
import type { ChatTurn, ProviderCallOptions } from './types.js';

/**
 * The sports this benchmark's read / discovery / scoring path supports —
 * RUNTIME-frozen (`Object.freeze`), not merely `readonly` / `as const`, because
 * it is an exported load-bearing boot registry the sport-allow-list check reads:
 * a compile-time-only `readonly` could be mutated at runtime through an `as`
 * cast, drifting which sports boot admits. The dimension is `sport` (the stable
 * `games.sport` slug), never the nullable `league`.
 */
export const SUPPORTED_SPORTS: readonly string[] = Object.freeze(['mlb']);

/** Exact ordered-sequence equality (length + element-by-element). Unlike a Set
 *  compare, it treats `['mlb','mlb']` and `['mlb','nfl']` as distinct from
 *  `['mlb']` — duplicates and supersets both fail. */
function orderedArrayEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Semantic validation of a strictly-parsed `CohortManifestV1` against the
 * running code — the known-version / recomputed-digest rule (spec §2) plus the
 * roster and full-roster-capacity checks. Pure and I/O-free: it returns a
 * violations array (empty = valid), mirroring `verifyRunIntegrity`, so the
 * caller decides how to refuse a mismatched manifest. The boot wiring that
 * calls this (and the canonical config-lock) is a separate slice.
 *
 * Every check here recomputes/looks up against real code, so a manifest that
 * pins a version or digest the runner cannot actually honor fails closed rather
 * than running a cohort whose declared policy differs from what executes.
 *
 * Deliberately NOT checked (no code module exists yet — validated when its
 * module lands): `uncertaintyPolicyVersion`.
 * Credential presence is a live/boot concern
 * (network), not this pure check.
 */
export function validateManifestAgainstCode(manifest: CohortManifestV1): string[] {
  const violations: string[] = [];

  // Sport allow-list: this benchmark's read/discovery/scoring path supports
  // exactly `SUPPORTED_SPORTS`, checked by EXACT ordered-array equality — a
  // duplicate (`['mlb','mlb']`) or a superset (`['mlb','nfl']`) fails, because
  // the market policy, discovery reads, and scorer are enumerated for one sport
  // only. The dimension is `sport` (the stable `games.sport` slug), never the
  // nullable `league`. An empty list is already refused by the manifest schema
  // (`.min(1)`), so it never reaches here.
  if (!orderedArrayEqual(manifest.sportAllowList, SUPPORTED_SPORTS)) {
    violations.push(
      `sportAllowList [${manifest.sportAllowList.join(', ')}] is not the supported set ` +
        `[${SUPPORTED_SPORTS.join(', ')}] (exact ordered equality; only 'mlb' is supported)`,
    );
  }

  // Source query version: known-version equality against the read-model version
  // the running `odds_history` predicate + as-of query actually implement. A
  // manifest pinning a version the code cannot honor fails closed.
  if (!isSourceQueryVersion(manifest.sourceQueryVersion)) {
    violations.push(
      `unknown sourceQueryVersion "${manifest.sourceQueryVersion}" (code implements "${SOURCE_QUERY_VERSION}")`,
    );
  }

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

  // Spend-reservation policy: known version, AND (for a known version) the manifest's
  // per-attempt reservation must equal the code-owned amount for that version. The trusted
  // admission builder derives the per-fire reservation from this amount, so a divergent
  // amount would mis-reserve against the pinned cohort spend cap. The two checks are
  // independent, but an unknown version does NOT call the fail-closed accessor and does NOT
  // add a cascading amount mismatch for a policy whose semantics are unknown.
  if (!isSpendReservationPolicyVersion(manifest.spendReservationPolicyVersion)) {
    violations.push(`unknown spendReservationPolicyVersion "${manifest.spendReservationPolicyVersion}"`);
  } else {
    const policy = spendReservationPolicyForVersion(manifest.spendReservationPolicyVersion);
    if (
      manifest.constants.providerAttemptReservationUsdMicros !== policy.providerAttemptReservationUsdMicros
    ) {
      violations.push(
        `providerAttemptReservationUsdMicros (${manifest.constants.providerAttemptReservationUsdMicros}) ` +
          `does not match code spend-reservation policy (${policy.providerAttemptReservationUsdMicros})`,
      );
    }
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

  // Tool-inference config: the manifest digest must equal the hash of the
  // code's declared tool configuration (which server-side tools each arm runs
  // with, and their caps) — so what a cohort declares and what its adapters
  // actually send cannot drift apart.
  const toolConfig = toolInferenceConfigSha256();
  if (manifest.toolInferenceConfigSha256 !== toolConfig) {
    violations.push(
      `toolInferenceConfigSha256 mismatch: manifest "${manifest.toolInferenceConfigSha256}" != recomputed "${toolConfig}"`,
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
  // A duplicate id in the CODE roster would collapse in that Map, so the
  // missing-arm sweep below could not see it. Dispatch throws on one, but only
  // after boot and publication have both passed.
  if (codeArms.size !== defaultExpectedArms().length) {
    violations.push('the code arm registry contains a duplicate participantId');
  }

  // Two entrants that are byte-identical are one competitor entered twice, and
  // the post-run identity gate already refuses that — but it runs on RESPONSES,
  // which means the refusal arrives after a full night of provider spend, and
  // arrives as a permanently unscoreable artifact. It is decidable here, from
  // the roster alone. Same reasoning as `mergeabilityViolations`: a refused
  // boot beats a mid-fire discovery.
  const byEntrant = new Map<string, string>();
  for (const arm of manifest.expectedArmRoster) {
    const key = JSON.stringify([arm.requestedModelId, configurationSha256(arm.configuration)]);
    const prior = byEntrant.get(key);
    if (prior !== undefined && prior !== arm.participantId) {
      violations.push(
        `roster arms "${prior}" and "${arm.participantId}" are the same entrant: model "${arm.requestedModelId}" under the identical configuration`,
      );
      continue;
    }
    byEntrant.set(key, arm.participantId);
  }

  const seen = new Set<string>();
  for (const arm of manifest.expectedArmRoster) {
    // The configuration checks run for EVERY entry, before any `continue`.
    // They used to sit after the duplicate-id and unknown-participant guards,
    // which skipped them for exactly the two entries most likely to be a
    // hand-edited addition — so a roster carrying a credential in a "ghost"
    // arm was refused for the wrong reason and never said what was in the
    // file. The diagnostic is the whole value of that check.
    for (const violation of configurationViolationsFor(arm)) {
      violations.push(`roster arm "${arm.participantId}" ${violation}`);
    }
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
    // The configuration is compared BY DIGEST against the code's, for the same
    // reason as everything above it and with more at stake. Without this a
    // manifest could precommit to a setting the adapters would never send: the
    // digest would be published, hashed into cohortId, and describe a request
    // that did not happen. Falsifiability is the whole point of publishing it.
    const declared = configurationSha256(arm.configuration);
    const inCode = configurationSha256(code.configuration);
    if (declared !== inCode) {
      violations.push(
        `roster arm "${arm.participantId}" configuration ${declared} != code ${inCode}`,
      );
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

/**
 * Everything about ONE roster entry's configuration that can be checked
 * without knowing whether the entry is otherwise well-formed.
 *
 * Split out so it can run before the duplicate-id and unknown-participant
 * guards, which both `continue`. Those are exactly the entries a hand-edited
 * roster produces, and skipping the credential check on them meant the
 * operator got a schema complaint and no word about what was in the file.
 */
function configurationViolationsFor(arm: CohortManifestV1['expectedArmRoster'][number]): string[] {
  const violations: string[] = [];

  // This manifest is published verbatim to a public Git repository, and
  // `configuration` is the one field in it that accepts names this schema has
  // never seen. Compare the canonical text against its redacted form and
  // refuse on any difference; the check never names or emits the value.
  //
  // ITS BOUND, because a clean result here is weaker than it looks: this is
  // exact-substring matching against the secrets THIS PROCESS holds, so it is
  // a property of the validating environment and not of the manifest. It
  // cannot see a credential this shell did not export, one belonging to a
  // provider not enrolled in the secret registry, one shorter than the
  // registry's floor, or one split across two keys. And it runs at BOOT — the
  // publication it protects has already happened by then, so it refuses to
  // RUN rather than preventing disclosure. The gate that prevents disclosure
  // is the pre-commit scan, and it lives outside this program.
  const canonicalText = canonicalConfigurationText(arm.configuration);
  if (redactSecrets(canonicalText) !== canonicalText) {
    violations.push(
      'configuration contains a value matching a credential in this environment — a manifest is published verbatim, so treat it as already disclosed and rotate',
    );
  }

  // Can it actually be merged? `planArmRequest` builds the real request body
  // through the adapters' own builders and throws if the configuration
  // collides with something the cohort already sets, or names something the
  // per-attempt record carries from outside the body. Proving it here means a
  // bad configuration costs a refused boot rather than a mid-fire throw with
  // provider spend already committed.
  violations.push(...mergeabilityViolations(arm.participantId, arm.configuration));
  return violations;
}

/**
 * Two synthetic turns, enough to build a request and never sent anywhere.
 * `planArmRequest` returns the body the adapters would have built; nothing in
 * this file touches the network.
 */
const MERGEABILITY_PROBE_TURNS: ChatTurn[] = [
  { role: 'system', content: 'mergeability probe' },
  { role: 'user', content: 'mergeability probe' },
];

/**
 * Whether an arm's configuration can be merged into every request this cohort
 * will make with it.
 *
 * The legs are ENUMERATED, not sampled, because the body differs between them
 * and so does what a configuration can collide with. A repair carries no tool
 * block, so a configuration touching `tools` collides on the initial leg only;
 * Gemini creates `generationConfig` only when a token cap is supplied, so a
 * configuration touching `generationConfig.maxOutputTokens` collides on the
 * capped legs only. Checking one leg would pass a configuration that throws on
 * the call it first applies to — mid-fire, with provider spend committed.
 */
function mergeabilityViolations(
  participantId: string,
  configuration: ParticipantConfiguration,
): string[] {
  const codeArm = ARMS.find((a) => a.participantId === participantId);
  // Not a code arm — already reported by the roster check; do not report twice.
  if (codeArm === undefined) return [];
  // The MANIFEST's configuration against the code arm's provider and model:
  // this function validates the document, and a manifest declaring something
  // the adapters could not send is exactly the defect it exists to catch. When
  // the two configurations agree, which the digest check above requires, this
  // is the same thing either way.
  const spec = { ...codeArm, configuration };
  const legs: Array<{ label: string; options: ProviderCallOptions }> = [
    { label: 'the initial leg', options: { tools: 'declared', maxOutputTokens: 16_000 } },
    { label: 'the repair leg', options: { tools: 'none', maxOutputTokens: 16_000 } },
    { label: 'a leg with no token cap', options: { tools: 'declared' } },
  ];
  const violations: string[] = [];
  for (const leg of legs) {
    try {
      planArmRequest(spec, MERGEABILITY_PROBE_TURNS, leg.options);
    } catch (error) {
      violations.push(`configuration cannot be merged into ${leg.label}: ${describeError(error)}`);
    }
  }
  return violations;
}

/** Set equality (order- and duplicate-independent on both sides). */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}
