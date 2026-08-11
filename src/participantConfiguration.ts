import { canonicalize, sha256Hex } from './canonical.js';

/**
 * A participant's CONFIGURATION — the settings that make one competing
 * entrant distinct from another running the same model.
 *
 * A participant is one competing configuration, not a lab and not a model
 * line. Two models from one lab are two entrants; one model at two reasoning
 * levels is also two entrants. That is the axis this module adds, and two
 * properties of it are load-bearing, both inherited from the serving table
 * these values are published to (`benchmark_participants`, whose entrant key
 * is `(lab_id, model_id, configuration)`):
 *
 * 1. It is each lab's OWN vocabulary, recorded verbatim. Nothing here folds
 *    `reasoning_effort` and a thinking-token budget into a shared "effort"
 *    scale, because they are not the same quantity and the mapping would be
 *    this repository's opinion published as the provider's fact. A new
 *    dimension is a new KEY: no fixed arity, no numbered generic fields, no
 *    translation table, and no migration to add one.
 * 2. Its digest IS part of the entrant's identity. `configurationSha256` is
 *    the SHA-256 of `canonicalize()`'s output, and the serving table pins
 *    `configuration_digest_version = 1` to name RFC 8785 (JCS).
 *    `canonical.ts` was not written against that RFC — it predates this and
 *    exists for bundle hashing — so the agreement is a MEASURED property
 *    rather than a stated one, pinned by a differential matrix in
 *    `participantConfiguration.test.ts` that reddens if either side moves.
 *    The same bytes are hashed here and stored there, so a published row can
 *    be recomputed from the run artifact rather than trusted.
 *
 * `{}` is a real value meaning "this entrant sets no knobs" — it is not the
 * absence of a configuration, and it hashes like any other.
 *
 * What a configuration may NOT do is override the cohort. See
 * `applyConfiguration`.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type ParticipantConfiguration = Readonly<Record<string, JsonValue>>;

/**
 * The value written to `benchmark_participants.configuration_digest_version`,
 * where 1 names RFC 8785 (JCS).
 *
 * Bump only alongside the serving schema's own CHECK: a digest recomputed
 * under a different rule would not match a row already written under this one.
 */
export const CONFIGURATION_DIGEST_VERSION = 1;

/** The digest of the empty configuration, precomputed for readable assertions. */
export const EMPTY_CONFIGURATION_SHA256 =
  '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

/**
 * Canonical-byte ceiling on one configuration, and on the two identifiers it
 * is keyed with.
 *
 * The serving table refuses an entrant whose `lab_id`, `model_id` and
 * `configuration` together exceed what a btree entry can carry (the
 * `benchmark_participants_entrant_key_bounded` CHECK). That limit counts the
 * database's OWN jsonb rendering, which is longer than this canonical form —
 * jsonb re-emits a space after every `:` and `,`. These ceilings are therefore
 * set well under it rather than at it: a configuration inside 512 canonical
 * bytes cannot render past ~768, which with 128 bytes of identifiers stays
 * clear of the database's 1024.
 *
 * Refusing here rather than at publication is the point. A run whose roster
 * cannot be written is a night of provider spend that produces an
 * unpublishable artifact, and the roster is known before the first call.
 */
export const MAX_CONFIGURATION_CANONICAL_BYTES = 512;
export const MAX_ENTRANT_IDENTIFIER_BYTES = 128;

/**
 * Assigning to `__proto__` sets an object's prototype instead of adding a
 * member, so it is refused as a configuration key rather than merged. Every
 * other key — including `constructor` — is an ordinary own property here.
 */
const FORBIDDEN_KEY = '__proto__';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The SHA-256 of the canonical (RFC 8785) serialization of a configuration.
 * This is the value stored in `benchmark_participants.configuration_sha256`
 * and the value every consumer recomputes rather than accepts.
 */
export function configurationSha256(configuration: ParticipantConfiguration): string {
  return sha256Hex(canonicalize(configuration));
}

/** Canonical text of a configuration — the exact bytes the digest is taken over. */
export function canonicalConfigurationText(configuration: ParticipantConfiguration): string {
  return canonicalize(configuration);
}

/**
 * Structural violations of a candidate configuration. Empty = usable.
 *
 * This runs before a run starts, so the failure modes it catches are all
 * cheap here and expensive later: a value `canonicalize` would throw on
 * mid-run, a shape jsonb cannot store, or an entrant too large for the
 * serving table's key.
 *
 * `labId` / `modelId` are optional because a configuration is also validated
 * on its own, away from the arm that carries it.
 */
export function configurationViolations(
  value: unknown,
  context: { labId?: string | undefined; modelId?: string | undefined } = {},
): string[] {
  const violations: string[] = [];
  if (!isPlainObject(value)) {
    return [
      `configuration must be a JSON object (got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value})`,
    ];
  }

  walkJson(value, [], violations, false);
  if (violations.length > 0) return violations;

  const bytes = Buffer.byteLength(canonicalize(value), 'utf8');
  if (bytes > MAX_CONFIGURATION_CANONICAL_BYTES) {
    violations.push(
      `configuration is ${bytes} canonical bytes, over the ${MAX_CONFIGURATION_CANONICAL_BYTES}-byte ceiling`,
    );
  }

  const identifierBytes =
    Buffer.byteLength(context.labId ?? '', 'utf8') + Buffer.byteLength(context.modelId ?? '', 'utf8');
  if (identifierBytes > MAX_ENTRANT_IDENTIFIER_BYTES) {
    violations.push(
      `lab and model identifiers are ${identifierBytes} bytes together, over the ${MAX_ENTRANT_IDENTIFIER_BYTES}-byte ceiling`,
    );
  }
  return violations;
}

/**
 * A lone surrogate: a high one not followed by a low, or a low one not
 * preceded by a high. Legal in a JavaScript string and NOT legal JSON — which
 * makes it exactly the kind of value that passes every check written in
 * JavaScript and then fails at the database.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Why a string cannot be stored, or null.
 *
 * These are the shapes `canonicalize` serializes happily and `jsonb` refuses,
 * so accepting one means a roster that boots, spends a night of provider
 * calls, and then cannot be published.
 *
 * MEASURED against PostgreSQL 17.10 rather than reasoned about, because the
 * boundary is not where it looks: a NUL is `unsupported Unicode escape
 * sequence` in a value AND in a key, and both halves of a split surrogate pair
 * are `invalid input syntax for type json` — while other control characters
 * (U+001F) and well-formed surrogate pairs store fine. So the rule is these
 * two, not "control characters".
 */
function unstorableString(text: string): string | null {
  if (text.includes('\u0000')) return 'contains a NUL, which jsonb cannot store';
  if (LONE_SURROGATE.test(text)) return 'contains a lone surrogate, which is not valid JSON';
  return null;
}

function walkJson(
  value: unknown,
  segments: readonly string[],
  violations: string[],
  insideArray: boolean,
): void {
  // Depth comes from the SEGMENT COUNT, never from `path === ''`. The empty
  // string is a legal JSON key, so a joined path used as a root sentinel makes
  // `{"": …}` indistinguishable from the root — which let an empty top-level
  // key slip past the empty-object rule below and collapse two structures onto
  // one leaf path.
  const where = segments.length === 0 ? 'configuration' : `configuration.${segments.join('.')}`;
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    const unstorable = unstorableString(value);
    if (unstorable !== null) violations.push(`${where} ${unstorable}`);
    return;
  }
  if (typeof value === 'number') {
    // canonicalize() throws on these, which would be a mid-run crash rather
    // than a refused roster; and jsonb has no representation for them either.
    if (!Number.isFinite(value)) violations.push(`${where} is a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    // Everything below an array is exempt from the empty-object rule below: an
    // array is a LEAF, replaced whole, so any change inside it changes the
    // request.
    value.forEach((item, index) =>
      walkJson(item, [...segments, String(index)], violations, true),
    );
    return;
  }
  if (isPlainObject(value)) {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      violations.push(`${where} is a class instance, not a plain JSON object`);
      return;
    }
    // An empty object as the value of a KEY contributes nothing to the request
    // and nothing to the evidence, while still contributing to the digest — so
    // `{}` and `{"generationConfig":{}}` are two entrant IDENTITIES that send
    // byte-identical requests, and neither the duplicate-entrant gate nor the
    // post-run collision check can tell them apart.
    //
    // Refusing it is what makes leaf-set and configuration a BIJECTION (dotted
    // keys, the other way to break it, are refused below), and therefore what
    // makes "different digest" mean "different request". The top-level `{}` is
    // exempt — it is the real "sets no knobs" value — and so is an empty
    // ARRAY, which is a leaf that does change the body.
    if (!insideArray && segments.length > 0 && Object.keys(value).length === 0) {
      violations.push(
        `${where} is an empty object, which changes the digest without changing the request`,
      );
      return;
    }
    for (const key of Object.keys(value)) {
      if (key === FORBIDDEN_KEY) {
        violations.push(`${where} uses the reserved key "${FORBIDDEN_KEY}"`);
        continue;
      }
      const unstorableKey = unstorableString(key);
      if (unstorableKey !== null) {
        violations.push(`${where} has a key that ${unstorableKey}`);
        continue;
      }
      if (key === '') {
        // An empty key is legal JSON and it is the one key that can impersonate
        // the ROOT of a joined evidence path. `{"":{"a":1}}` flattened to the
        // same leaf as `{"a":1}` — same evidence, different digest — and
        // `{"":{}}` slipped past the empty-object rule entirely, so deleting
        // the whole member from the recorded request went undetected.
        //
        // Resolution no longer joins or splits (leaves carry their segments),
        // so this rule is no longer what makes the encoding injective. It is
        // kept because an empty parameter name is meaningless to every provider
        // and a configuration containing one is a mistake worth naming, and
        // because the human-readable path in a violation message is still a
        // joined string.
        violations.push(`${where} has an empty key`);
        continue;
      }
      if (key.includes('.')) {
        // A dot is the separator in the human-readable path a violation
        // message prints, so a key containing one produces a message that reads
        // as a nesting it does not have. Resolution is unaffected — it walks
        // segments — but a diagnostic that misdescribes the value it is
        // refusing is worse than no diagnostic.
        violations.push(`${where} key "${key}" contains a dot, which is the evidence path separator`);
        continue;
      }
      walkJson(value[key], [...segments, key], violations, insideArray);
    }
    return;
  }
  violations.push(`${where} is a ${typeof value}, which is not representable in JSON`);
}

/**
 * Raised when a configuration tries to set something the cohort already sets.
 */
export class ConfigurationCollisionError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `participant configuration may not set "${path}": the cohort's frozen request policy already sets it — ` +
        'a configuration ADDS settings to a request, it never overrides the model, the prompt, the declared tool block, or the token cap',
    );
    this.name = 'ConfigurationCollisionError';
    this.path = path;
  }
}

/**
 * Merge a participant's configuration into a provider request body.
 *
 * The rule is one-directional: **a configuration may add to a request, never
 * override it.** Any leaf the cohort's frozen policy already set — the model,
 * the prompt turns, the declared tool block and its cap, the output-token cap
 * — is a collision and throws.
 *
 * STATE THE SCOPE, because the obvious reading of that is too strong. The rule
 * protects exactly the keys the adapter's own body sets. It says nothing about
 * a provider parameter the cohort does not set, and there are ones that
 * matter: no adapter sets `tool_choice`, so nothing HERE stops a configuration
 * adding it and competing with search off, and none sets `service_tier`,
 * `candidateCount` or `background`. What actually bounds spend is the
 * per-attempt reservation and the context envelope it was priced against, not
 * this function; what binds the tool policy is the manifest's
 * `toolInferenceConfigSha256` plus the tool block recorded on every attempt.
 * The merge rule's real guarantee is narrower and still worth having: a
 * configuration cannot silently REPLACE something the cohort precommitted to,
 * so a reader comparing the artifact to the manifest is comparing like with
 * like.
 *
 * Objects merge recursively, which is what makes a nested provider namespace
 * usable: a configuration may add `generationConfig.thinkingConfig` beside an
 * existing `generationConfig.maxOutputTokens`, but setting
 * `generationConfig.maxOutputTokens` itself collides.
 *
 * Returns a new object; neither input is mutated, and the merged values are
 * copies, so the frozen arm registry cannot be reached through the request.
 */
export function applyConfiguration(
  body: Record<string, unknown>,
  configuration: ParticipantConfiguration,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...body };
  mergeInto(merged, configuration, '');
  return merged;
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>, prefix: string): void {
  for (const key of Object.keys(source)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (key === FORBIDDEN_KEY) throw new ConfigurationCollisionError(path);
    const incoming = source[key];
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = cloneJson(incoming);
      continue;
    }
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(incoming)) {
      const next: Record<string, unknown> = { ...existing };
      mergeInto(next, incoming, path);
      target[key] = next;
      continue;
    }
    throw new ConfigurationCollisionError(path);
  }
}

function cloneJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/**
 * Every LEAF of a configuration, as `path -> value`. A leaf is any value that
 * is not a plain object: scalars, nulls and whole arrays. Objects are walked
 * because they merge member-by-member into a request; arrays are not, because
 * they are replaced whole.
 */
export interface ConfigurationLeaf {
  /**
   * The SEGMENTS, which is what resolution walks. Structured rather than
   * joined because the empty string is a legal JSON key: a joined path cannot
   * distinguish `{"":{"a":1}}` from `{"a":1}`, and it once did not.
   */
  readonly segments: readonly string[];
  /** The same path joined with dots, for a human-readable message only. */
  readonly path: string;
  readonly value: unknown;
}

export function configurationLeaves(
  configuration: ParticipantConfiguration,
): ConfigurationLeaf[] {
  const leaves: ConfigurationLeaf[] = [];
  collectLeaves(configuration, [], leaves);
  return leaves;
}

function collectLeaves(
  value: Record<string, unknown>,
  prefix: readonly string[],
  leaves: ConfigurationLeaf[],
): void {
  for (const key of Object.keys(value)) {
    const segments = [...prefix, key];
    const member = value[key];
    if (isPlainObject(member)) {
      collectLeaves(member, segments, leaves);
      continue;
    }
    leaves.push({ segments, path: segments.join('.'), value: member });
  }
}

/**
 * Whether the evidence recorded for one provider call shows the participant's
 * DECLARED configuration actually going out on the wire. Empty = it did.
 *
 * The declared configuration and the recorded request parameters are produced
 * by different code — the roster declares, the adapter sends, and the adapter
 * derives its record from the body it built. This compares the two, which is
 * the only thing in the run that can catch a knob an adapter silently dropped.
 *
 * The bound is worth stating plainly: this proves what was SENT, not what the
 * provider DID with it. No provider echoes a reasoning setting back, so a lab
 * that ignores a knob is indistinguishable here from one that honours it.
 * That gap is irreducible from response metadata alone; recording the request
 * is what makes it auditable at all.
 *
 * `requestParams` is null for an attempt that never reached the provider (a
 * timeout, a transport failure, a missing credential). Those carry no evidence
 * either way and are the caller's business to skip.
 */
export function configurationEvidenceViolations(
  declared: ParticipantConfiguration,
  requestParams: Record<string, unknown>,
): string[] {
  const violations: string[] = [];
  for (const leaf of configurationLeaves(declared)) {
    const found = resolvePath(requestParams, leaf.segments);
    if (!found.present) {
      violations.push(`declared configuration "${leaf.path}" is absent from the recorded request parameters`);
      continue;
    }
    if (canonicalizeUnknown(found.value) !== canonicalizeUnknown(leaf.value)) {
      violations.push(
        `declared configuration "${leaf.path}" was recorded as ${canonicalizeUnknown(found.value)}, not ${canonicalizeUnknown(leaf.value)}`,
      );
    }
  }
  return violations;
}

function resolvePath(
  root: Record<string, unknown>,
  segments: readonly string[],
): { present: boolean; value: unknown } {
  let cursor: unknown = root;
  for (const segment of segments) {
    if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return { present: false, value: undefined };
    }
    cursor = cursor[segment];
  }
  return { present: true, value: cursor };
}

function canonicalizeUnknown(value: unknown): string {
  try {
    return canonicalize(value);
  } catch {
    // A value canonicalize refuses cannot equal a validated configuration
    // leaf; render it distinctly rather than throwing out of a comparison.
    return `<unrepresentable ${typeof value}>`;
  }
}
