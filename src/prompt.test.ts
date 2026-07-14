import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import {
  buildContractNotes,
  RESPONSE_TEMPLATE,
  SYSTEM_PROMPT,
  TEMPLATE_PLACEHOLDERS,
} from './prompt.js';
import {
  benchmarkResponseSchema,
  renderResponseTemplate,
  schemaLeafPaths,
} from './schema.js';

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
  // The contract notes are rendered per market set; the enabled MLB set carries
  // the template verbatim and names exactly the two dispatched markets.
  const notes = buildContractNotes(['moneyline', 'total']);
  assert.ok(notes.includes(RESPONSE_TEMPLATE));
  assert.ok(notes.includes('exactly 2 forecasts'));
  assert.ok(!notes.includes('"spread"'));
});

test('contract notes name exactly the supplied markets (scoped vs full board)', () => {
  const mlOnly = buildContractNotes(['moneyline']);
  assert.ok(mlOnly.includes('exactly 1 forecast'));
  assert.ok(!mlOnly.includes('"total"'));
  const full = buildContractNotes(['moneyline', 'spread', 'total']);
  assert.ok(full.includes('exactly 3 forecasts'));
  assert.ok(full.includes('"spread"'));
  // The run line is present but explicitly not executed.
  assert.ok(full.includes('false on the spread forecast'));
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
