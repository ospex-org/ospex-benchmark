import { z } from 'zod';
import type {
  GameBundle,
  MarketKey,
  MoneylineBlock,
  RunLineBlock,
  TotalBlock,
} from './types.js';

/**
 * The scoped-bundle market set (evidence spec §3.4) and its SINGLE validated
 * boundary. A scoped bundle carries exactly the speculations firing in its
 * dispatch, so the prompt's required forecast set, the validator's cardinality,
 * the deterministic baselines, and the records all derive from ONE source — the
 * bundle's present markets — never a hard-coded three.
 *
 * "Present" means an OWN enumerable property holding a structurally-valid block.
 * Because `GameBundle.markets` is a plain optional-field object, an untyped or
 * corrupt caller could otherwise smuggle a falsy/malformed value (`null`,
 * `false`, `0`, `""`, `{}`) or an unknown/inherited key: a naive
 * `value !== undefined` check would count it present while every truthiness
 * guard downstream skipped its market checks — accepting an arbitrary forecast.
 * So the present set is validated ONCE here, fail-closed, and every consumer
 * reads it through this module; there is no second notion of "present".
 *
 * The run line is the MarketKey `spread`, stored under the bundle field
 * `runLine` (the field name is retained for archived-corpus replay); this module
 * is the only bridge between the two.
 */

/**
 * Canonical market order. The present set is always reported in this order so
 * records, prompts, and validation stay deterministic regardless of key order.
 */
export const MARKET_ORDER: readonly MarketKey[] = Object.freeze([
  'moneyline',
  'spread',
  'total',
] as const);

const decimal = z.number().finite().gt(1);
const finite = z.number().finite();
const nonEmpty = z.string().min(1);

// Structural block validators. Plain objects (unknown keys stripped, not
// rejected — forward-compatible), so a block with extra fields still validates,
// but a null/primitive/missing-field/wrong-type value does not.
const moneylineBlockSchema = z.object({
  awayDecimal: decimal,
  homeDecimal: decimal,
  observedAt: nonEmpty,
  evidenceRef: nonEmpty,
});
const runLineBlockSchema = z.object({
  line: finite,
  awayHandicap: finite,
  homeHandicap: finite,
  awayDecimal: decimal,
  homeDecimal: decimal,
  observedAt: nonEmpty,
  evidenceRef: nonEmpty,
});
const totalBlockSchema = z.object({
  line: finite,
  overDecimal: decimal,
  underDecimal: decimal,
  observedAt: nonEmpty,
  evidenceRef: nonEmpty,
});

export interface ScopedBundle {
  /** Present markets, in MARKET_ORDER — the sole cardinality source. */
  markets: MarketKey[];
  /** Validated blocks (present iff the market is in `markets`). */
  moneyline?: MoneylineBlock;
  runLine?: RunLineBlock;
  total?: TotalBlock;
}

export type ScopedResult = { ok: true; scoped: ScopedBundle } | { ok: false; violations: string[] };

export class ScopedBundleError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`invalid scoped bundle: ${violations.join('; ')}`);
    this.name = 'ScopedBundleError';
    this.violations = violations;
  }
}

/**
 * Validate a game's scoped markets. Absence is an omitted OWN property; a
 * present own market key must hold a structurally-valid block, and at least one
 * market must be present. Own undefined / null / primitives / malformed blocks,
 * unknown keys, inherited keys, and an empty scope are all rejected. Pure and
 * non-throwing — returns a discriminated result so soft validators can fold the
 * violations into their own error channel.
 */
export function scopedMarkets(game: GameBundle): ScopedResult {
  const markets = game.markets as unknown;
  if (typeof markets !== 'object' || markets === null || Array.isArray(markets)) {
    return { ok: false, violations: ['markets is not an object'] };
  }
  const record = markets as Record<string, unknown>;
  // Own enumerable keys only — an inherited market key is not a real scope.
  const ownKeys = Object.keys(record);

  const violations: string[] = [];
  for (const key of ownKeys) {
    if (key !== 'moneyline' && key !== 'runLine' && key !== 'total') {
      violations.push(`unknown market key "${key}"`);
    }
  }

  const scoped: ScopedBundle = { markets: [] };
  // Built in MARKET_ORDER by construction (moneyline, spread, total). Each block
  // is read from `record` ONCE into a local, so the value validated is exactly
  // the value stored (no getter/Proxy could diverge validation from the block
  // that consumers then read).
  if (ownKeys.includes('moneyline')) {
    const block = record['moneyline'];
    if (moneylineBlockSchema.safeParse(block).success) {
      scoped.moneyline = block as MoneylineBlock;
      scoped.markets.push('moneyline');
    } else {
      violations.push('malformed moneyline block');
    }
  }
  if (ownKeys.includes('runLine')) {
    const block = record['runLine'];
    if (runLineBlockSchema.safeParse(block).success) {
      scoped.runLine = block as RunLineBlock;
      scoped.markets.push('spread');
    } else {
      violations.push('malformed runLine block');
    }
  }
  if (ownKeys.includes('total')) {
    const block = record['total'];
    if (totalBlockSchema.safeParse(block).success) {
      scoped.total = block as TotalBlock;
      scoped.markets.push('total');
    } else {
      violations.push('malformed total block');
    }
  }

  if (scoped.markets.length === 0 && violations.length === 0) {
    violations.push('empty scope: a bundle must carry at least one present market');
  }
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, scoped };
}

/**
 * The validated scoped markets, or throw `ScopedBundleError`. For trusted /
 * fail-closed callers (baselines, mock, summary, the bundle-build boundary):
 * a malformed or empty scope must fail loudly, never silently drop a market.
 */
export function requireScopedMarkets(game: GameBundle): ScopedBundle {
  const result = scopedMarkets(game);
  if (!result.ok) throw new ScopedBundleError(result.violations);
  return result.scoped;
}

/**
 * The present market set in canonical order — the single cardinality source.
 * Throws on a malformed/empty scope (fail-closed).
 */
export function presentMarkets(game: GameBundle): MarketKey[] {
  return requireScopedMarkets(game).markets;
}
