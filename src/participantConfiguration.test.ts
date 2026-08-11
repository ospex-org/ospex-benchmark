import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { canonicalize } from './canonical.js';
import {
  applyConfiguration,
  canonicalConfigurationText,
  CONFIGURATION_DIGEST_VERSION,
  ConfigurationCollisionError,
  configurationEvidenceViolations,
  configurationLeaves,
  configurationSha256,
  configurationViolations,
  EMPTY_CONFIGURATION_SHA256,
  MAX_CONFIGURATION_CANONICAL_BYTES,
  MAX_ENTRANT_IDENTIFIER_BYTES,
} from './participantConfiguration.js';
import type { ParticipantConfiguration } from './participantConfiguration.js';

// ---------------------------------------------------------------------------
// RFC 8785 (JCS) agreement
// ---------------------------------------------------------------------------

/**
 * `configuration_digest_version = 1` on the serving table names RFC 8785, and
 * the digest is taken over `canonicalize()`. That module was written for
 * bundle hashing and makes no JCS claim, so the agreement is MEASURED here and
 * pinned: this table is what goes red if either side moves. It is a
 * differential against hand-written expected bytes rather than against a
 * second implementation, because a second implementation of the same mistake
 * agrees with the first.
 */
const JCS: Array<[string, unknown, string]> = [
  ['key sort', { b: 2, a: 1 }, '{"a":1,"b":2}'],
  ['multibyte key sorts after ASCII', { 'ä': 1, a: 2 }, '{"a":2,"ä":1}'],
  ['currency signs', { '€': 1, $: 2, '¢': 3 }, '{"$":2,"¢":3,"€":1}'],
  // THE case that is easy to get wrong, and did get "corrected" into a bug
  // once: JCS sorts by UTF-16 CODE UNITS, not code points. U+1F600 is the
  // surrogate pair D83D DE00, and 0xD83D < 0xFFFF, so the emoji sorts BEFORE
  // U+FFFF — the opposite of code-point order. JS string `<` is already
  // code-unit order, so deriving the expectation by code point is what turns a
  // correct implementation into a reported defect.
  ['astral key sorts by code UNIT', { '\u{1F600}': 1, '￿': 2 }, '{"\u{1F600}":1,"￿":2}'],
  ['1e30', { a: 1e30 }, '{"a":1e+30}'],
  ['1e21', { a: 1e21 }, '{"a":1e+21}'],
  ['1e-7', { a: 1e-7 }, '{"a":1e-7}'],
  ['0.1', { a: 0.1 }, '{"a":0.1}'],
  ['negative zero normalizes', { a: -0 }, '{"a":0}'],
  ['1.0 is 1', { a: 1.0 }, '{"a":1}'],
  ['double rounding', { a: 333333333.33333329 }, '{"a":333333333.3333333}'],
  ['max safe integer', { a: Number.MAX_SAFE_INTEGER }, '{"a":9007199254740991}'],
  ['quote and backslash', { a: 'x"y\\z' }, '{"a":"x\\"y\\\\z"}'],
  // Built from char codes rather than written literally: a raw NUL in a source
  // file makes git treat the whole file as binary, and the Read tool renders it
  // as a space, so it is invisible right up until the diff says `Bin`.
  ['control characters', { a: `${String.fromCharCode(0)}${String.fromCharCode(31)}` }, '{"a":"\\u0000\\u001f"}'],
  ['short escapes', { a: '\n\t\r\b\f' }, '{"a":"\\n\\t\\r\\b\\f"}'],
  ['non-ASCII is not escaped', { a: 'é😀' }, '{"a":"é😀"}'],
  ['array order is preserved', { a: [3, 1, 2] }, '{"a":[3,1,2]}'],
  ['nested objects sort too', { a: { d: 1, c: 2 } }, '{"a":{"c":2,"d":1}}'],
  ['literals', { a: null, b: true, c: false }, '{"a":null,"b":true,"c":false}'],
  ['empty object', {}, '{}'],
  ['empty nested object', { a: {} }, '{"a":{}}'],
  ['empty array', { a: [] }, '{"a":[]}'],
  ['a real effort knob', { reasoning_effort: 'high' }, '{"reasoning_effort":"high"}'],
  [
    'a real thinking block',
    { thinking: { type: 'enabled', budget_tokens: 8000 } },
    '{"thinking":{"budget_tokens":8000,"type":"enabled"}}',
  ],
  ['sampling knobs', { temperature: 0.7, top_p: 0.95 }, '{"temperature":0.7,"top_p":0.95}'],
];

for (const [label, input, expected] of JCS) {
  test(`canonicalize agrees with RFC 8785: ${label}`, () => {
    assert.equal(canonicalize(input), expected);
  });
}

test('the digest is the SHA-256 of the canonical bytes, and nothing else', () => {
  const configuration = { thinking: { type: 'enabled', budget_tokens: 8000 } };
  const text = canonicalConfigurationText(configuration);
  assert.equal(text, '{"thinking":{"budget_tokens":8000,"type":"enabled"}}');
  assert.equal(
    configurationSha256(configuration),
    createHash('sha256').update(text, 'utf8').digest('hex'),
  );
});

test('the digest is independent of source key order', () => {
  assert.equal(
    configurationSha256({ b: 1, a: { d: 2, c: 3 } }),
    configurationSha256({ a: { c: 3, d: 2 }, b: 1 }),
  );
});

test('the empty configuration digest is the published constant', () => {
  assert.equal(configurationSha256({}), EMPTY_CONFIGURATION_SHA256);
  assert.equal(CONFIGURATION_DIGEST_VERSION, 1);
});

test('a configuration survives a JSON round trip byte-identically', () => {
  // The publisher stores the canonical TEXT as a jsonb parameter and the
  // database re-renders it. If canonicalizing a parsed canonical form ever
  // differed from the original, a stored row could not be recomputed from the
  // artifact, which is the whole contract of publishing the digest.
  for (const [, input] of JCS) {
    const once = canonicalize(input);
    assert.equal(canonicalize(JSON.parse(once) as unknown), once);
  }
});

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

test('a non-object is refused, and says what it got', () => {
  assert.match(configurationViolations([])[0] ?? '', /must be a JSON object \(got array\)/);
  assert.match(configurationViolations(null)[0] ?? '', /got null/);
  assert.match(configurationViolations('x')[0] ?? '', /got string/);
  assert.deepEqual(configurationViolations({}), []);
});

test('a value canonicalize would throw on is refused at validation instead', () => {
  // Refusing here costs a rejected roster; reaching canonicalize costs a throw
  // inside cohortId at boot, from a stack that does not name the field.
  assert.match(configurationViolations({ a: Number.NaN })[0] ?? '', /non-finite/);
  assert.match(configurationViolations({ a: [1, Infinity] })[0] ?? '', /configuration\.a\.1/);
  assert.match(configurationViolations({ a: { b: () => 1 } })[0] ?? '', /not representable in JSON/);
  assert.match(configurationViolations({ a: new Date(0) })[0] ?? '', /class instance/);
});

test('__proto__ is refused as a key', () => {
  const hostile = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
  assert.match(configurationViolations(hostile)[0] ?? '', /reserved key "__proto__"/);
});

test('the size ceiling is in BYTES, not characters', () => {
  // The defect this pins: a bound written with `.length` accepts a multibyte
  // value well over the byte limit. Each character here is 3 bytes in UTF-8
  // and 1 JavaScript character.
  //
  // The COUNT is what makes this discriminating, and the first version of this
  // test got it wrong: at `repeat(512)` the canonical form is 520 characters
  // and 1544 bytes, so a character-counting bound refuses it too and the test
  // passes either way. A mutation battery caught that. 300 characters is
  // inside the ceiling by every character measure (308) and far outside it by
  // every byte measure (908), so ONLY a byte-counting bound refuses it.
  const multibyte = '一'.repeat(300);
  const canonical = canonicalize({ k: multibyte });
  assert.ok(
    canonical.length <= MAX_CONFIGURATION_CANONICAL_BYTES,
    `the fixture must be ACCEPTED by a character count (${canonical.length}), or it does not discriminate`,
  );
  assert.ok(
    Buffer.byteLength(canonical, 'utf8') > MAX_CONFIGURATION_CANONICAL_BYTES,
    'and refused by a byte count',
  );
  const violations = configurationViolations({ k: multibyte });
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? '', /canonical bytes, over the/);
});

test('the size ceiling is exact at the boundary', () => {
  // Padded with hash output rather than a repeated character. The database
  // limit this proxies for is applied AFTER compression, so a bound calibrated
  // on filler is calibrated on the one input that cannot measure it.
  const incompressible = (bytes: number): string => {
    let out = '';
    let seed = 0;
    while (out.length < bytes) {
      out += createHash('sha256').update(String(seed)).digest('hex');
      seed += 1;
    }
    return out.slice(0, bytes);
  };
  // {"k":"<pad>"} is 8 characters of envelope, all single-byte and unescaped.
  const envelope = Buffer.byteLength(canonicalize({ k: '' }), 'utf8');
  const atLimit = { k: incompressible(MAX_CONFIGURATION_CANONICAL_BYTES - envelope) };
  assert.equal(
    Buffer.byteLength(canonicalize(atLimit), 'utf8'),
    MAX_CONFIGURATION_CANONICAL_BYTES,
    'the fixture must sit exactly ON the boundary, or it tests the wrong side of it',
  );
  assert.deepEqual(configurationViolations(atLimit), []);

  const overLimit = { k: incompressible(MAX_CONFIGURATION_CANONICAL_BYTES - envelope + 1) };
  assert.equal(configurationViolations(overLimit).length, 1);
});

test('the identifier ceiling counts the lab and the model together', () => {
  const half = 'x'.repeat(MAX_ENTRANT_IDENTIFIER_BYTES / 2);
  assert.deepEqual(configurationViolations({}, { labId: half, modelId: half }), []);
  const violations = configurationViolations({}, { labId: half, modelId: half + 'x' });
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? '', /identifiers are \d+ bytes together/);
});

// ---------------------------------------------------------------------------
// The add-only merge
// ---------------------------------------------------------------------------

test('a configuration adds to a request body', () => {
  const body = { model: 'm', input: [] };
  const merged = applyConfiguration(body, { reasoning: { effort: 'high' } });
  assert.deepEqual(merged, { model: 'm', input: [], reasoning: { effort: 'high' } });
});

test('an empty configuration leaves the body byte-identical', () => {
  const body = { model: 'm', max_tokens: 16000, tools: [{ type: 'web_search' }] };
  assert.equal(canonicalize(applyConfiguration(body, {})), canonicalize(body));
});

test('a configuration may NOT override what the cohort already set', () => {
  const body = { model: 'm', max_tokens: 16000 };
  for (const hostile of [{ model: 'other' }, { max_tokens: 999_999 }] as ParticipantConfiguration[]) {
    assert.throws(
      () => applyConfiguration(body, hostile),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationCollisionError);
        assert.equal(error.path, Object.keys(hostile)[0]);
        return true;
      },
    );
  }
});

test('objects merge member by member, and only the colliding LEAF is refused', () => {
  const body = { generationConfig: { maxOutputTokens: 16000 } };
  assert.deepEqual(applyConfiguration(body, { generationConfig: { thinkingConfig: { budget: 1 } } }), {
    generationConfig: { maxOutputTokens: 16000, thinkingConfig: { budget: 1 } },
  });
  assert.throws(
    () => applyConfiguration(body, { generationConfig: { maxOutputTokens: 1 } }),
    (error: unknown) => (error as ConfigurationCollisionError).path === 'generationConfig.maxOutputTokens',
  );
});

test('an array is a leaf: it may be added but never merged into', () => {
  assert.deepEqual(applyConfiguration({ model: 'm' }, { stop: ['x'] }), { model: 'm', stop: ['x'] });
  assert.throws(
    () => applyConfiguration({ tools: [{ type: 'web_search' }] }, { tools: [] }),
    ConfigurationCollisionError,
  );
});

test('a type change is a collision, in both directions', () => {
  assert.throws(() => applyConfiguration({ a: { b: 1 } }, { a: 1 }), ConfigurationCollisionError);
  assert.throws(() => applyConfiguration({ a: 1 }, { a: { b: 1 } }), ConfigurationCollisionError);
});

test('__proto__ cannot be merged even if validation was skipped', () => {
  const hostile = JSON.parse('{"__proto__": {"polluted": true}}') as ParticipantConfiguration;
  assert.throws(() => applyConfiguration({ model: 'm' }, hostile), ConfigurationCollisionError);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('the merge mutates neither input, and a frozen configuration is safe', () => {
  const body = { model: 'm', generationConfig: { maxOutputTokens: 1 } };
  const configuration = Object.freeze({
    generationConfig: Object.freeze({ thinkingConfig: Object.freeze({ budget: 1 }) }),
  }) as ParticipantConfiguration;
  const merged = applyConfiguration(body, configuration);
  assert.deepEqual(body, { model: 'm', generationConfig: { maxOutputTokens: 1 } });
  // The merged value must not SHARE structure with the frozen registry, or a
  // later write into the request would throw from a place that looks unrelated.
  const nested = (merged['generationConfig'] as Record<string, unknown>)['thinkingConfig'];
  assert.notEqual(nested, configuration['generationConfig']);
  assert.ok(!Object.isFrozen(nested));
});

// ---------------------------------------------------------------------------
// Declared versus sent
// ---------------------------------------------------------------------------

test('every leaf carries its SEGMENTS, and objects are walked', () => {
  // The joined path is for messages only. Resolution walks the segments,
  // because the empty string is a legal JSON key and a joined path cannot
  // tell `{"":{"a":1}}` from `{"a":1}` — which is exactly how those two came
  // to share a leaf set.
  assert.deepEqual(configurationLeaves({ a: 1, b: { c: 'x', d: [1, 2] } }), [
    { segments: ['a'], path: 'a', value: 1 },
    { segments: ['b', 'c'], path: 'b.c', value: 'x' },
    { segments: ['b', 'd'], path: 'b.d', value: [1, 2] },
  ]);
});

test('evidence: a configuration that went out on the wire has no violations', () => {
  const declared = { reasoning: { effort: 'high' }, top_p: 0.95 };
  const recorded = {
    endpoint: 'https://example.invalid/responses',
    model: 'm',
    reasoning: { effort: 'high' },
    top_p: 0.95,
  };
  assert.deepEqual(configurationEvidenceViolations(declared, recorded), []);
});

test('evidence: a knob the adapter DROPPED is caught', () => {
  const violations = configurationEvidenceViolations(
    { reasoning: { effort: 'high' } },
    { endpoint: 'e', model: 'm' },
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? '', /"reasoning\.effort" is absent from the recorded request/);
});

test('evidence: a knob the adapter CHANGED is caught, and names both values', () => {
  const violations = configurationEvidenceViolations(
    { reasoning: { effort: 'high' } },
    { reasoning: { effort: 'low' } },
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? '', /was recorded as "low", not "high"/);
});

test('evidence: extra recorded parameters are not violations', () => {
  // The record carries the endpoint and the cohort's own parameters too; only
  // the declared leaves are the subject.
  assert.deepEqual(
    configurationEvidenceViolations({ top_p: 0.95 }, { endpoint: 'e', model: 'm', top_p: 0.95, max_output_tokens: 16000 }),
    [],
  );
});

test('evidence: an empty configuration is vacuously satisfied — and that is why it is not the only fixture', () => {
  // Stated so the next reader does not mistake the production roster's green
  // result for coverage: with `{}` this check asserts nothing, and every real
  // assertion above uses a configuration that sets something.
  assert.deepEqual(configurationEvidenceViolations({}, {}), []);
  assert.deepEqual(configurationEvidenceViolations({}, { anything: 1 }), []);
});

test('evidence compares by canonical value, so key order in the record does not matter', () => {
  assert.deepEqual(
    configurationEvidenceViolations({ thinking: { a: 1, b: 2 } }, { thinking: { b: 2, a: 1 } }),
    [],
  );
});

test('a key containing a dot is refused — it is the message path separator', () => {
  // Resolution no longer joins or splits, so a dotted key is no longer a
  // correctness hazard; it is a DIAGNOSTIC one. The path printed in a
  // violation would read as a nesting the value does not have, and a message
  // that misdescribes what it refuses is worse than none.
  assert.match(configurationViolations({ 'a.b': 1 })[0] ?? '', /contains a dot/);
  assert.match(configurationViolations({ x: { 'a.b': 1 } })[0] ?? '', /contains a dot/);
  assert.deepEqual(configurationViolations({ a: { b: 1 } }), []);

  // And resolution now tells the two apart even though the rule refuses one:
  // belt and braces, so a bug in the rule cannot reopen the collision.
  assert.equal(configurationEvidenceViolations({ 'a.b': 1 }, { a: { b: 1 } }).length, 1);
  assert.deepEqual(configurationEvidenceViolations({ 'a.b': 1 }, { 'a.b': 1 }), []);
});

test('an EMPTY key is refused — it is the one key that can impersonate the root', () => {
  // `''` was doing double duty as the root sentinel of a joined path and as a
  // legal JSON key, so `{"":{"a":1}}` flattened to the same leaf as `{"a":1}`
  // (same evidence, different digest) and `{"":{}}` slipped past the
  // empty-object rule, making the whole member deletable from the record
  // undetected.
  for (const hostile of [{ '': 1 }, { '': { a: 1 } }, { '': {} }, { a: { '': 1 } }]) {
    assert.match(
      configurationViolations(hostile)[0] ?? '',
      /has an empty key/,
      JSON.stringify(hostile),
    );
  }
  // Negative control: a build refusing every key would satisfy that loop.
  assert.deepEqual(configurationViolations({ a: 1, b: { c: 2 } }), []);
});

test('the root sentinel is gone: resolution tells an empty key from the root', () => {
  // The rule above refuses these before they can be declared. This asserts the
  // SECOND line of defence — that the encoding itself no longer collides — so
  // a bug in the rule cannot reopen the hole.
  assert.deepEqual(configurationLeaves({ '': { a: 1 } } as ParticipantConfiguration), [
    { segments: ['', 'a'], path: '.a', value: 1 },
  ]);
  assert.deepEqual(configurationLeaves({ a: 1 }), [{ segments: ['a'], path: 'a', value: 1 }]);
  // Resolves against the request it actually describes...
  assert.deepEqual(
    configurationEvidenceViolations({ '': { a: 1 } } as ParticipantConfiguration, { '': { a: 1 } }),
    [],
  );
  // ...and refuses the flat one it does not.
  assert.equal(
    configurationEvidenceViolations({ '': { a: 1 } } as ParticipantConfiguration, { a: 1 }).length,
    1,
  );
});

test('the accepted KEY GRAMMAR flattens and resolves without collisions', () => {
  // The standing guard for the whole class, rather than one test per key that
  // has bitten so far. Every accepted key shape, at four value shapes: no two
  // distinct configurations may share a leaf set, and every leaf must resolve
  // against the request that carries it.
  const keys = [
    'k', 'K', 'a-b', 'a_b', '0', '00', 'with space', 'with\ttab', 'quote"',
    'back\\slash', 'é', 'é', '一', '\u{1F600}', '￿', 'constructor',
    'prototype', 'toString', 'hasOwnProperty', '__proto__x', 'x__proto__',
    'a.', '.a', 'null', 'true', '-1', '1e3', 'k'.repeat(64),
  ];
  const shapes: Array<(k: string) => Record<string, unknown>> = [
    (k) => ({ [k]: 1 }),
    (k) => ({ [k]: { inner: 1 } }),
    (k) => ({ outer: { [k]: 1 } }),
    (k) => ({ [k]: [1, { deep: 2 }] }),
  ];

  const byLeafSet = new Map<string, string>();
  let accepted = 0;
  for (const key of keys) {
    for (const shape of shapes) {
      const configuration = shape(key) as ParticipantConfiguration;
      if (configurationViolations(configuration).length > 0) continue;
      accepted += 1;

      // 1. The leaf set is unique to this configuration.
      //
      // The set is (segments, VALUE) pairs, sorted. Segments alone is the
      // wrong invariant and this sweep is what showed it: `{k:1}` and
      // `{k:[1,{deep:2}]}` share the path set `[["k"]]` and are legitimately
      // different entrants, because an array is a leaf. What must determine
      // the configuration is the paths together with what sits at them. Sorted
      // because key order does not move the digest and must not move this.
      const leafSet = JSON.stringify(
        configurationLeaves(configuration)
          .map((leaf) => [leaf.segments, canonicalize(leaf.value)] as const)
          .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
      );
      const prior = byLeafSet.get(leafSet);
      const digest = configurationSha256(configuration);
      if (prior !== undefined && prior !== digest) {
        assert.fail(`two configurations share a leaf set ${leafSet}: ${prior} and ${digest}`);
      }
      byLeafSet.set(leafSet, digest);

      // 2. Every leaf resolves against the request that carries it, and the
      //    configuration is NOT satisfied by a request that does not.
      assert.deepEqual(
        configurationEvidenceViolations(configuration, { endpoint: 'e', ...configuration }),
        [],
        `must resolve: ${JSON.stringify(configuration)}`,
      );
      assert.ok(
        configurationEvidenceViolations(configuration, { endpoint: 'e' }).length > 0,
        `must not be vacuous: ${JSON.stringify(configuration)}`,
      );
    }
  }
  assert.ok(accepted >= 80, `the sweep must actually accept a wide grammar, got ${accepted}`);
});

// --- review blockers: identity must determine the request -------------------

test('a nested empty object is refused; the top-level one and an empty ARRAY are not', () => {
  assert.match(
    configurationViolations({ generationConfig: {} })[0] ?? '',
    /configuration\.generationConfig is an empty object/,
  );
  assert.match(configurationViolations({ a: { b: {} } })[0] ?? '', /configuration\.a\.b is an empty object/);
  assert.match(configurationViolations({ a: {}, b: 1 })[0] ?? '', /configuration\.a is an empty object/);
  // Exemptions, each for a stated reason:
  assert.deepEqual(configurationViolations({}), [], 'the top-level {} is the real "sets no knobs" value');
  assert.deepEqual(configurationViolations({ stop: [] }), [], 'an empty ARRAY is a leaf that changes the body');
  assert.deepEqual(
    configurationViolations({ tools: [{}] }),
    [],
    'and an empty object INSIDE an array rides along on a leaf that changes the body',
  );
});

test('different digest implies different LEAF SET — identity determines the request', () => {
  // The invariant the empty-object and dotted-key rules exist to create. With
  // both refused, leaf-set and configuration are a bijection, so two entrants
  // that hash differently cannot send the same request.
  const accepted: ParticipantConfiguration[] = [
    {},
    { a: 1 },
    { a: 2 },
    { a: { b: 1 } },
    { a: { b: 2 } },
    { a: { b: 1 }, c: 'x' },
    { c: 'x' },
    { stop: [] },
    { stop: ['x'] },
    { tools: [{}] },
    { reasoning: { effort: 'low' } },
    { reasoning: { effort: 'high' } },
  ];
  const seen = new Map<string, string>();
  for (const configuration of accepted) {
    assert.deepEqual(configurationViolations(configuration), [], JSON.stringify(configuration));
    const digest = configurationSha256(configuration);
    const leaves = JSON.stringify(configurationLeaves(configuration));
    const prior = seen.get(digest);
    if (prior !== undefined) assert.equal(prior, leaves, 'one digest, one leaf set');
    for (const [otherDigest, otherLeaves] of seen) {
      if (otherDigest === digest) continue;
      assert.notEqual(otherLeaves, leaves, `distinct digests must have distinct leaf sets: ${leaves}`);
    }
    seen.set(digest, leaves);
  }
  assert.equal(seen.size, accepted.length, 'every fixture is a distinct entrant');
});

test('values PostgreSQL jsonb cannot store are refused', () => {
  // Measured against PostgreSQL 17.10, not reasoned about: a NUL is
  // `unsupported Unicode escape sequence` in a value AND in a key, and each
  // half of a split surrogate pair is `invalid input syntax for type json`.
  // Accepting one means a roster that boots, spends a night, and then cannot
  // be published.
  const NUL = String.fromCharCode(0);
  const HIGH = String.fromCharCode(0xd800);
  const LOW = String.fromCharCode(0xdc00);
  assert.match(configurationViolations({ note: `a${NUL}b` })[0] ?? '', /contains a NUL/);
  assert.match(configurationViolations({ [`k${NUL}`]: 1 })[0] ?? '', /key that contains a NUL/);
  assert.match(configurationViolations({ note: HIGH })[0] ?? '', /lone surrogate/);
  assert.match(configurationViolations({ note: LOW })[0] ?? '', /lone surrogate/);
  assert.match(configurationViolations({ note: `${LOW}${HIGH}` })[0] ?? '', /lone surrogate/);
  assert.match(configurationViolations({ [`k${HIGH}`]: 1 })[0] ?? '', /key that contains a lone surrogate/);
  assert.match(configurationViolations({ deep: { list: [HIGH] } })[0] ?? '', /lone surrogate/);
});

test('the storable characters PostgreSQL DOES accept are not refused', () => {
  // The negative control, and it is the half that pins the boundary in the
  // right place: all three of these store fine in jsonb (measured), so a build
  // that refused "control characters" or "anything with a surrogate in it"
  // would satisfy the test above and reject legal configurations.
  assert.deepEqual(configurationViolations({ note: String.fromCharCode(31) }), []);
  assert.deepEqual(configurationViolations({ note: '\u{1F600}' }), []);
  assert.deepEqual(configurationViolations({ note: 'e\u0301 \u00e9 \u4e00' }), []);
});
