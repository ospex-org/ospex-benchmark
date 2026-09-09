-- Explicit store:migrate only; caller must be the dedicated object owner.
-- These roles are pre-provisioned by a separately authorized DBA, never by a runtime.
-- Reset table AND column ACLs (REVOKE on a table does not remove column grants).
do $hardening$
declare role_name text; grantee_sql text; t record; columns_sql text;
begin
  foreach role_name in array array['PUBLIC', 'ospex_store_runtime', 'ospex_store_status', 'anon', 'authenticated', 'service_role'] loop
    if role_name <> 'PUBLIC' and not exists (select 1 from pg_roles where rolname = role_name) then
      if role_name like 'ospex_store_%' then raise exception 'store hardening: missing role %', role_name; end if;
      continue;
    end if;
    grantee_sql := case when role_name = 'PUBLIC' then 'PUBLIC' else quote_ident(role_name) end;
    execute format('revoke all on schema store from %s', grantee_sql);
    execute format('revoke all on all tables in schema store from %s', grantee_sql);
    execute format('revoke all on all sequences in schema store from %s', grantee_sql);
    execute format('revoke all on all functions in schema store from %s', grantee_sql);
    for t in select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'store' and c.relkind = 'r' loop
      select string_agg(quote_ident(attname), ', ' order by attnum) into columns_sql
        from pg_attribute where attrelid = t.oid and attnum > 0 and not attisdropped;
      execute format('revoke all (%s) on table store.%I from %s', columns_sql, t.relname, grantee_sql);
    end loop;
    -- Global function defaults matter: schema-local REVOKE cannot undo a global grant.
    execute format('alter default privileges revoke execute on functions from %s', grantee_sql);
    execute format('alter default privileges in schema store revoke all on functions from %s', grantee_sql);
    execute format('alter default privileges in schema store revoke all on tables from %s', grantee_sql);
    execute format('alter default privileges in schema store revoke all on sequences from %s', grantee_sql);
  end loop;
end $hardening$;

-- A DBA can revoke the owner's ordinary ACLs without changing ownership. The
-- DEFINER money path needs those privileges too; explicit migration repairs them.
grant all on schema store to ospex_store_migrator;
grant all on all tables in schema store to ospex_store_migrator;
grant all on all sequences in schema store to ospex_store_migrator;
grant all on all functions in schema store to ospex_store_migrator;

grant usage on schema store to ospex_store_runtime, ospex_store_status;
grant select on store.cohort_budget, store.fires, store.claims, store.concurrency_leases,
  store.campaign_authorizations, store.campaign_ticks to ospex_store_runtime, ospex_store_status;

grant execute on function store.init_cohort_budget(jsonb),
  store.admit_dispatch(text,text,text,int,text,jsonb,jsonb),
  store.acquire_repair_lease(text,text,text,int,int,int),
  store.release_lease(text,text), store.complete_claim(text,text,int,bigint,bigint)
  to ospex_store_runtime;

-- Exactly the adapter's writable columns. No DELETE/TRUNCATE/REFERENCES/TRIGGER,
-- no rewriting identity/default columns, no sequence setval, no helper EXECUTE.
grant insert (cohort_id, record), update (record) on store.campaign_authorizations to ospex_store_runtime;
grant insert (cohort_id, kind, started_at, finished_at, outcome, detail),
  update (finished_at, outcome, detail) on store.campaign_ticks to ospex_store_runtime;
grant usage on sequence store.campaign_ticks_id_seq to ospex_store_runtime;
