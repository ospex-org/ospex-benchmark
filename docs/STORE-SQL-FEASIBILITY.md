# Store SQL feasibility spike — verdict

**Gate:** SPEC-atomic-store.md §11 ("the operations slice's first gate is to run this
against a scratch schema … before writing production code").
**Verdict: FEASIBLE.** The atomic claim + budget/concurrency + lease store is
implementable on stock Postgres with the exact semantics the design assumes. Proceed
to the durable-operations slice (the TS `AtomicStore` adapter over these functions)
and then the conformance slice.

## What was run

A real Postgres 16 (local Docker) with the store's DDL (`src/store/schema.sql`) and
plpgsql operations (`src/store/functions.sql`), driven by a Node conformance harness
(`src/store/spike/conformance.ts`) over a connection **pool** so the concurrency
cases execute as genuinely overlapping transactions — mocks cannot substitute for
that (§12).

```
docker run -d -e POSTGRES_PASSWORD=spike -e POSTGRES_DB=store_spike -p 5433:5432 postgres:16-alpine
STORE_DATABASE_URL=postgres://postgres:spike@localhost:5433/store_spike yarn store:spike
```

`yarn store:spike` is NOT part of `yarn test` (that suite is pure and DB-free); this
is the store's real-Postgres gate, run on demand / in a Postgres-enabled CI.

## Result: 12/12 conformance checks passed

The load-bearing mechanisms — the ones where "does Postgres actually do this under
concurrency?" was the open question — are empirically confirmed:

| Mechanism (spec) | Case | Proven by |
|---|---|---|
| `cohort_budget FOR UPDATE` serializes the budget race | 25 | 2- and 8-worker admits racing a scarce call cap → exactly one (resp. exactly three) admitted; `calls_reserved` never over-reserved (12 iters) |
| claim PK + `ON CONFLICT DO NOTHING` = at-most-once | 8 | 2- and 8-worker admits (distinct fireIds) on one key → exactly one `admitted` + one claim row (12 iters) |
| idempotency check **inside** the budget lock | new | two concurrent SAME-`fireId` admits → one `admitted`, one `replayed`; one reservation, one lease set (12 iters) |
| DB-time lease expiry **across** transactions | 46 | capacity held until `expires_at` (blocks a second dispatch), freed after real-time expiry with no reclaim event; the crashed fire's claim stays `pending` and budget stays consumed (no refund) |
| concurrency `SUM` ceiling under per-arm release | 45 | saturate to the limit → per-arm `release` frees slots → re-acquire; `SUM(active, unexpired) ≤ limit` throughout; owner-scoped release (`not_owner`) |
| settle-down-only, floored, idempotent | 12 | `completeClaim` settles once to the `made_calls` floor; a retry is a no-op; an out-of-interval actual → `invariant_breach`, a malformed one → `invalid_input` |
| negative-input guard before the cap arithmetic | 22 | a negative scope spend → `invalid_input`, zero rows written (cannot decrement a reservation to free headroom) |
| repair idempotency-first; `made_calls ≤ call_reserved` | 20 | an exact same-key repair `replayed`s (re-increments nothing); over-cap → `repair_limit`; foreign owner → `not_owner` |

## Key Postgres facts this confirms

- The `FOR UPDATE` row lock on the single `cohort_budget` row makes check-then-reserve
  serializable under `READ COMMITTED` — no `SERIALIZABLE` isolation, no retry loop. A
  same-`fireId` retry blocks on the lock and observes the committed prior admission.
- `clock_timestamp()` (advances within a txn) stamps `expires_at` at the true insert
  instant, so a lock-wait before insert does not shorten the lease; `now()` /
  `transaction_timestamp()` (txn-stable) is the capacity-read clock, so a lease cannot
  "expire mid-transaction." Case 46 must be driven **across** transactions — confirmed.
- Capacity as `SUM(1) WHERE released_at IS NULL AND expires_at > now()` self-heals a
  crashed, never-released lease with no counter and no reclaim event.
- `bigint` counters + DB `CHECK (… >= 0)` constraints keep accounting exact and
  non-negative even against a direct write.

## Decisions this spike settles (for the durable-ops slice)

- **Scope-reservation validation** (resolves an F3a open item): the impl does **not**
  pre-enforce that `scopeReservations` is *exactly* the nonempty subsets. `invalid_input`
  catches a malformed/negative/unsafe **spend or empty digest** value; a **retained**
  subset absent from the map is the reachable, distinct `scope_reservation_missing`.
  This keeps the two reasons disjoint and both reachable. `contract.ts`'s
  `AdmitDispatchRequest` JSDoc and spec §4.5 should be reconciled to this in the
  durable-ops slice (drop the "a missing subset → `invalid_input`" clause).
- **Replay leases**: a `pending`-fire replay returns the per-arm initial leases; a
  `completed`-fire replay returns none — matching `contract.ts` `AdmitReplayResult`.
- **Backend shape**: these are plpgsql functions = one function call is one
  transaction, callable equivalently via a direct `pg` connection (as here) or Supabase
  RPC (`.rpc('admit_dispatch', …)`). The atomicity lives in the function, not the client.

## Explicitly deferred to the durable-ops (F3b) / conformance (F3c) slices

- The `AtomicStore` TS adapter mapping JSONB ↔ the `contract.ts` unions; the exhaustive
  `invalid_input` taxonomy (this spike validated the load-bearing guards, not every
  malformed-argument variant); the per-attempt spend pricing (§6, caller-side).
- RPC authority hardening (§11.1): private schema, `REVOKE EXECUTE FROM PUBLIC/anon/
  authenticated`, `GRANT` only the runtime role, `SECURITY` model + pinned `search_path`,
  deny direct table DML, and migration privilege assertions.
- Optional lease GC (§7) pruning only non-counting, non-replayable rows.
- Real overlapping-worker / crash / restart conformance as the committed gate (F3c) —
  this spike is the feasibility proof, not that full suite.
- Moving from the local Docker Postgres to the Supabase target + migrations.

The runtime integration (F5) structurally depends on the conformance slice passing;
`--live` stays hard-disabled and no paid cohort runs before global coverage lands.
