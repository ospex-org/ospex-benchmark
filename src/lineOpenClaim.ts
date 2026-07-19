import { deepFreeze } from './freeze.js';
import type { AdmitDispatchRequest, AtomicStore, ClaimKey, Lease } from './store/contract.js';

/**
 * The unforgeable authorization to launch one fire's roster (SPEC-line-open-evidence-model.md
 * §4/§5). A `DispatchPermit` is minted ONLY by a genuine store admission — the
 * module-private `mintDispatchPermit`, called only by `StoreClaimPort` on an `admitted`
 * outcome — so a report-only rehearsal path, which never admits, can never obtain one.
 * The canonical `FireFn` and the canonical `ArtifactSink` both require a permit
 * (`assertDispatchPermit`), so a canonical `FireArtifactV1` is structurally unreachable
 * without a real admission. The brand is a module-private `WeakSet`, not a structural
 * field: a cast cannot forge it.
 */
export interface DispatchPermit {
  readonly cohortId: string;
  readonly fireId: string;
  readonly gameId: string;
  /** Exactly the keys this dispatch claimed — the retained scope to project + fire. */
  readonly claimedKeys: readonly ClaimKey[];
  /** The retained scope's prepared-bytes digest (the store echoes it back). */
  readonly preparedBytesDigest: string;
  /** One initial lease per roster arm, keyed by manifest arm index. */
  readonly initialLeases: readonly Lease[];
}

const permits = new WeakSet<DispatchPermit>();

/**
 * Mint an authenticated permit from a genuine store admission. Module-private: only
 * `StoreClaimPort` below can call it, so no other path — least of all a report-only
 * rehearsal — can produce an authorization.
 */
function mintDispatchPermit(fields: DispatchPermit): DispatchPermit {
  // DETACH (clone) every nested claimed-key / lease from the store result, then DEEP-freeze
  // the whole graph — so an authorization cannot be changed after minting (a plain
  // assignment to any nested field is ineffective or throws) and a later mutation of the
  // store's own arrays cannot reach back into the permit.
  const permit: DispatchPermit = deepFreeze({
    cohortId: fields.cohortId,
    fireId: fields.fireId,
    gameId: fields.gameId,
    claimedKeys: fields.claimedKeys.map((k) => ({ gameId: k.gameId, market: k.market })),
    preparedBytesDigest: fields.preparedBytesDigest,
    initialLeases: fields.initialLeases.map((l) => ({
      leaseId: l.leaseId,
      armIndex: l.armIndex,
      expiresAt: l.expiresAt,
      state: l.state,
    })),
  });
  permits.add(permit);
  return permit;
}

/** Throw unless `permit` was minted by a genuine store admission (forged or substituted). */
export function assertDispatchPermit(permit: DispatchPermit): void {
  if (!permits.has(permit)) {
    throw new Error('dispatch permit was not minted by a store admission (forged or substituted)');
  }
}

/**
 * A claim attempt's outcome. Only `Authorized` carries a `DispatchPermit`; every other
 * outcome authorizes zero dispatch. `WouldAdmit` is the report-only rehearsal outcome
 * (visibly non-canonical, never a permit).
 */
export type ClaimOutcome =
  | { readonly kind: 'Authorized'; readonly permit: DispatchPermit }
  | { readonly kind: 'WouldAdmit' }
  | { readonly kind: 'Defer'; readonly reason: string }
  | { readonly kind: 'Skip'; readonly reason: string }
  | { readonly kind: 'Fault'; readonly reason: string };

/** The claim seam: admit one fire's dispatch, atomically, at most once. */
export interface ClaimPort {
  admit(req: AdmitDispatchRequest): Promise<ClaimOutcome>;
}

/**
 * The store-backed claim port. Gates STRICTLY on the `admitted` outcome AND its
 * `dispatchAuthorized: true` literal (never the outcome name alone), and mints a permit
 * only then. Any store throw — including a `StoreWireError` contract skew — fails loud,
 * never coerced into an authorization.
 *
 * This slice implements the happy-path `admitted → Authorized` mapping the walking
 * skeleton needs. The EXHAUSTIVE non-admitted reaction matrix (all_claimed → terminal
 * Skip; call/spend/concurrency → Defer while clean; replay/pending → resume; replay/
 * completed → Skip; invariant/config/wire faults → Fault) and the per-arm lease lifecycle
 * land in a later durable-store-integration slice; here every non-admitted outcome fails
 * loud (a skeleton fires only on a fresh admission).
 */
export class StoreClaimPort implements ClaimPort {
  constructor(private readonly store: AtomicStore) {}

  async admit(req: AdmitDispatchRequest): Promise<ClaimOutcome> {
    let result;
    try {
      result = await this.store.admitDispatch(req);
    } catch (error) {
      return {
        kind: 'Fault',
        reason: `store admitDispatch threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (result.outcome === 'admitted' && result.dispatchAuthorized === true) {
      return {
        kind: 'Authorized',
        permit: mintDispatchPermit({
          cohortId: req.cohortId,
          fireId: req.fireId,
          gameId: req.gameId,
          claimedKeys: result.claimedKeys,
          preparedBytesDigest: result.preparedBytesDigest,
          initialLeases: result.initialLeases,
        }),
      };
    }
    return {
      kind: 'Fault',
      reason: `non-admitted admit outcome '${result.outcome}' — the exhaustive reaction matrix is a later slice`,
    };
  }
}

/**
 * The report-only rehearsal claim port. It NEVER admits and NEVER mints a
 * `DispatchPermit`, so its result can never reach the canonical `FireFn` / `ArtifactSink`
 * — a rehearsal run is structurally incapable of writing a canonical `FireArtifactV1`. A
 * separate simulation path may later exercise mock adapters against a visibly
 * non-canonical sink; it does not run through this port.
 */
export class RehearsalClaimPort implements ClaimPort {
  admit(_req: AdmitDispatchRequest): Promise<ClaimOutcome> {
    return Promise.resolve({ kind: 'WouldAdmit' });
  }
}
