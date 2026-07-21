/**
 * Repair policy: the versioned governance of a repair attempt, plus the runner's
 * audited maximum repair capability. The cohort manifest pins `repairPolicyVersion`;
 * canonical boot recomputes nothing (the repair behavior is executable code, pinned
 * by the runner commit and this version — it carries no mutable data table), but it
 * rejects an unknown version, and rejects a `maxRepairAttemptsPerArm` that disagrees
 * with `CODE_MAX_REPAIRS_PER_ARM`: the store and the spend estimator derive their
 * call/spend reservations from that cap, so a divergent cap would silently mis-reserve.
 *
 * `CODE_MAX_REPAIRS_PER_ARM` DESCRIBES the runner's capability (the runner sends at
 * most this many repairs; an exhaustion path sends exactly the maximum) — it does not
 * control the flow, and it is not a caller knob. A behavior-correspondence test observes
 * the repair-exhaustion path and compares the actual repair count to it. Version-only, no
 * digest: the repair spend is reserved by the manifest-pinned fixed-attempt
 * spend-reservation policy (which prices every possible attempt, initial and repair), not
 * here.
 * A future semantic repair change requires a new version AND corresponding runner
 * behavior/version-selection — do not add a second known version until the runner
 * can select the corresponding behavior from authenticated manifest state.
 */
export const REPAIR_POLICY_VERSIONS = Object.freeze(['repair-v1'] as const);
export type RepairPolicyVersion = (typeof REPAIR_POLICY_VERSIONS)[number];

/** The repair-policy version the harness stamps on NEW runs. */
export const REPAIR_POLICY_VERSION: RepairPolicyVersion = 'repair-v1';

/** The runner's audited maximum repair attempts per arm (at most this many; an exhaustion path sends exactly the maximum). */
export const CODE_MAX_REPAIRS_PER_ARM = 1;

export function isRepairPolicyVersion(value: string): value is RepairPolicyVersion {
  return (REPAIR_POLICY_VERSIONS as readonly string[]).includes(value);
}
