import { z } from 'zod';
import { FUTURE_QUOTE_SKEW_MS } from './bundle.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { deepFreeze } from './freeze.js';
import { instantMs, isParseableInstant } from './time.js';
import { SMOKE_LABEL } from './types.js';
import type { GameBundle, SlateBundle } from './types.js';

/**
 * The prepared request boundary (SPEC-prepared-request.md §1–2). A game supplies
 * 1–3 of the known markets (S3 — moneyline, runLine, total; an absent market is
 * an omitted key).
 *
 * `prepareGameRequest` turns a caller-supplied request envelope (accepted as
 * `unknown`) into ONE immutable, normalized, plain-data value that every
 * downstream surface derives from. It `structuredClone`s the WHOLE envelope into
 * fresh, recursively-plain data (copying own-enumerable values only — so
 * inherited keys and custom prototypes are dropped, each accessor is evaluated
 * once, `toJSON` is never invoked, and a function/unclonable value throws, which
 * becomes a typed rejection), requires at least one own known market and rejects
 * any unknown market key, strict-parses the whole envelope, verifies the
 * cross-field identity and timing invariants, DERIVES the hashes (never trusting
 * a supplied hash), and deep-freezes the result. A malformed or inconsistent
 * request throws
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

// S3 — 1-3 of the known markets (moneyline, runLine, total); an absent market is
// an omitted key. `.strict()` rejects any unknown market key and the refinement
// enforces the at-least-one guarantee at the boundary (SPEC-prepared-request.md
// §4 pt 2 — the RUNTIME guarantee, since the GameBundle type does not encode it).
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
    markets: z
      .object({
        moneyline: moneylineBlock.optional(),
        runLine: runLineBlock.optional(),
        total: totalBlock.optional(),
      })
      .strict()
      .refine((m) => m.moneyline != null || m.runLine != null || m.total != null, {
        message: 'a game must supply at least one known market (moneyline, runLine, or total)',
      }),
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

  // 2. Under S3 a game supplies 1-3 known markets; an absent market is simply an
  //    omitted key. structuredClone kept own-enumerable keys only, so any market
  //    still present is an OWN property (an inherited market was dropped, never
  //    smuggled into the hash) and an unknown key is rejected by the strict schema
  //    below. The remaining boundary invariant is at-least-one own known market —
  //    surfaced here as an early, clear error before the schema parse.
  const markets = clonedMarkets(clone);
  if (markets !== null) {
    const present = MARKET_FIELDS.filter((key) =>
      Object.prototype.hasOwnProperty.call(markets, key),
    );
    if (present.length === 0) {
      throw new PreparedRequestError([
        'markets must contain at least one own market property (moneyline, runLine, or total)',
      ]);
    }
  }

  // 3. Strict-parse the whole envelope into validated plain data.
  const parsed = envelopeSchema.safeParse(clone);
  if (!parsed.success) throw new PreparedRequestError(issueList(parsed.error));
  const env = parsed.data;
  // Keep the parser's inferred type (markets are 1-3, each optional) internally so
  // TypeScript ENFORCES a presence check before every market deref below. The
  // final PreparedGameRequest bridges to GameBundle/SlateBundle, which now carry
  // the same per-market-optional shape; the only remaining gap is that zod infers
  // each optional market as `Block | undefined`, which exactOptionalPropertyTypes
  // rejects against GameBundle's `Block`-only optional — a single documented type
  // assertion at step 9 bridges exactly that (see there).
  const bundle = env.requestBundle;

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

  // 5b. Absence must be an OMITTED key, never an own property with an undefined
  //     value (spec §2.2). zod `.optional()` RETAINS an explicit `undefined`,
  //     while canonicalize/JSON drop it — so an undefined-valued market key would
  //     leave the frozen snapshot's own keys (Object.keys / Object.hasOwn)
  //     disagreeing with its value-derived scope under an identical request hash
  //     (two shapes, one identity). Reject it on BOTH the bundle game and the
  //     supplied alias, so one request identity maps to exactly one object shape.
  for (const [label, m] of [
    ['bundle game', game.markets],
    ['supplied game alias', env.game.markets],
  ] as const) {
    for (const key of MARKET_FIELDS) {
      if (
        Object.prototype.hasOwnProperty.call(m, key) &&
        (m as Record<string, unknown>)[key] === undefined
      ) {
        violations.push(
          `${label} market "${key}" is an own property with an undefined value; an absent market must be an omitted key`,
        );
      }
    }
  }

  // 6. Market coherence. The instant fields are already schema-validated, so
  //    instantMs cannot throw here.
  const bundleMs = instantMs(bundle.bundleTimestamp);
  // Run-line redundancy is only checked when the game supplies a run line (S3).
  const rl = game.markets.runLine;
  if (rl) {
    if (rl.homeHandicap !== rl.line) {
      violations.push(`run line homeHandicap ${rl.homeHandicap} must equal line ${rl.line}`);
    }
    if (rl.awayHandicap !== -rl.line) {
      violations.push(`run line awayHandicap ${rl.awayHandicap} must equal -line ${-rl.line}`);
    }
  }
  const validRefs = new Set(game.evidenceRefs);
  // Freshness + evidence-ref coherence over the markets the game SUPPLIES (1-3).
  const blocks: Array<readonly [string, { observedAt: string; evidenceRef: string }]> = [];
  if (game.markets.moneyline) blocks.push(['moneyline', game.markets.moneyline]);
  if (game.markets.runLine) blocks.push(['runLine', game.markets.runLine]);
  if (game.markets.total) blocks.push(['total', game.markets.total]);
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
  //    boundaries can prove at runtime that this value came through here. The
  //    GameBundle/SlateBundle types now share the parser's per-market-optional
  //    shape, so this is a pure type bridge — NOT a reshape: `as` still requires
  //    structural compatibility (it is not `as unknown`), so any real drift would
  //    still fail. It exists solely because zod's `.optional()` infers each market
  //    as `Block | undefined`, which exactOptionalPropertyTypes rejects against the
  //    `Block`-only optional; step 5b already rejected any explicit-undefined market
  //    key, so a present market is genuinely a Block and an absent one an omitted
  //    key. The object identity (game === bundle.games[0]) is preserved, so the
  //    derived hashes and every downstream runtime presence-check (S3a-e) still hold.
  const prepared: PreparedGameRequest = deepFreeze({
    gameId: game.gameId,
    slug: env.slug,
    game: game as GameBundle,
    requestBundle: bundle as SlateBundle,
    requestSha256,
    gameSha256,
    cutoffAt: bundle.cutoffAt,
  });
  preparedRegistry.add(prepared);
  return prepared;
}
