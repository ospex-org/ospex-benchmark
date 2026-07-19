-- The atomic claim + budget/concurrency + lease store (SPEC-atomic-store.md §3;
-- normative interface: src/store/contract.ts). Four tables under a PRIVATE schema
-- so the API-exposed roles never reach them; all writes go through the atomic
-- functions in functions.sql (§11.1). This is the SQL FEASIBILITY SPIKE schema —
-- proven against a real Postgres by store/spike/conformance.ts before the durable
-- adapter is built. Every counter is a non-negative bigint (exact integer
-- accounting, §6); every timestamp is the STORE clock (§7), never a worker clock.

create schema if not exists store;

-- One row per cohort, written once at boot from the pinned manifest (§2.3, §1.1).
create table if not exists store.cohort_budget (
  cohort_id                 text    primary key,
  schema_version            int     not null,
  call_cap                  bigint  not null check (call_cap >= 0),
  spend_cap_usd_micros      bigint  not null check (spend_cap_usd_micros >= 0),
  concurrency_limit         int     not null check (concurrency_limit >= 0),
  roster_size               int     not null check (roster_size >= 0),
  max_repairs_per_arm       int     not null check (max_repairs_per_arm >= 0),
  initial_lease_bound_ms    int     not null check (initial_lease_bound_ms >= 0),
  repair_lease_bound_ms     int     not null check (repair_lease_bound_ms >= 0),
  calls_reserved            bigint  not null default 0 check (calls_reserved >= 0),
  spend_reserved_usd_micros bigint  not null default 0 check (spend_reserved_usd_micros >= 0)
);

-- One row per dispatch: idempotency anchor + settle anchor (§2.1).
create table if not exists store.fires (
  cohort_id                 text    not null,
  fire_id                   text    not null,
  call_reserved             bigint  not null check (call_reserved >= 0),
  spend_reserved_usd_micros bigint  not null check (spend_reserved_usd_micros >= 0),
  made_calls                bigint  not null check (made_calls >= 0),   -- attempts STARTED; the calls settle floor
  status                    text    not null check (status in ('pending','completed')),
  admitted_at               timestamptz not null,
  completed_at              timestamptz,
  primary key (cohort_id, fire_id)
);

-- The at-most-once claim ledger; the PK enforces at-most-once (§2.2, case 8).
create table if not exists store.claims (
  cohort_id  text not null,
  game_id    text not null,
  market     text not null check (market in ('moneyline','spread','total')),
  fire_id    text not null,
  status     text not null check (status in ('pending','completed')),
  claimed_at timestamptz not null,
  primary key (cohort_id, game_id, market)
);
create index if not exists claims_by_fire on store.claims (cohort_id, fire_id);

-- One slot per row; releasable, crash-expiring (§2.4). Capacity is a time filter,
-- not a counter, so a crashed never-released lease self-heals at expires_at.
create table if not exists store.concurrency_leases (
  lease_id       text primary key,
  cohort_id      text not null,
  fire_id        text not null,
  owner_id       text not null,
  arm_index      int  not null check (arm_index >= 0),
  attempt_kind   text not null check (attempt_kind in ('initial','repair')),
  repair_ordinal int  check (repair_ordinal is null or repair_ordinal >= 1),
  acquired_at    timestamptz not null,   -- clock_timestamp() at insert (the true acquire instant, §7)
  expires_at     timestamptz not null,   -- acquired_at + pinned bound
  released_at    timestamptz,
  -- per-arm repair idempotency: (cohort, fire, arm, ordinal); NULL ordinal (initial)
  -- rows stay distinct, and one initial per (fire, arm_index) is inserted once.
  unique (cohort_id, fire_id, arm_index, attempt_kind, repair_ordinal)
);
