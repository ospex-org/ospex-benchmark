import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EscalationLatchedError,
  composeEscalationLatch,
  describeEscalationLatchCause,
  latchGuardedClaimPort,
  unresolvedFireLatchSource,
} from './escalationLatch.js';
import type {
  EscalationLatch,
  EscalationLatchCause,
  EscalationLatchSource,
  UnresolvedFireRead,
} from './escalationLatch.js';
import type { ClaimOutcome, ClaimPort } from './lineOpenClaim.js';
import type { AdmitDispatchRequest } from './store/contract.js';

/**
 * The escalation-latch domain: composition (all sources consulted, causes concatenated,
 * fail-closed on a source failure, zero sources refused at construction), the store-read
 * adapter, and the per-dispatch claim-port guard (check strictly before admit, typed abort
 * on a trip, rejection propagation, method capture). The filesystem source has its own
 * suite (`escalationEvidenceScan.test.ts`); the SQL read has its own scripted suite plus
 * real-Postgres conformance; the end-to-end sequence from docs/CAMPAIGN-ACTIVATION.md
 * lives in `escalationLatchAcceptance.test.ts`.
 */

const COHORT = 'c'.repeat(64);

const UNRESOLVED: EscalationLatchCause = {
  kind: 'unresolved_fire',
  fireId: 'f'.repeat(64),
  admittedAt: '2026-08-05T12:00:00.000Z',
};
const EVIDENCE: EscalationLatchCause = {
  kind: 'escalation_evidence',
  path: '/base/cohort/fire-x-moneyline-abc-spend.json',
  reason: 'spend_attempt_over_reservation',
};
const UNREADABLE: EscalationLatchCause = {
  kind: 'unreadable_evidence',
  path: '/base/cohort/fire-y-total-def-spend.json',
  detail: 'not valid JSON',
};

function sourceOf(causes: readonly EscalationLatchCause[], log: string[], label: string): EscalationLatchSource {
  return {
    async causes(cohortId) {
      log.push(`${label}:${cohortId}`);
      return causes;
    },
  };
}

const REQUEST: AdmitDispatchRequest = {
  cohortId: COHORT,
  fireId: 'f'.repeat(64),
  ownerId: 'owner-host-1234-abc',
  expectedSchemaVersion: 1,
  gameId: 'g-1',
  proposedMarkets: ['moneyline'],
  scopeReservations: {
    moneyline: { spendReservationUsdMicros: 800_000_000, preparedBytesDigest: 'd'.repeat(64) },
  },
};

const ADMITTED: ClaimOutcome = { kind: 'Skip', reason: 'all_claimed' };

// ===========================================================================
// composition
// ===========================================================================

test('a latch composed from ZERO sources is refused at construction — a latch that can never trip is not a latch', () => {
  assert.throws(() => composeEscalationLatch([]), /at least one source/);
});

test('all sources clear → not latched; every source was consulted with the cohortId', async () => {
  const log: string[] = [];
  const latch = composeEscalationLatch([sourceOf([], log, 'a'), sourceOf([], log, 'b')]);
  assert.deepEqual(await latch.check(COHORT), { latched: false });
  assert.deepEqual(log, [`a:${COHORT}`, `b:${COHORT}`], 'both sources consulted, in order');
});

test('a trip lists EVERY cause from EVERY source, concatenated in source order — never just the first hit', async () => {
  const log: string[] = [];
  const latch = composeEscalationLatch([
    sourceOf([UNRESOLVED], log, 'store'),
    sourceOf([], log, 'clear'),
    sourceOf([EVIDENCE, UNREADABLE], log, 'fs'),
  ]);
  const verdict = await latch.check(COHORT);
  assert.equal(verdict.latched, true);
  if (!verdict.latched) return;
  assert.deepEqual(
    verdict.causes.map((c) => ({ ...c })),
    [UNRESOLVED, EVIDENCE, UNREADABLE].map((c) => ({ ...c })),
  );
  assert.deepEqual(log, [`store:${COHORT}`, `clear:${COHORT}`, `fs:${COHORT}`], 'the later sources were still consulted after the first trip');
});

test('a source failure REJECTS the check — fail closed, never read as clear', async () => {
  const latch = composeEscalationLatch([
    {
      async causes() {
        throw new Error('store unreachable');
      },
    },
  ]);
  await assert.rejects(latch.check(COHORT), /store unreachable/);
});

test('sources are captured at composition — a later swap of a source `causes` method cannot redirect the latch', async () => {
  const log: string[] = [];
  const source = sourceOf([UNRESOLVED], log, 'original');
  const latch = composeEscalationLatch([source]);
  (source as { causes: EscalationLatchSource['causes'] }).causes = async () => {
    log.push('swapped');
    return [];
  };
  const verdict = await latch.check(COHORT);
  assert.equal(verdict.latched, true, 'the original captured read still answers');
  assert.deepEqual(log, [`original:${COHORT}`]);
});

// ===========================================================================
// the store-read adapter
// ===========================================================================

test('unresolvedFireLatchSource maps each unresolved fire to a cause; empty reads clear; a rejection propagates', async () => {
  const read: UnresolvedFireRead = {
    async unresolvedFires(cohortId) {
      assert.equal(cohortId, COHORT);
      return [
        { fireId: 'a'.repeat(64), admittedAt: '2026-08-05T12:00:00.000Z' },
        { fireId: 'b'.repeat(64), admittedAt: '2026-08-05T13:00:00.000Z' },
      ];
    },
  };
  assert.deepEqual(
    (await unresolvedFireLatchSource(read).causes(COHORT)).map((c) => ({ ...c })),
    [
      { kind: 'unresolved_fire', fireId: 'a'.repeat(64), admittedAt: '2026-08-05T12:00:00.000Z' },
      { kind: 'unresolved_fire', fireId: 'b'.repeat(64), admittedAt: '2026-08-05T13:00:00.000Z' },
    ],
  );

  const empty = unresolvedFireLatchSource({ async unresolvedFires() { return []; } });
  assert.deepEqual(await empty.causes(COHORT), []);

  const failing = unresolvedFireLatchSource({
    async unresolvedFires(): Promise<never> {
      throw new Error('read failed');
    },
  });
  await assert.rejects(failing.causes(COHORT), /read failed/);
});

// ===========================================================================
// the per-dispatch guard
// ===========================================================================

function clearLatch(log: string[]): EscalationLatch {
  return {
    async check(cohortId) {
      log.push(`check:${cohortId}`);
      return { latched: false };
    },
  };
}

test('clear latch: the check runs STRICTLY BEFORE the inner admit, which receives the exact request and answers by identity', async () => {
  const log: string[] = [];
  const inner: ClaimPort = {
    async admit(request) {
      log.push('admit');
      assert.strictEqual(request, REQUEST, 'the exact request object reaches the inner port');
      return ADMITTED;
    },
  };
  const guarded = latchGuardedClaimPort(inner, clearLatch(log));
  const outcome = await guarded.admit(REQUEST);
  assert.strictEqual(outcome, ADMITTED, 'the inner outcome is returned by identity');
  assert.deepEqual(log, [`check:${REQUEST.cohortId}`, 'admit'], 'check first, admit second — never the reverse');
});

test('tripped latch: the guard throws the typed error carrying every cause and the inner admit is NEVER called', async () => {
  const log: string[] = [];
  const inner: ClaimPort = {
    async admit() {
      log.push('admit');
      return ADMITTED;
    },
  };
  const latch: EscalationLatch = {
    async check() {
      return { latched: true, causes: [UNRESOLVED, EVIDENCE] };
    },
  };
  const guarded = latchGuardedClaimPort(inner, latch);
  await assert.rejects(guarded.admit(REQUEST), (error: unknown) => {
    assert.ok(error instanceof EscalationLatchedError);
    assert.equal(error.name, 'EscalationLatchedError');
    assert.match(error.message, new RegExp(REQUEST.cohortId));
    assert.match(error.message, /unresolved fire/);
    assert.match(error.message, /installed escalation evidence/);
    assert.deepEqual(error.causes.map((c) => ({ ...c })), [UNRESOLVED, EVIDENCE].map((c) => ({ ...c })));
    return true;
  });
  assert.deepEqual(log, [], 'a tripped latch admits NOTHING');
});

test('a latch-check failure REJECTS the admission — fail closed — and the inner admit is never called', async () => {
  let admits = 0;
  const inner: ClaimPort = {
    async admit() {
      admits += 1;
      return ADMITTED;
    },
  };
  const latch: EscalationLatch = {
    async check(): Promise<never> {
      throw new Error('latch source unreachable');
    },
  };
  await assert.rejects(latchGuardedClaimPort(inner, latch).admit(REQUEST), /latch source unreachable/);
  assert.equal(admits, 0);
});

test('both methods are captured at construction — swapping admit or check afterwards cannot redirect an admission', async () => {
  const log: string[] = [];
  const inner: ClaimPort = {
    async admit() {
      log.push('original-admit');
      return ADMITTED;
    },
  };
  const latch = clearLatch(log);
  const guarded = latchGuardedClaimPort(inner, latch);
  (inner as { admit: ClaimPort['admit'] }).admit = async () => {
    log.push('swapped-admit');
    return ADMITTED;
  };
  (latch as { check: EscalationLatch['check'] }).check = async () => {
    log.push('swapped-check');
    return { latched: true, causes: [UNRESOLVED] };
  };
  await guarded.admit(REQUEST);
  assert.deepEqual(log, [`check:${REQUEST.cohortId}`, 'original-admit']);
});

// ===========================================================================
// rendering + the typed error
// ===========================================================================

test('describeEscalationLatchCause names each cause kind with its identifying facts', () => {
  assert.equal(
    describeEscalationLatchCause(UNRESOLVED),
    `unresolved fire ${'f'.repeat(64)} (admitted 2026-08-05T12:00:00.000Z) — pending with no live lease`,
  );
  assert.equal(
    describeEscalationLatchCause(EVIDENCE),
    'installed escalation evidence /base/cohort/fire-x-moneyline-abc-spend.json (spend_attempt_over_reservation)',
  );
  assert.equal(
    describeEscalationLatchCause(UNREADABLE),
    'unreadable spend evidence /base/cohort/fire-y-total-def-spend.json: not valid JSON',
  );
  assert.equal(
    describeEscalationLatchCause({
      kind: 'unverified_evidence',
      path: '/base/cohort/fire-z-moneyline-ghi-spend.json',
      detail: 'clean-pass claim did not verify against fire-z-moneyline-ghi.json — reason-recomputed: …',
    }),
    'unverified clean-pass claim /base/cohort/fire-z-moneyline-ghi-spend.json: ' +
      'clean-pass claim did not verify against fire-z-moneyline-ghi.json — reason-recomputed: …',
  );
});

test('EscalationLatchedError freezes a COPY of the causes — mutating the input array afterwards changes nothing', () => {
  const causes: EscalationLatchCause[] = [UNRESOLVED];
  const error = new EscalationLatchedError(COHORT, causes);
  causes.push(EVIDENCE);
  assert.equal(error.causes.length, 1);
  assert.ok(Object.isFrozen(error.causes));
});
