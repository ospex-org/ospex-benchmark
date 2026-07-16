/**
 * Recursively freeze an object graph so a TypeScript `readonly` / `as const`
 * type cannot be bypassed at runtime — via an `as any` cast, or even a plain
 * accessor that hands back a canonical nested array. Load-bearing registries
 * that dispatch and scoring consume (the market policy, the arm roster, the
 * approved-model sets, the known baseline versions, the scored-market set) must
 * be frozen so a one-time manifest preflight is a real semantic lock, not a
 * snapshot the runtime can drift away from afterward. TypeScript `readonly`
 * alone is insufficient.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
