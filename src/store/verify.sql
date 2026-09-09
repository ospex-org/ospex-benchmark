-- Frozen SH3/SH4 readback. No persistent objects or money writes. Used inside the
-- migration transaction before COMMIT and independently by store:migrate --check.
-- Scope: store + the dedicated role graph/attributes, NOT a global database audit.
-- Effective has_* checks include inherited/PUBLIC grants; raw ACL checks also catch
-- PUBLIC, unknown grantees and grant options even when schema USAGE currently blocks them.
do $verify$
declare
  owner_id oid := (select oid from pg_roles where rolname = 'ospex_store_migrator');
  runtime_id oid := (select oid from pg_roles where rolname = 'ospex_store_runtime');
  status_id oid := (select oid from pg_roles where rolname = 'ospex_store_status');
  ns oid := (select oid from pg_namespace where nspname = 'store');
  t record; col record; f record; r record; priv text; expected boolean;
  money text[] := array['store.init_cohort_budget(jsonb)',
    'store.admit_dispatch(text,text,text,integer,text,jsonb,jsonb)',
    'store.acquire_repair_lease(text,text,text,integer,integer,integer)',
    'store.release_lease(text,text)', 'store.complete_claim(text,text,integer,bigint,bigint)'];
  helpers text[] := array['store._market_ord(text)', 'store._iso(timestamp with time zone)',
    'store._lease_state(timestamp with time zone,timestamp with time zone)',
    'store._markets_canonical(jsonb)', 'store._scope_spend_safe(jsonb)'];
  signature text;
  table_privileges text[] := array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
begin
  -- MAINTAIN is a table privilege starting in PostgreSQL 17 (not accepted by 16).
  if current_setting('server_version_num')::int >= 170000 then
    table_privileges := array_append(table_privileges, 'MAINTAIN');
  end if;
  if owner_id is null or runtime_id is null or status_id is null or ns is null then
    raise exception 'store hardening: missing dedicated roles/schema';
  end if;
  if exists (select 1 from pg_roles where oid = any(array[owner_id,runtime_id,status_id])
    and (rolsuper or rolcreaterole or rolcreatedb or rolbypassrls or rolreplication or not rolcanlogin)) then
    raise exception 'store hardening: unsafe dedicated role attributes';
  end if;
  -- No direct membership edges in EITHER direction, even NOINHERIT / SET-only.
  -- This also precludes every transitive path to owner, status or runtime authority.
  if exists (select 1 from pg_auth_members
    where member = any(array[owner_id,runtime_id,status_id]) or roleid = any(array[owner_id,runtime_id,status_id])) then
    raise exception 'store hardening: dedicated roles must have no memberships (including SET ROLE)';
  end if;
  if (select nspowner from pg_namespace where oid = ns) <> owner_id then
    raise exception 'store hardening: wrong schema owner';
  end if;
  if (select count(*) from pg_class where relnamespace = ns and relkind not in ('i','I')) <> 7
    or exists (select 1 from pg_class where relnamespace = ns and relkind not in ('i','I') and
      (relowner <> owner_id or relrowsecurity or relforcerowsecurity or
       not ((relkind = 'r' and relname = any(array['cohort_budget','fires','claims','concurrency_leases',
           'campaign_authorizations','campaign_ticks'])) or (relkind = 'S' and relname = 'campaign_ticks_id_seq')))) then
    raise exception 'store hardening: unexpected relations/owners/RLS';
  end if;
  if exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid
    where c.relnamespace = ns and not g.tgisinternal) then
    raise exception 'store hardening: unexpected store trigger';
  end if;
  if (select count(*) from pg_proc where pronamespace = ns) <> cardinality(money) + cardinality(helpers) then
    raise exception 'store hardening: unexpected routine count';
  end if;
  foreach signature in array money || helpers loop
    select * into f from pg_proc where oid = to_regprocedure(signature);
    if not found then raise exception 'store hardening: missing routine %', signature; end if;
    if f.proowner <> owner_id or f.prosecdef <> (signature = any(money))
       or f.proconfig is distinct from array['search_path=pg_catalog, store, pg_temp']::text[] then
      raise exception 'store hardening: unsafe routine owner/definer/search_path %', signature;
    end if;
  end loop;

  -- No ACL recipient outside the owner and the two bounded roles, no grant options.
  -- Relation checks include sequences, and column ACLs are inspected independently.
  if exists (
    select 1 from (
      select x.* from pg_namespace n cross join lateral aclexplode(n.nspacl) x where n.oid = ns
      union all
      select x.* from pg_class c cross join lateral aclexplode(c.relacl) x where c.relnamespace = ns
      union all
      select x.* from pg_attribute a join pg_class c on c.oid = a.attrelid
        cross join lateral aclexplode(a.attacl) x where c.relnamespace = ns
      union all
      select x.* from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) x where p.pronamespace = ns
    ) acl where acl.grantee <> owner_id and
      (acl.grantee not in (runtime_id, status_id) or acl.is_grantable)
  ) then raise exception 'store hardening: unexpected ACL recipient/PUBLIC/grant option'; end if;
  -- New objects must start owner-only (global defaults plus store-local defaults).
  if exists (select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl) x
    where d.defaclrole = owner_id and d.defaclnamespace in (0,ns) and d.defaclobjtype in ('r','S','f') and x.grantee <> owner_id)
    or not exists (select 1 from pg_default_acl where defaclrole = owner_id and defaclnamespace = 0 and defaclobjtype = 'f') then
    raise exception 'store hardening: unsafe default privileges';
  end if;

  for r in select oid, rolname from pg_roles where oid in (runtime_id,status_id)
    or rolname in ('anon','authenticated','service_role') loop
    expected := r.oid in (runtime_id,status_id);
    if has_schema_privilege(r.oid, ns, 'USAGE') <> expected or has_schema_privilege(r.oid, ns, 'CREATE')
      or has_schema_privilege(r.oid, ns, 'USAGE WITH GRANT OPTION') then
      raise exception 'store hardening: schema privilege mismatch %', r.rolname;
    end if;
    for t in select * from pg_class where relnamespace = ns and relkind = 'r' loop
      foreach priv in array table_privileges loop
        expected := r.oid in (runtime_id,status_id) and priv = 'SELECT';
        if has_table_privilege(r.oid,t.oid,priv) <> expected
          or has_table_privilege(r.oid,t.oid,priv || ' WITH GRANT OPTION') then
          raise exception 'store hardening: table privilege mismatch %.% %', r.rolname,t.relname,priv;
        end if;
      end loop;
      for col in select attname, attnum from pg_attribute where attrelid = t.oid and attnum > 0 and not attisdropped loop
        foreach priv in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
          expected := (r.oid in (runtime_id,status_id) and priv = 'SELECT') or
            (r.oid = runtime_id and (
              (t.relname = 'campaign_authorizations' and
                ((priv = 'INSERT' and col.attname in ('cohort_id','record')) or (priv = 'UPDATE' and col.attname = 'record')))
              or (t.relname = 'campaign_ticks' and
                ((priv = 'INSERT' and col.attname in ('cohort_id','kind','started_at','finished_at','outcome','detail'))
                or (priv = 'UPDATE' and col.attname in ('finished_at','outcome','detail'))))));
          if has_column_privilege(r.oid,t.oid,col.attnum,priv) <> expected
            or has_column_privilege(r.oid,t.oid,col.attnum,priv || ' WITH GRANT OPTION') then
            raise exception 'store hardening: column privilege mismatch %.%.% %', r.rolname,t.relname,col.attname,priv;
          end if;
        end loop;
      end loop;
    end loop;
    foreach signature in array money || helpers loop
      expected := r.oid = runtime_id and signature = any(money);
      if has_function_privilege(r.oid,to_regprocedure(signature),'EXECUTE') <> expected
        or has_function_privilege(r.oid,to_regprocedure(signature),'EXECUTE WITH GRANT OPTION') then
        raise exception 'store hardening: routine privilege mismatch % %',r.rolname,signature;
      end if;
    end loop;
    foreach priv in array array['USAGE','SELECT','UPDATE'] loop
      expected := r.oid = runtime_id and priv = 'USAGE';
      if has_sequence_privilege(r.oid,'store.campaign_ticks_id_seq',priv) <> expected
        or has_sequence_privilege(r.oid,'store.campaign_ticks_id_seq',priv || ' WITH GRANT OPTION') then
        raise exception 'store hardening: sequence privilege mismatch % %',r.rolname,priv;
      end if;
    end loop;
  end loop;
end $verify$;
