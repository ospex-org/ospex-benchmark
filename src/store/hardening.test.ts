import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import { requireStoreRole } from './connection.js';
import { redactSecrets } from '../config.js';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

test('SH1: ordinary campaign and related runner paths cannot install store DDL', () => {
  for (const path of ['../campaignMain.ts', '../cohortRunnerMain.ts']) {
    const source = read(path);
    assert.doesNotMatch(source, /schema\.sql|functions\.sql|applyStoreSchema|store\/migrate/);
  }
});

test('SH2: status uses only its distinct DSN and retains server read-only enforcement', () => {
  const source = read('../campaignMain.ts');
  const start = source.indexOf('export async function statusCampaign');
  assert.ok(start > 0);
  const end = source.indexOf('export async function resumeCampaign', start);
  const status = source.slice(start, end);
  assert.match(status, /envValue\('STORE_STATUS_DATABASE_URL'\)/);
  assert.doesNotMatch(status, /envValue\('STORE_DATABASE_URL'\)/);
  assert.match(source, /options: '-c default_transaction_read_only=on'/);
  const config = read('../config.ts');
  assert.match(config, /'STORE_STATUS_DATABASE_URL'/);
  assert.match(config, /'STORE_MIGRATION_DATABASE_URL'/);
});

test('SH3: all five money RPCs pin definer execution; helpers stay private', () => {
  const sql = read('./functions.sql');
  for (const name of ['init_cohort_budget', 'admit_dispatch', 'acquire_repair_lease', 'release_lease', 'complete_claim']) {
    const header = sql.match(new RegExp(`create or replace function store\\.${name}\\([\\s\\S]*?as \\$\\$`, 'i'))?.[0];
    assert.ok(header, name);
    assert.match(header, /security definer/i, name);
    assert.match(header, /set search_path = pg_catalog, store, pg_temp/i, name);
  }
  assert.doesNotMatch(read('./campaignTickJournal.ts'), /store\._iso\(/);
  const helpers = [...sql.matchAll(/create or replace function store\.(_\w+)\([\s\S]*?as \$\$/g)];
  assert.equal(helpers.length, 5);
  for (const [header, name] of helpers) {
    assert.match(header, /security invoker/i, name);
    assert.match(header, /set search_path = pg_catalog, store, pg_temp/i, name);
  }
});

test('SH4: migration is explicit, transaction-scoped and separately credentialed', () => {
  assert.ok(existsSync(new URL('./migrate.ts', import.meta.url)), 'missing explicit migration command');
  const source = read('./migrate.ts');
  assert.match(source, /STORE_MIGRATION_DATABASE_URL/);
  assert.doesNotMatch(source, /loadDotEnv|envValue\('STORE_DATABASE_URL'\)/);
  assert.match(source, /await client\.query\(checkOnly \? 'begin read only' : 'begin'\)/);
  assert.match(source, /verify\.sql/);
  assert.match(source, /await client\.query\('rollback'\)\.catch/);
  const scripts = JSON.parse(read('../../package.json')).scripts;
  assert.equal(scripts['store:migrate'], 'tsx src/store/migrate.ts');
  assert.equal(scripts['store:hardening'], 'tsx src/store/hardening.conformance.ts');
  assert.ok(scripts.test.includes('src/store/hardening.test.ts'));
});

test('SH1/SH2/SH4: role guard allows only the actual standalone dedicated login (SELECT only)', async () => {
  for (const role of ['ospex_store_migrator', 'ospex_store_runtime', 'ospex_store_status'] as const) {
    const valid = { role, login: role, elevated: false, membership: false };
    const client = (rows: Array<Record<string, unknown>>) => ({ query: async (statement: string) => {
      assert.match(statement, /^select /);
      assert.doesNotMatch(statement, /\b(create|alter|grant|insert|update|delete|set role)\b/i);
      assert.match(statement, /rolsuper or rolcreaterole or rolcreatedb or rolbypassrls or rolreplication as elevated/);
      assert.match(statement, /where member = r\.oid or roleid = r\.oid/);
      return { rows };
    } });
    await requireStoreRole(client([valid]), role);
    for (const rows of [[], [valid, valid], [{}],
      [{ ...valid, role: 'postgres' }], [{ ...valid, login: 'postgres' }],
      [{ ...valid, elevated: true }], [{ ...valid, membership: true }],
      [{ ...valid, elevated: null }], [{ ...valid, membership: undefined }],
    ]) await assert.rejects(requireStoreRole(client(rows), role), /requires standalone/);
    await assert.rejects(requireStoreRole({ query: async () => { throw new Error('offline'); } }, role), /offline/);
  }
});

for (const path of ['./campaignAuthStore.conformance.ts', './atomicStore.conformance.ts', './spike/conformance.ts']) {
  test(`SH6: ${path} refuses existing cluster roles before schema reset`, () => {
    const source = read(path);
    const guard = source.indexOf('preexisting dedicated store role');
    const reset = source.indexOf("await pool.query('drop schema if exists store cascade')");
    assert.ok(guard > 0 && guard < reset, 'role topology guard must precede destructive schema reset');
    assert.match(source.slice(0, guard), /select rolname from pg_roles where rolname in \('ospex_store_migrator','ospex_store_runtime','ospex_store_status'\)/);
    assert.doesNotMatch(source, /drop role if exists ospex_store_status/);
  });
}

test('SH2/SH4: both new DSNs are redacted at the diagnostic boundary', () => {
  for (const key of ['STORE_STATUS_DATABASE_URL', 'STORE_MIGRATION_DATABASE_URL']) {
    const before = process.env[key];
    const value = `postgres://synthetic:synthetic-password@localhost/${key}`;
    try {
      process.env[key] = value;
      assert.ok(!redactSecrets(`failure: ${value}`).includes(value));
    } finally {
      if (before === undefined) delete process.env[key]; else process.env[key] = before;
    }
  }
});
