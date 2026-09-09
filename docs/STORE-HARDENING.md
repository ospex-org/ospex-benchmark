# Store role boundary and explicit migration

This source change is **not authority to migrate or relaunch** an installed campaign.
Campaign `arm`, `tick`, `stop`, `resume` and `runner:fire` no longer install SQL.
They require the dedicated runtime login and an already migrated store. Status
requires a separate SELECT-only login. Missing schema or incorrect roles fail;
there is no privileged DSN fallback or automatic repair.

## Roles and credentials

Provision three standalone LOGIN roles through separately authorized DBA work:

- `ospex_store_migrator`: owns the `store` schema, its tables, sequence and routines.
  Only this role installs `schema.sql`, `functions.sql` and `security.sql` through
  `yarn store:migrate`. It needs database CREATE for a fresh schema.
- `ospex_store_runtime`: schema USAGE; SELECT on store tables; EXECUTE on exactly
  `init_cohort_budget`, `admit_dispatch`, `acquire_repair_lease`, `release_lease`,
  `complete_claim`. Column INSERT on authorization `(cohort_id, record)` and tick
  `(cohort_id, kind, started_at, finished_at, outcome, detail)`; column UPDATE on
  authorization `record` and tick `(finished_at, outcome, detail)`. Sequence USAGE
  on `campaign_ticks_id_seq` is needed by tick INSERT. No other DML, DDL, ownership,
  grant options or helper-function EXECUTE.
- `ospex_store_status`: schema USAGE and SELECT on store tables only; no DML,
  sequences or routine EXECUTE. The CLI also requests server read-only mode.

All three must have no superuser/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS attributes,
no role membership in either direction, and must connect as themselves, not via
SET ROLE from a privileged login. Role creation, passwords, database grants and
existing-object ownership transfer are deliberately **not automated** here.
Grant CONNECT on the selected database separately if its policy requires it.
Do not use REASSIGN OWNED broadly in a shared database.

Keep DSNs in the canonical operator secret channel, never tracked files or CLI
arguments. Runtime uses `STORE_DATABASE_URL`; status exclusively uses
`STORE_STATUS_DATABASE_URL`; migration exclusively uses
`STORE_MIGRATION_DATABASE_URL`. Migration does not load `.env`. Existing TLS/CA
and explicit plaintext-opt-out rules apply to all three DSNs. Never supply the
migration credential to a daemon or status process.

## Separately approved migration procedure

1. Keep writers off. Inventory and back up the exact target. A DBA must review any
   existing schema and transfer only its canonical store objects to the migrator.
   Foreign ownership, extra store objects, RLS, user triggers, unsafe memberships
   and unexpected privileges are refused by readback, not silently adopted.
2. Supply only the migration DSN securely and run `yarn store:migrate` from the
   reviewed checkout. The command uses one Client/transaction, a transaction-scoped
   advisory lock, bounded lock/statement timeouts, explicit installation, effective
   permitted/denied catalog readback, then COMMIT. Failure rolls back, including
   post-DDL verification failure. It never creates roles or seizes ownership.
3. Run `yarn store:migrate --check`. This uses a READ ONLY transaction and performs
   no repair. Retain its actual exit and readback. Role identity is checked before
   either mode enters its transaction.
4. Install distinct runtime/status DSNs only under separate deployment authority.
   A successful migration is not authority to start any campaign or service.

Money RPCs are SECURITY DEFINER with `search_path = pg_catalog, store, pg_temp`.
Helpers remain private SECURITY INVOKER routines. PUBLIC, `anon`, `authenticated`
and `service_role` receive no store access. Role-wide default PUBLIC EXECUTE is
revoked for the dedicated migrator. Readback checks effective ACLs, column grants,
grant options, routine identities/owners/search paths, sequence permissions, role
attributes/membership and PG17 MAINTAIN denial. This is a bounded privilege gate,
not a complete structural migration engine for arbitrary preexisting schemas.

## Reproducible verification

`yarn typecheck` and `yarn test` remain database-free. The explicit
`yarn store:hardening` harness needs Docker and a pre-cached `postgres:17.10` image;
it uses `--pull=never`, a uniquely named owned container, tmpfs data, loopback-only
ports, synthetic credentials and an isolated temporary HOME. It accepts no input
DSN or environment file and removes only its owned container.

That harness exercises allowed money/auth/tick/status paths, denied table/column/
DDL/helper/RPC operations for runtime/status/public roles, legacy economic/race
conformance, migration replay, grant mutations and post-DDL rollback. PostgreSQL
conformance is local explicit evidence, not part of the existing offline CI job.
No production database was migrated as part of this PR.
