/**
 * Two-sided conformance of the ACCEPTED CONFIGURATION SPACE against a real
 * PostgreSQL `jsonb` column.
 *
 *   accepted by `configurationViolations`  =>  stores, and reads back to the
 *                                              SAME canonical bytes and digest
 *   refused for a STORAGE reason           =>  really is unstorable
 *
 * ADVISORY. Run by hand, never in CI, gates nothing.
 *
 * It needs a THROWAWAY PostgreSQL — never a real one; it writes — reached
 * through `CONFIG_SPACE_DB_URL`. Start one with the official image on a port
 * nothing else uses, point the variable at it as the superuser, run this file
 * with `npx tsx`, then remove the container. The connection string is not
 * written down here on purpose: a URL shape in a public repository is a thing
 * someone later copies and fills in with a real host.
 *
 * WHY IT EXISTS. A participant's configuration is arbitrary JSON by design, so
 * "which values are valid" is a question about the CONSUMERS, not a question
 * this repository gets to answer on its own. Three separate defects came from
 * answering it here: an empty nested object that changes the digest without
 * changing the request, a NUL, and a lone surrogate. Each was found as an
 * instance and could have been fixed as one. This bounds the class instead, by
 * asking the database rather than modelling it — the boundary is not where it
 * looks, and reasoning about it has been wrong twice. Measured on PostgreSQL
 * 17.10: a NUL is refused in a KEY as well as a value, while U+001F and
 * well-formed surrogate pairs store fine.
 *
 * The second half is the half that keeps the rule honest. Refusing a value the
 * database would happily store is also a defect — it rejects a legal
 * configuration — so every storage refusal has to be a real one.
 */
import { createRequire } from 'node:module';
import {
  canonicalConfigurationText,
  configurationSha256,
  configurationViolations,
} from '../src/participantConfiguration.js';
import type { ParticipantConfiguration } from '../src/participantConfiguration.js';

const require = createRequire(import.meta.url);
const { Client } = require('pg') as typeof import('pg');

/** Built from char codes: a raw NUL in a source file makes git treat it as binary. */
const cc = (code: number): string => String.fromCharCode(code);

const STRINGS: string[] = [
  '',
  'plain',
  'with space',
  'quote"and\\backslash',
  '\n\t\r\b\f',
  cc(1),
  cc(31),
  cc(127),
  cc(0),
  `a${cc(0)}b`,
  cc(0xd800),
  cc(0xdc00),
  `${cc(0xdc00)}${cc(0xd800)}`,
  `ok${cc(0xd800)}`,
  '\u{1F600}',
  '\u{10FFFF}',
  '￿',
  '￾',
  '﻿',
  'é',
  'é',
  '一二三',
  'x'.repeat(300),
];

const NUMBERS: number[] = [
  0, -0, 1, -1, 1.5, 0.1, 1e21, 1e-7, 1e308, 5e-324,
  Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER,
  333333333.33333329, 0.30000000000000004,
];

const KEYS: string[] = [
  'k', 'with space', 'é', '一', '\u{1F600}', 'UPPER', 'a-b', 'a_b', '0',
  'constructor', 'prototype', 'toString', 'k'.repeat(100),
  `k${cc(0)}`, `k${cc(0xd800)}`, 'a.b',
];

const candidates: Array<{ label: string; value: unknown }> = [];
const add = (label: string, value: unknown): void => {
  candidates.push({ label, value });
};

for (const s of STRINGS) add(`value:string:${JSON.stringify(s).slice(0, 24)}`, { k: s });
for (const n of NUMBERS) add(`value:number:${n}`, { k: n });
for (const k of KEYS) add(`key:${JSON.stringify(k).slice(0, 24)}`, { [k]: 1 });
for (const s of STRINGS) add(`nested:${JSON.stringify(s).slice(0, 20)}`, { a: { b: { c: s } } });
for (const s of STRINGS) add(`array:${JSON.stringify(s).slice(0, 20)}`, { a: [s, { b: s }] });
add('literals', { a: null, b: true, c: false });
add('empty root', {});
add('empty nested', { a: {} });
add('empty array', { a: [] });
add('empty object inside an array', { a: [{}] });
add('deep', { a: { b: { c: { d: { e: { f: 1 } } } } } });
add('a realistic knob set', { reasoning: { effort: 'high' }, temperature: 0.7, stop: ['a'], seed: null });
for (const n of [400, 480, 500, 510]) add(`size:${n}`, { k: 'x'.repeat(n) });

/** Violations that claim the value cannot be STORED, as opposed to identity or size rules. */
const STORAGE_REASON = /contains a NUL|lone surrogate/;

async function main(): Promise<number> {
  const connectionString = process.env['CONFIG_SPACE_DB_URL'];
  if (connectionString === undefined) {
    console.error('CONFIG_SPACE_DB_URL is not set — see the header for a throwaway container.');
    return 2;
  }
  const client = new Client({ connectionString, statement_timeout: 15_000 });
  await client.connect();
  await client.query('create temporary table probe (v jsonb)');

  let accepted = 0;
  let refusedForStorage = 0;
  let refusedOther = 0;
  const failures: string[] = [];

  for (const { label, value } of candidates) {
    const violations = configurationViolations(value);

    if (violations.length === 0) {
      accepted += 1;
      const configuration = value as ParticipantConfiguration;
      const text = canonicalConfigurationText(configuration);
      try {
        const { rows } = await client.query('insert into probe (v) values ($1::jsonb) returning v', [text]);
        const readBack = rows[0].v as ParticipantConfiguration;
        if (canonicalConfigurationText(readBack) !== text) {
          failures.push(
            `ACCEPTED BUT DOES NOT ROUND-TRIP  ${label}\n      sent ${text}\n      back ${canonicalConfigurationText(readBack)}`,
          );
        } else if (configurationSha256(readBack) !== configurationSha256(configuration)) {
          failures.push(`ACCEPTED BUT THE DIGEST MOVES  ${label}`);
        }
      } catch (error) {
        failures.push(`ACCEPTED BUT UNSTORABLE  ${label}: ${(error as Error).message}`);
      }
      continue;
    }

    if (violations.some((violation) => STORAGE_REASON.test(violation))) {
      refusedForStorage += 1;
      try {
        await client.query('insert into probe (v) values ($1::jsonb)', [JSON.stringify(value)]);
        failures.push(`REFUSED AS UNSTORABLE BUT POSTGRESQL ACCEPTS IT  ${label}`);
      } catch {
        // Expected: the refusal describes a real limit.
      }
      continue;
    }

    // Refused by an identity, size or shape rule. Storage is not the claim, so
    // it is not asserted either way.
    refusedOther += 1;
  }

  await client.end();

  console.log(`candidates                ${candidates.length}`);
  console.log(`accepted                  ${accepted}  (each must store and round-trip)`);
  console.log(`refused: unstorable       ${refusedForStorage}  (each must really be unstorable)`);
  console.log(`refused: identity/size    ${refusedOther}  (storage not asserted)`);
  console.log('');
  if (failures.length === 0) {
    console.log('PROPERTY HOLDS on every candidate');
    return 0;
  }
  console.log(`${failures.length} FAILURE(S):`);
  for (const failure of failures) console.log(`  ${failure}`);
  return 1;
}

process.exitCode = await main();
