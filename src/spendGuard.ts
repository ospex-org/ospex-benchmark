import { ConservativeSpendUnknownError, deriveConservativeActualUsdMicros } from './conservativeSpend.js';
import type { ProviderName } from './types.js';

/**
 * The runtime spend guard's policy layer. It classifies each provider attempt by billing
 * provenance + sent-evidence, prices the billable+received ones via the conservative arithmetic
 * ({@link deriveConservativeActualUsdMicros}), compares each against the per-attempt reservation,
 * and reduces a whole fire to PASS / BREACH / UNKNOWN. The consumer (the fire spine, a later
 * slice) installs the artifact first, then escalates on BREACH or UNKNOWN — this module is pure
 * and takes no I/O, no clock, and no adapters.
 *
 * Two invariants shape every decision: an undercount silently defeats the hard-stop (so every
 * ambiguity resolves toward escalation, never toward "zero"), and an UNKNOWN spend must escalate
 * (never be read as zero). `httpStatus` is deliberately NOT a predicate here — see
 * {@link classifyAttemptSpend}.
 */

/**
 * Whether an arm's adapter can incur REAL provider spend. Sourced ONLY from the unforgeable
 * dispatch capability (a mock or real-shaped fake is `known-zero`; a gated real adapter is
 * `billable`) — never a free boolean beside a raw adapter map.
 */
export type BillingClass = 'known-zero' | 'billable';

/** One attempt's spend disposition. */
export type AttemptSpendClass = 'known_zero' | 'zero' | 'price' | 'unknown';

/**
 * Classify ONE attempt's spend disposition from billing provenance and sent-evidence.
 *
 * `httpStatus` is deliberately NOT consulted: an HTTP failure / 429 carries a non-null status but
 * no usage, and a timeout carries no status yet may have billed after the provider accepted work.
 * The predicate is (billingClass, sent?, usage-present?):
 *   - `known-zero`               → `known_zero` (no real spend, regardless of anything else)
 *   - billable, sent, usage      → `price`
 *   - billable, sent, no usage   → `unknown`  (a sent attempt with no usage may still have billed)
 *   - billable, not sent, usage  → `unknown`  (incoherent: usage without a sent request)
 *   - billable, not sent, none   → `zero`     (never dispatched)
 *
 * The `zero` disposition is PROVISIONAL: the consumer must independently confirm the arm's
 * never-sent/refusal evidence is internally consistent (the refusal-evidence relation) before
 * treating it as zero — an inconsistency there is UNKNOWN, not zero.
 *
 * "usage present" is a shallow check (a non-null, non-array object). DEEP coherence — the exact
 * per-provider token fields and total-consistency — is enforced by the arithmetic, which throws
 * a typed UNKNOWN; {@link computeFireSpendGuard} converts that throw to an `unknown` verdict.
 */
export function classifyAttemptSpend(input: {
  billingClass: BillingClass;
  requestAt: string | null;
  usageRaw: unknown;
}): AttemptSpendClass {
  if (input.billingClass === 'known-zero') return 'known_zero';
  const sent = input.requestAt !== null;
  const usagePresent = isUsagePresent(input.usageRaw);
  if (sent) return usagePresent ? 'price' : 'unknown';
  return usagePresent ? 'unknown' : 'zero';
}

function isUsagePresent(usageRaw: unknown): boolean {
  return typeof usageRaw === 'object' && usageRaw !== null && !Array.isArray(usageRaw);
}

/** One attempt of one arm; identity (provider/model/billingClass) rides on the owning {@link GuardArmInput}. */
export interface GuardAttemptInput {
  readonly requestAt: string | null;
  readonly usageRaw: unknown;
}

/** One arm's authenticated identity + its initial and (optional) repair attempts. */
export interface GuardArmInput {
  readonly participantId: string;
  readonly billingClass: BillingClass;
  readonly provider: ProviderName;
  readonly requestedModelId: string;
  readonly attempt: GuardAttemptInput;
  readonly repair: GuardAttemptInput | null;
}

/** An attempt that either breached the per-attempt reservation or could not be priced. */
export interface SpendGuardOffender {
  readonly participantId: string;
  readonly role: 'initial' | 'repair';
  readonly status: 'breach' | 'unknown';
  /** The conservative derived-actual (set for a breach; `null` for an unknown). */
  readonly derivedActualUsdMicros: number | null;
}

/**
 * The whole-fire verdict. `breach` = at least one priced attempt exceeded the per-attempt
 * reservation; `unknown` = no breach, but at least one billable attempt could not be priced
 * with confidence. Both must escalate (install-then-do-not-settle); `pass` settles normally.
 * A breach takes precedence over an unknown for the `kind` (a confirmed over-spend is the
 * headline), but `offenders` lists every non-passing attempt so the escalation record is complete.
 */
export type FireSpendVerdict =
  | { readonly kind: 'pass' }
  | { readonly kind: 'breach'; readonly offenders: readonly SpendGuardOffender[] }
  | { readonly kind: 'unknown'; readonly offenders: readonly SpendGuardOffender[] };

/**
 * Reduce a fire's arms to a spend verdict. Prices each billable+received attempt at the pinned
 * `priceVersion` and compares to `perAttemptReservationUsdMicros`; a derived-actual STRICTLY
 * greater than the reservation is a breach (exact equality is accepted). Never throws for a money
 * ambiguity — a {@link ConservativeSpendUnknownError} from the arithmetic is converted to an
 * `unknown` verdict — but a non-money error propagates loudly (never swallowed as UNKNOWN).
 */
export function computeFireSpendGuard(input: {
  arms: readonly GuardArmInput[];
  priceVersion: string;
  perAttemptReservationUsdMicros: number;
}): FireSpendVerdict {
  const { arms, priceVersion } = input;
  const cap = input.perAttemptReservationUsdMicros;
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    throw new Error(`perAttemptReservationUsdMicros must be a positive safe integer, got ${describe(cap)}`);
  }

  const offenders: SpendGuardOffender[] = [];
  let anyBreach = false;
  let anyUnknown = false;

  for (const arm of arms) {
    const attempts: ReadonlyArray<readonly ['initial' | 'repair', GuardAttemptInput | null]> = [
      ['initial', arm.attempt],
      ['repair', arm.repair],
    ];
    for (const [role, att] of attempts) {
      if (att === null) continue;
      const cls = classifyAttemptSpend({ billingClass: arm.billingClass, requestAt: att.requestAt, usageRaw: att.usageRaw });
      if (cls === 'known_zero' || cls === 'zero') continue;
      if (cls === 'unknown') {
        offenders.push(unknownOffender(arm.participantId, role));
        anyUnknown = true;
        continue;
      }
      // cls === 'price'
      let derived: number;
      try {
        derived = deriveConservativeActualUsdMicros({
          provider: arm.provider,
          requestedModelId: arm.requestedModelId,
          priceVersion,
          usageRaw: att.usageRaw,
        });
      } catch (error) {
        if (error instanceof ConservativeSpendUnknownError) {
          offenders.push(unknownOffender(arm.participantId, role));
          anyUnknown = true;
          continue;
        }
        throw error; // a genuine (non-money) bug propagates loudly — never masked as UNKNOWN
      }
      if (derived > cap) {
        offenders.push(
          Object.freeze({ participantId: arm.participantId, role, status: 'breach' as const, derivedActualUsdMicros: derived }),
        );
        anyBreach = true;
      }
    }
  }

  if (anyBreach) return Object.freeze({ kind: 'breach' as const, offenders: Object.freeze(offenders) });
  if (anyUnknown) return Object.freeze({ kind: 'unknown' as const, offenders: Object.freeze(offenders) });
  return Object.freeze({ kind: 'pass' as const });
}

function unknownOffender(participantId: string, role: 'initial' | 'repair'): SpendGuardOffender {
  return Object.freeze({ participantId, role, status: 'unknown' as const, derivedActualUsdMicros: null });
}

function describe(value: unknown): string {
  return typeof value === 'number' ? String(value) : typeof value;
}
