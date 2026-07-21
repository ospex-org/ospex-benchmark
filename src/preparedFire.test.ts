import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, sha256Hex } from './canonical.js';
import { assertBootedCohort, cohortBoot } from './cohortBoot.js';
import { evaluateCandidate } from './detection.js';
import { MARKET_ORDINAL } from './fireArtifact.js';
import { assertPublicationVerified, checkPublication } from './manifestPublication.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { MODEL_PRICE_TABLE_DIGEST, MODEL_PRICE_TABLE_VERSION } from './modelPriceTable.js';
import {
  assertPreparedFireSnapshot,
  deriveFireId,
  deriveRunId,
  PreparedFireError,
  sealPreparedFire,
} from './preparedFire.js';
import type { PreparedFireSnapshot, PreparedMarketEvidenceInput, SealPreparedFireInput } from './preparedFire.js';
import { assertPrepared } from './preparedRequest.js';
import { isParseableInstant } from './time.js';
import { promptScaffoldSha256 } from './prompt.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import type { BootedCohort } from './cohortBoot.js';
import type { CandidateInput } from './detection.js';
import type { PublicationVerified } from './manifestPublication.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { GameBundle, MarketKey } from './types.js';

/**
 * The prepared-fire snapshot boundary. Every test drives real code: the request is
 * built through the shared wrapper + the branded prepared-request owner, the cohort
 * through the canonical `cohortBoot`, the publication through `checkPublication`, and
 * every verdict re-derives through the real `evaluateCandidate`. MLB's market policy
 * enables moneyline + total only, so fixtures use that scope.
 */

const GAME_ID = '00000000-0000-4000-8000-0000000000f1';
const CUTOFF = '2026-07-18T20:00:00+00:00';
const WINDOW_START = '2026-07-18T00:00:00.000Z';
const WINDOW_END = '2026-07-19T00:00:00.000Z';
const BUNDLE_TS = '2026-07-18T12:00:00.000Z';
const DETECTED_AT = '2026-07-18T12:00:30.000Z'; // 60 s after opener, in window
const OPENER_AT = '2026-07-18T11:59:30.000Z';
const OBSERVED_AT = '2026-07-18T11:58:00+00:00';
const BUNDLE_BUILT_AT = '2026-07-18T12:00:31.000Z';
const COMMITTER_TS = '2026-07-17T23:00:00+00:00'; // strictly before windowStart
const SLATE_DATE = '2026-07-18';
const W = 120_000;
const SKEW = 5_000;

const CODE_ARMS = defaultExpectedArms();

// --- manifest / boot / publication fixtures ---------------------------------

function manifestObject(over: { network?: string } = {}): Record<string, unknown> {
  return {
    artifactSchemaVersion: 1,
    network: over.network ?? 'polygon',
    sportAllowList: ['mlb'],
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    source: 'jsonodds',
    sourceQueryVersion: 'source-query-v1',
    marketPolicyVersion: MARKET_POLICY_VERSION,
    marketPolicyDigest: MARKET_POLICY_DIGEST,
    promptScaffoldSha256: promptScaffoldSha256(),
    expectedArmRoster: CODE_ARMS.map((a) => ({
      participantId: a.participantId,
      provider: a.provider,
      requestedModelId: a.requestedModelId,
      approvedReportedModelIds: [...a.approvedReportedModelIds],
    })),
    toolInferenceConfigSha256: 'c'.repeat(64),
    baselinePolicyVersion: 'baselines-v0.3.0',
    repairPolicyVersion: 'repair-v1',
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: MODEL_PRICE_TABLE_VERSION,
    modelPriceTableDigest: MODEL_PRICE_TABLE_DIGEST,
    runnerCommitSha: 'e'.repeat(40),
    constants: {
      pollIntervalMs: 30_000,
      cleanEntryWindowMs: W,
      gameDiscoveryWindowHours: 168,
      maxClockSkewMs: SKEW,
      freshFireMs: 30_000,
      maxDispatchLagMs: 10_000,
      historyReadTimeoutMs: 30_000,
      providerCallTimeoutMs: 300_000,
      maxOutputTokens: 16_000,
      maxRepairAttemptsPerArm: 1,
      ingestionGraceMs: 900_000,
      scheduleChangeToleranceMs: 60_000,
      maxConcurrentProviderRequests: Math.max(8, CODE_ARMS.length),
      maxDispatchesPerTick: 8,
    },
    cohortCallCap: 1_000,
    cohortSpendCapUsdMicros: 1_000_000,
  };
}

function manifestJson(over?: { network?: string }): string {
  return JSON.stringify(manifestObject(over));
}

function bootFrom(json: string): BootedCohort {
  return cohortBoot({ live: false, manifestBytes: json });
}

function publicationFor(json: string): PublicationVerified {
  const bytes = new TextEncoder().encode(json);
  return checkPublication({
    localManifestBytes: bytes,
    publication: {
      repositoryOwner: 'ospex-org',
      repositoryName: 'ospex-benchmark',
      path: 'manifests/cohort.json',
      commitSha: 'a'.repeat(40),
    },
    resolved: { blobBytes: bytes, committerTimestamp: COMMITTER_TS },
  });
}

// --- game / detection fixtures ----------------------------------------------

function scopedGame(markets: readonly MarketKey[], gameId = GAME_ID): GameBundle {
  const m: GameBundle['markets'] = {};
  if (markets.includes('moneyline')) {
    m.moneyline = { awayDecimal: 1.74627, homeDecimal: 2.17, observedAt: OBSERVED_AT, evidenceRef: `ev:${gameId}:moneyline` };
  }
  if (markets.includes('total')) {
    m.total = { line: 8.5, overDecimal: 1.90909, underDecimal: 1.90909, observedAt: OBSERVED_AT, evidenceRef: `ev:${gameId}:total` };
  }
  return {
    gameId,
    league: 'mlb',
    scheduledStartUtc: CUTOFF,
    awayTeam: 'Milwaukee Brewers',
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: m,
    evidenceRefs: [`ev:${gameId}:identity`, `ev:${gameId}:schedule`, `ev:${gameId}:moneyline`, `ev:${gameId}:total`],
  };
}

function historyRow(market: MarketKey, over: Partial<TwoSidedHistoryRow> = {}): TwoSidedHistoryRow {
  const quote =
    market === 'moneyline'
      ? { line: null, away_odds_american: -134, away_odds_decimal: 1.74627, home_odds_american: 117, home_odds_decimal: 2.17 }
      : { line: 8.5, away_odds_american: -110, away_odds_decimal: 1.90909, home_odds_american: -110, home_odds_decimal: 1.90909 };
  return {
    id: 1,
    jsonodds_id: GAME_ID,
    market,
    source: 'jsonodds',
    ...quote,
    captured_at: OPENER_AT,
    captured_at_ms: Date.parse(OPENER_AT),
    ...over,
  };
}

function candidateInput(market: MarketKey, over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    gameId: GAME_ID,
    sport: 'mlb',
    market,
    sportAllowList: ['mlb'],
    marketPolicyVersion: MARKET_POLICY_VERSION,
    opener: historyRow(market),
    detectedAt: DETECTED_AT,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    cleanEntryWindowMs: W,
    maxClockSkewMs: SKEW,
    ...over,
  };
}

function sealInput(
  markets: readonly MarketKey[] = ['moneyline', 'total'],
  over: Partial<SealPreparedFireInput> = {},
): SealPreparedFireInput {
  const json = manifestJson();
  return {
    game: scopedGame(markets),
    slug: 'mil-pit-2026-07-18',
    slateDate: SLATE_DATE,
    bundleTimestamp: BUNDLE_TS,
    booted: bootFrom(json),
    publication: publicationFor(json),
    detectedAt: DETECTED_AT,
    bundleBuiltAt: BUNDLE_BUILT_AT,
    proposedMarkets: markets,
    perMarket: markets.map((m) => ({
      candidateInput: candidateInput(m),
      verdict: evaluateCandidate(candidateInput(m)),
      historyRows: [historyRow(m)],
      historyWatermark: null,
    })),
    ...over,
  };
}

function sealed(markets: readonly MarketKey[] = ['moneyline', 'total']): PreparedFireSnapshot {
  return sealPreparedFire(sealInput(markets));
}

/** Independent recomputation of the digest preimage (hand-built from the snapshot's
 *  public fields — NOT by calling the production helper), so dropping any documented
 *  field from the production preimage breaks this equality. */
function recomputeDigest(snap: PreparedFireSnapshot): string {
  return sha256Hex(
    canonicalize({
      domain: 'line-open-prepared-fire-digest-v1',
      cohortId: snap.booted.cohortId,
      publication: {
        publication: snap.publication.publication,
        committerTimestamp: snap.publication.committerTimestamp,
        cohortId: snap.publication.cohortId,
      },
      prepared: {
        gameId: snap.prepared.gameId,
        slug: snap.prepared.slug,
        requestBundle: snap.prepared.requestBundle,
        requestSha256: snap.prepared.requestSha256,
        gameSha256: snap.prepared.gameSha256,
        cutoffAt: snap.prepared.cutoffAt,
      },
      proposedMarkets: [...snap.proposedMarkets],
      detectedAt: snap.detectedAt,
      bundleBuiltAt: snap.bundleBuiltAt,
      perMarket: snap.perMarket.map((m) => ({
        market: m.market,
        candidateInput: m.candidateInput,
        verdict: m.verdict,
        historyRows: m.historyRows,
        historyWatermark: m.historyWatermark,
      })),
      expectedArmIdentities: snap.expectedArmIdentities.map((a) => ({
        participantId: a.participantId,
        provider: a.provider,
        requestedModelId: a.requestedModelId,
        approvedReportedModelIds: [...a.approvedReportedModelIds],
      })),
    }),
  );
}

function attemptMutation(fn: () => void): void {
  // A frozen assignment may throw (strict mode) or fail silently; either is fine —
  // the value must not change. So swallow the throw and assert the value afterwards.
  try {
    fn();
  } catch {
    /* frozen — throwing is acceptable */
  }
}

// A genuine digest for the fire-id operand tests.
const DIGEST_A = sha256Hex('digest-a');
const DIGEST_B = sha256Hex('digest-b');
const FIRE_ID_ARGS = {
  cohortId: 'cohort-1',
  gameId: GAME_ID,
  proposedMarkets: ['moneyline', 'total'] as MarketKey[],
  detectedAt: DETECTED_AT,
  preparedSnapshotDigest: DIGEST_A,
};

// ===========================================================================
// T2 — identity matrix
// ===========================================================================

test('deriveFireId is deterministic and canonical-order-insensitive on the market set', () => {
  const a = deriveFireId(FIRE_ID_ARGS);
  const b = deriveFireId({ ...FIRE_ID_ARGS });
  assert.equal(a, b);
  const reordered = deriveFireId({ ...FIRE_ID_ARGS, proposedMarkets: ['total', 'moneyline'] });
  assert.equal(a, reordered);
});

test('each of the five fire-id operands changes the id independently', () => {
  const base = deriveFireId(FIRE_ID_ARGS);
  assert.notEqual(base, deriveFireId({ ...FIRE_ID_ARGS, cohortId: 'cohort-2' }));
  assert.notEqual(base, deriveFireId({ ...FIRE_ID_ARGS, gameId: '00000000-0000-4000-8000-0000000000f2' }));
  assert.notEqual(base, deriveFireId({ ...FIRE_ID_ARGS, proposedMarkets: ['moneyline'] }));
  assert.notEqual(base, deriveFireId({ ...FIRE_ID_ARGS, detectedAt: '2026-07-18T12:00:31.000Z' }));
  assert.notEqual(base, deriveFireId({ ...FIRE_ID_ARGS, preparedSnapshotDigest: DIGEST_B }));
});

test('deriveRunId is deterministic, domain-separated, and never equals the fire id', () => {
  const fireId = deriveFireId(FIRE_ID_ARGS);
  const runId = deriveRunId(fireId);
  assert.equal(runId, deriveRunId(fireId));
  assert.notEqual(runId, fireId);
  assert.notEqual(runId, deriveRunId(deriveFireId({ ...FIRE_ID_ARGS, cohortId: 'other' })));
});

test('sealPreparedFire rejects an empty, duplicate, or unknown proposed market set', () => {
  assert.throws(() => sealPreparedFire(sealInput(['moneyline'], { proposedMarkets: [] })), (e) => e instanceof PreparedFireError && e.violations.some((v) => v.includes('nonempty')));
  assert.throws(
    () => sealPreparedFire(sealInput(['moneyline'], { proposedMarkets: ['moneyline', 'moneyline'] })),
    (e) => e instanceof PreparedFireError && e.violations.some((v) => v.includes('duplicate proposed market')),
  );
  assert.throws(
    () => sealPreparedFire(sealInput(['moneyline'], { proposedMarkets: ['moneyline', 'bogus' as MarketKey] })),
    (e) => e instanceof PreparedFireError && e.violations.some((v) => v.includes('unknown proposed market')),
  );
});

test('the sealed fire and run ids derive from the snapshot digest', () => {
  const snap = sealed();
  assert.equal(
    snap.fireId,
    deriveFireId({
      cohortId: snap.booted.cohortId,
      gameId: snap.prepared.gameId,
      proposedMarkets: snap.proposedMarkets,
      detectedAt: snap.detectedAt,
      preparedSnapshotDigest: snap.preparedSnapshotDigest,
    }),
  );
  assert.equal(snap.runId, deriveRunId(snap.fireId));
});

// ===========================================================================
// T3 — origin and foreign-authority rejection
// ===========================================================================

test('a genuine seal output authenticates; a structural copy does not', () => {
  const snap = sealed();
  assert.doesNotThrow(() => assertPreparedFireSnapshot(snap));
  assert.throws(() => assertPreparedFireSnapshot({ ...snap }), PreparedFireError);
});

test('a forged booted cohort is rejected', () => {
  const genuine = sealInput();
  const forgedBooted = { cohortId: genuine.booted.cohortId, manifest: genuine.booted.manifest } as BootedCohort;
  assert.throws(() => sealPreparedFire({ ...genuine, booted: forgedBooted }));
});

test('a forged publication is rejected', () => {
  const genuine = sealInput();
  const forgedPub = {
    publication: genuine.publication.publication,
    committerTimestamp: genuine.publication.committerTimestamp,
    cohortId: genuine.publication.cohortId,
  } as PublicationVerified;
  assert.throws(() => sealPreparedFire({ ...genuine, publication: forgedPub }));
});

test('a genuine publication verified for a different cohort is rejected', () => {
  const jsonA = manifestJson({ network: 'polygon' });
  const jsonB = manifestJson({ network: 'polygon-amoy' });
  const input = sealInput(['moneyline', 'total'], { booted: bootFrom(jsonA), publication: publicationFor(jsonB) });
  assert.throws(
    () => sealPreparedFire(input),
    (e) => e instanceof PreparedFireError && e.violations.some((v) => v.includes('not this cohort')),
  );
});

test('the prepared request the snapshot retains still authenticates', () => {
  const snap = sealed();
  assert.doesNotThrow(() => assertPrepared(snap.prepared));
});

// ===========================================================================
// T4 — deep immutability and source detachment
// ===========================================================================

test('the snapshot is deeply immutable — nested mutation leaves the value unchanged', () => {
  const snap = sealed(['moneyline', 'total']);
  const wm = snap.perMarket[0]!.historyRows[0]!;
  attemptMutation(() => ((wm as { away_odds_american: number }).away_odds_american = 999));
  assert.notEqual(snap.perMarket[0]!.historyRows[0]!.away_odds_american, 999);

  const price = snap.prepared.requestBundle.games[0]!.markets.moneyline!;
  attemptMutation(() => ((price as { awayDecimal: number }).awayDecimal = 42));
  assert.notEqual(snap.prepared.requestBundle.games[0]!.markets.moneyline!.awayDecimal, 42);

  attemptMutation(() => ((snap as { bundleBuiltAt: string }).bundleBuiltAt = 'x'));
  assert.equal(snap.bundleBuiltAt, BUNDLE_BUILT_AT);

  const roster = snap.expectedArmIdentities[0]!;
  attemptMutation(() => ((roster as { participantId: string }).participantId = 'tampered'));
  assert.notEqual(snap.expectedArmIdentities[0]!.participantId, 'tampered');
});

test('the snapshot is detached — mutating the caller source after sealing does not change it', () => {
  const input = sealInput(['moneyline', 'total']);
  const snap = sealPreparedFire(input);

  const beforeAway = snap.perMarket[0]!.historyRows[0]!.away_odds_american;
  (input.perMarket[0]!.historyRows[0] as { away_odds_american: number }).away_odds_american = 12345;
  assert.equal(snap.perMarket[0]!.historyRows[0]!.away_odds_american, beforeAway);

  const beforeDetected = snap.perMarket[0]!.candidateInput.detectedAt;
  (input.perMarket[0]!.candidateInput as { detectedAt: string }).detectedAt = '1999-01-01T00:00:00Z';
  assert.equal(snap.perMarket[0]!.candidateInput.detectedAt, beforeDetected);

  const beforeGameId = snap.prepared.game.gameId;
  (input.game as { gameId: string }).gameId = 'mutated-after-seal';
  assert.equal(snap.prepared.game.gameId, beforeGameId);
});

// ===========================================================================
// T5 — relational-coherence matrix
// ===========================================================================

function rejects(over: Partial<SealPreparedFireInput>, needle: string): void {
  assert.throws(
    () => sealPreparedFire(sealInput(['moneyline', 'total'], over)),
    (e) => e instanceof PreparedFireError && e.violations.some((v) => v.includes(needle)),
    `expected a violation containing "${needle}"`,
  );
}

test('rejects a candidate whose gameId does not match the request game', () => {
  const perMarket = sealInput().perMarket.map((m) =>
    m.candidateInput.market === 'moneyline'
      ? { ...m, candidateInput: candidateInput('moneyline', { gameId: '00000000-0000-4000-8000-0000000000f9' }) }
      : m,
  );
  rejects({ perMarket }, 'candidate gameId');
});

test('rejects proposed markets that differ from the request scope', () => {
  // Game supplies moneyline + total, but only moneyline is proposed.
  assert.throws(
    () => sealPreparedFire(sealInput(['moneyline', 'total'], {
      proposedMarkets: ['moneyline'],
      perMarket: [{ candidateInput: candidateInput('moneyline'), verdict: evaluateCandidate(candidateInput('moneyline')), historyRows: [historyRow('moneyline')], historyWatermark: null }],
    })),
    (e) => e instanceof PreparedFireError && e.violations.some((v) => v.includes('!= request scope')),
  );
});

test('rejects duplicate, missing, or foreign per-market evidence', () => {
  const base = sealInput(['moneyline', 'total']);
  const ml = base.perMarket.find((m) => m.candidateInput.market === 'moneyline')!;
  // duplicate
  rejects({ perMarket: [ml, ml, base.perMarket.find((m) => m.candidateInput.market === 'total')!] }, 'duplicate per-market evidence');
  // missing (only moneyline supplied for a moneyline+total scope)
  rejects({ perMarket: [ml] }, 'missing per-market evidence');
  // foreign (a spread entry that is not in scope)
  const spread = { candidateInput: candidateInput('spread'), verdict: evaluateCandidate(candidateInput('spread')), historyRows: [historyRow('spread')], historyWatermark: null };
  rejects({ perMarket: [...base.perMarket, spread] }, 'is not a proposed market');
});

test('rejects a history row bound to the wrong game or market', () => {
  const base = sealInput(['moneyline', 'total']);
  const perMarket = base.perMarket.map((m) =>
    m.candidateInput.market === 'total'
      ? { ...m, historyRows: [historyRow('total', { jsonodds_id: '00000000-0000-4000-8000-0000000000f9' })] }
      : m,
  );
  rejects({ perMarket }, 'does not bind to fire');
});

test('rejects a candidate whose detectedAt disagrees with the fire detection instant', () => {
  const base = sealInput(['moneyline', 'total']);
  const perMarket = base.perMarket.map((m) =>
    m.candidateInput.market === 'moneyline'
      ? { ...m, candidateInput: candidateInput('moneyline', { detectedAt: '2026-07-18T12:00:29.000Z' }), verdict: evaluateCandidate(candidateInput('moneyline', { detectedAt: '2026-07-18T12:00:29.000Z' })) }
      : m,
  );
  rejects({ perMarket }, 'detectedAt');
});

test('rejects a recorded verdict that does not match its re-derivation', () => {
  const base = sealInput(['moneyline', 'total']);
  const perMarket = base.perMarket.map((m) =>
    m.candidateInput.market === 'moneyline'
      ? { ...m, verdict: { state: 'not_enabled' as const } }
      : m,
  );
  rejects({ perMarket }, 'does not match its re-derivation');
});

test('rejects a non-offset detection or bundle-built instant', () => {
  rejects({ detectedAt: '2026-07-18 12:00:30' }, 'detectedAt');
  rejects({ bundleBuiltAt: 'not-an-instant' }, 'bundleBuiltAt');
});

// ===========================================================================
// T6 — digest matrix
// ===========================================================================

test('the preparation digest is deterministic and independently recomputable', () => {
  const snap = sealed(['moneyline', 'total']);
  assert.equal(snap.preparedSnapshotDigest, recomputeDigest(snap));
  // Determinism: a second seal of the same input yields the same digest + ids.
  const again = sealed(['moneyline', 'total']);
  assert.equal(again.preparedSnapshotDigest, snap.preparedSnapshotDigest);
  assert.equal(again.fireId, snap.fireId);
});

test('canonical market input order produces the same digest', () => {
  const forward = sealPreparedFire(sealInput(['moneyline', 'total']));
  const reversed = sealPreparedFire(
    sealInput(['moneyline', 'total'], {
      proposedMarkets: ['total', 'moneyline'],
      perMarket: [
        { candidateInput: candidateInput('total'), verdict: evaluateCandidate(candidateInput('total')), historyRows: [historyRow('total')], historyWatermark: null },
        { candidateInput: candidateInput('moneyline'), verdict: evaluateCandidate(candidateInput('moneyline')), historyRows: [historyRow('moneyline')], historyWatermark: null },
      ],
    }),
  );
  assert.equal(reversed.preparedSnapshotDigest, forward.preparedSnapshotDigest);
  assert.equal(reversed.fireId, forward.fireId);
});

test('changing each digest field class changes the digest and the fire id', () => {
  const base = sealed(['moneyline', 'total']);

  const otherCohort = sealPreparedFire(sealInput(['moneyline', 'total'], { booted: bootFrom(manifestJson({ network: 'polygon-amoy' })), publication: publicationFor(manifestJson({ network: 'polygon-amoy' })) }));
  assert.notEqual(otherCohort.preparedSnapshotDigest, base.preparedSnapshotDigest);
  assert.notEqual(otherCohort.fireId, base.fireId);

  const otherDetected = sealPreparedFire(sealInput(['moneyline', 'total'], {
    detectedAt: '2026-07-18T12:00:31.000Z',
    perMarket: ['moneyline', 'total'].map((m) => ({ candidateInput: candidateInput(m as MarketKey, { detectedAt: '2026-07-18T12:00:31.000Z' }), verdict: evaluateCandidate(candidateInput(m as MarketKey, { detectedAt: '2026-07-18T12:00:31.000Z' })), historyRows: [historyRow(m as MarketKey)], historyWatermark: null })),
  }));
  assert.notEqual(otherDetected.preparedSnapshotDigest, base.preparedSnapshotDigest);
  assert.notEqual(otherDetected.fireId, base.fireId);

  const otherBuilt = sealPreparedFire(sealInput(['moneyline', 'total'], { bundleBuiltAt: '2026-07-18T12:00:32.000Z' }));
  assert.notEqual(otherBuilt.preparedSnapshotDigest, base.preparedSnapshotDigest);
  assert.notEqual(otherBuilt.fireId, base.fireId);

  const otherScope = sealed(['moneyline']);
  assert.notEqual(otherScope.preparedSnapshotDigest, base.preparedSnapshotDigest);
  assert.notEqual(otherScope.fireId, base.fireId);

  const otherWatermark = sealPreparedFire(sealInput(['moneyline', 'total'], {
    perMarket: ['moneyline', 'total'].map((m) => ({ candidateInput: candidateInput(m as MarketKey), verdict: evaluateCandidate(candidateInput(m as MarketKey)), historyRows: [historyRow(m as MarketKey)], historyWatermark: 5 })),
  }));
  assert.notEqual(otherWatermark.preparedSnapshotDigest, base.preparedSnapshotDigest);
  assert.notEqual(otherWatermark.fireId, base.fireId);
});

// ===========================================================================
// Identity-domain closure — the exported deriveFireId validates directly, and the
// canonical-order owner is runtime-immutable so identity is stable.
// ===========================================================================

test('deriveFireId rejects an empty, duplicate, or unknown market set directly', () => {
  assert.throws(() => deriveFireId({ ...FIRE_ID_ARGS, proposedMarkets: [] }), PreparedFireError);
  assert.throws(() => deriveFireId({ ...FIRE_ID_ARGS, proposedMarkets: ['moneyline', 'moneyline'] }), PreparedFireError);
  assert.throws(() => deriveFireId({ ...FIRE_ID_ARGS, proposedMarkets: ['bogus' as MarketKey] }), PreparedFireError);
});

test('the canonical market-order owner is runtime-frozen, so the fire id is stable against ambient mutation', () => {
  assert.equal(Object.isFrozen(MARKET_ORDINAL), true);
  const before = deriveFireId(FIRE_ID_ARGS);
  const savedMoneyline = MARKET_ORDINAL.moneyline;
  const savedTotal = MARKET_ORDINAL.total;
  try {
    // Tolerates throw (strict-mode frozen assignment) or silent rejection; the values
    // must not change and the same identity input must still produce the same id.
    attemptMutation(() => ((MARKET_ORDINAL as Record<string, number>).moneyline = 99));
    attemptMutation(() => ((MARKET_ORDINAL as Record<string, number>).total = -5));
    assert.equal(MARKET_ORDINAL.moneyline, 0);
    assert.equal(MARKET_ORDINAL.total, 2);
    assert.equal(deriveFireId(FIRE_ID_ARGS), before);
  } finally {
    // Restore defensively so a weakened-freeze negative-control run cannot pollute
    // later tests (a no-op when the owner is genuinely frozen).
    attemptMutation(() => {
      (MARKET_ORDINAL as Record<string, number>).moneyline = savedMoneyline;
      (MARKET_ORDINAL as Record<string, number>).total = savedTotal;
    });
  }
});

// ===========================================================================
// Capture-once — a swapping getter cannot substitute a post-check value.
// Each getter returns the genuine/valid value on the FIRST read and a forged/invalid
// value thereafter; the seal must read it exactly once and retain the first value.
// ===========================================================================

/** Wrap `base` so property `key` returns `first` on the first access and `rest`
 *  after, counting reads — a probe for the single-read (capture-once) invariant. */
function swappingProp<T extends object>(
  base: T,
  key: keyof T & string,
  first: unknown,
  rest: unknown,
): { value: T; counter: { reads: number } } {
  const counter = { reads: 0 };
  const value = { ...base } as T;
  Object.defineProperty(value, key, {
    get() {
      counter.reads += 1;
      return counter.reads === 1 ? first : rest;
    },
    enumerable: true,
    configurable: true,
  });
  return { value, counter };
}

test('capture-once: a swapping booted getter is read once and the authenticated cohort is retained', () => {
  const json = manifestJson();
  const booted = bootFrom(json);
  const publication = publicationFor(json);
  const forgedBooted = { cohortId: booted.cohortId, manifest: booted.manifest } as BootedCohort;
  const { value: input, counter } = swappingProp(
    sealInput(['moneyline', 'total'], { booted, publication }),
    'booted',
    booted,
    forgedBooted,
  );
  const snap = sealPreparedFire(input);
  assert.equal(counter.reads, 1);
  assert.strictEqual(snap.booted, booted);
  assert.doesNotThrow(() => assertBootedCohort(snap.booted));
});

test('capture-once: a swapping publication getter is read once and the verified publication is retained', () => {
  const json = manifestJson();
  const booted = bootFrom(json);
  const publication = publicationFor(json);
  const forgedPub = {
    publication: publication.publication,
    committerTimestamp: publication.committerTimestamp,
    cohortId: publication.cohortId,
  } as PublicationVerified;
  const { value: input, counter } = swappingProp(
    sealInput(['moneyline', 'total'], { booted, publication }),
    'publication',
    publication,
    forgedPub,
  );
  const snap = sealPreparedFire(input);
  assert.equal(counter.reads, 1);
  assert.strictEqual(snap.publication, publication);
  assert.doesNotThrow(() => assertPublicationVerified(snap.publication));
});

test('capture-once: a swapping detectedAt getter is read once and the validated instant is retained', () => {
  const { value: input, counter } = swappingProp(sealInput(['moneyline', 'total']), 'detectedAt', DETECTED_AT, 'not-an-instant');
  const snap = sealPreparedFire(input);
  assert.equal(counter.reads, 1);
  assert.equal(snap.detectedAt, DETECTED_AT);
  assert.equal(isParseableInstant(snap.detectedAt), true);
});

test('capture-once: a swapping bundleBuiltAt getter is read once and the validated instant is retained', () => {
  const { value: input, counter } = swappingProp(sealInput(['moneyline', 'total']), 'bundleBuiltAt', BUNDLE_BUILT_AT, 'not-an-instant');
  const snap = sealPreparedFire(input);
  assert.equal(counter.reads, 1);
  assert.equal(snap.bundleBuiltAt, BUNDLE_BUILT_AT);
  assert.equal(isParseableInstant(snap.bundleBuiltAt), true);
});

test('capture-once: a swapping per-market historyRows getter is read once and the correct-game rows are retained', () => {
  const goodRows = [historyRow('total')];
  const badRows = [historyRow('total', { jsonodds_id: '00000000-0000-4000-8000-0000000000f9' })];
  const baseEntry: PreparedMarketEvidenceInput = {
    candidateInput: candidateInput('total'),
    verdict: evaluateCandidate(candidateInput('total')),
    historyRows: [historyRow('total')], // placeholder; overridden by the swapping getter
    historyWatermark: null,
  };
  const { value: entry, counter } = swappingProp(baseEntry, 'historyRows', goodRows, badRows);
  const snap = sealPreparedFire(
    sealInput(['total'], { proposedMarkets: ['total'], game: scopedGame(['total']), perMarket: [entry] }),
  );
  assert.equal(counter.reads, 1);
  for (const row of snap.perMarket[0]!.historyRows) assert.equal(row.jsonodds_id, GAME_ID);
});

test('capture-once: a swapping per-market historyWatermark getter is read once and the validated value is retained', () => {
  const baseEntry: PreparedMarketEvidenceInput = {
    candidateInput: candidateInput('total'),
    verdict: evaluateCandidate(candidateInput('total')),
    historyRows: [historyRow('total')],
    historyWatermark: null, // placeholder; overridden by the swapping getter
  };
  const { value: entry, counter } = swappingProp(baseEntry, 'historyWatermark', null, -1);
  const snap = sealPreparedFire(
    sealInput(['total'], { proposedMarkets: ['total'], game: scopedGame(['total']), perMarket: [entry] }),
  );
  assert.equal(counter.reads, 1);
  assert.equal(snap.perMarket[0]!.historyWatermark, null);
});
