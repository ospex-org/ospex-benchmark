import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveComparableUsage } from './comparableUsage.js';

/**
 * The cross-provider derived fields, swept as a matrix per provider and wire
 * shape. The invariant under test: `billableOutputTokens` includes reasoning
 * under each provider's OWN semantics (subset for openai/anthropic, additive
 * for google/xai), and every underivable case is `null` — never a fabricated
 * zero (the false-zero rule).
 */

test('openai: reasoning is a SUBSET on both wire shapes — billable output equals the output total, never output + reasoning', () => {
  // Chat-completions shape (legacy records).
  assert.deepEqual(
    deriveComparableUsage('openai', {
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      completion_tokens_details: { reasoning_tokens: 16 },
    }),
    { reasoningTokens: 16, billableOutputTokens: 40 },
  );
  // Responses-API shape (the live adapter).
  assert.deepEqual(
    deriveComparableUsage('openai', {
      input_tokens: 100,
      output_tokens: 40,
      total_tokens: 140,
      output_tokens_details: { reasoning_tokens: 16 },
    }),
    { reasoningTokens: 16, billableOutputTokens: 40 },
  );
  // No reasoning detail: the billable total is still the output total; the
  // reasoning field is null, not zero.
  assert.deepEqual(
    deriveComparableUsage('openai', { input_tokens: 100, output_tokens: 40, total_tokens: 140 }),
    { reasoningTokens: null, billableOutputTokens: 40 },
  );
});

test('anthropic: output_tokens is the inclusive billable total; thinking_tokens is a read-only subset breakdown', () => {
  assert.deepEqual(
    deriveComparableUsage('anthropic', {
      input_tokens: 80,
      output_tokens: 20,
      output_tokens_details: { thinking_tokens: 12 },
    }),
    { reasoningTokens: 12, billableOutputTokens: 20 },
  );
  assert.deepEqual(
    deriveComparableUsage('anthropic', { input_tokens: 80, output_tokens: 20 }),
    { reasoningTokens: null, billableOutputTokens: 20 },
  );
});

test('google: thoughts are ADDITIVE — billable output is candidates + thoughts', () => {
  assert.deepEqual(
    deriveComparableUsage('google', {
      promptTokenCount: 70,
      candidatesTokenCount: 10,
      thoughtsTokenCount: 900,
      totalTokenCount: 980,
    }),
    { reasoningTokens: 900, billableOutputTokens: 910 },
  );
});

test('google: an ABSENT thoughts bucket needs a corroborating total to read as zero — with or without the tool-use bucket; otherwise null, never zero', () => {
  // Corroborated (no tool use): total = prompt + candidates.
  assert.deepEqual(
    deriveComparableUsage('google', { promptTokenCount: 70, candidatesTokenCount: 10, totalTokenCount: 80 }),
    { reasoningTokens: null, billableOutputTokens: 10 },
  );
  // Corroborated including the tool-use prompt bucket.
  assert.deepEqual(
    deriveComparableUsage('google', {
      promptTokenCount: 70,
      candidatesTokenCount: 10,
      toolUsePromptTokenCount: 40,
      totalTokenCount: 120,
    }),
    { reasoningTokens: null, billableOutputTokens: 10 },
  );
  // No total at all: cannot prove thoughts were zero — null, never zero.
  assert.deepEqual(
    deriveComparableUsage('google', { promptTokenCount: 70, candidatesTokenCount: 10 }),
    { reasoningTokens: null, billableOutputTokens: null },
  );
  // A total matching neither identity: inconsistent accounting — null.
  assert.deepEqual(
    deriveComparableUsage('google', { promptTokenCount: 70, candidatesTokenCount: 10, totalTokenCount: 500 }),
    { reasoningTokens: null, billableOutputTokens: null },
  );
});

test('xai chat shape: reasoning is ADDITIVE (total = prompt + completion + reasoning)', () => {
  assert.deepEqual(
    deriveComparableUsage('xai', {
      prompt_tokens: 90,
      completion_tokens: 30,
      total_tokens: 520,
      completion_tokens_details: { reasoning_tokens: 400 },
    }),
    { reasoningTokens: 400, billableOutputTokens: 430 },
  );
});

test('xai Responses shape: additivity is decided by ARITHMETIC against the total', () => {
  // Additive identity holds → output + reasoning.
  assert.deepEqual(
    deriveComparableUsage('xai', {
      input_tokens: 90,
      output_tokens: 30,
      total_tokens: 520,
      output_tokens_details: { reasoning_tokens: 400 },
    }),
    { reasoningTokens: 400, billableOutputTokens: 430 },
  );
  // Subset identity holds (total = input + output, reasoning <= output) → output alone.
  assert.deepEqual(
    deriveComparableUsage('xai', {
      input_tokens: 90,
      output_tokens: 430,
      total_tokens: 520,
      output_tokens_details: { reasoning_tokens: 400 },
    }),
    { reasoningTokens: 400, billableOutputTokens: 430 },
  );
  // A total matching neither identity: inconsistent — null, never a guess.
  assert.deepEqual(
    deriveComparableUsage('xai', {
      input_tokens: 90,
      output_tokens: 30,
      total_tokens: 999,
      output_tokens_details: { reasoning_tokens: 400 },
    }),
    { reasoningTokens: 400, billableOutputTokens: null },
  );
  // No discriminating total: the larger (additive) reading is reported so the
  // field can only overstate, never hide reasoning spend.
  assert.deepEqual(
    deriveComparableUsage('xai', {
      input_tokens: 90,
      output_tokens: 30,
      output_tokens_details: { reasoning_tokens: 400 },
    }),
    { reasoningTokens: 400, billableOutputTokens: 430 },
  );
  // Reasoning absent: a corroborating total proves it zero; without one, null.
  assert.deepEqual(
    deriveComparableUsage('xai', { input_tokens: 90, output_tokens: 30, total_tokens: 120 }),
    { reasoningTokens: null, billableOutputTokens: 30 },
  );
  assert.deepEqual(
    deriveComparableUsage('xai', { input_tokens: 90, output_tokens: 30 }),
    { reasoningTokens: null, billableOutputTokens: null },
  );
});

test('malformed usage objects derive nothing — null across the board, never a fabricated count', () => {
  for (const raw of [null, undefined, 'usage', 42, [1, 2], { prompt_tokens: 'many' }]) {
    for (const provider of ['openai', 'anthropic', 'google', 'xai'] as const) {
      assert.deepEqual(
        deriveComparableUsage(provider, raw),
        { reasoningTokens: null, billableOutputTokens: null },
        `${provider} over ${JSON.stringify(raw) ?? 'undefined'}`,
      );
    }
  }
});
