import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import {
  CONTRACT_NOTES,
  RESPONSE_TEMPLATE,
  SYSTEM_PROMPT,
  TEMPLATE_PLACEHOLDERS,
} from './prompt.js';
import {
  benchmarkResponseSchema,
  renderResponseTemplate,
  schemaLeafPaths,
} from './schema.js';
import { AXIS_NAMES } from './types.js';

/**
 * Guards the prompt/validator contract alignment structurally, at every
 * nesting depth. The first live run failed 60/60 arm-games because the
 * scaffold never named "confidence" or "wouldAbstain"; a review mutation
 * then proved a name-only check misses nested fields (probabilities.*) and
 * shape changes. The template is rendered FROM the live zod schema, and
 * these tests pin the path-set equality and the fail-loud behavior.
 */

test('placeholder paths equal the schema leaf paths exactly (set equality, all depths)', () => {
  const schemaPaths = [...schemaLeafPaths(benchmarkResponseSchema)].sort();
  const placeholderPaths = Object.keys(TEMPLATE_PLACEHOLDERS).sort();
  assert.deepEqual(placeholderPaths, schemaPaths);
});

test('nested decision fields are individually covered', () => {
  const paths = schemaLeafPaths(benchmarkResponseSchema);
  for (const path of [
    'games[].forecasts[].probabilities.win',
    'games[].forecasts[].probabilities.push',
    'games[].forecasts[].probabilities.loss',
    'games[].forecasts[].confidence',
    'games[].forecasts[].wouldAbstain',
    'games[].forecasts[].evidenceRefs[]',
  ]) {
    assert.ok(paths.includes(path), `schema must expose leaf path ${path}`);
  }
});

test('the scaffold carries the rendered JSON template block, not just prose names', () => {
  assert.ok(RESPONSE_TEMPLATE.startsWith('{'));
  assert.ok(RESPONSE_TEMPLATE.includes('"probabilities": {'));
  assert.ok(CONTRACT_NOTES.includes(RESPONSE_TEMPLATE));
});

test('mutation: a schema leaf without a placeholder throws (nested field addition is caught)', () => {
  // Simulate the review's mutation: a new nested field under probabilities.
  const mutated = z
    .object({
      probabilities: z
        .object({ win: z.number(), calibrationNote: z.number().optional() })
        .strict(),
    })
    .strict();
  assert.ok(schemaLeafPaths(mutated).includes('probabilities.calibrationNote'));
  assert.throws(
    () => renderResponseTemplate(mutated, { 'probabilities.win': '<0..1>' }),
    /no placeholder for schema field "probabilities\.calibrationNote"/,
  );
});

test('mutation: a placeholder naming a nonexistent schema field throws', () => {
  assert.throws(
    () =>
      renderResponseTemplate(benchmarkResponseSchema, {
        ...TEMPLATE_PLACEHOLDERS,
        'games[].forecasts[].probabilities.calibrationNote': '<x>',
      }),
    /do not exist/,
  );
});

test('mutation: removing a nested placeholder throws (missing probabilities.win)', () => {
  const incomplete: Record<string, string> = { ...TEMPLATE_PLACEHOLDERS };
  delete incomplete['games[].forecasts[].probabilities.win'];
  assert.throws(
    () => renderResponseTemplate(benchmarkResponseSchema, incomplete),
    /probabilities\.win/,
  );
});

test('shape sensitivity: probabilities as an array yields different leaf paths than the object', () => {
  const asArray = z.object({ probabilities: z.array(z.number()) }).strict();
  assert.deepEqual(schemaLeafPaths(asArray), ['probabilities[]']);
  const asObject = z
    .object({ probabilities: z.object({ win: z.number() }).strict() })
    .strict();
  assert.deepEqual(schemaLeafPaths(asObject), ['probabilities.win']);
});

test('the system prompt stays verbatim — the template lives in the harness scaffold only', () => {
  assert.ok(
    SYSTEM_PROMPT.startsWith(
      'You are one participant in a preregistered sports-market decision benchmark running through Ospex.',
    ),
  );
  assert.ok(
    SYSTEM_PROMPT.endsWith(
      'If required information is missing or contradictory, record the supplied reason code rather than inventing facts.',
    ),
  );
});

test('the system prompt is byte-identical to the contract doc — the doc IS the contract, not a paraphrase of it', () => {
  // prompt.ts declares docs/BENCHMARK_PROMPT_V0.md the contract. Until now that
  // was prose: only the first and last sentences were checked, so the entire
  // middle of the prompt could drift from the doc silently.
  const doc = readFileSync(new URL('../docs/BENCHMARK_PROMPT_V0.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const match = doc.match(/## System prompt draft\n\n```text\n([\s\S]*?)\n```/);
  assert.ok(match, 'the contract doc must carry a "System prompt draft" text block');
  assert.equal(match[1], SYSTEM_PROMPT.replace(/\r\n/g, '\n'));
});

test('the superseded pre-axes prompt is retained in the doc, and is NOT the live prompt', () => {
  // Archived runs (prompt scaffold below v0.4, response schema v1) were produced
  // under the earlier text; keeping it lets those artifacts stay interpretable.
  const doc = readFileSync(new URL('../docs/BENCHMARK_PROMPT_V0.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const appendix = doc.match(/## Appendix: superseded pre-axes system prompt[^\n]*\n\n[\s\S]*?```text\n([\s\S]*?)\n```/);
  assert.ok(appendix, 'the superseded prompt must remain in the doc');
  const superseded = appendix[1] ?? '';
  assert.ok(superseded.includes('Do not use memory of later events, external browsing, native provider search'));
  assert.notEqual(superseded, SYSTEM_PROMPT.replace(/\r\n/g, '\n'));
});

test('the live prompt asks for exactly what the validator enforces: the five axes, one primary driver, and search-aware grounding', () => {
  // Cheap coupling check between the prompt text and the schema's own vocabulary
  // — a renamed axis in one place and not the other fails here.
  for (const axis of AXIS_NAMES) {
    assert.ok(SYSTEM_PROMPT.includes(axis), `the prompt must name the "${axis}" axis`);
    assert.ok(CONTRACT_NOTES.includes(axis), `the contract notes must name the "${axis}" axis`);
  }
  assert.ok(/Rate each axis 1 to 5/.test(SYSTEM_PROMPT));
  assert.ok(/If every axis is 1, name no primary driver/.test(SYSTEM_PROMPT));
  // The prompt permits (and the validator now accepts) a rationale that rests on
  // a performed search rather than a bundle ref.
  assert.ok(/where it rests on outside reasoning or a search you performed/.test(SYSTEM_PROMPT));
  assert.ok(/leave this array empty rather than citing a ref that does not support it/.test(CONTRACT_NOTES));
});
