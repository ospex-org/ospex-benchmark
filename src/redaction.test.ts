import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactAndTruncate } from './config.js';

const SECRET = 'boundary-secret-abcdefgh12345678';

function withSecretEnv(fn: () => void): void {
  const original = process.env['OPENAI_API_KEY'];
  process.env['OPENAI_API_KEY'] = SECRET;
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = original;
    }
  }
}

test('redaction precedes truncation: a credential straddling each truncation boundary never leaks a prefix', () => {
  withSecretEnv(() => {
    // The exact limits used by the harness: preflight text (120), non-JSON
    // body and fetcher errors (500), provider HTTP error bodies (2000).
    for (const limit of [120, 500, 2000]) {
      // The credential starts 8 characters before the boundary, so naive
      // truncate-then-redact would leave an unrecognizable 8-char prefix.
      const text = 'a'.repeat(limit - 8) + SECRET + ' trailing content';
      const out = redactAndTruncate(text, limit);
      assert.ok(out.length <= limit);
      assert.ok(!out.includes(SECRET));
      // No recognizable fragment of the credential survives either.
      assert.ok(!out.includes(SECRET.slice(0, 10)));
      // The redaction marker is present (possibly clipped by the limit).
      assert.ok(out.includes('[REDACT'));
    }
  });
});

test('a credential fully inside the limit is replaced with the intact marker', () => {
  withSecretEnv(() => {
    const out = redactAndTruncate(`prefix ${SECRET} suffix`, 500);
    assert.equal(out, 'prefix [REDACTED] suffix');
  });
});

test('text without secrets is truncated verbatim', () => {
  withSecretEnv(() => {
    assert.equal(redactAndTruncate('plain body content', 5), 'plain');
  });
});
