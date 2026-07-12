import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_NOTES, SYSTEM_PROMPT } from './prompt.js';
import { RESPONSE_FIELD_NAMES } from './schema.js';

/**
 * Guards the prompt/validator contract alignment. The first live run failed
 * 60/60 arm-games because the scaffold never named "confidence" or
 * "wouldAbstain" — four labs, four invented field names. The field list here
 * is DERIVED from the live zod shapes, so a schema field added without
 * updating the scaffold fails this test.
 */

test('every validator-enforced field name appears verbatim in the contract scaffold', () => {
  const allFields = [
    ...RESPONSE_FIELD_NAMES.root,
    ...RESPONSE_FIELD_NAMES.game,
    ...RESPONSE_FIELD_NAMES.forecast,
  ];
  assert.ok(allFields.includes('confidence'));
  assert.ok(allFields.includes('wouldAbstain'));
  for (const field of allFields) {
    assert.ok(
      CONTRACT_NOTES.includes(`"${field}"`),
      `contract scaffold must name the field "${field}" explicitly`,
    );
  }
});

test('the system prompt stays verbatim — the template lives in the harness scaffold only', () => {
  // The system prompt is the methodology doc's text and must not absorb
  // harness details; spot-check its first and last sentences are intact.
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
