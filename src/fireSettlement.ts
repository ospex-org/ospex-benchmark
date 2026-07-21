import { completionForPermit } from './lineOpenClaim.js';
import type { DispatchPermit } from './lineOpenClaim.js';
import type { CompleteResult } from './store/contract.js';

/**
 * Fire settlement — the post-install claim settle (SPEC-line-open-evidence-model.md §4/§5).
 *
 * The composition spine calls `settleCompletedFire(permit)` exactly once per installed fire, STRICTLY
 * AFTER the artifact is durably installed. The store owns global settle-once/idempotency; this module
 * owns the single post-install invocation and the total classification of its result.
 *
 * The guiding invariant is that a durably-persisted fire is NEVER discarded by a settle failure. Once
 * the artifact is installed, an ordinary completion refusal or a `complete()` throw does not delete or
 * relabel the artifact and does not reject the run: it folds to a typed `unsettled` status. This is the
 * deliberate asymmetry with admission — an admission/store-wire failure is pre-paid and pre-durable and
 * must stop before authority, whereas a completion failure is post-artifact and must preserve the
 * artifact and merely expose `unsettled`. `CompletionStatus` reports completion CONFIRMATION, not
 * omniscient canonical store state. A known refusal (`version_mismatch` / `invariant_breach` /
 * `invalid_input`) is atomic and wrote nothing, so the claim is confirmed still `pending` with its
 * reservations unchanged. A `store_complete_failed` (a rejected/lost `complete()`) or a
 * `store_result_mismatch` (an unrecognizable resolved value) is UNCONFIRMED: the store transaction may
 * have committed before its acknowledgement was lost, so the canonical fire may be `pending` (reservations
 * retained) OR already `completed` (calls settled to the `made_calls` floor; spend still fully consumed,
 * since this request omits `actualSpendUsdMicros`). In every `unsettled` case the artifact stays installed,
 * no provider is re-dispatched, and an activation consumer escalates; a later recovery slice reconciles an
 * aged fire through the store's idempotent, artifact-backed completion (never a blind re-settle). Nothing
 * self-heals it today — lease expiry recovers only concurrency, and a re-detected fire replays without
 * re-settling — so an `unsettled` status is an escalation signal, never a clean-settlement signal.
 *
 * Capability RESOLUTION is kept outside all folding: `completionForPermit` asserts the permit brand, so
 * a forged or substituted permit propagates its assertion (never folded to `unsettled`). Only the
 * genuine `complete()` invocation and the shape of its resolved value are folded.
 */

/**
 * Why a settle did not cleanly complete. The reason also encodes the store-state confidence a consumer
 * may rely on. `version_mismatch` / `invariant_breach` / `invalid_input` are the store's own atomic
 * refusal reasons — the completion was refused, so the claim is confirmed still `pending`. By contrast
 * `store_complete_failed` (a rejection/throw from `complete()`) and `store_result_mismatch` (a resolved
 * value whose shape is neither `completed` nor a known refusal — a runtime skew, including a hostile
 * discriminator) are UNCONFIRMED: the store may have committed before its acknowledgement was lost, so
 * the canonical fire may be `pending` or already `completed`. A thrown or malformed value is never read,
 * coerced, formatted, or embedded.
 */
export type CompletionUnsettledReason =
  | 'version_mismatch'
  | 'invariant_breach'
  | 'invalid_input'
  | 'store_result_mismatch'
  | 'store_complete_failed';

/** Completion CONFIRMATION for a durably-installed fire — not omniscient canonical store state.
 *  `settled` is a confirmed `completed`; `unsettled` carries the reason, whose confidence a consumer
 *  reads (a known refusal is confirmed `pending`; a failed/mismatched completion is unconfirmed).
 *  Independent of durable artifact presence, which is `Installed`. */
export type CompletionStatus =
  | { readonly status: 'settled' }
  | { readonly status: 'unsettled'; readonly reason: CompletionUnsettledReason };

const SETTLED: CompletionStatus = Object.freeze({ status: 'settled' });

function unsettled(reason: CompletionUnsettledReason): CompletionStatus {
  return Object.freeze({ status: 'unsettled', reason });
}

/** The fixed mismatch status for any resolved value that is not a recognizable `CompleteResult`. */
const UNSETTLED_RESULT_MISMATCH: CompletionStatus = unsettled('store_result_mismatch');

/**
 * Classify a resolved store completion result. TOTAL over every runtime value: a `null`, a primitive,
 * an unknown outcome, a known outcome with an unknown reason, or a value whose `outcome` / `reason`
 * getter throws (or a discriminator-trapping proxy) all fold to the fixed `store_result_mismatch`
 * without the value ever being read past its discriminator or formatted. The nested `switch`es stay
 * compiler-exhaustive (a new `CompleteResult` outcome or a new refusal reason breaks `tsc`), and the
 * outer `try/catch` fail-closes any hostile discriminator access at runtime.
 */
export function classifyCompleteResult(result: CompleteResult): CompletionStatus {
  try {
    switch (result.outcome) {
      case 'completed':
        return SETTLED;
      case 'refused': {
        // Read the nested discriminator EXACTLY ONCE into a local: `result.reason` is store-result-
        // owned runtime state, and an accessor could return a recognized reason on the first read and
        // an arbitrary out-of-domain value on a second — so validating one read and returning another
        // would let a hostile reason escape the `CompletionUnsettledReason` union. Switch and return
        // only the captured local.
        const reason = result.reason;
        switch (reason) {
          case 'version_mismatch':
          case 'invariant_breach':
          case 'invalid_input':
            return unsettled(reason);
          default: {
            const _exhaustiveReason: never = reason;
            void _exhaustiveReason;
            return UNSETTLED_RESULT_MISMATCH;
          }
        }
      }
      default: {
        const _exhaustiveOutcome: never = result;
        void _exhaustiveOutcome;
        return UNSETTLED_RESULT_MISMATCH;
      }
    }
  } catch {
    // A hostile `outcome`/`reason` getter (or a trapping proxy) threw — fold to the fixed mismatch,
    // never reading or formatting the value.
    return UNSETTLED_RESULT_MISMATCH;
  }
}

/**
 * Settle one installed fire's claim exactly once. Resolves the completion capability from the permit
 * (a forged/substituted permit's brand assertion PROPAGATES), invokes `complete()` under a total
 * hostile-safe catch (a rejection/throw → `unsettled/store_complete_failed`, value never read), then
 * classifies the resolved result. Returns a `CompletionStatus`; never rejects on a genuine settle
 * failure, so a durably-persisted fire is never discarded.
 */
export async function settleCompletedFire(permit: DispatchPermit): Promise<CompletionStatus> {
  const capability = completionForPermit(permit); // a forged-permit brand assertion propagates
  let result: CompleteResult;
  try {
    result = await capability.complete();
  } catch {
    // The thrown value is never read, coerced, formatted, or tested.
    return unsettled('store_complete_failed');
  }
  return classifyCompleteResult(result);
}
