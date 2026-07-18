import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import { assertPrepared, PreparedRequestError, prepareGameRequest } from './preparedRequest.js';
import { makeRequest } from './testFactories.js';
import type { GameRequest } from './bundle.js';
import type { PreparedGameRequest } from './preparedRequest.js';

/**
 * The pure prepared-request boundary (S1a, SPEC-prepared-request.md §1–2 and the
 * §5 S1 matrix, minus the dispatch/prompt/records integration items which are
 * S1b). The full-board cases are S1a; the S3 relaxation to 1–3 present markets
 * (scoped acceptance + supplied-run-line coherence) is covered below.
 */

/** A fresh, valid three-market request (a new object graph each call). */
function base(): GameRequest {
  return makeRequest();
}

/** Recompute the supplied hash so a bundle mutation surfaces only its own violation. */
function reSha(request: GameRequest): GameRequest {
  request.requestSha256 = sha256Hex(canonicalize(request.requestBundle));
  return request;
}

/** assert.throws with a PreparedRequestError whose violations match `re`. */
function throwsWith(fn: () => unknown, re: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof PreparedRequestError, `expected PreparedRequestError, got ${String(err)}`);
    assert.ok(
      err.violations.some((v) => re.test(v)),
      `violations ${JSON.stringify(err.violations)} do not match ${re}`,
    );
    return true;
  });
}

test('a valid three-market request prepares to a frozen, hash-consistent snapshot', () => {
  const request = base();
  const prepared = prepareGameRequest(request);

  // Derived hash equals the buildBundle-computed hash (archived replay consistency).
  assert.equal(prepared.requestSha256, request.requestSha256);
  assert.equal(prepared.requestSha256, sha256Hex(canonicalize(prepared.requestBundle)));
  assert.equal(prepared.gameSha256, sha256Hex(canonicalize(prepared.game)));

  // One canonical game; cutoff bound to first pitch.
  assert.equal(prepared.game, prepared.requestBundle.games[0]);
  assert.equal(prepared.cutoffAt, prepared.game.scheduledStartUtc);
  assert.equal(prepared.gameId, prepared.game.gameId);

  // Deep-frozen plain data.
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(prepared.game));
  assert.ok(Object.isFrozen(prepared.game.markets.moneyline));
  assert.ok(Object.isFrozen(prepared.requestBundle.games));
});

test('a mutation after preparation changes nothing', () => {
  const prepared = prepareGameRequest(base());
  const before = canonicalize(prepared.requestBundle);
  assert.throws(() => {
    (prepared.game.markets.moneyline as { awayDecimal: number }).awayDecimal = 999;
  });
  assert.equal(canonicalize(prepared.requestBundle), before);
});

// --- S3: the boundary accepts 1-3 present markets -------------------------

test('a scoped 1-2-market game is accepted (S3: a missing market is no longer a rejection)', () => {
  const request = base();
  // Drop the total from the bundle game AND its alias, then recompute the hash —
  // a coherent moneyline+runLine scoped request. Under S3 it prepares cleanly.
  delete (request.requestBundle.games[0]!.markets as unknown as Record<string, unknown>).total;
  delete (request.game.markets as unknown as Record<string, unknown>).total;
  const prepared = prepareGameRequest(reSha(request));
  assert.deepEqual(Object.keys(prepared.game.markets).sort(), ['moneyline', 'runLine']);
});

test('a scoped game with an incoherent run line is still rejected', () => {
  const request = base();
  // moneyline+runLine, but the runLine handicap contradicts its line — the
  // run-line coherence check still fires for a SUPPLIED run line.
  delete (request.requestBundle.games[0]!.markets as unknown as Record<string, unknown>).total;
  delete (request.game.markets as unknown as Record<string, unknown>).total;
  request.requestBundle.games[0]!.markets.runLine.homeHandicap = 99;
  request.game.markets.runLine.homeHandicap = 99;
  throwsWith(() => prepareGameRequest(reSha(request)), /run line homeHandicap/);
});

// --- parse-level rejections (strict schema) -------------------------------

test('an unknown market key is rejected', () => {
  const request = base();
  (request.requestBundle.games[0]!.markets as unknown as Record<string, unknown>).parlay = { foo: 1 };
  assert.throws(() => prepareGameRequest(request), PreparedRequestError);
});

test('an extra field on a block is rejected', () => {
  const request = base();
  (request.requestBundle.games[0]!.markets.moneyline as unknown as Record<string, unknown>).foo = 1;
  assert.throws(() => prepareGameRequest(request), PreparedRequestError);
});

test('a null / primitive block is rejected', () => {
  for (const bad of [null, 0, 'x', false] as unknown[]) {
    const request = base();
    (request.requestBundle.games[0]!.markets as unknown as Record<string, unknown>).total = bad;
    assert.throws(() => prepareGameRequest(request), PreparedRequestError);
  }
});

test('a present block missing a required field is rejected', () => {
  const request = base();
  delete (request.requestBundle.games[0]!.markets.moneyline as unknown as Record<string, unknown>).homeDecimal;
  assert.throws(() => prepareGameRequest(request), PreparedRequestError);
});

test('probableStartingPitchers: a present object validates and freezes; a malformed one is rejected', () => {
  const present = base();
  present.requestBundle.games[0]!.probableStartingPitchers = { away: 'Ace McPitcher', home: null };
  const prepared = prepareGameRequest(reSha(present));
  assert.deepEqual(prepared.game.probableStartingPitchers, { away: 'Ace McPitcher', home: null });
  assert.ok(Object.isFrozen(prepared.game.probableStartingPitchers));

  const malformed = base();
  (malformed.requestBundle.games[0]! as unknown as Record<string, unknown>).probableStartingPitchers = {
    away: 123,
    home: null,
  };
  assert.throws(() => prepareGameRequest(reSha(malformed)), PreparedRequestError);
});

test('a decimal <= 1 is rejected', () => {
  const request = base();
  (request.requestBundle.games[0]!.markets.moneyline as { awayDecimal: number }).awayDecimal = 1;
  assert.throws(() => prepareGameRequest(request), PreparedRequestError);
});

test('a non-instant observedAt is rejected', () => {
  const request = base();
  (request.requestBundle.games[0]!.markets.total as { observedAt: string }).observedAt = 'not-an-instant';
  assert.throws(() => prepareGameRequest(request), PreparedRequestError);
});

// --- cross-field rejections (accumulated) ---------------------------------

test('a widened cutoff (cutoff != scheduledStartUtc) is rejected', () => {
  const request = base();
  request.requestBundle.cutoffAt = '2026-07-12T17:15:00+00:00'; // one hour after first pitch
  throwsWith(() => prepareGameRequest(reSha(request)), /cutoffAt .* must equal .* scheduledStartUtc/);
});

test('contradictory run-line handicaps are rejected', () => {
  const home = base();
  (home.requestBundle.games[0]!.markets.runLine as { homeHandicap: number }).homeHandicap = 99;
  throwsWith(() => prepareGameRequest(reSha(home)), /homeHandicap .* must equal line/);

  const away = base();
  (away.requestBundle.games[0]!.markets.runLine as { awayHandicap: number }).awayHandicap = 99;
  throwsWith(() => prepareGameRequest(reSha(away)), /awayHandicap .* must equal -line/);
});

test('an observedAt that postdates the bundle timestamp is rejected', () => {
  const request = base();
  (request.requestBundle.games[0]!.markets.moneyline as { observedAt: string }).observedAt =
    '2026-07-12T23:00:00+00:00'; // hours after bundleTimestamp (14:05)
  throwsWith(() => prepareGameRequest(reSha(request)), /postdates the bundle timestamp/);
});

test('an evidenceRef absent from the game evidence list is rejected', () => {
  const request = base();
  (request.requestBundle.games[0]!.markets.total as { evidenceRef: string }).evidenceRef =
    'ev:not-in-the-list';
  throwsWith(() => prepareGameRequest(reSha(request)), /evidenceRef .* is not in the game's evidenceRefs/);
});

// --- request shape / alias rejections --------------------------------------

test('a multi-game (or zero-game) request is rejected', () => {
  const multi = base();
  multi.requestBundle.games = [multi.requestBundle.games[0]!, multi.requestBundle.games[0]!];
  throwsWith(() => prepareGameRequest(reSha(multi)), /exactly one game/);

  const zero = base();
  zero.requestBundle.games = [];
  throwsWith(() => prepareGameRequest(reSha(zero)), /exactly one game/);
});

test('a gameId alias mismatch is rejected', () => {
  const request = base();
  request.gameId = 'a-different-game-id';
  throwsWith(() => prepareGameRequest(request), /gameId .* does not match/);
});

test('a request.game that diverges from the bundle game is rejected', () => {
  const request = base();
  // Same gameId, different content (records serialize the game — it must not be
  // allowed to differ from the game that is prompted and hashed).
  request.game = { ...request.game, awayTeam: 'DIFFERENT AWAY' };
  throwsWith(() => prepareGameRequest(request), /supplied game is not the same canonical value/);
});

test('a forged (mismatched) supplied requestSha256 is rejected', () => {
  const request = base();
  request.requestSha256 = 'a'.repeat(64);
  throwsWith(() => prepareGameRequest(request), /does not match the recomputed hash/);
});

// --- plain-data normalization ---------------------------------------------

test('a value-changing accessor cannot have its second read validate', () => {
  const request = base();
  let reads = 0;
  Object.defineProperty(request.requestBundle.games[0]!.markets.moneyline, 'awayDecimal', {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? 1.9 : 99;
    },
  });
  // Whatever the parse pinned, the later read (99) must never become validated —
  // the divergence is caught and the request rejected.
  assert.throws(() => prepareGameRequest(request), PreparedRequestError);
});

test('an accessor does not survive preparation — the stored value is plain data', () => {
  const request = base();
  const ml = request.requestBundle.games[0]!.markets.moneyline;
  const fixed = ml.awayDecimal;
  Object.defineProperty(ml, 'awayDecimal', {
    configurable: true,
    enumerable: true,
    get: () => fixed,
  });
  reSha(request); // canonicalize reads the (stable) getter, so the supplied hash matches
  const prepared = prepareGameRequest(request);
  const descriptor = Object.getOwnPropertyDescriptor(prepared.game.markets.moneyline, 'awayDecimal');
  assert.equal(descriptor?.get, undefined, 'stored awayDecimal must be a data property, not an accessor');
  assert.equal(prepared.game.markets.moneyline.awayDecimal, fixed);
});

test('an inherited (non-market) key such as toJSON is stripped, not carried', () => {
  const request = base();
  Object.setPrototypeOf(request.requestBundle.games[0]!, { toJSON: () => ({ hijacked: true }) });
  const prepared = prepareGameRequest(request);
  // structuredClone copied only own-enumerable keys, so the inherited toJSON is
  // gone — a later JSON.stringify (the prompt, S1b) has nothing to invoke.
  assert.equal(Object.getPrototypeOf(prepared.game), Object.prototype);
  assert.ok(!('toJSON' in prepared.game));
});

test('an inherited (non-own) market key is rejected', () => {
  for (const key of ['moneyline', 'runLine', 'total'] as const) {
    const request = base();
    const rawMarkets = request.requestBundle.games[0]!.markets as unknown as Record<string, unknown>;
    const block = rawMarkets[key];
    // Present via the prototype but not as an own property.
    delete rawMarkets[key];
    Object.setPrototypeOf(rawMarkets, { [key]: block });
    assert.throws(() => prepareGameRequest(request), PreparedRequestError);
  }
});

test('a non-string slug (object or function) is rejected, not carried into the snapshot', () => {
  const objectSlug = base();
  (objectSlug as unknown as Record<string, unknown>).slug = { hijack: 'HIJACKED-SLUG' };
  assert.throws(() => prepareGameRequest(objectSlug), PreparedRequestError);

  const functionSlug = base();
  (functionSlug as unknown as Record<string, unknown>).slug = () => 'HIJACKED-SLUG';
  assert.throws(() => prepareGameRequest(functionSlug), PreparedRequestError);
});

test('a non-object input (null / undefined / primitive) is a typed rejection, not a raw error', () => {
  for (const bad of [null, undefined, 42, 'x', true] as unknown[]) {
    assert.throws(() => prepareGameRequest(bad), PreparedRequestError);
  }
});

test('a throwing accessor anywhere in the envelope is a typed rejection', () => {
  const outer = base();
  Object.defineProperty(outer, 'gameId', {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error('boom');
    },
  });
  assert.throws(() => prepareGameRequest(outer), PreparedRequestError);

  const nested = base();
  Object.defineProperty(nested.requestBundle.games[0]!.markets.total, 'overDecimal', {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error('boom');
    },
  });
  assert.throws(() => prepareGameRequest(nested), PreparedRequestError);
});

test('a hostile value thrown during cloning is still a typed rejection (Symbol.toPrimitive throws)', () => {
  const request = base();
  const hostile = {
    [Symbol.toPrimitive]() {
      throw new Error('toPrimitive boom');
    },
  };
  Object.defineProperty(request, 'gameId', {
    configurable: true,
    enumerable: true,
    get() {
      throw hostile; // structuredClone reads gameId, the getter throws this value
    },
  });
  assert.throws(() => prepareGameRequest(request), PreparedRequestError);
});

test('a hostile Error thrown during cloning is still a typed rejection (message accessor throws)', () => {
  const request = base();
  const hostileError = new Error('placeholder');
  Object.defineProperty(hostileError, 'message', {
    configurable: true,
    get() {
      throw new Error('message boom');
    },
  });
  Object.defineProperty(request.requestBundle.games[0]!.markets.total, 'overDecimal', {
    configurable: true,
    enumerable: true,
    get() {
      throw hostileError;
    },
  });
  assert.throws(() => prepareGameRequest(request), PreparedRequestError);
});

test('the prepared slug is the normalized string', () => {
  const prepared = prepareGameRequest(base());
  assert.equal(typeof prepared.slug, 'string');
  assert.equal(prepared.slug, 'mil-pit-2026-07-12');
});

test('an empty slug is rejected — the scorer requires a non-empty slug', () => {
  const request = base();
  request.slug = '';
  assert.throws(() => prepareGameRequest(request), PreparedRequestError);
});

test('the prepared snapshot is a plain-data object graph — no custom prototype survives', () => {
  // The prompt (S1b) and the hash serialize THIS snapshot, so a plain-object
  // graph is what defeats an inherited toJSON: there is nothing to invoke.
  const prepared = prepareGameRequest(base());
  assert.equal(Object.getPrototypeOf(prepared.game), Object.prototype);
  assert.equal(Object.getPrototypeOf(prepared.requestBundle), Object.prototype);
  assert.equal(Object.getPrototypeOf(prepared.game.markets.moneyline), Object.prototype);
  assert.ok(!('toJSON' in prepared.game));
});

test('assertPrepared accepts a real prepared request and rejects a forged look-alike', () => {
  const prepared = prepareGameRequest(base());
  assert.doesNotThrow(() => assertPrepared(prepared));

  // A structural clone carries identical content but did NOT come through the
  // boundary — the runtime brand rejects it by origin, not by shape (the
  // TypeScript type would let it through).
  const forged = structuredClone(prepared) as PreparedGameRequest;
  assert.throws(() => assertPrepared(forged), PreparedRequestError);

  // A hand-forged plain object of the same shape is likewise rejected.
  const handForged = { ...prepared } as PreparedGameRequest;
  assert.throws(() => assertPrepared(handForged), PreparedRequestError);

  // A Proxy over the shape is a distinct identity too — rejected without ever
  // reading a property (WeakSet membership is identity, not shape/access).
  const proxied = new Proxy(
    {},
    {
      get() {
        throw new Error('assertPrepared must not read a property to reject');
      },
    },
  ) as unknown as PreparedGameRequest;
  assert.throws(() => assertPrepared(proxied), PreparedRequestError);
});
