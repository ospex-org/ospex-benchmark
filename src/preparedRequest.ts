import { z } from 'zod';
import { FUTURE_QUOTE_SKEW_MS } from './bundle.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { deepFreeze } from './freeze.js';
import { instantMs, isParseableInstant } from './time.js';
import { SMOKE_LABEL } from './types.js';
import type { GameRequest } from './bundle.js';
import type { GameBundle, SlateBundle } from './types.js';

/**
 * The prepared request boundary (SPEC-prepared-request.md §1–2), for the current
 * fixed three-market bundle (S1 — no cardinality change; S3 relaxes to 1–3).
 *
 * `prepareGameRequest` turns a caller-supplied `GameRequest` into ONE immutable,
 * normalized, plain-data value that every downstream surface derives from. It
 * strict-parses the request bundle into fresh plain data (the parser's `.data`,
 * never the original object — so any getter/Proxy is evaluated once and inherited
 * `toJSON`, symbols, non-data descriptors, and unknown fields cannot survive),
 * verifies the cross-field identity and timing invariants, DERIVES the hashes
 * (never trusting a supplied hash), and deep-freezes the result. A malformed or
 * inconsistent request throws `PreparedRequestError` — the dispatch path (S1b)
 * treats that as a harness/preparation failure and makes zero adapter calls.
 */

export interface PreparedGameRequest {
  gameId: string;
  /** Display-only; mutable upstream, never a key or hashed. */
  slug: string;
  /** The one canonical game — identical to `requestBundle.games[0]`. */
  game: GameBundle;
  requestBundle: SlateBundle;
  /** Derived: sha256Hex(canonicalize(requestBundle)). */
  requestSha256: string;
  /** Derived: sha256Hex(canonicalize(game)). */
  gameSha256: string;
  /** Derived: requestBundle.cutoffAt, which equals game.scheduledStartUtc. */
  cutoffAt: string;
}

export class PreparedRequestError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`invalid prepared request: ${violations.join('; ')}`);
    this.name = 'PreparedRequestError';
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// Strict schema — MODULE-PRIVATE. Parsing yields fresh plain data; `.strict()`
// rejects unknown/extra fields; each numeric/instant field is validated here,
// the cross-field invariants below.
// ---------------------------------------------------------------------------

const instantString = z.string().refine(isParseableInstant, {
  message: 'must be an ISO-8601 instant with an explicit offset',
});
const decimal = z.number().finite().gt(1);
const finiteNumber = z.number().finite();
const nonEmpty = z.string().min(1);

const moneylineBlock = z
  .object({ awayDecimal: decimal, homeDecimal: decimal, observedAt: instantString, evidenceRef: nonEmpty })
  .strict();
const runLineBlock = z
  .object({
    line: finiteNumber,
    awayHandicap: finiteNumber,
    homeHandicap: finiteNumber,
    awayDecimal: decimal,
    homeDecimal: decimal,
    observedAt: instantString,
    evidenceRef: nonEmpty,
  })
  .strict();
const totalBlock = z
  .object({
    line: finiteNumber,
    overDecimal: decimal,
    underDecimal: decimal,
    observedAt: instantString,
    evidenceRef: nonEmpty,
  })
  .strict();

// S1 — exactly the three fixed markets, all present.
const gameSchema = z
  .object({
    gameId: nonEmpty,
    league: z.literal('mlb'),
    scheduledStartUtc: instantString,
    awayTeam: nonEmpty,
    homeTeam: nonEmpty,
    probableStartingPitchers: z
      .object({ away: z.string().nullable(), home: z.string().nullable() })
      .strict()
      .nullable(),
    markets: z.object({ moneyline: moneylineBlock, runLine: runLineBlock, total: totalBlock }).strict(),
    evidenceRefs: z.array(nonEmpty),
  })
  .strict();

const requestBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    label: z.literal(SMOKE_LABEL),
    league: z.literal('mlb'),
    slateDate: nonEmpty,
    bundleTimestamp: instantString,
    cutoffAt: instantString,
    games: z.array(gameSchema),
  })
  .strict();

/** canonicalize, or null if the value is not canonically representable. */
function canonicalOrNull(value: unknown): string | null {
  try {
    return canonicalize(value);
  } catch {
    return null;
  }
}

export function prepareGameRequest(request: GameRequest): PreparedGameRequest {
  // 1. Strict parse into fresh plain data. A parse failure is terminal — the
  //    cross-field checks below need a validated `.data`.
  const parsed = requestBundleSchema.safeParse(request.requestBundle);
  if (!parsed.success) {
    throw new PreparedRequestError(
      parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const bundle: SlateBundle = parsed.data;

  // 2. Exactly one game. For a per-game request this also subsumes the
  //    duplicate-game-id case (there is only one game to key on).
  if (bundle.games.length !== 1) {
    throw new PreparedRequestError([
      `a per-game request must carry exactly one game, found ${bundle.games.length}`,
    ]);
  }
  const game = bundle.games[0]!;

  const violations: string[] = [];

  // 3. The cutoff is bound to first pitch — it cannot be widened past it.
  if (bundle.cutoffAt !== game.scheduledStartUtc) {
    violations.push(
      `cutoffAt "${bundle.cutoffAt}" must equal the game's scheduledStartUtc "${game.scheduledStartUtc}"`,
    );
  }

  // 4. Market coherence. The instant fields are already schema-validated, so
  //    instantMs cannot throw here.
  const bundleMs = instantMs(bundle.bundleTimestamp);
  const rl = game.markets.runLine;
  if (rl.homeHandicap !== rl.line) {
    violations.push(`run line homeHandicap ${rl.homeHandicap} must equal line ${rl.line}`);
  }
  if (rl.awayHandicap !== -rl.line) {
    violations.push(`run line awayHandicap ${rl.awayHandicap} must equal -line ${-rl.line}`);
  }
  const validRefs = new Set(game.evidenceRefs);
  const blocks: ReadonlyArray<readonly [string, { observedAt: string; evidenceRef: string }]> = [
    ['moneyline', game.markets.moneyline],
    ['runLine', game.markets.runLine],
    ['total', game.markets.total],
  ];
  for (const [name, block] of blocks) {
    // observedAt must not postdate the bundle timestamp. The build-time freshness
    // policy tolerates FUTURE_QUOTE_SKEW_MS of cross-host clock skew, so this
    // re-check applies the same bound rather than rejecting a valid bundle.
    if (instantMs(block.observedAt) > bundleMs + FUTURE_QUOTE_SKEW_MS) {
      violations.push(`${name} observedAt "${block.observedAt}" postdates the bundle timestamp`);
    }
    if (!validRefs.has(block.evidenceRef)) {
      violations.push(`${name} evidenceRef "${block.evidenceRef}" is not in the game's evidenceRefs`);
    }
  }

  // 5. Derive the hashes from the normalized snapshot.
  const requestSha256 = sha256Hex(canonicalize(bundle));
  const gameSha256 = sha256Hex(canonicalize(game));

  // 6. Verify the caller's aliases against the derived canonical values — a
  //    mismatch is a rejection, never a silent correction.
  if (request.gameId !== game.gameId) {
    violations.push(`request.gameId "${request.gameId}" does not match the bundle game "${game.gameId}"`);
  }
  const suppliedGame = canonicalOrNull(request.game);
  if (suppliedGame === null || suppliedGame !== canonicalize(game)) {
    violations.push('request.game is not the same canonical value as the request bundle game');
  }
  if (request.requestSha256 !== requestSha256) {
    violations.push(
      `supplied requestSha256 "${request.requestSha256}" does not match the recomputed hash`,
    );
  }

  if (violations.length > 0) throw new PreparedRequestError(violations);

  // 7. Deep-freeze — the prepared request is immutable plain data, and `game`
  //    is the same frozen object as `requestBundle.games[0]`.
  return deepFreeze({
    gameId: game.gameId,
    slug: request.slug,
    game,
    requestBundle: bundle,
    requestSha256,
    gameSha256,
    cutoffAt: bundle.cutoffAt,
  });
}
