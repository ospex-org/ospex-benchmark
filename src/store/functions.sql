-- The atomic store operations as Postgres functions (SPEC-atomic-store.md §4/§11;
-- normative result/refusal shapes: src/store/contract.ts). Every budget-touching
-- operation takes `cohort_budget … FOR UPDATE` FIRST (the global lock order, §4) so
-- the budget race AND the idempotency check are serialized on one row; the claim PK
-- + ON CONFLICT serializes duplicate claims. Functions return JSONB; the durable TS
-- adapter (later slice) maps JSONB → the contract unions. `now()`
-- (`transaction_timestamp()`) is the txn-stable capacity read clock; `clock_timestamp()`
-- stamps `expires_at`/`claimed_at`/`acquired_at` at the true insert instant (§7).
--
-- SPIKE SCOPE: this proves the load-bearing DB mechanisms (FOR UPDATE serialization,
-- ON CONFLICT at-most-once, DB-time lease expiry, capacity ceiling, settle-floor,
-- negative-input guard). The exhaustive invalid_input / refusal taxonomy is the
-- durable-operations slice's; the spike keeps validation to what its cases exercise.

-- ---------------------------------------------------------------------------
-- Helpers (defined first so the operation bodies resolve them at call time).
-- ---------------------------------------------------------------------------

create or replace function store._market_ord(m text) returns int language sql immutable as $$
  select case m when 'moneyline' then 0 when 'spread' then 1 when 'total' then 2 else 99 end;
$$;

create or replace function store._iso(t timestamptz) returns text language sql immutable as $$
  select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

create or replace function store._lease_state(p_released timestamptz, p_expires timestamptz) returns text language sql stable as $$
  select case when p_released is not null then 'released'
              when p_expires <= now()     then 'expired'
              else 'live' end;
$$;

-- The proposed markets must be known, unique, and in canonical (ordinal) order.
create or replace function store._markets_canonical(p jsonb) returns boolean language plpgsql as $$
declare m text; ord int; prev int := -1;
begin
  for m in select value from jsonb_array_elements_text(p) loop
    ord := store._market_ord(m);
    if ord = 99 or ord <= prev then return false; end if;  -- unknown, non-canonical, or duplicate
    prev := ord;
  end loop;
  return true;
end $$;

-- Every present scope reservation's spend must be a SAFE non-negative integer with a
-- non-empty digest — a negative/fractional/unsafe spend must be rejected BEFORE the
-- cap arithmetic, or it could decrement the reservation and free headroom (§4, case 22).
create or replace function store._scope_spend_safe(p jsonb) returns boolean language plpgsql as $$
declare val jsonb; n numeric;
begin
  if p is null then return true; end if;                       -- absence handled by scope_reservation_missing
  if jsonb_typeof(p) <> 'object' then return false; end if;
  for val in select value from jsonb_each(p) loop
    if jsonb_typeof(val) <> 'object' or (val ->> 'spend') is null then return false; end if;
    begin n := (val ->> 'spend')::numeric; exception when others then return false; end;
    if n < 0 or n <> trunc(n) or n > 9007199254740991 then return false; end if;
    if coalesce(val ->> 'digest','') = '' then return false; end if;
  end loop;
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- initCohortBudget — insert-once from the pinned manifest (§2.3, §1.1).
-- ---------------------------------------------------------------------------

create or replace function store.init_cohort_budget(p jsonb) returns jsonb language plpgsql as $$
declare v store.cohort_budget%rowtype;
begin
  select * into v from store.cohort_budget where cohort_id = p ->> 'cohortId' for update;
  if found then
    if v.schema_version <> (p ->> 'schemaVersion')::int then return jsonb_build_object('outcome','refused','reason','version_mismatch'); end if;
    if v.call_cap <> (p ->> 'callCap')::bigint
       or v.spend_cap_usd_micros <> (p ->> 'spendCapUsdMicros')::bigint
       or v.concurrency_limit <> (p ->> 'concurrencyLimit')::int
       or v.roster_size <> (p ->> 'rosterSize')::int
       or v.max_repairs_per_arm <> (p ->> 'maxRepairsPerArm')::int
       or v.initial_lease_bound_ms <> (p ->> 'initialLeaseBoundMs')::int
       or v.repair_lease_bound_ms <> (p ->> 'repairLeaseBoundMs')::int then
      return jsonb_build_object('outcome','refused','reason','config_mismatch');  -- fail loud, NO reset
    end if;
    return jsonb_build_object('outcome','initialized');  -- existing consistent row: preserve reservations
  end if;
  insert into store.cohort_budget (cohort_id, schema_version, call_cap, spend_cap_usd_micros, concurrency_limit,
                                   roster_size, max_repairs_per_arm, initial_lease_bound_ms, repair_lease_bound_ms)
  values (p ->> 'cohortId', (p ->> 'schemaVersion')::int, (p ->> 'callCap')::bigint, (p ->> 'spendCapUsdMicros')::bigint,
          (p ->> 'concurrencyLimit')::int, (p ->> 'rosterSize')::int, (p ->> 'maxRepairsPerArm')::int,
          (p ->> 'initialLeaseBoundMs')::int, (p ->> 'repairLeaseBoundMs')::int)
  on conflict (cohort_id) do nothing;
  return jsonb_build_object('outcome','initialized');
end $$;

-- ---------------------------------------------------------------------------
-- admitDispatch — one transaction, all-or-nothing (§4.1).
-- ---------------------------------------------------------------------------

create or replace function store.admit_dispatch(p_cohort text, p_fire text, p_owner text, p_ver int,
                                                p_game text, p_markets jsonb, p_scope jsonb) returns jsonb
language plpgsql as $$
declare
  v store.cohort_budget%rowtype;
  v_retained text[]; v_scope_key text; v_call_delta bigint; v_spend_delta bigint; v_digest text;
  v_slots int; v_inserted int; v_claimed jsonb; v_leases jsonb; v_fire_status text; v_mismatch int;
begin
  -- 0. domain validation, fail-closed.
  if p_markets is null or jsonb_typeof(p_markets) <> 'array' or jsonb_array_length(p_markets) = 0
     or not store._markets_canonical(p_markets) or not store._scope_spend_safe(p_scope) then
    return jsonb_build_object('outcome','refused','reason','invalid_input','dispatchAuthorized',false);
  end if;

  -- 1. lock + existence + version, fail-closed.
  select * into v from store.cohort_budget where cohort_id = p_cohort for update;
  if not found then return jsonb_build_object('outcome','refused','reason','not_initialized','dispatchAuthorized',false); end if;
  if v.schema_version <> p_ver then return jsonb_build_object('outcome','refused','reason','version_mismatch','dispatchAuthorized',false); end if;

  -- 2. idempotency INSIDE the lock.
  select status into v_fire_status from store.fires where cohort_id = p_cohort and fire_id = p_fire;
  if found then
    -- fail loud iff a recorded claimed key is absent from this retry's proposal.
    select count(*) into v_mismatch from store.claims c
      where c.cohort_id = p_cohort and c.fire_id = p_fire
        and not (c.game_id = p_game and (p_markets ? c.market));
    if v_mismatch > 0 then return jsonb_build_object('outcome','error','reason','fire_id_key_mismatch','dispatchAuthorized',false); end if;
    select coalesce(jsonb_agg(jsonb_build_object('gameId', game_id, 'market', market) order by store._market_ord(market)), '[]'::jsonb)
      into v_claimed from store.claims where cohort_id = p_cohort and fire_id = p_fire;
    if v_fire_status = 'pending' then
      select coalesce(jsonb_agg(jsonb_build_object('leaseId', lease_id, 'armIndex', arm_index, 'expiresAt', store._iso(expires_at),
               'state', store._lease_state(released_at, expires_at)) order by arm_index), '[]'::jsonb)
        into v_leases from store.concurrency_leases where cohort_id = p_cohort and fire_id = p_fire and attempt_kind = 'initial';
      return jsonb_build_object('outcome','replayed','fireStatus','pending','claimedKeys',v_claimed,'initialLeases',v_leases,'dispatchAuthorized',false);
    end if;
    return jsonb_build_object('outcome','replayed','fireStatus','completed','claimedKeys',v_claimed,'dispatchAuthorized',false);
  end if;

  -- 3. retain this game's markets claimed by NO OTHER fire, canonical order.
  select array_agg(m order by store._market_ord(m)) into v_retained
  from jsonb_array_elements_text(p_markets) m
  where not exists (select 1 from store.claims c where c.cohort_id = p_cohort and c.game_id = p_game and c.market = m and c.fire_id <> p_fire);
  if v_retained is null then return jsonb_build_object('outcome','refused','reason','all_claimed','dispatchAuthorized',false); end if;

  -- 4. store-derived magnitudes; spend from the retained scope table (§4.5).
  v_call_delta := v.roster_size * (1 + v.max_repairs_per_arm);
  v_scope_key := array_to_string(v_retained, '+');
  if not (p_scope ? v_scope_key) then return jsonb_build_object('outcome','refused','reason','scope_reservation_missing','dispatchAuthorized',false); end if;
  v_spend_delta := (p_scope -> v_scope_key ->> 'spend')::bigint;
  v_digest := p_scope -> v_scope_key ->> 'digest';

  -- 5. capacity SUM (txn-stable now()).
  select coalesce(sum(1),0) into v_slots from store.concurrency_leases
    where cohort_id = p_cohort and released_at is null and expires_at > now();

  -- 6. caps.
  if v.calls_reserved + v_call_delta > v.call_cap then return jsonb_build_object('outcome','refused','reason','call_cap','dispatchAuthorized',false); end if;
  if v.spend_reserved_usd_micros + v_spend_delta > v.spend_cap_usd_micros then return jsonb_build_object('outcome','refused','reason','spend_cap','dispatchAuthorized',false); end if;
  if v_slots + v.roster_size > v.concurrency_limit then return jsonb_build_object('outcome','refused','reason','concurrency','dispatchAuthorized',false); end if;

  -- 7. commit: claims (ON CONFLICT DO NOTHING) → fires → budget → per-arm initial leases.
  with ins as (
    insert into store.claims (cohort_id, game_id, market, fire_id, status, claimed_at)
    select p_cohort, p_game, m, p_fire, 'pending', clock_timestamp() from unnest(v_retained) m
    on conflict (cohort_id, game_id, market) do nothing
    returning market)
  select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('gameId', p_game, 'market', market) order by store._market_ord(market)), '[]'::jsonb)
    into v_inserted, v_claimed from ins;
  if v_inserted = 0 then return jsonb_build_object('outcome','refused','reason','all_claimed','dispatchAuthorized',false); end if;  -- phantom-reservation guard

  insert into store.fires (cohort_id, fire_id, call_reserved, spend_reserved_usd_micros, made_calls, status, admitted_at)
    values (p_cohort, p_fire, v_call_delta, v_spend_delta, v.roster_size, 'pending', clock_timestamp());
  update store.cohort_budget set calls_reserved = calls_reserved + v_call_delta,
                                 spend_reserved_usd_micros = spend_reserved_usd_micros + v_spend_delta
    where cohort_id = p_cohort;
  with lz as (
    insert into store.concurrency_leases (lease_id, cohort_id, fire_id, owner_id, arm_index, attempt_kind, acquired_at, expires_at)
    select gen_random_uuid()::text, p_cohort, p_fire, p_owner, g.i - 1, 'initial', clock_timestamp(),
           clock_timestamp() + make_interval(secs => v.initial_lease_bound_ms / 1000.0)
    from generate_series(1, v.roster_size) as g(i)
    returning lease_id, arm_index, expires_at)
  select coalesce(jsonb_agg(jsonb_build_object('leaseId', lease_id, 'armIndex', arm_index, 'expiresAt', store._iso(expires_at), 'state', 'live') order by arm_index), '[]'::jsonb)
    into v_leases from lz;

  return jsonb_build_object('outcome','admitted','claimedKeys',v_claimed,'preparedBytesDigest',v_digest,'initialLeases',v_leases,'dispatchAuthorized',true);
end $$;

-- ---------------------------------------------------------------------------
-- acquireRepairLease — one fresh slot, same lock, idempotency-FIRST (§4.2).
-- ---------------------------------------------------------------------------

create or replace function store.acquire_repair_lease(p_cohort text, p_fire text, p_owner text, p_arm int, p_ordinal int, p_ver int) returns jsonb
language plpgsql as $$
declare v store.cohort_budget%rowtype; f store.fires%rowtype; l store.concurrency_leases%rowtype; v_slots int; v_existing int;
begin
  if p_arm is null or p_arm < 0 or p_ordinal is null or p_ordinal < 1 then return jsonb_build_object('outcome','refused','reason','invalid_input','requestAuthorized',false); end if;
  select * into v from store.cohort_budget where cohort_id = p_cohort for update;
  if not found then return jsonb_build_object('outcome','refused','reason','not_initialized','requestAuthorized',false); end if;
  if v.schema_version <> p_ver then return jsonb_build_object('outcome','refused','reason','version_mismatch','requestAuthorized',false); end if;
  select * into f from store.fires where cohort_id = p_cohort and fire_id = p_fire;
  if not found then return jsonb_build_object('outcome','refused','reason','fire_not_pending','requestAuthorized',false); end if;

  -- durable-key idempotency lookup, BEFORE any fresh-only check.
  select * into l from store.concurrency_leases
    where cohort_id = p_cohort and fire_id = p_fire and arm_index = p_arm and attempt_kind = 'repair' and repair_ordinal = p_ordinal;
  if found then
    if l.owner_id <> p_owner then return jsonb_build_object('outcome','refused','reason','not_owner','requestAuthorized',false); end if;
    return jsonb_build_object('outcome','replayed','lease',jsonb_build_object('leaseId',l.lease_id,'armIndex',l.arm_index,'expiresAt',store._iso(l.expires_at),'state',store._lease_state(l.released_at,l.expires_at)),'requestAuthorized',false);
  end if;

  -- fresh-only checks.
  if f.status <> 'pending' then return jsonb_build_object('outcome','refused','reason','fire_not_pending','requestAuthorized',false); end if;
  if p_arm >= v.roster_size then return jsonb_build_object('outcome','refused','reason','invalid_arm','requestAuthorized',false); end if;
  if p_ordinal > v.max_repairs_per_arm then return jsonb_build_object('outcome','refused','reason','repair_limit','requestAuthorized',false); end if;
  select count(*) into v_existing from store.concurrency_leases where cohort_id=p_cohort and fire_id=p_fire and arm_index=p_arm and attempt_kind='repair';
  if v_existing <> p_ordinal - 1 then return jsonb_build_object('outcome','refused','reason','invalid_attempt','requestAuthorized',false); end if;
  if f.made_calls >= f.call_reserved then return jsonb_build_object('outcome','refused','reason','call_reserved_exhausted','requestAuthorized',false); end if;
  select coalesce(sum(1),0) into v_slots from store.concurrency_leases where cohort_id=p_cohort and released_at is null and expires_at > now();
  if v_slots + 1 > v.concurrency_limit then return jsonb_build_object('outcome','refused','reason','concurrency','requestAuthorized',false); end if;

  insert into store.concurrency_leases (lease_id, cohort_id, fire_id, owner_id, arm_index, attempt_kind, repair_ordinal, acquired_at, expires_at)
    values (gen_random_uuid()::text, p_cohort, p_fire, p_owner, p_arm, 'repair', p_ordinal, clock_timestamp(), clock_timestamp() + make_interval(secs => v.repair_lease_bound_ms/1000.0))
    returning * into l;
  update store.fires set made_calls = made_calls + 1 where cohort_id = p_cohort and fire_id = p_fire;
  return jsonb_build_object('outcome','acquired','lease',jsonb_build_object('leaseId',l.lease_id,'armIndex',l.arm_index,'expiresAt',store._iso(l.expires_at),'state','live'),'requestAuthorized',true);
end $$;

-- ---------------------------------------------------------------------------
-- releaseLease — owner-scoped, capacity-only, no budget lock (§4.3).
-- ---------------------------------------------------------------------------

create or replace function store.release_lease(p_lease text, p_owner text) returns jsonb language plpgsql as $$
declare v_owner text;
begin
  select owner_id into v_owner from store.concurrency_leases where lease_id = p_lease;
  if not found then return jsonb_build_object('outcome','released'); end if;      -- unknown lease: no-op
  if v_owner <> p_owner then return jsonb_build_object('outcome','refused','reason','not_owner'); end if;
  update store.concurrency_leases set released_at = clock_timestamp() where lease_id = p_lease and released_at is null;
  return jsonb_build_object('outcome','released');                                -- second release is a no-op
end $$;

-- ---------------------------------------------------------------------------
-- completeClaim — budget-lock-first, settle exactly once (§4.4).
-- ---------------------------------------------------------------------------

create or replace function store.complete_claim(p_cohort text, p_fire text, p_ver int, p_actual_calls bigint, p_actual_spend bigint) returns jsonb
language plpgsql as $$
declare v store.cohort_budget%rowtype; f store.fires%rowtype;
begin
  select * into v from store.cohort_budget where cohort_id = p_cohort for update;
  if not found or v.schema_version <> p_ver then return jsonb_build_object('outcome','refused','reason','version_mismatch'); end if;
  select * into f from store.fires where cohort_id = p_cohort and fire_id = p_fire;
  if not found then return jsonb_build_object('outcome','completed'); end if;     -- no fire: no-op
  if f.status = 'completed' then return jsonb_build_object('outcome','completed'); end if;  -- idempotent

  -- malformed (negative) actual → invalid_input; well-typed out-of-interval → invariant_breach.
  if (p_actual_calls is not null and p_actual_calls < 0) or (p_actual_spend is not null and p_actual_spend < 0) then
    return jsonb_build_object('outcome','refused','reason','invalid_input');
  end if;
  if (p_actual_calls is not null and (p_actual_calls < f.made_calls or p_actual_calls > f.call_reserved))
     or (p_actual_spend is not null and p_actual_spend > f.spend_reserved_usd_micros) then
    return jsonb_build_object('outcome','refused','reason','invariant_breach');
  end if;

  -- settle-down-only: calls floor = made_calls (omitted → settle to made_calls); spend floor = 0 (omitted → full).
  update store.cohort_budget set
    calls_reserved = calls_reserved - (f.call_reserved - coalesce(p_actual_calls, f.made_calls)),
    spend_reserved_usd_micros = spend_reserved_usd_micros - (f.spend_reserved_usd_micros - coalesce(p_actual_spend, f.spend_reserved_usd_micros))
    where cohort_id = p_cohort;
  update store.fires set status = 'completed', completed_at = clock_timestamp() where cohort_id = p_cohort and fire_id = p_fire;
  update store.claims set status = 'completed' where cohort_id = p_cohort and fire_id = p_fire;
  return jsonb_build_object('outcome','completed');
end $$;
