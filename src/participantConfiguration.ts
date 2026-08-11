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

  walkJson(value, '', violations);
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

function walkJson(value: unknown, path: string, violations: string[]): void {
  const where = path === '' ? 'configuration' : `configuration.${path}`;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    // canonicalize() throws on these, which would be a mid-run crash rather
    // than a refused roster; and jsonb has no representation for them either.
    if (!Number.isFinite(value)) violations.push(`${where} is a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJson(item, path === '' ? `${index}` : `${path}.${index}`, violations));
    return;
  }
  if (isPlainObject(value)) {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      violations.push(`${where} is a class instance, not a plain JSON object`);
      return;
    }
    for (const key of Object.keys(value)) {
      if (key === FORBIDDEN_KEY) {
        violations.push(`${where} uses the reserved key "${FORBIDDEN_KEY}"`);
        continue;
      }
      walkJson(value[key], path === '' ? key : `${path}.${key}`, violations);
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
 * The rule is one-directional and it is the whole safety story of this
 * feature: **a configuration may add to a request, never override it.** Any
 * leaf the cohort's frozen policy already set — the model, the prompt turns,
 * the declared tool block and its cap, the output-token cap — is a collision
 * and throws. So a per-participant setting cannot quietly raise the token cap
 * (which would move spend past what the fire reserved), cannot disable the
 * tool policy the cohort precommitted to, and cannot swap the model out from
 * under its own identity check.
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
export function configurationLeaves(
  configuration: ParticipantConfiguration,
): Array<{ path: string; value: unknown }> {
  const leaves: Array<{ path: string; value: unknown }> = [];
  collectLeaves(configuration, '', leaves);
  return leaves;
}

function collectLeaves(
  value: Record<string, unknown>,
  prefix: string,
  leaves: Array<{ path: string; value: unknown }>,
): void {
  for (const key of Object.keys(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const member = value[key];
    if (isPlainObject(member)) {
      collectLeaves(member, path, leaves);
      continue;
    }
    leaves.push({ path, value: member });
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
    const found = resolvePath(requestParams, leaf.path);
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

function resolvePath(root: Record<string, unknown>, path: string): { present: boolean; value: unknown } {
  let cursor: unknown = root;
  for (const segment of path.split('.')) {
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
