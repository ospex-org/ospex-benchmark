/**
 * The `AtomicStore` adapter over the merged store SQL functions (`src/store/functions.sql`;
 * normative contract `src/store/contract.ts`). It maps each typed request → its plpgsql
 * call and zod-validates the JSONB result into the discriminated contract unions.
 *
 * Client-side validation catches every malformed / unsafe / out-of-domain input BEFORE
 * the DB — returning the typed `invalid_input` refusal — so a bad magnitude never reaches
 * an `::int` / `::bigint` cast as a raw driver exception, and the DB's own fail-closed
 * checks (`_markets_canonical`, `_scope_spend_safe`, `CHECK`s) remain a redundant backstop.
 * A DB result that does not match the contract shape is a wire/contract skew that must
 * never happen against the checked-in SQL — it is surfaced loudly (`StoreWireError`),
 * never silently coerced into an authorizing outcome.
 *
 * Backend-injectable: the class takes a low-level `StoreQuery` (pg-shaped
 * `(sql, params) → rows`); `pgStoreQuery(pg)` builds one from any `pg` Pool/Client. The
 * atomicity lives in the SQL function (one call = one transaction), so a Supabase-RPC
 * executor is a later deploy concern, not an adapter-logic change. The adapter imports no
 * `pg` types (the executor is structural), so it stays a pure library.
 */
import { z } from 'zod';
import { isParseableInstant } from '../time.js';
import type {
  AtomicStore,
  InitCohortBudgetRequest,
  InitResult,
  AdmitDispatchRequest,
  AdmitResult,
  AdmitRefusalReason,
  AcquireRepairLeaseRequest,
  RepairLeaseResult,
  RepairRefusalReason,
  ReleaseLeaseRequest,
  ReleaseResult,
  CompleteClaimRequest,
  CompleteResult,
  CompleteRefusalReason,
} from './contract.js';
import type { MarketKey } from '../types.js';

/** Runs one store-function call (`select store.<fn>(…) as r`) and returns the rows. */
export type StoreQuery = (sql: string, params: readonly unknown[]) => Promise<ReadonlyArray<Record<string, unknown>>>;

/** The minimal shape of a `pg` Pool/Client the adapter needs — structural, so `pg` is
 *  never imported here (it stays a test/runtime-wiring dependency, not an adapter one). */
export interface PgQueryable {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Builds a `StoreQuery` from a `pg` Pool or Client. */
export function pgStoreQuery(pg: PgQueryable): StoreQuery {
  return async (sql, params) => (await pg.query(sql, params)).rows;
}

/**
 * A DB result that violates the normative contract shape — a wire/contract skew that must
 * never happen against the checked-in SQL. Thrown (never returned) so it cannot be mistaken
 * for a refusal; a caller that catches it must fail closed (authorize nothing).
 */
export class StoreWireError extends Error {
  constructor(fn: string, detail: string) {
    super(`store.${fn} returned a result that violates the contract: ${detail}`);
    this.name = 'StoreWireError';
  }
}

// ---------------------------------------------------------------------------
// Client-side invalid_input taxonomy (fail-closed, before the DB)
// ---------------------------------------------------------------------------

/** Safe non-negative integer — the bound for the store's `bigint` fields (call/spend caps
 *  + reservations, actual calls/spend). `number` alone guarantees none of this. */
const isSafeNonNegInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const INT4_MAX = 2_147_483_647;
/** Non-negative Postgres `int` (int4). The int4 columns/params are bounded TIGHTER than
 *  `bigint`: an unsafe-magnitude value that is a safe JS integer (≤ 2^53-1) but > int4 max
 *  would slip past `isSafeNonNegInt` and hit an `(…)::int` cast / `int` bound param as a raw
 *  `integer out of range` driver exception instead of the typed `invalid_input` refusal. */
const isInt4NonNeg = (n: unknown): n is number => isSafeNonNegInt(n) && n <= INT4_MAX;
// Non-empty AND free of a NUL — Postgres `text`/`jsonb` cannot store one, so a NUL in a
// string param/value reaches the driver as a raw exception, not a typed refusal.
const NUL = String.fromCharCode(0);
const isNonEmptyString = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && !s.includes(NUL);
// The prepared-bytes digest is a sha256 hex string (64 lowercase hex). Anything else is a
// malformed digest, refused BEFORE the executor (a non-hex/NUL digest otherwise reaches
// jsonb as a raw 22P05). Both the input reservation and the round-tripped result use this.
const SHA256_HEX = /^[0-9a-f]{64}$/;
const isSha256Hex = (s: unknown): s is string => typeof s === 'string' && SHA256_HEX.test(s);

const MARKET_ORD: Record<MarketKey, number> = { moneyline: 0, spread: 1, total: 2 };
const isKnownMarket = (m: unknown): m is MarketKey => m === 'moneyline' || m === 'spread' || m === 'total';

/** proposedMarkets must be a nonempty, known, duplicate-free, canonically-ordered list
 *  (mirrors `_markets_canonical`), so the DB never sees an unknown/dup/out-of-order market. */
function marketsValid(markets: readonly MarketKey[]): boolean {
  if (!Array.isArray(markets) || markets.length === 0) return false;
  let prev = -1;
  for (const m of markets) {
    if (!isKnownMarket(m)) return false;
    const ord = MARKET_ORD[m];
    if (ord <= prev) return false; // duplicate or non-canonical
    prev = ord;
  }
  return true;
}

/** Every PRESENT scope entry must carry a safe non-negative integer spend and a well-formed
 *  (sha256-hex) digest. A malformed digest is refused here, before the executor — otherwise
 *  a non-hex / NUL digest reaches jsonb as a raw 22P05. Completeness is NOT required: a
 *  retained subset absent from the map is the DB's distinct `scope_reservation_missing`, and
 *  an extra entry outside `proposedMarkets` is simply never selected (SPEC §4.5, reconciled). */
function scopeReservationsValid(scope: AdmitDispatchRequest['scopeReservations']): boolean {
  if (scope === null || typeof scope !== 'object') return false;
  for (const res of Object.values(scope)) {
    if (res === undefined) continue;
    if (res === null || typeof res !== 'object') return false;
    if (!isSafeNonNegInt(res.spendReservationUsdMicros) || !isSha256Hex(res.preparedBytesDigest)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Result schemas — the JSONB shapes the SQL functions emit (src/store/functions.sql)
// ---------------------------------------------------------------------------

// Every schema is `.strict()`: an unknown field is a contract skew that must throw
// StoreWireError, not be silently stripped. Each object lists EXACTLY the keys the SQL's
// `jsonb_build_object(...)` emits, and the value semantics are validated too — a lease id
// must be non-empty, `expiresAt` a genuine store instant, a digest sha256-hex.
const leaseSchema = z
  .object({
    leaseId: z.string().min(1),
    armIndex: z.number().int().nonnegative(),
    expiresAt: z.string().refine(isParseableInstant, 'lease expiresAt is not a parseable instant'),
    state: z.enum(['live', 'released', 'expired']),
  })
  .strict();
const claimKeySchema = z.object({ gameId: z.string().min(1), market: z.enum(['moneyline', 'spread', 'total']) }).strict();
const digestSchema = z.string().regex(SHA256_HEX, 'preparedBytesDigest is not sha256-hex');

const initResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('initialized') }).strict(),
  // NB: the SQL never emits `invalid_input` for init (it casts pins) — the adapter injects
  // it client-side above; the DB only returns these two.
  z.object({ outcome: z.literal('refused'), reason: z.enum(['config_mismatch', 'version_mismatch']) }).strict(),
]);

// A `pending` replay REQUIRES its per-arm leases; a `completed` replay FORBIDS them (the key
// is absent from the strict schema, so a completed-with-leases skew throws rather than being
// silently rewritten). Modelled as separate members, not one optional-leases branch.
const admitResultSchema = z.union([
  z
    .object({
      outcome: z.literal('admitted'),
      claimedKeys: z.array(claimKeySchema),
      preparedBytesDigest: digestSchema,
      initialLeases: z.array(leaseSchema),
      dispatchAuthorized: z.literal(true),
    })
    .strict(),
  z.discriminatedUnion('fireStatus', [
    z
      .object({
        outcome: z.literal('replayed'),
        fireStatus: z.literal('pending'),
        claimedKeys: z.array(claimKeySchema),
        initialLeases: z.array(leaseSchema),
        dispatchAuthorized: z.literal(false),
      })
      .strict(),
    z
      .object({
        outcome: z.literal('replayed'),
        fireStatus: z.literal('completed'),
        claimedKeys: z.array(claimKeySchema),
        dispatchAuthorized: z.literal(false),
      })
      .strict(),
  ]),
  z
    .object({
      outcome: z.literal('refused'),
      reason: z.enum(['not_initialized', 'version_mismatch', 'invalid_input', 'all_claimed', 'scope_reservation_missing', 'call_cap', 'spend_cap', 'concurrency']),
      dispatchAuthorized: z.literal(false),
    })
    .strict(),
  z.object({ outcome: z.literal('error'), reason: z.literal('fire_id_key_mismatch'), dispatchAuthorized: z.literal(false) }).strict(),
]);

const repairResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('acquired'), lease: leaseSchema, requestAuthorized: z.literal(true) }).strict(),
  z.object({ outcome: z.literal('replayed'), lease: leaseSchema, requestAuthorized: z.literal(false) }).strict(),
  z
    .object({
      outcome: z.literal('refused'),
      reason: z.enum(['not_initialized', 'version_mismatch', 'invalid_input', 'fire_not_pending', 'invalid_arm', 'invalid_attempt', 'repair_limit', 'call_reserved_exhausted', 'concurrency', 'not_owner']),
      requestAuthorized: z.literal(false),
    })
    .strict(),
]);

const releaseResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('released') }).strict(),
  z.object({ outcome: z.literal('refused'), reason: z.literal('not_owner') }).strict(),
]);

const completeResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('completed') }).strict(),
  z.object({ outcome: z.literal('refused'), reason: z.enum(['version_mismatch', 'invariant_breach', 'invalid_input']) }).strict(),
]);

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * The `AtomicStore` implemented over the store SQL functions through an injectable
 * `StoreQuery`. Every method validates its request fail-closed, calls exactly one
 * function (one transaction), and maps the JSONB back into the typed union — or throws
 * `StoreWireError` if the DB shape does not match the contract.
 */
export class SqlAtomicStore implements AtomicStore {
  constructor(private readonly query: StoreQuery) {}

  private async callOne(fn: string, sql: string, params: readonly unknown[]): Promise<unknown> {
    const rows = await this.query(sql, params);
    if (rows.length !== 1) throw new StoreWireError(fn, `expected exactly 1 row, got ${rows.length}`);
    return rows[0]!.r;
  }

  async initCohortBudget(req: InitCohortBudgetRequest): Promise<InitResult> {
    if (
      !isNonEmptyString(req.cohortId) ||
      !isInt4NonNeg(req.schemaVersion) || // int4
      !isSafeNonNegInt(req.callCap) || // bigint
      !isSafeNonNegInt(req.spendCapUsdMicros) || // bigint
      !isInt4NonNeg(req.concurrencyLimit) ||
      !isInt4NonNeg(req.rosterSize) ||
      !isInt4NonNeg(req.maxRepairsPerArm) ||
      !isInt4NonNeg(req.initialLeaseBoundMs) ||
      !isInt4NonNeg(req.repairLeaseBoundMs) ||
      // The store DERIVES the per-dispatch call reservation `roster × (1 + maxRepairs)`
      // (§1.1). Both operands are valid int4, but their product must stay a safe integer —
      // else it exceeds JS-representable range AND overflows the SQL arithmetic at admit.
      !isSafeNonNegInt(req.rosterSize * (1 + req.maxRepairsPerArm))
    ) {
      return { outcome: 'refused', reason: 'invalid_input' };
    }
    const p = {
      cohortId: req.cohortId,
      schemaVersion: req.schemaVersion,
      callCap: req.callCap,
      spendCapUsdMicros: req.spendCapUsdMicros,
      concurrencyLimit: req.concurrencyLimit,
      rosterSize: req.rosterSize,
      maxRepairsPerArm: req.maxRepairsPerArm,
      initialLeaseBoundMs: req.initialLeaseBoundMs,
      repairLeaseBoundMs: req.repairLeaseBoundMs,
    };
    const raw = await this.callOne('init_cohort_budget', 'select store.init_cohort_budget($1::jsonb) as r', [JSON.stringify(p)]);
    const parsed = initResultSchema.safeParse(raw);
    if (!parsed.success) throw new StoreWireError('init_cohort_budget', parsed.error.message);
    return parsed.data;
  }

  async admitDispatch(req: AdmitDispatchRequest): Promise<AdmitResult> {
    const refuse = (reason: AdmitRefusalReason): AdmitResult => ({ outcome: 'refused', reason, dispatchAuthorized: false });
    if (
      !isNonEmptyString(req.cohortId) ||
      !isNonEmptyString(req.fireId) ||
      !isNonEmptyString(req.ownerId) ||
      !isNonEmptyString(req.gameId) ||
      !isInt4NonNeg(req.expectedSchemaVersion) || // int4 (p_ver)
      !marketsValid(req.proposedMarkets) ||
      !scopeReservationsValid(req.scopeReservations)
    ) {
      return refuse('invalid_input');
    }
    const scope: Record<string, { spend: number; digest: string }> = {};
    for (const [key, res] of Object.entries(req.scopeReservations)) {
      if (res !== undefined) scope[key] = { spend: res.spendReservationUsdMicros, digest: res.preparedBytesDigest };
    }
    const raw = await this.callOne(
      'admit_dispatch',
      'select store.admit_dispatch($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) as r',
      [req.cohortId, req.fireId, req.ownerId, req.expectedSchemaVersion, req.gameId, JSON.stringify(req.proposedMarkets), JSON.stringify(scope)],
    );
    const parsed = admitResultSchema.safeParse(raw);
    if (!parsed.success) throw new StoreWireError('admit_dispatch', parsed.error.message);
    // The strict, split schema makes the parsed value already the exact contract union — a
    // pending replay carries its leases, a completed one cannot (a completed-with-leases skew
    // fails the strict schema above), so no manual rewrite is needed or possible.
    return parsed.data;
  }

  async acquireRepairLease(req: AcquireRepairLeaseRequest): Promise<RepairLeaseResult> {
    const refuse = (reason: RepairRefusalReason): RepairLeaseResult => ({ outcome: 'refused', reason, requestAuthorized: false });
    if (
      !isNonEmptyString(req.cohortId) ||
      !isNonEmptyString(req.fireId) ||
      !isNonEmptyString(req.ownerId) ||
      !isInt4NonNeg(req.armIndex) || // int4 (p_arm)
      !isInt4NonNeg(req.repairOrdinal) || // int4 (p_ordinal)
      req.repairOrdinal < 1 ||
      !isInt4NonNeg(req.expectedSchemaVersion) // int4 (p_ver)
    ) {
      return refuse('invalid_input');
    }
    const raw = await this.callOne(
      'acquire_repair_lease',
      'select store.acquire_repair_lease($1,$2,$3,$4,$5,$6) as r',
      [req.cohortId, req.fireId, req.ownerId, req.armIndex, req.repairOrdinal, req.expectedSchemaVersion],
    );
    const parsed = repairResultSchema.safeParse(raw);
    if (!parsed.success) throw new StoreWireError('acquire_repair_lease', parsed.error.message);
    return parsed.data;
  }

  async releaseLease(req: ReleaseLeaseRequest): Promise<ReleaseResult> {
    // `ReleaseResult` has no `invalid_input`: an unknown lease is an idempotent no-op
    // (`released`) and a foreign owner is `not_owner`. A malformed (empty/NUL) reference
    // corresponds to no real lease/owner and is resolved WITHOUT the DB — a no-op release
    // for a malformed lease id, `not_owner` for a malformed owner — so a NUL never reaches
    // a `text` param as a raw exception (the release analogue of the invalid_input guards).
    if (!isNonEmptyString(req.leaseId)) return { outcome: 'released' };
    if (!isNonEmptyString(req.ownerId)) return { outcome: 'refused', reason: 'not_owner' };
    const raw = await this.callOne('release_lease', 'select store.release_lease($1,$2) as r', [req.leaseId, req.ownerId]);
    const parsed = releaseResultSchema.safeParse(raw);
    if (!parsed.success) throw new StoreWireError('release_lease', parsed.error.message);
    return parsed.data;
  }

  async completeClaim(req: CompleteClaimRequest): Promise<CompleteResult> {
    const refuse = (reason: CompleteRefusalReason): CompleteResult => ({ outcome: 'refused', reason });
    if (!isNonEmptyString(req.cohortId) || !isNonEmptyString(req.fireId) || !isInt4NonNeg(req.expectedSchemaVersion)) {
      return refuse('invalid_input');
    }
    // An OMITTED actual (undefined) settles to the floor (SQL `coalesce(NULL, …)`); a
    // PRESENT actual must be a safe non-negative integer, else `invalid_input` before the
    // `bigint` cast. TS forbids an explicit `null`, so undefined is the only "omitted".
    if (req.actualCalls !== undefined && !isSafeNonNegInt(req.actualCalls)) return refuse('invalid_input');
    if (req.actualSpendUsdMicros !== undefined && !isSafeNonNegInt(req.actualSpendUsdMicros)) return refuse('invalid_input');
    const raw = await this.callOne(
      'complete_claim',
      'select store.complete_claim($1,$2,$3,$4,$5) as r',
      [req.cohortId, req.fireId, req.expectedSchemaVersion, req.actualCalls ?? null, req.actualSpendUsdMicros ?? null],
    );
    const parsed = completeResultSchema.safeParse(raw);
    if (!parsed.success) throw new StoreWireError('complete_claim', parsed.error.message);
    return parsed.data;
  }
}
