import type { ClaimPort } from './lineOpenClaim.js';
import type { SpendEscalationSidecarV1 } from './spendEscalationSidecar.js';

/**
 * The durable escalation latch (docs/CAMPAIGN-ACTIVATION.md §"A durable escalation latch"):
 * once a spend-guard escalation exists for a cohort, no further dispatch may begin — across
 * process restarts, and independently of whether a disarm write ever succeeded.
 *
 * The latch is DERIVED, never separately written. A "disarm after the tick result" write is
 * best-effort — if it fails transiently, the authorization stays live and a cron scheduler
 * runs again — so the latch reads state that already durably exists the moment an
 * escalation does:
 *
 *   1. The STORE's shadow of the escalation ({@link unresolvedFireLatchSource}): an
 *      escalated fire's claim is deliberately never settled (`runOneFire` retains it
 *      pending), and every one of its leases was settled BEFORE the spend guard ran (the
 *      spine's stage order: the lifecycle runner settles all leases, then production,
 *      install, and the guard). So from strictly before the moment escalation evidence can
 *      exist, the cohort durably holds a fire that is `pending` with no live lease — and a
 *      dispatch admitted through the latch-guarded port at or after that moment is refused
 *      at its own admission. This source is readable from any box that reaches the store,
 *      and it holds even when the escalation sidecar's install itself failed.
 *   2. The installed escalation evidence itself (`escalationEvidenceLatchSource` in
 *      `escalationEvidenceScan.ts`): a spend sidecar with a non-null `reason` in the fire
 *      artifact sink's cohort directory. This source is same-box (it reads the sink root),
 *      and it keeps the latch tripped even if the escalated claim is later settled through
 *      a reviewed recovery path without the campaign being stopped.
 *
 * The unresolved-fire predicate is deliberately BROADER than escalation: it also holds for
 * a fire whose process crashed after admission (once its leases expire) and for a fire
 * whose settlement failed (`Installed/unsettled`) — states in which the spend evidence is
 * unconfirmed, which on an unattended path must also refuse further spending until a human
 * looks. It is also transiently true of a healthy fire between its last lease settlement
 * and its claim settlement; a concurrent tick that begins a dispatch inside that window is
 * refused conservatively (the condition clears when the fire settles). What the latch does
 * NOT do: recall a dispatch already in flight when an escalation lands, or re-check inside
 * an admitted fire's repair leg — an in-flight fire was admitted before the escalation
 * existed and stays bounded by its own reservation and the store's row-locked caps.
 *
 * Every path here fails CLOSED: a source that cannot be read rejects — it is never treated
 * as "clear" — and a latch cannot be composed from zero sources.
 */

/** The escalation reasons a spend sidecar can carry (`null` marks a clean pass, not a cause). */
export type SpendEscalationReason = Exclude<SpendEscalationSidecarV1['reason'], null>;

/** One durable fact holding the latch tripped. */
export type EscalationLatchCause =
  | {
      /** A cohort fire that is `pending` with NO live lease: it escalated, crashed, or
       *  failed to settle — in every case its spend is unconfirmed and dispatch must stop. */
      readonly kind: 'unresolved_fire';
      readonly fireId: string;
      readonly admittedAt: string;
    }
  | {
      /** An installed spend sidecar whose `reason` is non-null — the escalation evidence itself. */
      readonly kind: 'escalation_evidence';
      readonly path: string;
      readonly reason: SpendEscalationReason;
    }
  | {
      /** A spend-evidence file that could not be read or decoded. Fail closed: a file that
       *  MIGHT be escalation evidence latches until a human resolves it. */
      readonly kind: 'unreadable_evidence';
      readonly path: string;
      readonly detail: string;
    };

export type EscalationLatchVerdict =
  | { readonly latched: false }
  | { readonly latched: true; readonly causes: readonly EscalationLatchCause[] };

/** One derivable latch signal. An empty result is "clear"; a failure REJECTS (fail closed). */
export interface EscalationLatchSource {
  causes(cohortId: string): Promise<readonly EscalationLatchCause[]>;
}

/** The composed latch a dispatch path consults. */
export interface EscalationLatch {
  check(cohortId: string): Promise<EscalationLatchVerdict>;
}

/** One unresolved fire as the store reads it. */
export interface UnresolvedFire {
  readonly fireId: string;
  readonly admittedAt: string;
}

/** The store read behind {@link unresolvedFireLatchSource}: every cohort fire that is
 *  `pending` with no live (unreleased, unexpired) lease. Implemented over SQL in
 *  `store/escalationLatchRead.ts`; a rejection propagates (fail closed). */
export interface UnresolvedFireRead {
  unresolvedFires(cohortId: string): Promise<readonly UnresolvedFire[]>;
}

/** A human-readable one-liner for a cause; total over the union (exhaustive switch). */
export function describeEscalationLatchCause(cause: EscalationLatchCause): string {
  switch (cause.kind) {
    case 'unresolved_fire':
      return `unresolved fire ${cause.fireId} (admitted ${cause.admittedAt}) — pending with no live lease`;
    case 'escalation_evidence':
      return `installed escalation evidence ${cause.path} (${cause.reason})`;
    case 'unreadable_evidence':
      return `unreadable spend evidence ${cause.path}: ${cause.detail}`;
    default: {
      const _exhaustive: never = cause;
      return _exhaustive;
    }
  }
}

/** A dispatch admission was refused because the escalation latch is tripped. Typed so an
 *  unattended consumer aborts loudly and a test can assert the exact refusal. */
export class EscalationLatchedError extends Error {
  readonly causes: readonly EscalationLatchCause[];
  constructor(cohortId: string, causes: readonly EscalationLatchCause[]) {
    super(
      `the escalation latch is tripped for cohort ${cohortId} — refusing to admit any dispatch: ` +
        causes.map(describeEscalationLatchCause).join('; '),
    );
    this.name = 'EscalationLatchedError';
    this.causes = Object.freeze([...causes]);
  }
}

/** Adapt the store's unresolved-fire read into a latch source. */
export function unresolvedFireLatchSource(read: UnresolvedFireRead): EscalationLatchSource {
  const unresolvedFires = read.unresolvedFires.bind(read);
  return {
    async causes(cohortId: string): Promise<readonly EscalationLatchCause[]> {
      const fires = await unresolvedFires(cohortId);
      return fires.map((fire) =>
        Object.freeze({ kind: 'unresolved_fire' as const, fireId: fire.fireId, admittedAt: fire.admittedAt }),
      );
    },
  };
}

/**
 * Compose the latch from one or more sources. Sources are consulted in order and ALL are
 * consulted (the verdict lists every cause, so an operator sees the whole picture, not the
 * first hit); any source rejection propagates — a latch that cannot read one of its sources
 * refuses dispatch rather than reading it as clear. Zero sources is a construction error:
 * a latch that can never trip is not a latch.
 */
export function composeEscalationLatch(sources: readonly EscalationLatchSource[]): EscalationLatch {
  if (sources.length === 0) {
    throw new Error('an escalation latch requires at least one source — a source-less latch can never trip');
  }
  // Capture each source's method once, so a later swap of a source object's `causes`
  // property cannot redirect an already-composed latch.
  const reads = sources.map((source) => source.causes.bind(source));
  return {
    async check(cohortId: string): Promise<EscalationLatchVerdict> {
      const causes: EscalationLatchCause[] = [];
      for (const read of reads) {
        causes.push(...(await read(cohortId)));
      }
      if (causes.length === 0) return { latched: false };
      return { latched: true, causes: Object.freeze(causes) };
    },
  };
}

/**
 * The per-dispatch guard: wrap a claim port so EVERY admission first consults the latch.
 * Every dispatch begins with `claimPort.admit` (the spine dispatches only on an authorized
 * admission), so this is literally "checked before every dispatch" — with no change to the
 * store contract, the claim port, or the spine. A tripped latch THROWS the typed
 * {@link EscalationLatchedError}: the tick aborts loudly instead of iterating refusals,
 * which is the correct unattended behaviour (a latched campaign is over; a scheduler must
 * halt and a human must stop it). A latch-check rejection propagates unchanged — fail
 * closed — and the inner admit is never called on a trip. Both methods are captured at
 * construction, so a later swap on the wrapped objects cannot redirect an admission.
 */
export function latchGuardedClaimPort(inner: ClaimPort, latch: EscalationLatch): ClaimPort {
  const admit = inner.admit.bind(inner);
  const check = latch.check.bind(latch);
  return {
    async admit(request) {
      const verdict = await check(request.cohortId);
      if (verdict.latched) throw new EscalationLatchedError(request.cohortId, verdict.causes);
      return admit(request);
    },
  };
}
