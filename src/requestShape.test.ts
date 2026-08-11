import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize } from './canonical.js';
import { ARMS, planArmRequest } from './providers/index.js';
import {
  ConfigurationCollisionError,
  configurationEvidenceViolations,
  configurationSha256,
} from './participantConfiguration.js';
import type { ParticipantConfiguration } from './participantConfiguration.js';
import type { ArmSpec, ChatTurn, ProviderCallOptions, ProviderName } from './types.js';

/**
 * What each provider actually puts on the wire, and what gets recorded about
 * it.
 *
 * `cannedHttp.test.ts` already pins the wire bodies through the real adapters
 * and a canned fetch; this file pins the layer above — that a participant's
 * configuration reaches BOTH the body and the recorded evidence, from one
 * source, and that it can never overwrite what the cohort set.
 */

const TURNS: ChatTurn[] = [
  { role: 'system', content: 'S' },
  { role: 'user', content: 'U' },
];

const DECLARED: ProviderCallOptions = { tools: 'declared', maxOutputTokens: 16_000 };
const REPAIR: ProviderCallOptions = { tools: 'none', maxOutputTokens: 16_000 };
const UNCAPPED: ProviderCallOptions = { tools: 'declared' };

function arm(provider: ProviderName, configuration: ParticipantConfiguration = {}): ArmSpec {
  const model = { openai: 'gpt-5.6-sol', anthropic: 'claude-fable-5', google: 'gemini-3.1-pro-preview', xai: 'grok-4.5' }[provider];
  return {
    participantId: `${provider}-probe`,
    provider,
    requestedModelId: model,
    credentialEnvVar: 'UNUSED',
    configuration,
  };
}

const PROVIDERS: ProviderName[] = ['openai', 'anthropic', 'google', 'xai'];

// ---------------------------------------------------------------------------
// The recorded evidence is DERIVED from the body
// ---------------------------------------------------------------------------

/**
 * The body members that carry the prompt, per provider. Recorded evidence
 * excludes exactly these and nothing else — the prompt is bound once per run
 * by its own hash, and repeating it per attempt would multiply the artifact by
 * the bundle.
 */
const PROMPT_KEYS: Record<ProviderName, string[]> = {
  openai: ['input'],
  xai: ['input'],
  anthropic: ['system', 'messages'],
  google: ['systemInstruction', 'contents'],
};

for (const provider of PROVIDERS) {
  for (const [legName, options] of [['declared', DECLARED], ['repair', REPAIR], ['uncapped', UNCAPPED]] as const) {
    test(`${provider} ${legName}: recorded params are the body minus the prompt, plus the endpoint`, () => {
      const plan = planArmRequest(arm(provider), TURNS, options);
      const fromBody = Object.fromEntries(
        Object.entries(plan.body).filter(([key]) => !PROMPT_KEYS[provider].includes(key)),
      );
      for (const [key, value] of Object.entries(fromBody)) {
        assert.equal(
          canonicalize(plan.requestParams[key]),
          canonicalize(value),
          `${key} must be recorded exactly as sent`,
        );
      }
      for (const key of PROMPT_KEYS[provider]) {
        assert.ok(!(key in plan.requestParams), `${key} is prompt content and must not be recorded per attempt`);
      }
      assert.equal(plan.requestParams['endpoint'], plan.endpoint);
      // Nothing in the record that is not the endpoint, a body member, or a
      // named non-body parameter. A record carrying something that never went
      // out is as false as one missing something that did.
      const allowed = new Set([...Object.keys(fromBody), 'endpoint', 'anthropic_version', 'model']);
      for (const key of Object.keys(plan.requestParams)) {
        assert.ok(allowed.has(key), `${key} is recorded but is not part of the request`);
      }
    });
  }
}

test('the API version anthropic sends as a HEADER is recorded, and is not in the body', () => {
  const plan = planArmRequest(arm('anthropic'), TURNS, DECLARED);
  assert.equal(plan.requestParams['anthropic_version'], '2023-06-01');
  assert.ok(!('anthropic_version' in plan.body));
});

test('the model gemini names in its URL is recorded, and is not in the body', () => {
  const plan = planArmRequest(arm('google'), TURNS, DECLARED);
  assert.equal(plan.requestParams['model'], 'gemini-3.1-pro-preview');
  assert.ok(!('model' in plan.body));
  assert.match(plan.endpoint, /gemini-3\.1-pro-preview:generateContent$/);
});

// ---------------------------------------------------------------------------
// An empty configuration changes nothing
// ---------------------------------------------------------------------------

/**
 * The production roster is all-defaults, so this is what the live wire looks
 * like today. Pinned as literals so a refactor that quietly reshapes a request
 * has to say so — and it is the negative control for every collision test
 * below, which would otherwise pass on a builder that produced nothing at all.
 */
const DECLARED_BODIES: Record<ProviderName, Record<string, unknown>> = {
  openai: {
    model: 'gpt-5.6-sol',
    input: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
    tools: [{ type: 'web_search' }],
    max_tool_calls: 5,
    include: ['web_search_call.action.sources'],
    max_output_tokens: 16_000,
  },
  anthropic: {
    model: 'claude-fable-5',
    max_tokens: 16_000,
    system: 'S',
    messages: [{ role: 'user', content: 'U' }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
  },
  google: {
    systemInstruction: { parts: [{ text: 'S' }] },
    contents: [{ role: 'user', parts: [{ text: 'U' }] }],
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: 16_000 },
  },
  xai: {
    model: 'grok-4.5',
    input: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
    tools: [{ type: 'web_search' }],
    max_turns: 5,
    max_output_tokens: 16_000,
  },
};

for (const provider of PROVIDERS) {
  test(`${provider}: an empty configuration leaves the wire body exactly as it was`, () => {
    assert.deepEqual(planArmRequest(arm(provider), TURNS, DECLARED).body, DECLARED_BODIES[provider]);
  });
}

// ---------------------------------------------------------------------------
// A configuration may add, and may never override
// ---------------------------------------------------------------------------

/**
 * Per provider, the leaves the cohort's own policy sets on at least one leg.
 * Enumerated rather than sampled: a repair carries no tool block and gemini
 * creates `generationConfig` only when a cap is supplied, so a configuration
 * that collides on ONE leg passes a check that only looks at another.
 */
const RESERVED: Record<ProviderName, ParticipantConfiguration[]> = {
  openai: [
    { model: 'other' },
    { input: [] },
    { tools: [] },
    { max_tool_calls: 99 },
    { include: [] },
    { max_output_tokens: 999_999 },
  ],
  xai: [{ model: 'other' }, { input: [] }, { tools: [] }, { max_turns: 99 }, { max_output_tokens: 999_999 }],
  anthropic: [
    { model: 'other' },
    { max_tokens: 999_999 },
    { system: 'injected' },
    { messages: [] },
    { tools: [] },
  ],
  google: [
    // `{ systemInstruction: {} }` would NOT be refused, and correctly so — an
    // empty object merges to a no-op and changes no byte of the request. The
    // rule is leaf-level, so the hostile value has to actually set a leaf.
    { systemInstruction: { parts: [{ text: 'injected' }] } },
    { contents: [] },
    { tools: [] },
    { generationConfig: { maxOutputTokens: 999_999 } },
  ],
};

for (const provider of PROVIDERS) {
  for (const hostile of RESERVED[provider]) {
    const path = Object.keys(hostile)[0] as string;
    test(`${provider}: a configuration setting "${path}" is refused on some leg`, () => {
      const spec = arm(provider, hostile);
      const refusals = ([DECLARED, REPAIR, UNCAPPED] as ProviderCallOptions[]).filter((options) => {
        try {
          planArmRequest(spec, TURNS, options);
          return false;
        } catch (error) {
          assert.ok(error instanceof ConfigurationCollisionError, 'must be the typed collision');
          return true;
        }
      });
      assert.ok(
        refusals.length > 0,
        `${path} is set by the cohort on at least one leg and must never be overridable`,
      );
    });
  }
}

test('a token cap can never be raised by a configuration — spend is not a participant setting', () => {
  // Called out separately from the table above because it is the one whose
  // failure costs money rather than correctness: the per-fire reservation is
  // priced off the manifest cap.
  for (const [provider, hostile] of [
    ['openai', { max_output_tokens: 1_000_000 }],
    ['xai', { max_output_tokens: 1_000_000 }],
    ['anthropic', { max_tokens: 1_000_000 }],
    ['google', { generationConfig: { maxOutputTokens: 1_000_000 } }],
  ] as Array<[ProviderName, ParticipantConfiguration]>) {
    assert.throws(
      () => planArmRequest(arm(provider, hostile), TURNS, DECLARED),
      ConfigurationCollisionError,
      `${provider} must refuse a configuration that raises the output cap`,
    );
  }
});

test('an empty object at a reserved path is a no-op, not an override', () => {
  // Found by a fixture that expected a refusal and did not get one. It is the
  // correct behaviour and worth pinning: the rule guards LEAVES, and an empty
  // object contributes none, so the request comes out byte-identical.
  const plan = planArmRequest(arm('google', { systemInstruction: {} }), TURNS, DECLARED);
  assert.deepEqual(plan.body, DECLARED_BODIES.google);
});

test('gemini: a nested namespace is ADDITIVE beside the cohort cap, not a collision', () => {
  // The positive control for the table above. If adding beside a reserved leaf
  // were also refused, every one of those tests would still pass and the
  // feature would be unusable for the provider that needs it most.
  const plan = planArmRequest(
    arm('google', { generationConfig: { thinkingConfig: { thinkingBudget: 4096 } } }),
    TURNS,
    DECLARED,
  );
  assert.deepEqual(plan.body['generationConfig'], {
    maxOutputTokens: 16_000,
    thinkingConfig: { thinkingBudget: 4096 },
  });
});

// ---------------------------------------------------------------------------
// The two cases this whole model exists for
// ---------------------------------------------------------------------------

test('low versus max produce different structured facts, all the way to the evidence', () => {
  const low = arm('openai', { reasoning: { effort: 'low' } });
  const max = arm('openai', { reasoning: { effort: 'high' } });

  // 1. Different identities.
  assert.notEqual(configurationSha256(low.configuration), configurationSha256(max.configuration));

  const lowPlan = planArmRequest(low, TURNS, DECLARED);
  const maxPlan = planArmRequest(max, TURNS, DECLARED);

  // 2. Different requests.
  assert.deepEqual(lowPlan.body['reasoning'], { effort: 'low' });
  assert.deepEqual(maxPlan.body['reasoning'], { effort: 'high' });
  assert.notEqual(canonicalize(lowPlan.body), canonicalize(maxPlan.body));

  // 3. Different recorded evidence.
  assert.notEqual(canonicalize(lowPlan.requestParams), canonicalize(maxPlan.requestParams));

  // 4. And the evidence DISCRIMINATES. Each arm's record satisfies its own
  //    declaration and fails the other's — without this pair the check would
  //    pass on an adapter that ignored the configuration entirely, because
  //    "no violations" is also what an unset knob compared to nothing gives.
  assert.deepEqual(configurationEvidenceViolations(low.configuration, lowPlan.requestParams), []);
  assert.deepEqual(configurationEvidenceViolations(max.configuration, maxPlan.requestParams), []);
  assert.equal(configurationEvidenceViolations(max.configuration, lowPlan.requestParams).length, 1);
  assert.equal(configurationEvidenceViolations(low.configuration, maxPlan.requestParams).length, 1);

  // 5. Everything else about the two requests is identical — which is exactly
  //    why the configuration has to be part of identity: no other field
  //    distinguishes them.
  assert.equal(lowPlan.body['model'], maxPlan.body['model']);
  assert.equal(lowPlan.endpoint, maxPlan.endpoint);
});

test('an arbitrary nested setting round-trips, in a vocabulary nothing here knows', () => {
  // No schema, no allowlist, no mapping table: a new dimension is a new key.
  // The value mixes every JSON type at depth so a shallow copy, a key sort, or
  // a JSON round trip that drops something would be visible.
  const exotic: ParticipantConfiguration = {
    someLabsFutureKnob: {
      mode: 'adaptive',
      budget: { soft: 1024, hard: 8192, ratio: 0.125 },
      stages: ['plan', 'search', 'answer'],
      flags: { verbose: false, experimental: true },
      fallback: null,
    },
    top_p: 0.95,
  };
  for (const provider of PROVIDERS) {
    const plan = planArmRequest(arm(provider, exotic), TURNS, DECLARED);
    // Verbatim in the body...
    assert.deepEqual(plan.body['someLabsFutureKnob'], exotic['someLabsFutureKnob']);
    assert.equal(plan.body['top_p'], 0.95);
    // ...verbatim in the record...
    assert.deepEqual(plan.requestParams['someLabsFutureKnob'], exotic['someLabsFutureKnob']);
    // ...and the two agree, which is the property the scorer relies on.
    assert.deepEqual(configurationEvidenceViolations(exotic, plan.requestParams), []);
  }
});

test('the repair leg carries the same configuration — it is the same entrant', () => {
  const spec = arm('anthropic', { thinking: { type: 'enabled', budget_tokens: 4096 } });
  const repair = planArmRequest(spec, TURNS, REPAIR);
  assert.deepEqual(repair.body['thinking'], { type: 'enabled', budget_tokens: 4096 });
  assert.ok(!('tools' in repair.body), 'a repair still carries no tools');
  assert.deepEqual(configurationEvidenceViolations(spec.configuration, repair.requestParams), []);
});

// ---------------------------------------------------------------------------
// The production roster
// ---------------------------------------------------------------------------

test('every code arm plans a request on every leg, and declares no knobs today', () => {
  for (const codeArm of ARMS) {
    assert.deepEqual(codeArm.configuration, {}, `${codeArm.participantId} declares a configuration`);
    for (const options of [DECLARED, REPAIR, UNCAPPED]) {
      assert.ok(planArmRequest(codeArm, TURNS, options).body);
    }
  }
});

test('planArmRequest reaches the right builder for each provider', () => {
  // A switch that fell through to one builder would still return a plan, so
  // this asserts a fact only the correct builder can produce.
  assert.match(planArmRequest(arm('openai'), TURNS, DECLARED).endpoint, /api\.openai\.com/);
  assert.match(planArmRequest(arm('xai'), TURNS, DECLARED).endpoint, /api\.x\.ai/);
  assert.match(planArmRequest(arm('anthropic'), TURNS, DECLARED).endpoint, /api\.anthropic\.com/);
  assert.match(planArmRequest(arm('google'), TURNS, DECLARED).endpoint, /generativelanguage/);
  // openai and xai share a builder but not their cap parameter.
  assert.ok('max_tool_calls' in planArmRequest(arm('openai'), TURNS, DECLARED).body);
  assert.ok('max_turns' in planArmRequest(arm('xai'), TURNS, DECLARED).body);
});
