import { z } from 'zod';
import { FUTURE_QUOTE_SKEW_MS } from './bundle.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { deepFreeze } from './freeze.js';
import { instantMs, isParseableInstant } from './time.js';
import { SMOKE_LABEL } from './types.js';
import type { GameBundle, SlateBundle } from './types.js';

/**
 * The prepared request boundary (SPEC-prepared-request.md §1–2), for the current
 * fixed three-market bundle (S1 — no cardinality change; S3 relaxes to 1–3).
 *
 * `prepareGameRequest` turns a caller-supplied request envelope (accepted as
 * `unknown`) into ONE immutable, normalized, plain-data value that every
 * downstream surface derives from. It `structuredClone`s the WHOLE envelope into
 * fresh, recursively-plain data (copying own-enumerable values only — so
 * inherited keys and custom prototypes are dropped, each accessor is evaluated
 * once, `toJSON` is never invoked, and a function/unclonable value throws, which
 * becomes a typed rejection), requires each market to be an OWN property,
 * strict-parses the whole envelope, verifies the cross-field identity and timing
 * invariants, DERIVES the hashes (never trusting a supplied hash), and
 * deep-freezes the result. A malformed or inconsistent request throws
 * `PreparedRequestError` — the dispatch path (S1b) treats that as a
 * harness/preparation failure and makes zero adapter calls.
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
// Runtime origin brand. A PreparedGameRequest's TypeScript type is erased at
// runtime, so a direct caller could forge the shape (or cast a raw bundle) and
// hand an unprepared request straight to the prompt/dispatch boundary. This
// module-private WeakSet is populated ONLY by prepareGameRequest below, and
// nothing outside this module can add to it, so membership is unforgeable
// runtime PROOF that a value actually came through the boundary — the type
// alone is not a guard.
// ---------------------------------------------------------------------------
const preparedRegistry = new WeakSet<PreparedGameRequest>();

/**
 * Throw unless `request` was produced by `prepareGameRequest`. The prompt
 * builder and the per-arm dispatch call this before serializing or dispatching
 * anything, so a forged or unprepared request never reaches a model — even
 * though the TypeScript type would let one through at compile time.
 */
export function assertPrepared(request: PreparedGameRequest): void {
  if (!preparedRegistry.has(request)) {
    throw new PreparedRequestError(['request was not produced by prepareGameRequest']);
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

const MARKET_FIELDS = ['moneyline', 'runLine', 'total'] as const;

// The whole request envelope — every field parsed to plain data, not just the
// bundle. `.strict()` rejects extra envelope keys; `slug` is display-only but
// must be non-empty — the scorer requires a non-empty slug, so an empty one
// would seal + dispatch here and then make the artifact unscoreable.
const envelopeSchema = z
  .object({
    gameId: nonEmpty,
    slug: nonEmpty,
    game: gameSchema,
    requestBundle: requestBundleSchema,
    requestSha256: z.string(),
  })
  .strict();

function issueList(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

/**
 * The clone's `requestBundle.games[0].markets` when the (already plain) clone has
 * that shape, else null (a structural problem the schema parse reports). Because
 * structuredClone keeps own-enumerable keys only, the returned object's own keys
 * are exactly the RAW markets' own keys — so the own-property gate reads true
 * ownership, not a value pulled through the prototype chain.
 */
function clonedMarkets(clone: unknown): Record<string, unknown> | null {
  if (typeof clone !== 'object' || clone === null) return null;
  const bundle = (clone as Record<string, unknown>)['requestBundle'];
  if (typeof bundle !== 'object' || bundle === null) return null;
  const games = (bundle as Record<string, unknown>)['games'];
  if (!Array.isArray(games) || games.length !== 1) return null;
  const game = games[0];
  if (typeof game !== 'object' || game === null) return null;
  const markets = (game as Record<string, unknown>)['markets'];
  if (typeof markets !== 'object' || markets === null) return null;
  return markets as Record<string, unknown>;
}

export function prepareGameRequest(input: unknown): PreparedGameRequest {
  // 1. Normalize the ENTIRE envelope to fresh, recursively-plain data before
  //    trusting anything. structuredClone copies own-enumerable values only
  //    (dropping inherited keys and custom prototypes), evaluates each accessor
  //    exactly once, never invokes toJSON, and throws on functions / unclonable
  //    values — a clone failure is a typed rejection, not a raw error.
  let clone: unknown;
  try {
    clone = structuredClone(input);
  } catch {
    // Do NOT format the thrown value — a hostile getter can throw an object whose
    // Symbol.toPrimitive (or an Error whose message accessor) throws again, which
    // would escape as a raw error. A fixed message keeps preparation total.
    throw new PreparedRequestError(['request is not clonable plain data']);
  }

  // 2. Each market must be an OWN property of the raw markets object. The clone
  //    kept own-enumerable keys only, so an inherited market was dropped and is
  //    rejected here with a clear message. (S3 relaxes this fixed three-key set
  //    to the present-market subset; the ownership rule is what carries over.)
  const markets = clonedMarkets(clone);
  if (markets !== null) {
    for (const key of MARKET_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(markets, key)) {
        throw new PreparedRequestError([`markets must contain an own "${key}" property`]);
      }
    }
  }

  // 3. Strict-parse the whole envelope into validated plain data.
  const parsed = envelopeSchema.safeParse(clone);
  if (!parsed.success) throw new PreparedRequestError(issueList(parsed.error));
  const env = parsed.data;
  const bundle: SlateBundle = env.requestBundle;

  // 4. Exactly one game (subsumes duplicate-game-id for a per-game request).
  if (bundle.games.length !== 1) {
    throw new PreparedRequestError([
      `a per-game request must carry exactly one game, found ${bundle.games.length}`,
    ]);
  }
  const game = bundle.games[0]!;

  const violations: string[] = [];

  // 5. The cutoff is bound to first pitch — it cannot be widened past it.
  if (bundle.cutoffAt !== game.scheduledStartUtc) {
    violations.push(
      `cutoffAt "${bundle.cutoffAt}" must equal the game's scheduledStartUtc "${game.scheduledStartUtc}"`,
    );
  }

  // 6. Market coherence. The instant fields are already schema-validated, so
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

  // 7. Derive the hashes from the normalized snapshot.
  const requestSha256 = sha256Hex(canonicalize(bundle));
  const gameSha256 = sha256Hex(canonicalize(game));

  // 8. Verify the caller's aliases against the derived canonical values — a
  //    mismatch is a rejection, never a silent correction.
  if (env.gameId !== game.gameId) {
    violations.push(`gameId "${env.gameId}" does not match the bundle game "${game.gameId}"`);
  }
  if (canonicalize(env.game) !== canonicalize(game)) {
    violations.push('the supplied game is not the same canonical value as the request bundle game');
  }
  if (env.requestSha256 !== requestSha256) {
    violations.push(
      `supplied requestSha256 "${env.requestSha256}" does not match the recomputed hash`,
    );
  }

  if (violations.length > 0) throw new PreparedRequestError(violations);

  // 9. Deep-freeze — immutable plain data; game === requestBundle.games[0] —
  //    then register it in the origin brand so the dispatch and prompt
  //    boundaries can prove at runtime that this value came through here.
  const prepared: PreparedGameRequest = deepFreeze({
    gameId: game.gameId,
    slug: env.slug,
    game,
    requestBundle: bundle,
    requestSha256,
    gameSha256,
    cutoffAt: bundle.cutoffAt,
  });
  preparedRegistry.add(prepared);
  return prepared;
}
