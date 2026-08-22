import { canonicalize, sha256Hex } from './canonical.js';
import { sealResponseEnvelope } from './providers/responseEnvelope.js';
import { RESPONSE_SCHEMA_VERSIONS, validateResponseText } from './schema.js';
import { SMOKE_LABEL } from './types.js';
import type { GameRequest } from './bundle.js';
import type { ResponseSchemaVersion } from './schema.js';
import type {
  ArmSpec,
  BenchmarkResponse,
  ForecastOutput,
  GameBundle,
  ProviderResponseEnvelope,
  SlateBundle,
} from './types.js';

/**
 * Shared deterministic factories for unit tests: one synthetic game request
 * and a schema-conformant response for it. Test-only; not part of the runtime
 * path — the only importers under src/ are `*.test.ts` and the database
 * conformance suites, which are run by their own scripts and not by
 * `yarn test`.
 */

/**
 * The retained response envelope for a fixture provider response.
 *
 * DELIBERATELY not the answer text: a real envelope is the whole provider body
 * and the answer is one field inside it, so a fixture where the two are equal
 * cannot tell `answerText` and `responseEnvelope.body` apart if a serializer
 * swaps them. Sealed by the production function so fixtures carry a digest
 * that verifies for the same reason a live one does.
 */
export function fixtureEnvelope(answerText: string): ProviderResponseEnvelope {
  return sealResponseEnvelope(
    JSON.stringify({
      fixture: 'test-factory',
      output: [{ type: 'message', content: [{ type: 'output_text', text: answerText }] }],
    }),
  );
}

/**
 * Ways a retained envelope can be DAMAGED, each isolating one rule of
 * `responseEnvelopeSchema` — the boundary fixtures the scorer and the replay
 * are both swept over, so "the two readers agree" is measured on the same
 * inputs rather than asserted twice from different ones.
 *
 * Every entry is a BOUNDARY value, not an extreme one (rule 3g-both): each
 * leaves the other two fields correct and the digest reproducible, so exactly
 * one schema rule can refuse it. A fixture that violates several rules at once
 * — the deleted `sha256` this table replaced — is refused by every candidate
 * implementation and therefore discriminates none of them.
 *
 * `whyOnlyThisRuleRefusesIt` is asserted in the tests, not decoration: it is
 * what stops a later edit from quietly un-discriminating a case.
 */
export const ENVELOPE_DAMAGE = {
  /** A key nobody planned for. `body`, `sha256` and `bytes` are all present,
   *  correctly typed and self-consistent, so only `.strict()` can refuse it —
   *  and a reader built from three `typeof` checks accepted it outright. */
  'extra-key': (sealed: ProviderResponseEnvelope): Record<string, unknown> => ({
    ...sealed,
    provenanceNote: 'added by hand after the run',
  }),
  /** The digest in UPPER-CASE hex. `typeof sha256 === 'string'` accepts it;
   *  only the `^[0-9a-f]{64}$` pattern refuses it as a SHAPE. */
  'upper-case-sha256': (sealed: ProviderResponseEnvelope): Record<string, unknown> => ({
    ...sealed,
    sha256: sealed.sha256.toUpperCase(),
  }),
  /** A fractional byte count. `typeof bytes === 'number'` accepts it; only
   *  `.int()` refuses it. */
  'fractional-bytes': (sealed: ProviderResponseEnvelope): Record<string, unknown> => ({
    ...sealed,
    bytes: sealed.bytes + 0.5,
  }),
  /** No `sha256` at all. The coarsest damage and the one every reader has
   *  always refused — kept as the control that the sweep is not passing only
   *  on its subtle members. */
  'missing-sha256': (sealed: ProviderResponseEnvelope): Record<string, unknown> => ({
    body: sealed.body,
    bytes: sealed.bytes,
  }),
} as const;

export type EnvelopeDamage = keyof typeof ENVELOPE_DAMAGE;

/** Apply one damage to a sealed envelope. */
export function damageEnvelope(
  sealed: ProviderResponseEnvelope,
  damage: EnvelopeDamage,
): Record<string, unknown> {
  return ENVELOPE_DAMAGE[damage](sealed);
}

export const TEST_ARM: ArmSpec = {
  participantId: 'stub-openai',
  provider: 'openai',
  requestedModelId: 'stub-model-1',
  credentialEnvVar: 'STUB_PROVIDER_KEY',
  configuration: {},
};

/**
 * The same stub model entered twice at two settings — the case the whole
 * per-participant configuration model exists for, and the one that breaks
 * anything deriving identity from the model rather than from the arm.
 */
export const TEST_ARM_LOW: ArmSpec = {
  participantId: 'stub-openai-low',
  provider: 'openai',
  requestedModelId: 'stub-model-1',
  credentialEnvVar: 'STUB_PROVIDER_KEY',
  configuration: { reasoning: { effort: 'low' } },
};

export const TEST_ARM_HIGH: ArmSpec = {
  participantId: 'stub-openai-high',
  provider: 'openai',
  requestedModelId: 'stub-model-1',
  credentialEnvVar: 'STUB_PROVIDER_KEY',
  configuration: { reasoning: { effort: 'high' } },
};

export const TEST_COHORT = 'test-cohort';

export function makeGameBundle(overrides: Partial<GameBundle> = {}): GameBundle {
  const gameId = overrides.gameId ?? '00000000-0000-4000-8000-00000000t001';
  return {
    gameId,
    league: 'mlb',
    scheduledStartUtc: '2026-07-12T16:15:00+00:00',
    awayTeam: 'Milwaukee Brewers',
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: {
      moneyline: {
        awayDecimal: 1.74627,
        homeDecimal: 2.17,
        observedAt: '2026-07-12T14:02:11+00:00',
        evidenceRef: `ev:${gameId}:moneyline`,
      },
      runLine: {
        line: 1.5,
        awayHandicap: -1.5,
        homeHandicap: 1.5,
        awayDecimal: 2.3,
        homeDecimal: 1.66667,
        observedAt: '2026-07-12T14:02:11+00:00',
        evidenceRef: `ev:${gameId}:runline`,
      },
      total: {
        line: 8.5,
        overDecimal: 1.90909,
        underDecimal: 1.90909,
        observedAt: '2026-07-12T14:02:11+00:00',
        evidenceRef: `ev:${gameId}:total`,
      },
    },
    evidenceRefs: [
      `ev:${gameId}:identity`,
      `ev:${gameId}:schedule`,
      `ev:${gameId}:moneyline`,
      `ev:${gameId}:runline`,
      `ev:${gameId}:total`,
    ],
    ...overrides,
  };
}

export function makeRequest(
  cutoffAt = '2026-07-12T16:15:00+00:00',
  overrides: Partial<GameBundle> = {},
): GameRequest {
  const game = makeGameBundle({ scheduledStartUtc: cutoffAt, ...overrides });
  const requestBundle: SlateBundle = {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate: '2026-07-12',
    bundleTimestamp: '2026-07-12T14:05:00+00:00',
    cutoffAt,
    games: [game],
  };
  return {
    gameId: game.gameId,
    slug: 'mil-pit-2026-07-12',
    game,
    requestBundle,
    requestSha256: sha256Hex(canonicalize(requestBundle)),
  };
}

/** A fully schema- and semantics-conformant response for makeRequest(). */
export function makeValidResponse(
  request: GameRequest,
  arm: ArmSpec = TEST_ARM,
  cohortId: string = TEST_COHORT,
): BenchmarkResponse {
  const game = request.game;
  // makeRequest/makeGameBundle always build a full three-market board.
  const ml = game.markets.moneyline!;
  const rl = game.markets.runLine!;
  const total = game.markets.total!;
  return {
    schemaVersion: 2,
    cohortId,
    participantId: arm.participantId,
    requestedModelId: arm.requestedModelId,
    bundleSha256: request.requestSha256,
    executionPolicy: 'fixed-moneyline-total',
    games: [
      {
        gameId: game.gameId,
        forecasts: [
          {
            market: 'moneyline',
            selection: game.awayTeam,
            line: null,
            observedDecimal: ml.awayDecimal,
            probabilities: { win: 0.55, push: 0, loss: 0.45 },
            confidence: 0.6,
            wouldAbstain: false,
            selectedForExecution: true,
            rationale: 'Reference prices favor the away side.',
            evidenceRefs: [ml.evidenceRef],
            reasonCode: null,
            axes: { valuation: 4, trend: 2, consensus: 3, news: 1, softness: 5 },
            primaryAxis: 'valuation',
            primaryExpectation: 'The away price reads rich against the implied probabilities.',
          },
          {
            market: 'spread',
            selection: game.homeTeam,
            line: rl.line,
            observedDecimal: rl.homeDecimal,
            probabilities: { win: 0.5, push: 0, loss: 0.5 },
            confidence: 0.5,
            wouldAbstain: false,
            selectedForExecution: false,
            rationale: 'Half-run line at even implied odds.',
            evidenceRefs: [rl.evidenceRef],
            reasonCode: null,
            axes: { valuation: 2, trend: 4, consensus: 1, news: 3, softness: 5 },
            primaryAxis: 'trend',
            primaryExpectation: 'Recent form favors the home side on the designated run line.',
          },
          {
            market: 'total',
            selection: 'over',
            line: total.line,
            observedDecimal: total.overDecimal,
            probabilities: { win: 0.5, push: 0, loss: 0.5 },
            confidence: 0.5,
            wouldAbstain: false,
            selectedForExecution: true,
            rationale: 'Total priced evenly at the designated line.',
            evidenceRefs: [total.evidenceRef],
            reasonCode: null,
            // The all-ones case: no primary driver, and an expectation stating
            // that no material movement is expected.
            axes: { valuation: 1, trend: 1, consensus: 1, news: 1, softness: 1 },
            primaryAxis: null,
            primaryExpectation: 'No material movement is expected in this total before close.',
          },
        ],
      },
    ],
  };
}

/**
 * An OVER-SCALE forecast the response validator accepts, with the validator's
 * verdict returned alongside so every caller can assert on it rather than trust
 * this comment.
 *
 * Every numeric carries more decimals than the serving projection's reveal
 * columns hold (`line numeric(10,4)`, `observed_decimal numeric(12,6)`,
 * probabilities and `confidence numeric(9,8)`), which is the case that made a
 * digest over unrounded floats unreproducible from the reveal.
 *
 * Producing one that is genuinely valid is fiddlier than it looks, which is why
 * it lives here instead of being retyped: probabilities must sum to 1 within
 * 1e-6, `observedDecimal` must EQUAL the bundle price for the selected side,
 * `line` must echo the bundle, and `push` must be 0 whenever the line is not an
 * integer — which an over-scale line always is. So the bundle carries the
 * over-scale price too.
 *
 * ── EVERY VALUE SITS ON A ROUNDING BOUNDARY, AND THAT IS THE POINT ───────────
 *
 * Each numeric below is chosen so `Number(v.toFixed(scale))` and PostgreSQL's
 * own `numeric` rounding DISAGREE — measured against PostgreSQL 17 with these
 * exact column types:
 *
 *              value            toFixed()     stored as
 *     line     1.52345          1.5234        1.5235      numeric(10,4)
 *     price    2.0537145        2.053714      2.053715    numeric(12,6)
 *     win      0.523123465      0.52312346    0.52312347  numeric(9,8)
 *     loss     0.476876535      0.47687653    0.47687654  numeric(9,8)
 *     conf     0.613712355      0.61371235    0.61371236  numeric(9,8)
 *
 * That is what makes the serving port's quantiser provable per column: hand
 * PostgreSQL the raw value for any of them and it stores a different number
 * from the one the digest committed to, so the conformance round trip reddens.
 * A fixture whose values round the same way under both rules cannot tell a
 * publisher that quantises from one that does not — measured, three columns
 * were in exactly that state and their quantisers could be deleted with the
 * whole suite staying green.
 *
 * `push` is the one this fixture cannot carry: the validator refuses a non-zero
 * push on a fractional line, and an over-scale line is fractional by definition.
 * `makeOverScalePushAccepted` exists for it.
 */
export function makeOverScaleAccepted(): {
  forecast: ForecastOutput;
  errors: readonly string[];
} {
  const base = makeRequest();
  const request = makeRequest('2026-07-12T16:15:00+00:00', {
    markets: {
      ...base.game.markets,
      runLine: {
        ...base.game.markets.runLine!,
        line: 1.52345,
        homeHandicap: 1.52345,
        awayHandicap: -1.52345,
        homeDecimal: 2.0537145,
      },
    },
  } as never);
  const response = makeValidResponse(request);
  const spread = response.games[0]!.forecasts.find((f) => f.market === 'spread')!;
  spread.line = 1.52345; //              numeric(10,4) holds 4
  spread.observedDecimal = 2.0537145; // numeric(12,6) holds 6
  spread.probabilities = { win: 0.523123465, push: 0, loss: 0.476876535 };
  spread.confidence = 0.613712355; //    numeric(9,8) holds 8

  const result = validateResponseText(
    JSON.stringify(response),
    request.requestBundle,
    request.requestSha256,
    TEST_ARM,
    TEST_COHORT
  );
  const accepted = result.parsed?.games[0]?.forecasts.find((f) => f.market === 'spread');
  return { forecast: (accepted ?? spread) as ForecastOutput, errors: result.errors };
}

/** Exported so a caller can assert on the validator's message verbatim. */
export const ACCEPTANCE_GAME_ID = '00000000-0000-4000-8000-00000000t001';
const ACCEPTANCE_AWAY_TEAM = 'Milwaukee Brewers';
const ACCEPTANCE_OBSERVED_AT = '2026-07-12T14:02:11+00:00';

/**
 * The price on the side the forecast did NOT take: `americanToDecimal(-125)`,
 * a price a book could post. The validator checks only the SELECTED side, so
 * nothing reads this — and because it is the same constant on every market, the
 * two-sided board it produces is not one any book would post. That matters to
 * nothing here; it is written down so the next reader does not mistake this for
 * a modelled market.
 */
const UNSELECTED_SIDE_DECIMAL = 1.8;

/**
 * A one-game, one-market bundle built AROUND a forecast, so the pair can be put
 * to the real validator.
 *
 * The game supplies only the forecast's own market — the response schema's
 * dynamic cardinality allows 1-3 — which keeps a single-forecast response legal
 * and avoids inventing two decisions nobody asked about. That is a construction
 * convenience rather than a board this repo builds: the batch producer always
 * requests the full three-market board, and the line-open path builds
 * single-market bundles under market policy. Nothing about the digest depends
 * on which of those a forecast arrived in.
 */
function bundleAround(forecast: ForecastOutput): GameBundle {
  const marketRef = `ev:${ACCEPTANCE_GAME_ID}:${forecast.market}`;
  const evidenceRefs = [...new Set([marketRef, ...forecast.evidenceRefs])];
  const homeTeam = forecast.market === 'total' ? 'Pittsburgh Pirates' : forecast.selection;
  if (homeTeam === ACCEPTANCE_AWAY_TEAM) {
    throw new Error('forecastAcceptance: the selection collides with the away team');
  }
  const base = makeGameBundle({
    gameId: ACCEPTANCE_GAME_ID,
    homeTeam,
    awayTeam: ACCEPTANCE_AWAY_TEAM,
    evidenceRefs,
  });
  if (forecast.market === 'moneyline') {
    return {
      ...base,
      markets: {
        moneyline: {
          awayDecimal: UNSELECTED_SIDE_DECIMAL,
          homeDecimal: forecast.observedDecimal,
          observedAt: ACCEPTANCE_OBSERVED_AT,
          evidenceRef: marketRef,
        },
      },
    };
  }
  if (forecast.line === null) {
    throw new Error(`forecastAcceptance: a ${forecast.market} forecast needs a line`);
  }
  if (forecast.market === 'spread') {
    return {
      ...base,
      markets: {
        runLine: {
          line: forecast.line,
          awayHandicap: -forecast.line,
          homeHandicap: forecast.line,
          awayDecimal: UNSELECTED_SIDE_DECIMAL,
          homeDecimal: forecast.observedDecimal,
          observedAt: ACCEPTANCE_OBSERVED_AT,
          evidenceRef: marketRef,
        },
      },
    };
  }
  const over = forecast.selection === 'over';
  return {
    ...base,
    markets: {
      total: {
        line: forecast.line,
        overDecimal: over ? forecast.observedDecimal : UNSELECTED_SIDE_DECIMAL,
        underDecimal: over ? UNSELECTED_SIDE_DECIMAL : forecast.observedDecimal,
        observedAt: ACCEPTANCE_OBSERVED_AT,
        evidenceRef: marketRef,
      },
    },
  };
}

/**
 * The real validator's verdict on a single forecast, as the list of errors it
 * reports — empty when the forecast is INTERNALLY CONSISTENT with a bundle
 * built to match it.
 *
 * For a fixture written as a literal (a golden preimage, say) this is how the
 * literal earns the right to be called realistic, because a forecast cannot be
 * judged alone: a matching one-game bundle is built around it and the pair goes
 * to `validateResponseText`.
 *
 * ⚠ Be precise about what that does and does not prove. The bundle is DERIVED
 *   from the forecast, so every check binding a forecast to its bundle is
 *   satisfied by construction and can never fail here:
 *
 *     - observedDecimal echoing the selected side's price
 *     - line echoing the designated line
 *     - evidence refs being drawn from the game's own list
 *     - the selection naming one of the two teams — the home team IS the
 *       selection, so any non-empty string passes on a spread or moneyline
 *
 *   Nor are the numbers checked for plausibility. Every price in a real bundle
 *   comes from `americanToDecimal`, which rounds to five decimals, and a real
 *   line arrives from the odds row in half-point steps; this copies whatever
 *   the forecast carries, so a price no book could post validates clean. An
 *   empty list means coherent, not quoted.
 *
 *   What survives as a real constraint is the forecast's own internal
 *   consistency, which is exactly where a hand-written fixture goes wrong:
 *
 *     - push must be 0 on a moneyline, which has no line at all, and on any
 *       spread or total whose line is fractional. A whole-number line is the
 *       only shape that admits a non-zero push.
 *     - the three probabilities must sum to 1 within 1e-6
 *     - selectedForExecution must match the market under fixed-moneyline-total
 *     - primaryAxis must be null iff every axis is rated 1
 *     - a moneyline forecast's line must be null, a total's selection over/under
 *
 * The forecast is placed on the HOME side of the board, so a fixture cannot
 * express "the away side was taken"; nothing here depends on that.
 *
 * `schemaVersion` 1 strips the three v2 analysis fields and validates against
 * the frozen v1 schema, the way replay contexts do.
 */
export function forecastAcceptance(
  forecast: ForecastOutput,
  schemaVersion: ResponseSchemaVersion = 2,
): readonly string[] {
  const game = bundleAround(forecast);
  const requestBundle: SlateBundle = {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate: '2026-07-12',
    bundleTimestamp: '2026-07-12T14:05:00+00:00',
    cutoffAt: game.scheduledStartUtc,
    games: [game],
  };
  const bundleSha256 = sha256Hex(canonicalize(requestBundle));
  const body =
    schemaVersion === 1
      ? {
          market: forecast.market,
          selection: forecast.selection,
          line: forecast.line,
          observedDecimal: forecast.observedDecimal,
          probabilities: forecast.probabilities,
          confidence: forecast.confidence,
          wouldAbstain: forecast.wouldAbstain,
          selectedForExecution: forecast.selectedForExecution,
          rationale: forecast.rationale,
          evidenceRefs: forecast.evidenceRefs,
          reasonCode: forecast.reasonCode,
        }
      : forecast;
  const response = {
    schemaVersion,
    cohortId: TEST_COHORT,
    participantId: TEST_ARM.participantId,
    requestedModelId: TEST_ARM.requestedModelId,
    bundleSha256,
    executionPolicy: 'fixed-moneyline-total',
    games: [{ gameId: ACCEPTANCE_GAME_ID, forecasts: [body] }],
  };
  return validateResponseText(
    JSON.stringify(response),
    requestBundle,
    bundleSha256,
    TEST_ARM,
    TEST_COHORT,
    schemaVersion === 1 ? RESPONSE_SCHEMA_VERSIONS : undefined,
  ).errors;
}

/**
 * A forecast carrying an over-scale PUSH, with the validator's verdict beside
 * it. Lives here rather than in a test file because the digest unit test and
 * the database conformance suite must argue about the same input.
 *
 * A non-zero push is refused on any fractional line, and a line is over-scale
 * only when it is fractional, so this is the one shape that can carry a push
 * with decimals for the reveal column to lose: a whole-number total, which is
 * an ordinary baseball number rather than an exotic one.
 *
 * The values are chosen so that no plausible wrong implementation reproduces
 * them. All FOUR of its scale-8 numerics sit ON a rounding boundary, where
 * `Number(v.toFixed(8))` and PostgreSQL's own numeric rounding DISAGREE —
 * measured against PostgreSQL 17 with these exact column types:
 *
 *              value           toFixed(8)    numeric(9,8)
 *     win      0.487654325     0.48765432    0.48765433
 *     push     0.061728395     0.06172839    0.06172840
 *     loss     0.450617285     0.45061728    0.45061729
 *     conf     0.554321105     0.55432110    0.55432111
 *
 * That is what makes the serving port's quantisation load-bearing rather than
 * decorative: hand PostgreSQL the raw value for any of the four and it stores a
 * different number from the one the digest committed to, so the conformance
 * round trip reddens.
 *
 * ⚠ `loss` READS as though it could not be one of them, and an earlier version
 *   of this comment said exactly that: three probabilities must sum to 1, so
 *   the third looks like whatever the first two leave. They sum to 1 WITHIN
 *   1e-6, not exactly — 0.487654325 + 0.061728395 + 0.450617285 is 1.000000005,
 *   five parts in a billion outside, and accepted. That slack is enough to put
 *   the third value wherever it needs to be. While the constraint was believed
 *   exact, the `prob_loss` quantiser could be deleted with the whole suite
 *   green.
 *
 * `line` and `observedDecimal` genuinely cannot join them HERE: a whole-number
 * line has nothing to round, and the price is `americanToDecimal(-110)`, which
 * is worth more than a boundary value because it is one the bundle builder can
 * actually emit. Both are covered on the spread fixture instead, so between the
 * two every quantised column is pinned.
 *
 * `win` also straddles the boundary between `toFixed` and the usual
 * `Math.round(v * 1e8) / 1e8` idiom (0.48765432 against 0.48765433), so
 * swapping the quantiser's rule for that one — a plausible cleanup — moves the
 * digest instead of silently redefining it.
 */
export function makeOverScalePushAccepted(): {
  forecast: ForecastOutput;
  errors: readonly string[];
} {
  const forecast: ForecastOutput = {
    market: 'total',
    selection: 'over',
    line: 8,
    observedDecimal: 1.90909,
    probabilities: { win: 0.487654325, push: 0.061728395, loss: 0.450617285 },
    confidence: 0.554321105,
    wouldAbstain: false,
    selectedForExecution: true,
    rationale: 'synthetic rationale, not from any model',
    evidenceRefs: ['ref-1'],
    reasonCode: null,
    axes: { valuation: 2, trend: 5, consensus: 3, news: 1, softness: 4 },
    primaryAxis: 'trend',
    primaryExpectation: 'synthetic expectation on a whole-number total.',
  };
  return { forecast, errors: forecastAcceptance(forecast) };
}
