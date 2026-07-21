import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CODE_MAX_REPAIRS_PER_ARM,
  REPAIR_POLICY_VERSION,
  REPAIR_POLICY_VERSIONS,
  isRepairPolicyVersion,
} from './repairPolicy.js';

/**
 * Repair-policy registry + audited capability. The version registry and the
 * capability constant are pinned to their literal values (so a mutated constant
 * cannot drag the tests with it); the known-version guard is exact (an unknown or
 * prototype-like string is not a version); and the registry is runtime-frozen.
 */

test('registry, guard, and golden capability', () => {
  assert.deepEqual([...REPAIR_POLICY_VERSIONS], ['repair-v1']);
  assert.equal(REPAIR_POLICY_VERSION, 'repair-v1');
  assert.equal(CODE_MAX_REPAIRS_PER_ARM, 1);
  assert.equal(isRepairPolicyVersion('repair-v1'), true);
  for (const v of ['', 'repair-v2', 'toString', '__proto__']) {
    assert.equal(isRepairPolicyVersion(v), false, v);
  }
});

test('the version registry is frozen — a casted push cannot forge a known version', () => {
  assert.ok(isRepairPolicyVersion(REPAIR_POLICY_VERSION));
  assert.throws(() => (REPAIR_POLICY_VERSIONS as unknown as string[]).push('repair-v2'));
  assert.equal(isRepairPolicyVersion('repair-v2'), false);
  assert.deepEqual([...REPAIR_POLICY_VERSIONS], ['repair-v1']); // unchanged state
});
