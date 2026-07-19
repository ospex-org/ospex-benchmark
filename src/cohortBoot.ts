import { deepFreeze } from './freeze.js';
import { cohortId as deriveCohortId, parseManifest } from './manifest.js';
import type { CohortManifestV1 } from './manifest.js';
import { validateManifestAgainstCode } from './manifestValidate.js';

/**
 * The canonical cohort boot gate (SPEC-line-open-evidence-model.md §2). It turns
 * a manifest file's bytes plus the invocation's canonical overrides into a
 * validated, config-locked cohort identity — or refuses to boot. This is the one
 * place the pure manifest checks become a real, fail-closed boot:
 *
 *   1. `--live` is HARD-DISABLED. Live firing is refused unconditionally in this
 *      phase (rehearsal only until the reviewed live-canary phase, Tier-0 §9),
 *      before the manifest is even read — a paid dispatch must be unreachable
 *      from this gate.
 *   2. The manifest is strictly parsed (`parseManifest`); an invalid manifest
 *      never runs.
 *   3. It is validated against the running code (`validateManifestAgainstCode`):
 *      an unknown policy version, a digest mismatch, a roster that does not equal
 *      the code roster, or concurrency below the roster all FAIL boot (§2; the
 *      capacity rule is case 38).
 *   4. The canonical config-lock rejects any eligibility-, completion-, or
 *      scoring-affecting value a CLI override tries to diverge from the manifest —
 *      every such value must come only from the manifest (§2 config lock;
 *      case 18).
 *   5. Only then is `cohortId` derived and the (deep-frozen) manifest returned.
 *
 * Pure and I/O-free: no filesystem, no network. The public-Git precommitment
 * verification (§2; case 17) and the CLI wiring that reads the manifest file and
 * loops the runner are separate slices; this gate is the fixture-testable core
 * they call.
 */

/**
 * A boot refusal carrying the exact reasons, mirroring the violations-array shape
 * of `validateManifestAgainstCode` / `verifyRunIntegrity`.
 */
export class CohortBootError extends Error {
  readonly violations: readonly string[];
  constructor(message: string, violations: readonly string[]) {
    super(message);
    this.name = 'CohortBootError';
    this.violations = violations;
  }
}

/**
 * Canonical overrides explicitly supplied on the invocation, already normalized
 * to the manifest's units (e.g. `--poll-seconds 30` -> `pollIntervalMs: 30000`).
 * A key is present IFF the operator supplied it; an absent key means the manifest
 * value stands. Divergence from the manifest constant fails canonical boot.
 *
 * Normalization to manifest units is the caller's job, so this check is a pure
 * equality in manifest units: a caller unit bug biases toward OVER-refusing (fail
 * closed) rather than admitting a divergence — except the degenerate case where an
 * un-normalized flag value coincidentally equals the pinned constant, which the
 * CLI slice covers with a normalization round-trip test.
 *
 * These overrides are a REFUSAL GUARD only. `cohortBoot` returns just
 * `{ cohortId, manifest }` — the overrides are discarded, so the frozen
 * `manifest.constants` is the sole config the runner and scorer read. A
 * mis-normalized or ignored override can therefore never become runtime config;
 * it can only refuse a divergent invocation.
 */
export interface CanonicalOverrides {
  pollIntervalMs?: number;
  providerCallTimeoutMs?: number;
  maxOutputTokens?: number;
  gameDiscoveryWindowHours?: number;
  maxDispatchesPerTick?: number;
  /**
   * Supplied flags that have NO canonical manifest equivalent (e.g. a late-gate
   * minutes lever, superseded by the canonical window gates): their mere presence
   * in canonical mode fails boot — there is nothing for them to be equal to.
   */
  nonCanonical?: readonly string[];
}

export interface CohortBootRequest {
  /** True IFF the invocation passed the (hard-disabled) `--live` flag. */
  live: boolean;
  /** Raw bytes of the manifest file (UTF-8 JSON text). */
  manifestBytes: string;
  /** Canonical overrides explicitly supplied (unit-normalized); none by default. */
  overrides?: CanonicalOverrides;
}

export interface BootedCohort {
  readonly cohortId: string;
  /**
   * The strictly-parsed manifest, DEEP-FROZEN so no post-boot `as` cast can
   * mutate the eligibility / completion / scoring config the runner and scorer
   * read (identity is already fixed by the time it is returned).
   */
  readonly manifest: CohortManifestV1;
}

// Module-private registry of cohorts produced by cohortBoot. Nothing outside this
// module can add to it, so membership is unforgeable proof that a BootedCohort
// actually came through the canonical boot gate (--live hard-disable, strict
// parse, code-consistency validation, config-lock) — a consumer that authenticates
// against it cannot be handed a hand-built or structurally-copied cohort whose
// manifest never passed `validateManifestAgainstCode`.
const bootedCohorts = new WeakSet<BootedCohort>();

/**
 * Throw unless `booted` was produced by `cohortBoot`. A consumer that must trust
 * the cohort's authenticated identity/config (e.g. the fire-artifact producer)
 * calls this; a forged or structurally-identical copy is rejected.
 */
export function assertBootedCohort(booted: BootedCohort): void {
  if (!bootedCohorts.has(booted)) {
    throw new Error('booted cohort was not produced by cohortBoot (forged or substituted)');
  }
}

/**
 * The manifest constants a CLI override is allowed to name — the subset of
 * eligibility-/completion-/scoring-affecting values that have a legacy CLI flag
 * (`--poll-seconds`, `--timeout-seconds`, `--max-output-tokens`, `--window-hours`,
 * `--max-fires-per-tick`). `--late-minutes` has no canonical equivalent and is
 * handled via `nonCanonical`.
 */
const LOCKED_CONSTANT_KEYS = [
  'pollIntervalMs',
  'providerCallTimeoutMs',
  'maxOutputTokens',
  'gameDiscoveryWindowHours',
  'maxDispatchesPerTick',
] as const;

function enforceConfigLock(manifest: CohortManifestV1, overrides: CanonicalOverrides): string[] {
  const violations: string[] = [];
  for (const key of LOCKED_CONSTANT_KEYS) {
    const supplied = overrides[key];
    const pinned = manifest.constants[key];
    if (supplied !== undefined && supplied !== pinned) {
      violations.push(
        `canonical override ${key} (${supplied}) != manifest ${key} (${pinned}); ` +
          `every eligibility-affecting value must come only from the manifest`,
      );
    }
  }
  for (const key of overrides.nonCanonical ?? []) {
    violations.push(`${key} is not a canonical lever; remove it or move the value into the manifest`);
  }
  return violations;
}

/**
 * Gate a canonical cohort boot. Throws `CohortBootError` (carrying every reason)
 * on any refusal; returns the frozen `{ cohortId, manifest }` on success.
 */
export function cohortBoot(request: CohortBootRequest): BootedCohort {
  // (1) `--live` is hard-disabled — refuse before touching the manifest so a paid
  //     dispatch is unreachable from this gate.
  if (request.live) {
    throw new CohortBootError(
      'live firing is disabled in this build — rehearsal only until the reviewed live-canary phase; remove --live',
      ['--live is hard-disabled'],
    );
  }

  // (2) Strict structural parse — an invalid manifest never runs. Both JSON and
  //     schema failures surface as a boot refusal.
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(request.manifestBytes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CohortBootError(`manifest is not valid JSON: ${reason}`, [`invalid JSON: ${reason}`]);
  }
  let manifest: CohortManifestV1;
  try {
    manifest = parseManifest(parsedRaw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CohortBootError(reason, [reason]);
  }

  // (3) Semantic validation against the running code (version/digest/roster;
  //     capacity is case 38) and (4) the canonical config-lock (case 18) both
  //     accumulate into one refusal so the operator sees every problem at once.
  const violations = [
    ...validateManifestAgainstCode(manifest),
    ...enforceConfigLock(manifest, request.overrides ?? {}),
  ];
  if (violations.length > 0) {
    throw new CohortBootError(`manifest failed canonical boot: ${violations.join('; ')}`, violations);
  }

  // (5) Freeze the config the runner will read, then derive identity from it.
  //     Freezing AFTER the checks and BEFORE returning means no downstream `as`
  //     cast can drift the eligibility / completion / scoring config post-boot —
  //     the same immutability rule that governs the canonical code registries.
  //     Register in the boot brand so a consumer can prove genuine origin.
  const frozen = deepFreeze(manifest);
  const booted: BootedCohort = Object.freeze({ cohortId: deriveCohortId(frozen), manifest: frozen });
  bootedCohorts.add(booted);
  return booted;
}
