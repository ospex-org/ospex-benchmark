import { createHash } from 'node:crypto';

/**
 * Deterministic canonical JSON serialization: recursively key-sorted objects,
 * no insignificant whitespace, `undefined` object members dropped. The SHA-256
 * of this string is the bundle's content hash, so the serialization must be
 * byte-stable for identical logical input.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('non-finite number is not representable in a canonical bundle');
      }
      return JSON.stringify(value);
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item)).join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
    }
    default:
      throw new Error(`unsupported value type in canonical serialization: ${typeof value}`);
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
