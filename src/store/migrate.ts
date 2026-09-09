/** Explicit owner-only migration. Never imported by campaign/runner production paths. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { envValue, describeError } from '../config.js';
import { storeConnectionConfig, requireStoreRole } from './connection.js';

export async function migrateStore(databaseUrl: string, checkOnly = false): Promise<void> {
  // One checked-out connection for the entire transaction, never Pool.query transaction calls.
  const client = new Client(storeConnectionConfig(databaseUrl));
  const absorb = (): void => {};
  client.on('error', absorb);
  try {
    await client.connect();
    await requireStoreRole(client, 'ospex_store_migrator');
    await client.query(checkOnly ? 'begin read only' : 'begin');
    await client.query("set local search_path = pg_catalog, store, pg_temp");
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '60s'");
    if (!checkOnly) {
      await client.query("select pg_advisory_xact_lock(hashtext('ospex-store-hardening-v1'))");
      // Existing installations must first have their canonical objects transferred by a
      // separately authorized DBA. Never seize foreign ownership or provision login roles.
      for (const file of ['schema.sql', 'functions.sql', 'security.sql']) {
        await client.query(readFileSync(new URL(file, import.meta.url), 'utf8'));
      }
    }
    await client.query(readFileSync(new URL('verify.sql', import.meta.url), 'utf8'));
    await client.query('commit');
  } catch (error) {
    // Close the connection even if rollback fails. Connection loss itself aborts the txn.
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
    client.off('error', absorb);
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const databaseUrl = envValue('STORE_MIGRATION_DATABASE_URL');
  if (databaseUrl === undefined || args.some(a => a !== '--check') || args.length > 1) {
    console.error('usage: STORE_MIGRATION_DATABASE_URL=<dedicated owner DSN> yarn store:migrate [--check] (no .env loading or runtime DSN fallback)');
    process.exitCode = 2;
  } else {
    migrateStore(databaseUrl, args[0] === '--check').then(() => {
      console.log(args[0] === '--check' ? 'store hardening readback PASS (SELECT/catalog only)' : 'store migration committed; effective allowed + denied readback PASS');
    }).catch(error => {
      console.error(`store migration failed: ${describeError(error)}`);
      process.exitCode = 1;
    });
  }
}
