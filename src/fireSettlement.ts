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
 * artifact and merely expose `unsettled`. An `unsettled` fire leaves its claim `pending` and its
 * call/spend reservation conservatively consumed; nothing settles it today (lease expiry recovers only
 * concurrency, and a re-detected fire replays without re-settling), so an `unsettled` status is an
 * activation-consumer escalation signal, never a clean-settlement signal. A later recovery slice may
 * re-settle an aged `pending` fire only against durable exact-artifact proof.
 *
 * Capability RESOLUTION is kept outside all folding: `completionForPermit` asserts the permit brand, so
 * a forged or substituted permit propagates its assertion (never folded to `unsettled`). Only the
 * genuine `complete()` invocation and the shape of its resolved value are folded.
 */

/**
 * Why a settle did not cleanly complete. `version_mismatch` / `invariant_breach` / `invalid_input` are
 * the store's own refusal reasons; `store_result_mismatch` is a resolved value whose shape is neither
 * `completed` nor a known refusal (a runtime skew, including a hostile discriminator); and
 * `store_complete_failed` is a rejection/throw from `complete()`. A thrown or malformed value is never
 * read, coerced, formatted, or embedded.
 */
export type CompletionUnsettledReason =
  | 'version_mismatch'
  | 'invariant_breach'
  | 'invalid_input'
  | 'store_result_mismatch'
  | 'store_complete_failed';

/** Whether the store settled the fire. Independent of durable artifact presence (that is `Installed`). */
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
      case 'refused':
        switch (result.reason) {
          case 'version_mismatch':
          case 'invariant_breach':
          case 'invalid_input':
            return unsettled(result.reason);
          default: {
            const _exhaustiveReason: never = result.reason;
            void _exhaustiveReason;
            return UNSETTLED_RESULT_MISMATCH;
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
