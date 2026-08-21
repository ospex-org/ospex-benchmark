import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256Hex, canonicalize } from '../canonical.js';
import { writeNdjson } from '../records.js';
import { ProviderUnfinishedTurnError } from './errors.js';
import { createRealAdapters } from './index.js';
import {
  ENVELOPE_VIOLATION,
  envelopeVerificationFailures,
  sealResponseEnvelope,
} from './responseEnvelope.js';
import type { ChatTurn, ProviderAdapter, ProviderResponse } from '../types.js';

/**
 * RETENTION of the complete provider response body (#92), at the two layers
 * that decide whether it is worth anything: the seal itself, and the four arms
 * that produce an attempt.
 *
 * The seal's two properties are the ones the issue turns on — the stored body
 * is the received bytes rather than a re-serialization of their parse, and the
 * digest covers exactly the string that is stored. Both are tested with
 * fixtures chosen so a wrong implementation cannot pass: see NON_CANONICAL_BODY
 * and the credential case.
 *
 * The adapter layer is exercised through the PRODUCTION registry with a
 * controlled `globalThis.fetch`, mirroring `cannedHttp.test.ts`, so what is
 * asserted is the body a real adapter would retain and not a re-derivation of
 * it. No network is reachable and every credential is synthetic.
 */

const TURNS: ChatTurn[] = [
  { role: 'system', content: 'system prompt' },
  { role: 'user', content: 'user prompt' },
];

const SYNTHETIC_KEY = 'synthetic-test-credential';

/**
 * A body no plausible normalization leaves alone. Every one of these is a
 * detail a canonicalizer would erase, and each dies under a DIFFERENT
 * normalization, so the fixture discriminates byte fidelity from all of them:
 *
 *   - two-space indentation and newlines (any re-serialization drops them);
 *   - `modelVersion` before `candidates`, i.e. NOT alphabetical (a key-sorting
 *     canonicalizer reorders them);
 *   - `1.50`, which a JSON round trip rewrites as `1.5`;
 *   - `é` written as an ESCAPE, which a round trip rewrites as the literal
 *     character;
 *   - a LITERAL multibyte character elsewhere, so the byte count and the
 *     character count of this body disagree.
 *
 * The assertions below state each of those disagreements before relying on
 * them, so an edit that quietly makes the fixture canonical fails here rather
 * than silently un-discriminating every test that uses it.
 */
const NON_CANONICAL_BODY = [
  '{',
  '  "modelVersion": "gemini-fixture-001",',
  '  "candidates": [ { "finishReason": "STOP" } ],',
  '  "amount": 1.50,',
  '  "escaped": "caf\\u00e9",',
  '  "literal": "Montréal"',
  '}',
].join('\n');

test('the fixture body disagrees with every normalization the seal must not apply', () => {
  const roundTripped = JSON.stringify(JSON.parse(NON_CANONICAL_BODY));
  assert.notEqual(
    NON_CANONICAL_BODY,
    roundTripped,
    'a body equal to its own JSON round trip cannot tell byte retention from re-serialization',
  );
  assert.notEqual(
    NON_CANONICAL_BODY,
    canonicalize(JSON.parse(NON_CANONICAL_BODY)),
    'a body equal to its own canonical form cannot tell byte retention from canonicalization',
  );
  assert.notEqual(
    Buffer.byteLength(NON_CANONICAL_BODY, 'utf8'),
    NON_CANONICAL_BODY.length,
    'a pure-ASCII body cannot tell a byte count from a character count',
  );
});

test('sealResponseEnvelope retains the received bytes, not a re-serialization of them', () => {
  const sealed = sealResponseEnvelope(NON_CANONICAL_BODY);
  assert.equal(sealed.body, NON_CANONICAL_BODY);
  // Named individually so a failure says WHICH normalization crept in.
  assert.ok(sealed.body.includes('\n  "modelVersion"'), 'indentation and key order survive');
  assert.ok(sealed.body.includes('"amount": 1.50'), 'number formatting survives');
  assert.ok(sealed.body.includes('caf\\u00e9'), 'the escape survives as an escape');
});

test('the digest and byte count cover exactly the stored body', () => {
  const sealed = sealResponseEnvelope(NON_CANONICAL_BODY);
  assert.equal(sealed.sha256, sha256Hex(sealed.body));
  assert.equal(sealed.bytes, Buffer.byteLength(sealed.body, 'utf8'));
  assert.notEqual(sealed.bytes, sealed.body.length, 'bytes are not characters');
  assert.deepEqual(envelopeVerificationFailures(sealed), []);
});

test('sealing an already-sealed body changes nothing — WITH a credential set', () => {
  // Rule 4b: the environment is part of the space. With no credential present
  // `redactSecrets` is the identity, so a credential-free version of this case
  // asserts seal(x) === seal(x) and a seal that mangles its own output passes
  // it. And credential-free is the state `yarn test` is ALWAYS in — only the
  // entry points load `.env` — while the runs this claim is about (`yarn smoke`)
  // are always the other one. So the credential goes in here explicitly.
  const prior = process.env['OPENAI_API_KEY'];
  process.env['OPENAI_API_KEY'] = SYNTHETIC_KEY;
  try {
    const received = `{"note":"upstream echoed ${SYNTHETIC_KEY} back","ok":true}`;
    const once = sealResponseEnvelope(received);
    assert.ok(once.body.includes('[REDACTED]'), 'the first seal really did substitute something');
    const twice = sealResponseEnvelope(once.body);
    assert.deepEqual(twice, once);
  } finally {
    if (prior === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = prior;
  }
});

test('the write chokepoint redacts a second time and the binding still holds', () => {
  // The property that actually fires on the way to disk, and the reason the
  // one above is stated at all: `writeNdjson` runs `redactSecrets` over EVERY
  // serialized line, so the stored body meets the redactor again AFTER its
  // digest was taken. Because the seal redacted first there is nothing left to
  // substitute, and the body read back off disk still reproduces its digest.
  //
  // Driven through the real writer and a real file rather than through
  // `redactSecrets` directly — the claim is about the artifact, not the helper.
  const prior = process.env['OPENAI_API_KEY'];
  process.env['OPENAI_API_KEY'] = SYNTHETIC_KEY;
  const dir = mkdtempSync(join(tmpdir(), 'envelope-write-'));
  try {
    const received = `{"note":"upstream echoed ${SYNTHETIC_KEY} back","ok":true}`;
    const sealed = sealResponseEnvelope(received);
    const path = join(dir, 'run.ndjson');
    writeNdjson(path, [{ recordType: 'probe', responseEnvelope: sealed } as never]);
    const onDisk = readFileSync(path, 'utf8');
    assert.ok(!onDisk.includes(SYNTHETIC_KEY), 'the credential is not on disk');
    const readBack = (JSON.parse(onDisk.trim()) as { responseEnvelope: typeof sealed }).responseEnvelope;
    assert.deepEqual(readBack, sealed, 'the write pass left the envelope byte-identical');
    assert.deepEqual(envelopeVerificationFailures(readBack), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (prior === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = prior;
  }
});

/**
 * The credential case, and the ONLY case in this file that discriminates
 * "digest the stored body" from "digest the received text": with no credential
 * set, redaction is the identity and the two are the same string. A mutant
 * that hashes before redacting survives every other assertion here.
 */
test('a credential echoed in the body is redacted, and the digest covers the redacted body', () => {
  const prior = process.env['ANTHROPIC_API_KEY'];
  process.env['ANTHROPIC_API_KEY'] = SYNTHETIC_KEY;
  try {
    const received = `{"note":"upstream echoed ${SYNTHETIC_KEY} back","ok":true}`;
    const sealed = sealResponseEnvelope(received);
    assert.ok(!sealed.body.includes(SYNTHETIC_KEY), 'the credential value is gone from the body');
    assert.ok(sealed.body.includes('[REDACTED]'), 'and it was replaced rather than dropped silently');
    assert.equal(sealed.sha256, sha256Hex(sealed.body), 'the digest covers what is stored');
    assert.notEqual(
      sealed.sha256,
      sha256Hex(received),
      'and NOT the pre-redaction text, which no artifact contains',
    );
    assert.equal(sealed.bytes, Buffer.byteLength(sealed.body, 'utf8'));
    assert.deepEqual(envelopeVerificationFailures(sealed), []);
  } finally {
    if (prior === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = prior;
  }
});

test('a same-length edit to a retained body fails the digest', () => {
  const sealed = sealResponseEnvelope(NON_CANONICAL_BODY);
  // Same length, so the byte-count binding still holds and the DIGEST is the
  // only thing that can catch it — the discrimination this case exists for.
  const tampered = { ...sealed, body: sealed.body.replace('"finishReason": "STOP"', '"finishReason": "PSOT"') };
  assert.equal(tampered.body.length, sealed.body.length);
  assert.deepEqual(envelopeVerificationFailures(tampered), [ENVELOPE_VIOLATION.DIGEST]);
});

test('a truncated retained body fails both bindings', () => {
  const sealed = sealResponseEnvelope(NON_CANONICAL_BODY);
  const truncated = { ...sealed, body: sealed.body.slice(0, 20) };
  assert.deepEqual(envelopeVerificationFailures(truncated), [
    ENVELOPE_VIOLATION.DIGEST,
    ENVELOPE_VIOLATION.BYTES,
  ]);
});

// ---------------------------------------------------------------------------
// the four arms that produce an attempt
// ---------------------------------------------------------------------------

interface RecordedCall {
  headers: Record<string, string>;
}

function registryAdapter(participantId: string): ProviderAdapter {
  const adapter = createRealAdapters().get(participantId);
  if (adapter === undefined) throw new Error(`production registry has no adapter for ${participantId}`);
  return adapter;
}

/** Serve `bodyText` VERBATIM (never a re-stringified object), record every
 *  call's headers, and always restore `globalThis.fetch`. */
async function withCannedBody<T>(
  bodyText: string,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: RecordedCall[] }> {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    calls.push({ headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(bodyText, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}

/** A finished-turn body for each provider, written NON-canonically (leading
 *  newline, two-space indent) so "the exact bytes" is a checkable claim. */
const FINISHED_BODY: Record<string, { env: string; participantId: string; body: string }> = {
  openai: {
    env: 'OPENAI_API_KEY',
    participantId: 'openai-gpt-5.6-sol',
    body: '{\n  "id": "resp_fixture",\n  "model": "gpt-fixture",\n  "status": "completed",\n  "output": [ { "type": "message", "content": [ { "type": "output_text", "text": "answer-openai" } ] } ]\n}',
  },
  xai: {
    env: 'XAI_API_KEY',
    participantId: 'xai-grok-4.5',
    body: '{\n  "id": "resp_fixture_x",\n  "model": "grok-fixture",\n  "status": "completed",\n  "output": [ { "type": "message", "content": [ { "type": "output_text", "text": "answer-xai" } ] } ]\n}',
  },
  anthropic: {
    env: 'ANTHROPIC_API_KEY',
    participantId: 'anthropic-claude-fable-5',
    body: '{\n  "id": "msg_fixture",\n  "model": "claude-fixture",\n  "stop_reason": "end_turn",\n  "content": [ { "type": "text", "text": "answer-anthropic" } ]\n}',
  },
  google: {
    env: 'GEMINI_API_KEY',
    participantId: 'google-gemini-3.1-pro-preview',
    body: '{\n  "responseId": "resp_fixture_g",\n  "modelVersion": "gemini-fixture",\n  "candidates": [ { "finishReason": "STOP", "content": { "parts": [ { "text": "answer-google" } ] } } ]\n}',
  },
};

for (const [provider, fixture] of Object.entries(FINISHED_BODY)) {
  test(`${provider}: a finished turn retains the exact received body`, async () => {
    const { result, calls } = await withEnv(fixture.env, SYNTHETIC_KEY, () =>
      withCannedBody(fixture.body, () =>
        registryAdapter(fixture.participantId).chat(TURNS, 5_000, { maxOutputTokens: 16_000 }),
      ),
    );
    const response = result as ProviderResponse;
    assert.equal(response.responseEnvelope.body, fixture.body, 'the received bytes, unaltered');
    assert.equal(response.responseEnvelope.sha256, sha256Hex(fixture.body));
    assert.equal(response.responseEnvelope.bytes, Buffer.byteLength(fixture.body, 'utf8'));
    // The answer text and the envelope are DIFFERENT values, so a serializer
    // that swaps them cannot pass unnoticed downstream.
    assert.notEqual(response.rawText, response.responseEnvelope.body);
    assert.ok(response.responseEnvelope.body.includes(response.rawText));

    // Credentials travel in headers and are never named in evidence. Assert on
    // BOTH sides: the header really carried the key (so the case is not vacuous
    // for the wrong reason), and no recorded field mentions it.
    const sentHeaders = JSON.stringify(calls[0]?.headers ?? {});
    assert.ok(sentHeaders.includes(SYNTHETIC_KEY), 'the call really did authenticate');
    const recorded = JSON.stringify({
      envelope: response.responseEnvelope,
      requestParams: response.requestParams,
      rawText: response.rawText,
    });
    assert.ok(!recorded.includes(SYNTHETIC_KEY), 'and no recorded field carries the credential');
    for (const headerName of ['authorization', 'x-api-key', 'x-goog-api-key']) {
      assert.ok(!recorded.toLowerCase().includes(headerName), `no ${headerName} header in evidence`);
    }
  });
}

test('an UNFINISHED turn carries the complete body too — it is a paid response', async () => {
  // Google `MAX_TOKENS`: HTTP 200, partial content, typed as an unfinished
  // turn. Grounding metadata is present, so the case also shows the envelope
  // arriving on the path where an unrecognized shape is most likely.
  const body =
    '{\n  "responseId": "resp_unfinished",\n  "modelVersion": "gemini-fixture",\n  "candidates": [ { "finishReason": "MAX_TOKENS", "content": { "parts": [ { "text": "partial" } ] }, "groundingMetadata": { "webSearchQueries": [ "yankees starter tonight" ] } } ],\n  "usageMetadata": { "toolUsePromptTokenCount": 42 }\n}';
  const error = await withEnv('GEMINI_API_KEY', SYNTHETIC_KEY, async () => {
    const { result } = await withCannedBody(body, async () => {
      try {
        await registryAdapter('google-gemini-3.1-pro-preview').chat(TURNS, 5_000, {
          maxOutputTokens: 16_000,
        });
        return null;
      } catch (caught: unknown) {
        return caught;
      }
    });
    return result;
  });
  assert.ok(error instanceof ProviderUnfinishedTurnError, 'the turn is typed as unfinished');
  assert.equal(error.responseEnvelope.body, body);
  assert.equal(error.responseEnvelope.sha256, sha256Hex(body));
  assert.deepEqual(envelopeVerificationFailures(error.responseEnvelope), []);
});

test('a REPAIR call retains its own envelope, distinct from the initial call', async () => {
  // The repair leg sends `tools: 'none'`; it is the same adapter and the same
  // seal, and a serializer that keeps only the initial envelope would leave
  // this one unverifiable. Two DIFFERENT bodies, so the assertion cannot pass
  // by both legs happening to agree.
  const initialBody = FINISHED_BODY['anthropic']!.body;
  const repairBody = initialBody.replace('answer-anthropic', 'repaired-anthropic');
  assert.notEqual(initialBody, repairBody);
  const adapter = registryAdapter('anthropic-claude-fable-5');
  const initial = await withEnv('ANTHROPIC_API_KEY', SYNTHETIC_KEY, () =>
    withCannedBody(initialBody, () => adapter.chat(TURNS, 5_000, { maxOutputTokens: 16_000 })),
  );
  const repair = await withEnv('ANTHROPIC_API_KEY', SYNTHETIC_KEY, () =>
    withCannedBody(repairBody, () =>
      adapter.chat(TURNS, 5_000, { maxOutputTokens: 16_000, tools: 'none' }),
    ),
  );
  assert.equal(initial.result.responseEnvelope.body, initialBody);
  assert.equal(repair.result.responseEnvelope.body, repairBody);
  assert.notEqual(initial.result.responseEnvelope.sha256, repair.result.responseEnvelope.sha256);
});

test('a non-2xx body is NOT retained — that path keeps its truncated error detail', async () => {
  // Deliberately out of scope (#92 is a 200 with parseable JSON in a shape the
  // extractor does not know). A provider error body is the likeliest place
  // request content is echoed back, so widening retention to it would put an
  // unbounded copy of that into evidence.
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{"error":{"message":"quota exceeded"}}', { status: 429 })) as typeof fetch;
  try {
    const thrown = await withEnv('ANTHROPIC_API_KEY', SYNTHETIC_KEY, async () => {
      try {
        await registryAdapter('anthropic-claude-fable-5').chat(TURNS, 5_000, { maxOutputTokens: 16_000 });
        return null;
      } catch (error: unknown) {
        return error;
      }
    });
    assert.ok(thrown instanceof Error);
    assert.ok(!(thrown instanceof ProviderUnfinishedTurnError));
    assert.ok(
      !Object.prototype.hasOwnProperty.call(thrown, 'responseEnvelope'),
      'a non-2xx failure carries no envelope',
    );
    assert.ok(thrown.message.includes('quota exceeded'), 'it keeps the truncated detail it always had');
  } finally {
    globalThis.fetch = original;
  }
});
