import assert from 'node:assert/strict';
import { test } from 'node:test';
import { printError, printLine } from './console.js';

test('captured console output is redacted — a credential in a provider-derived line never prints', () => {
  const secret = 'stub-console-secret-abcdef123456';
  const original = process.env['OPENAI_API_KEY'];
  process.env['OPENAI_API_KEY'] = secret;
  const originalLog = console.log;
  const originalError = console.error;
  const captured: string[] = [];
  console.log = (message?: unknown) => {
    captured.push(String(message));
  };
  console.error = (message?: unknown) => {
    captured.push(String(message));
  };
  try {
    printLine(`  reported model: ${secret}`);
    printLine(`  response id: ${secret}`);
    printError(`  MODEL_IDENTITY: arm reported unapproved model ID "${secret}"`);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (original === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = original;
    }
  }
  assert.equal(captured.length, 3);
  for (const line of captured) {
    assert.ok(!line.includes(secret));
    assert.ok(line.includes('[REDACTED]'));
  }
});
