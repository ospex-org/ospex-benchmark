import assert from 'node:assert/strict';
import { toolInferenceConfigSha256 } from './toolInferenceConfig.js';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256Hex } from './canonical.js';
import { redactSecrets } from './config.js';
import { cohortBoot } from './cohortBoot.js';
import { evaluateCandidate } from './detection.js';
import { armDigest } from './fireArtifact.js';
import { buildFireArtifact } from './fireArtifactProducer.js';
import type { FireContext, MarketFireContextV1 } from './fireArtifactProducer.js';
import {
  isCoherentPreRetentionFireArtifact,
  parseFireArtifactV1,
  recomputeFireArtifactDigests,
  serializeFireArtifactV1,
  verifyFireArtifactEnvelopes,
  verifyFireArtifactReplay,
  verifyFireArtifactRelations,
  writeFireArtifactV1,
} from './fireArtifactWriter.js';
import { ProviderTimeoutError, ProviderUnreadableResponseError } from './providers/errors.js';
import { sealResponseEnvelope } from './providers/responseEnvelope.js';
import { checkPublication } from './manifestPublication.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { MODEL_PRICE_TABLE_DIGEST, MODEL_PRICE_TABLE_VERSION } from './modelPriceTable.js';
import { promptScaffoldSha256 } from './prompt.js';
import { runSlate } from './runner.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import { SMOKE_LABEL } from './types.js';
import type { BootedCohort } from './cohortBoot.js';
import type { CandidateInput } from './detection.js';
import type { FireArtifactV1 } from './fireArtifactProducer.js';
import type { PublicationVerified } from './manifestPublication.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type { RunEnvelope } from './runner.js';
import type { GameRequest } from './bundle.js';
import type {
  ArmSpec,
  BenchmarkResponse,
  ForecastOutput,
  GameBundle,
  MarketKey,
  ProviderAdapter,
  ProviderName,
  ProviderResponse,
  ProviderResponseEnvelope,
  SlateBundle,
} from './types.js';
import { fixtureEnvelope } from './testFactories.js';

/**
 * The fire-artifact write path (SPEC §4/§5): serialize / parse / replay / write. Each
 * test drives a REAL produced artifact through `buildFireArtifact`, then either
 * round-trips it or mutates the PARSED (unbranded) value to prove one persisted
 * invariant fails closed. In-armDigest-domain tampers recompute the arm digest so the
 * targeted check is proven load-bearing, never masked by a stale downstream digest.
 */

const GAME_ID = '00000000-0000-4000-8000-0000000000f1';
const CUTOFF = '2026-07-18T20:00:00+00:00';
const WINDOW_START = '2026-07-18T00:00:00.000Z';
const WINDOW_END = '2026-07-19T00:00:00.000Z';
const BUNDLE_TS = '2026-07-18T12:00:00.000Z';
const DETECTED_AT = '2026-07-18T12:00:30.000Z';
const OPENER_AT = '2026-07-18T11:59:30.000Z';
const OBSERVED_AT = '2026-07-18T11:58:00+00:00';
const BUNDLE_BUILT_AT = '2026-07-18T12:00:31.000Z';
const COMMITTER_TS = '2026-07-17T23:00:00+00:00';
const NOW_MS = Date.parse('2026-07-18T12:00:40.000Z');
const W = 120_000;
const SKEW = 5_000;
const AWAY_TEAM = 'Milwaukee Brewers';
/** A string that appears ONLY inside an unreadable-2xx leg's retained body, so a case
 *  can tell "the body reached the file" from "the file merely verified". */
const UNREADABLE_BODY_MARKER = 'unreadable-2xx-body-4f10c3';

const CODE_ARMS = defaultExpectedArms();
const ARMS: ArmSpec[] = CODE_ARMS.map((a) => ({
  participantId: a.participantId,
  provider: a.provider as ProviderName,
  requestedModelId: a.requestedModelId,
  credentialEnvVar: `${a.participantId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_KEY`,
  configuration: {},
}));

// --- fixtures (a real produced fire) ----------------------------------------

function scopedGame(markets: readonly MarketKey[], awayTeam = AWAY_TEAM): GameBundle {
  const m: GameBundle['markets'] = {};
  if (markets.includes('moneyline')) {
    m.moneyline = { awayDecimal: 1.74627, homeDecimal: 2.17, observedAt: OBSERVED_AT, evidenceRef: `ev:${GAME_ID}:moneyline` };
  }
  if (markets.includes('total')) {
    m.total = { line: 8.5, overDecimal: 1.90909, underDecimal: 1.90909, observedAt: OBSERVED_AT, evidenceRef: `ev:${GAME_ID}:total` };
  }
  return {
    gameId: GAME_ID,
    league: 'mlb',
    scheduledStartUtc: CUTOFF,
    awayTeam,
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: m,
    evidenceRefs: [`ev:${GAME_ID}:identity`, `ev:${GAME_ID}:schedule`, `ev:${GAME_ID}:moneyline`, `ev:${GAME_ID}:total`],
  };
}

function scopedRequest(markets: readonly MarketKey[], awayTeam = AWAY_TEAM): GameRequest {
  const game = scopedGame(markets, awayTeam);
  const requestBundle: SlateBundle = {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate: '2026-07-18',
    bundleTimestamp: BUNDLE_TS,
    cutoffAt: CUTOFF,
    games: [game],
  };
  return { gameId: GAME_ID, slug: 'mil-pit-2026-07-18', game, requestBundle, requestSha256: sha256Hex(canonicalize(requestBundle)) };
}

function scopedResponse(req: GameRequest, arm: ArmSpec, cohortId: string): BenchmarkResponse {
  const game = req.game;
  const forecasts: ForecastOutput[] = [];
  if (game.markets.moneyline) {
    const ml = game.markets.moneyline;
    forecasts.push({
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
    });
  }
  if (game.markets.total) {
    const total = game.markets.total;
    forecasts.push({
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
      axes: { valuation: 1, trend: 1, consensus: 1, news: 1, softness: 1 },
      primaryAxis: null,
      primaryExpectation: 'No material movement is expected in this total before close.',
    });
  }
  return {
    schemaVersion: 2,
    cohortId,
    participantId: arm.participantId,
    requestedModelId: arm.requestedModelId,
    bundleSha256: req.requestSha256,
    executionPolicy: 'fixed-moneyline-total',
    games: [{ gameId: game.gameId, forecasts }],
  };
}

function stubResponse(
  rawText: string,
  reportedModelId: string,
  responseEnvelope: ProviderResponseEnvelope = fixtureEnvelope(rawText),
): ProviderResponse {
  return {
    rawText,
    responseEnvelope,
    reportedModelId,
    providerResponseId: 'stub-response',
    httpStatus: 200,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    usageRaw: { prompt_tokens: 100, completion_tokens: 50 },
    requestParams: { stub: true },
    searchAudit: null,
  };
}

function stubAdapter(arm: ArmSpec, handler: () => ProviderResponse): ProviderAdapter {
  return {
    provider: arm.provider,
    requestedModelId: arm.requestedModelId,
    credentialEnvVar: arm.credentialEnvVar,
    hasCredential: () => true,
    async chat(): Promise<ProviderResponse> {
      return handler();
    },
  };
}

function manifestJson(): string {
  return JSON.stringify({
    artifactSchemaVersion: 1,
    network: 'polygon',
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
      configuration: a.configuration,
    })),
    toolInferenceConfigSha256: toolInferenceConfigSha256(),
    baselinePolicyVersion: 'baselines-v0.3.0',
    repairPolicyVersion: 'repair-v1',
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    uncertaintyPolicyVersion: 'uncertainty-v1',
    modelPriceTableVersion: MODEL_PRICE_TABLE_VERSION,
    modelPriceTableDigest: MODEL_PRICE_TABLE_DIGEST,
    spendReservationPolicyVersion: 'fixed-attempt-v1',
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
      providerAttemptReservationUsdMicros: 100_000_000,
      ingestionGraceMs: 900_000,
      scheduleChangeToleranceMs: 60_000,
      maxConcurrentProviderRequests: Math.max(8, CODE_ARMS.length),
      maxDispatchesPerTick: 8,
    },
    cohortCallCap: 1_000,
    cohortSpendCapUsdMicros: 1_000_000,
  });
}

function publicationFor(json: string): PublicationVerified {
  const bytes = new TextEncoder().encode(json);
  return checkPublication({
    localManifestBytes: bytes,
    publication: { repositoryOwner: 'ospex-org', repositoryName: 'ospex-benchmark', path: 'manifests/cohort.json', commitSha: 'a'.repeat(40) },
    resolved: { blobBytes: bytes, committerTimestamp: COMMITTER_TS },
  });
}

function historyRow(market: MarketKey): TwoSidedHistoryRow {
  const quote =
    market === 'moneyline'
      ? { line: null, away_odds_american: -134, away_odds_decimal: 1.74627, home_odds_american: 117, home_odds_decimal: 2.17 }
      : { line: 8.5, away_odds_american: -110, away_odds_decimal: 1.90909, home_odds_american: -110, home_odds_decimal: 1.90909 };
  return { id: 1, jsonodds_id: GAME_ID, market, source: 'jsonodds', ...quote, captured_at: OPENER_AT, captured_at_ms: Date.parse(OPENER_AT) };
}

function candidateInput(market: MarketKey): CandidateInput {
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
  };
}

function marketCtx(market: MarketKey, cohortId: string, fireId: string): MarketFireContextV1 {
  const ci = candidateInput(market);
  return {
    candidateInput: ci,
    verdict: evaluateCandidate(ci),
    historyRows: [historyRow(market)],
    historyWatermark: null,
    claim: { cohortId, fireId, gameId: GAME_ID, market },
  };
}

interface FireOpts {
  markets?: readonly MarketKey[];
  awayTeam?: string;
  /**
   * What each arm's provider does. `repair` echoes a wrong cohort id first (schema-
   * invalid, fingerprint-preserving) so `runSlate` sends a real second leg; `timeout`
   * throws the typed timeout so the arm settles with nothing received. `unreadable`
   * throws the typed unreadable-2xx error — a response that DID come back, carrying a
   * sealed body, whose content fields all persist as `null`: the one leg class where
   * `httpStatus` is the only receipt carrier left standing.
   */
  behaviourFor?: (arm: ArmSpec) => 'valid' | 'repair' | 'timeout' | 'unreadable';
  /** Override the retained response envelope, given the answer text and the leg. */
  envelopeFor?: (rawText: string, leg: 'initial' | 'repair') => ProviderResponseEnvelope;
}

/**
 * The two halves of a produced fire, kept separable so a test can run the SLATE under
 * one environment and the ARTIFACT BUILD under another — which is the only way to hand
 * the mapper a response body that was sealed before a credential was configured.
 */
async function fireParts(opts: FireOpts = {}): Promise<{ env: RunEnvelope; ctx: FireContext }> {
  const markets = opts.markets ?? (['moneyline', 'total'] as const);
  const awayTeam = opts.awayTeam ?? AWAY_TEAM;
  const json = manifestJson();
  const booted: BootedCohort = cohortBoot({ manifestBytes: json });
  const publication = publicationFor(json);
  const cohortId = booted.cohortId;
  const request = scopedRequest(markets, awayTeam);
  const adapters = new Map<string, ProviderAdapter>();
  for (const arm of ARMS) {
    const behaviour = opts.behaviourFor?.(arm) ?? 'valid';
    let calls = 0;
    adapters.set(
      arm.participantId,
      stubAdapter(arm, () => {
        calls += 1;
        if (behaviour === 'timeout') throw new ProviderTimeoutError(arm.provider, 600_000);
        if (behaviour === 'unreadable') {
          throw new ProviderUnreadableResponseError({
            provider: arm.provider,
            httpStatus: 200,
            detail: 'response body did not parse',
            responseEnvelope: sealResponseEnvelope(JSON.stringify({ unreadable: UNREADABLE_BODY_MARKER })),
          });
        }
        // The leg this call IS, not the behaviour that produced it: a repair is only
        // ever the second call, so the label matches the persisted attempt's `kind`.
        const leg: 'initial' | 'repair' = calls === 1 ? 'initial' : 'repair';
        const body = scopedResponse(request, arm, cohortId);
        // A wrong cohort echo fails validation while preserving the decision
        // fingerprint exactly, which is what makes the repair leg admissible.
        const answer = JSON.stringify(behaviour === 'repair' && calls === 1 ? { ...body, cohortId: 'wrong-cohort-echo' } : body);
        return stubResponse(answer, arm.requestedModelId, opts.envelopeFor?.(answer, leg) ?? fixtureEnvelope(answer));
      }),
    );
  }
  const env: RunEnvelope = await runSlate([...ARMS], adapters, [request], {
    cohortId,
    timeoutMs: 600_000,
    maxOutputTokens: 16_000,
    executionPolicy: 'fixed-moneyline-total',
    baselinePolicyVersion: 'baselines-v0.3.0',
    nowMs: () => NOW_MS,
  });
  const ctx: FireContext = {
    booted,
    fireId: 'fire-1',
    runId: 'run-1',
    publication,
    bundleBuiltAt: BUNDLE_BUILT_AT,
    perMarket: markets.map((m) => marketCtx(m, cohortId, 'fire-1')),
  };
  return { env, ctx };
}

async function producedFire(opts: FireOpts = {}): Promise<FireArtifactV1> {
  const { env, ctx } = await fireParts(opts);
  return buildFireArtifact(env, ctx);
}

/** Parse a produced artifact into a mutable, unbranded value (a persisted read-back). */
async function parsedFire(opts?: FireOpts): Promise<FireArtifactV1> {
  const artifact = await producedFire(opts);
  return parseFireArtifactV1(serializeFireArtifactV1(artifact));
}

/** Apply a patch to arm `index` and RECOMPUTE its armDigest, so a targeted in-domain
 *  tamper leaves the arm digest coherent (the specific check must catch it alone). */
function patchArmCoherent(artifact: FireArtifactV1, index: number, patch: Partial<FireArtifactV1['arms'][number]>): FireArtifactV1 {
  const arm = { ...artifact.arms[index]!, ...patch };
  arm.armDigest = armDigest({
    cohortId: artifact.cohortId,
    fireId: artifact.fireId,
    runId: artifact.runId,
    participantId: arm.expectedArmIdentity.participantId,
    requestSha256: artifact.requestSha256,
    expectedArmIdentity: arm.expectedArmIdentity,
    orderedAttempts: arm.orderedAttempts,
    terminalOutcome: arm.terminalOutcome,
    acceptedResponseDigestOrNull: arm.acceptedResponseDigest,
    acceptedDecisionFingerprintOrNull: arm.acceptedDecisionFingerprint,
  });
  return { ...artifact, arms: artifact.arms.map((a, i) => (i === index ? arm : a)) };
}

function has(violations: string[], needle: string): boolean {
  return violations.some((v) => v.includes(needle));
}

function withEnv(name: string, value: string, fn: () => void): void {
  const original = process.env[name];
  process.env[name] = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

/** Run with a credential variable definitively UNSET. Named rather than folded into
 *  `withEnv` because "absent" is a state the redaction cases have to control: a value
 *  left over in the developer's shell would silently change what redaction does, and
 *  the negative control that proves redaction is doing the work depends on it (rule 4c). */
function withEnvAbsent(name: string, fn: () => void): void {
  const original = process.env[name];
  delete process.env[name];
  try {
    fn();
  } finally {
    if (original !== undefined) process.env[name] = original;
  }
}

/** The async form: the environment has to cover the whole slate run, not just the call
 *  that starts it. */
async function withEnvAsync<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

/** The fire artifacts this machine has actually written. `.fire-artifacts/` is
 *  gitignored, so this is local evidence and may legitimately be empty elsewhere. */
function archivedFireArtifacts(): string[] {
  const base = fileURLToPath(new URL('../.fire-artifacts', import.meta.url));
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(base, entry.name))
        .filter((name) => name.startsWith('fire-') && name.endsWith('.json'))
        .map((name) => join(base, entry.name, name)),
    );
}

// --- happy path -------------------------------------------------------------

test('serialize is canonical, deterministic, valid JSON, and requires the producer brand', async () => {
  const a = await producedFire();
  const sa = serializeFireArtifactV1(a);
  assert.equal(sa, serializeFireArtifactV1(a));
  assert.equal(sa, canonicalize(a));
  assert.doesNotThrow(() => JSON.parse(sa));
});

test('serialize and write reject an unbranded structural copy', async () => {
  const a = await producedFire();
  const copy = JSON.parse(JSON.stringify(a)) as FireArtifactV1;
  assert.throws(() => serializeFireArtifactV1(copy), /not produced by buildFireArtifact/);
  const dir = mkdtempSync(join(tmpdir(), 'ospex-fire-'));
  try {
    const filePath = join(dir, 'copy.json');
    assert.throws(() => writeFireArtifactV1(filePath, copy), /not produced by buildFireArtifact/);
    assert.ok(!existsSync(filePath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serialize → parse round-trips unchanged for one-market and co-arrival fires', async () => {
  for (const markets of [['moneyline'], ['total'], ['moneyline', 'total']] as MarketKey[][]) {
    const a = await producedFire({ markets });
    assert.deepEqual(parseFireArtifactV1(serializeFireArtifactV1(a)), JSON.parse(JSON.stringify(a)));
  }
});

test('parse fails closed on malformed JSON and on a nested unknown field', async () => {
  assert.throws(() => parseFireArtifactV1('{ not json'));
  const a = await producedFire();
  const obj = JSON.parse(serializeFireArtifactV1(a));
  obj.arms[0].sneaky = 1; // nested unknown
  assert.throws(() => parseFireArtifactV1(JSON.stringify(obj)));
});

test('verifyFireArtifactReplay is empty on produced fires and a write→read→parse replay stays clean', async () => {
  assert.deepEqual(verifyFireArtifactReplay(await parsedFire({ markets: ['moneyline'] })), []);
  const artifact = await producedFire();
  assert.deepEqual(verifyFireArtifactReplay(parseFireArtifactV1(serializeFireArtifactV1(artifact))), []);
  const dir = mkdtempSync(join(tmpdir(), 'ospex-fire-'));
  try {
    const filePath = join(dir, 'fire-1.json');
    writeFireArtifactV1(filePath, artifact);
    const bytes = readFileSync(filePath, 'utf8');
    assert.equal(bytes, serializeFireArtifactV1(artifact));
    assert.deepEqual(verifyFireArtifactReplay(parseFireArtifactV1(bytes)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- redaction chokepoint ---------------------------------------------------

test('a configured credential in a retained field refuses serialize and write (no file)', async () => {
  const artifact = await producedFire(); // clean: away team present, no credential configured
  withEnv('OPENAI_API_KEY', AWAY_TEAM, () => {
    assert.throws(() => serializeFireArtifactV1(artifact), /unredacted configured credential/);
    const dir = mkdtempSync(join(tmpdir(), 'ospex-fire-'));
    try {
      const filePath = join(dir, 'leak.json');
      assert.throws(() => writeFireArtifactV1(filePath, artifact), /unredacted configured credential/);
      assert.ok(!existsSync(filePath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('a JSON-escaped configured credential is caught field-level (a serialized-string sweep misses it)', async () => {
  const secret = 'Brewers"Quote-Secret'; // a schema-valid team name containing a quote
  const artifact = await producedFire({ awayTeam: secret });
  withEnv('OPENAI_API_KEY', secret, () => {
    // A string sweep over the SERIALIZED bytes misses it: canonical JSON escapes the
    // quote, so the raw credential substring is absent from the serialized form.
    const serializedEscaped = canonicalize(artifact);
    assert.ok(serializedEscaped.includes('Brewers\\"Quote-Secret'));
    assert.equal(redactSecrets(serializedEscaped), serializedEscaped); // sweep leaves it in
    // The field-level check catches it and refuses.
    assert.throws(() => serializeFireArtifactV1(artifact), /unredacted configured credential/);
  });
});

// --- digest / accepted-body replay teeth (each asserts its specific violation) ---

test('replay catches a tampered requestSha256', async () => {
  const t = { ...(await parsedFire()), requestSha256: 'b'.repeat(64) };
  assert.ok(has(verifyFireArtifactReplay(t), 'requestSha256 does not recompute'));
});

test('replay catches a tampered gameSha256', async () => {
  const t = { ...(await parsedFire()), gameSha256: 'b'.repeat(64) };
  assert.ok(has(verifyFireArtifactReplay(t), 'gameSha256 does not recompute'));
});

test('replay catches a tampered slateSha256 (previously outside replay)', async () => {
  const t = { ...(await parsedFire()), slateSha256: 'b'.repeat(64) };
  assert.ok(has(verifyFireArtifactReplay(t), 'slateSha256 does not recompute'));
});

test('replay catches a tampered attempt responseSha256', async () => {
  const parsed = await parsedFire();
  const arm0 = { ...parsed.arms[0]!, orderedAttempts: parsed.arms[0]!.orderedAttempts.map((a, i) => (i === 0 ? { ...a, responseSha256: 'b'.repeat(64) } : a)) };
  const t = { ...parsed, arms: [arm0, ...parsed.arms.slice(1)] };
  assert.ok(has(verifyFireArtifactReplay(t), 'responseSha256 does not match'));
});

test('replay catches an acceptedResponseDigest not linked to the accepted attempt (armDigest recomputed)', async () => {
  const parsed = await parsedFire();
  const t = patchArmCoherent(parsed, 0, { acceptedResponseDigest: 'f'.repeat(64) });
  const violations = verifyFireArtifactReplay(t);
  assert.ok(has(violations, 'acceptedResponseDigest is not the accepted attempt'));
  assert.ok(!has(violations, 'armDigest does not recompute')); // isolated: digest stays coherent
});

test('replay catches an accepted fingerprint that disagrees with the retained body (armDigest recomputed)', async () => {
  const parsed = await parsedFire();
  const fp = parsed.arms[0]!.acceptedDecisionFingerprint!;
  const mutatedFp = fp.map((e, i) => (i === 0 ? { ...e, confidence: e.confidence + 0.1 } : e));
  const t = patchArmCoherent(parsed, 0, { acceptedDecisionFingerprint: mutatedFp });
  const violations = verifyFireArtifactReplay(t);
  assert.ok(has(violations, 'does not re-derive from the retained accepted body'));
  assert.ok(!has(violations, 'armDigest does not recompute'));
});

test('replay catches a tampered armDigest', async () => {
  const parsed = await parsedFire();
  const arm0 = { ...parsed.arms[0]!, armDigest: 'c'.repeat(64) };
  const t = { ...parsed, arms: [arm0, ...parsed.arms.slice(1)] };
  assert.ok(has(verifyFireArtifactReplay(t), 'armDigest does not recompute'));
});

// --- relational replay teeth ------------------------------------------------

test('replay catches a non-canonical attempt number (armDigest recomputed)', async () => {
  const parsed = await parsedFire();
  const renumbered = parsed.arms[0]!.orderedAttempts.map((a, i) => (i === 0 ? { ...a, attemptNumber: 2 } : a));
  const t = patchArmCoherent(parsed, 0, { orderedAttempts: renumbered });
  const violations = verifyFireArtifactReplay(t);
  assert.ok(has(violations, 'not canonically numbered'));
  assert.ok(!has(violations, 'armDigest does not recompute'));
});

test('replay catches non-causal attempt timing (armDigest recomputed)', async () => {
  const parsed = await parsedFire();
  const badTiming = parsed.arms[0]!.orderedAttempts.map((a, i) => (i === 0 ? { ...a, requestReceivedAt: '2020-01-01T00:00:00.000Z' } : a));
  const t = patchArmCoherent(parsed, 0, { orderedAttempts: badTiming });
  const violations = verifyFireArtifactReplay(t);
  assert.ok(has(violations, 'requestStartedAt is after requestReceivedAt'));
  assert.ok(!has(violations, 'armDigest does not recompute'));
});

test('replay catches a foreign top-level game identity', async () => {
  const t = { ...(await parsedFire()), gameId: 'foreign-game' };
  assert.ok(has(verifyFireArtifactReplay(t), 'gameId does not equal the retained request game id'));
});

test('replay catches tampered top-level identity aliases (sport, preparedSnapshotTs, scheduledAtAtFire)', async () => {
  const base = await parsedFire();
  assert.ok(has(verifyFireArtifactRelations({ ...base, sport: 'nfl' }), 'sport does not equal'));
  assert.ok(has(verifyFireArtifactRelations({ ...base, preparedSnapshotTs: '2026-07-18T13:00:00.000Z' }), 'preparedSnapshotTs does not equal'));
  assert.ok(has(verifyFireArtifactRelations({ ...base, scheduledAtAtFire: '2026-07-18T21:00:00+00:00' }), 'scheduledAtAtFire does not equal'));
});

test('replay catches a scope reduction not matched by the request markets', async () => {
  const parsed = await parsedFire({ markets: ['moneyline', 'total'] });
  const t = { ...parsed, scopedMarkets: ['moneyline'] as MarketKey[] };
  assert.ok(has(verifyFireArtifactReplay(t), 'scopedMarkets do not equal the present retained-request markets'));
});

test('replay catches a foreign market-evidence opener identity', async () => {
  const parsed = await parsedFire();
  const me0 = { ...parsed.marketEvidence[0]!, opener: { ...parsed.marketEvidence[0]!.opener, jsonodds_id: 'foreign-game' } };
  const t = { ...parsed, marketEvidence: [me0, ...parsed.marketEvidence.slice(1)] };
  assert.ok(has(verifyFireArtifactReplay(t), 'opener identity does not bind'));
});

test('replay catches a per-market claim not bound to the fire identity', async () => {
  // marketEvidence[].claim is the SOLE authoritative claim carrier; a claim whose
  // fire identity is substituted must fail replay (no top-level claims[] to disagree).
  const parsed = await parsedFire();
  const me0 = { ...parsed.marketEvidence[0]!, claim: { ...parsed.marketEvidence[0]!.claim, fireId: 'foreign-fire' } };
  const t = { ...parsed, marketEvidence: [me0, ...parsed.marketEvidence.slice(1)] };
  assert.ok(has(verifyFireArtifactReplay(t), 'claim does not bind'));
});

test('replay catches a publication verified for a different cohort identity', async () => {
  const parsed = await parsedFire();
  const t = { ...parsed, publication: { ...parsed.publication, cohortId: 'a'.repeat(64) } };
  assert.ok(has(verifyFireArtifactReplay(t), 'publication cohortId does not equal'));
});

test('replay catches baseline decisions that do not rederive from the retained request', async () => {
  const parsed = await parsedFire();
  const bad = parsed.baselineDecisions.map((d, i) => (i === 0 ? { ...d, selection: 'tampered-selection' } : d));
  const t = { ...parsed, baselineDecisions: bad };
  assert.ok(has(verifyFireArtifactReplay(t), 'baseline decisions do not rederive'));
});

test('replay is empty for a produced non-scope-covering check across all legal scopes', async () => {
  for (const markets of [['moneyline'], ['total'], ['moneyline', 'total']] as MarketKey[][]) {
    assert.deepEqual(recomputeFireArtifactDigests(await parsedFire({ markets })), []);
  }
});

// --- retained response envelopes (#92 / #111) -------------------------------

/**
 * A produced fire with all three attempt shapes present at once: an arm that
 * answered on the first try, an arm that needed a repair (two sent legs), and an
 * arm that timed out (a sent leg where nothing came back). Every case below is
 * built on this so the presence rule is exercised against initial legs, repair
 * legs and no-receipt legs in one artifact rather than three tidy ones.
 */
async function mixedFire(opts: Omit<FireOpts, 'behaviourFor'> = {}): Promise<FireArtifactV1> {
  return producedFire({
    ...opts,
    behaviourFor: (arm) =>
      arm.participantId === ARMS[0]!.participantId
        ? 'repair'
        : arm.participantId === ARMS[ARMS.length - 1]!.participantId
          ? 'timeout'
          : 'valid',
  });
}

/**
 * A produced fire whose first arm returned a 2xx the extractor could NOT read
 * (`ProviderUnreadableResponseError`). Kept separate from {@link mixedFire} because
 * that fixture's cases assert `transport !== 'ok' ⇒ nothing retained`, and this leg
 * class is exactly the exception: a response DID come back and its body IS retained,
 * while the answer text, the reported model id and the `ok` transport are all absent.
 * That leaves the numeric `httpStatus` as the only receipt carrier standing, which is
 * the bound the two `unreadable` rows in the deletion table measure.
 */
async function unreadableFire(): Promise<FireArtifactV1> {
  return producedFire({
    behaviourFor: (arm) => (arm.participantId === ARMS[0]!.participantId ? 'unreadable' : 'valid'),
  });
}

/** A raw persisted artifact as plain JSON — the shape a hand-edit actually reaches. */
type RawFire = Record<string, any>;

function rawOf(artifact: FireArtifactV1): RawFire {
  return JSON.parse(serializeFireArtifactV1(artifact)) as RawFire;
}

/** Re-parse edited raw JSON through the production parser, so an absent key is
 *  absent because the BYTES lack it, not because a test built the object that way. */
function reparse(raw: RawFire): FireArtifactV1 {
  return parseFireArtifactV1(JSON.stringify(raw));
}

/** Recompute EVERY arm's digest over its edited domain, so a row proves the presence
 *  rule alone rather than riding on a stale digest. */
function recomputeAllArmDigests(raw: RawFire): void {
  for (const arm of raw['arms'] as RawFire[]) {
    arm['armDigest'] = armDigest({
      cohortId: raw['cohortId'],
      fireId: raw['fireId'],
      runId: raw['runId'],
      participantId: arm['expectedArmIdentity'].participantId,
      requestSha256: raw['requestSha256'],
      expectedArmIdentity: arm['expectedArmIdentity'],
      orderedAttempts: arm['orderedAttempts'],
      terminalOutcome: arm['terminalOutcome'],
      acceptedResponseDigestOrNull: arm['acceptedResponseDigest'],
      acceptedDecisionFingerprintOrNull: arm['acceptedDecisionFingerprint'],
    });
  }
}

function everyAttempt(raw: RawFire): RawFire[] {
  return (raw['arms'] as RawFire[]).flatMap((arm) => arm['orderedAttempts'] as RawFire[]);
}

/** The repair arm's two legs — the only arm with a second sent attempt. */
function repairArm(raw: RawFire): RawFire {
  const arm = (raw['arms'] as RawFire[]).find((a) => (a['orderedAttempts'] as RawFire[]).length === 2);
  assert.ok(arm !== undefined, 'the mixed fixture must contain an arm with a repair leg');
  return arm;
}

/** The unreadable-2xx leg: a received 2xx whose content fields are all null. */
function unreadableLeg(raw: RawFire): RawFire {
  const legs = everyAttempt(raw).filter(
    (a) => a['httpStatus'] === 200 && a['persistedResponseBody'] === null && a['reportedModelId'] === null,
  );
  assert.equal(legs.length, 1, 'the unreadable fixture must contain exactly one unreadable-2xx leg');
  return legs[0]!;
}

const OPTIONAL_KEYS = ['searchAudit', 'providerStopReason', 'turnCompleted', 'responseEnvelope'] as const;
/** The three optional attempt fields that the build BEFORE envelope retention wrote —
 *  `searchAudit` and its two siblings landed together in 68dfc6e (2026-08-07). An
 *  artifact carrying these and no `responseEnvelope` is what that build produced. */
const PRE_ENVELOPE_OPTIONAL_KEYS = ['searchAudit', 'providerStopReason', 'turnCompleted'] as const;

test('a produced fire retains a complete response envelope on every leg that received one', async () => {
  const artifact = await mixedFire();
  const parsed = parseFireArtifactV1(serializeFireArtifactV1(artifact));

  // Fixture reach (rule 3b-reach): the shapes this file's cases depend on are really here.
  const legCounts = parsed.arms.map((a) => a.orderedAttempts.length).sort();
  assert.ok(legCounts.includes(2), 'one arm sent a repair leg');
  const timedOut = parsed.arms.find((a) => a.terminalOutcome === 'timeout');
  assert.ok(timedOut !== undefined, 'one arm timed out');
  assert.equal(timedOut.orderedAttempts[0]!.transport, 'timeout');

  for (const arm of parsed.arms) {
    for (const attempt of arm.orderedAttempts) {
      const where = `${arm.expectedArmIdentity.participantId}#${attempt.attemptNumber}`;
      assert.ok(Object.hasOwn(attempt, 'responseEnvelope'), `${where} carries the key explicitly`);
      if (attempt.transport === 'ok') {
        assert.ok(attempt.responseEnvelope != null, `${where} received a response, so it retains a body`);
        assert.equal(sha256Hex(attempt.responseEnvelope.body), attempt.responseEnvelope.sha256);
        assert.equal(Buffer.byteLength(attempt.responseEnvelope.body, 'utf8'), attempt.responseEnvelope.bytes);
      } else {
        // The NEGATIVE CONTROL (rule 5): nothing came back, so nothing is retained —
        // and that leg is NOT flagged.
        assert.equal(attempt.responseEnvelope, null, `${where} received nothing, so it retains nothing`);
      }
    }
  }
  assert.deepEqual(verifyFireArtifactEnvelopes(parsed), []);
  assert.deepEqual(verifyFireArtifactReplay(parsed), []);
  assert.equal(isCoherentPreRetentionFireArtifact(parsed), false, 'a retaining build is never exempt');
});

test('a marker present ONLY in the response body survives into the WRITTEN artifact file', async () => {
  // The inverse of the reproduction in #111. The marker is in the envelope's wrapper
  // and NOWHERE in the answer text, so a build that persists only the extracted answer
  // loses it — which is exactly what the artifact used to do.
  const MARKER = 'envelope-only-marker-6b1f9c';
  const artifact = await mixedFire({
    envelopeFor: (answer, leg) =>
      sealResponseEnvelope(
        JSON.stringify({ providerWrapper: MARKER, leg, output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }] }),
      ),
  });
  const dir = mkdtempSync(join(tmpdir(), 'ospex-fire-'));
  try {
    const filePath = join(dir, 'fire-marker.json');
    writeFireArtifactV1(filePath, artifact);
    const bytes = readFileSync(filePath, 'utf8');
    // Rule 2: the claim is about the artifact on disk, not the mapper's return value.
    assert.ok(bytes.includes(MARKER), 'the durable file carries the complete response body');

    const parsed = parseFireArtifactV1(bytes);
    let received = 0;
    for (const arm of parsed.arms) {
      for (const attempt of arm.orderedAttempts) {
        assert.ok(
          !(attempt.persistedResponseBody ?? '').includes(MARKER),
          'the answer text does not carry the marker, so this fixture discriminates the two fields',
        );
        if (attempt.responseEnvelope == null) continue;
        received += 1;
        assert.ok(attempt.responseEnvelope.body.includes(MARKER), 'the retained body carries the marker');
        assert.ok(
          attempt.responseEnvelope.body.includes(`"leg":"${attempt.kind}"`),
          'each leg retains ITS OWN body — a repair is not persisted with a copy of the initial one',
        );
      }
    }
    assert.ok(received >= 4, `every received leg retained a body (${received})`);
    assert.deepEqual(verifyFireArtifactReplay(parsed), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the persisted envelope and the persisted answer are distinct strings, each bound to its own digest', async () => {
  // Rule 3d: both are strings written onto the same attempt from the same record, so a
  // positional swap is invisible unless the two carry different values and each is
  // checked against its own digest.
  const artifact = await mixedFire();
  const parsed = parseFireArtifactV1(serializeFireArtifactV1(artifact));
  let checked = 0;
  for (const arm of parsed.arms) {
    for (const attempt of arm.orderedAttempts) {
      if (attempt.responseEnvelope == null || attempt.persistedResponseBody === null) continue;
      checked += 1;
      assert.notEqual(attempt.persistedResponseBody, attempt.responseEnvelope.body);
      assert.equal(attempt.responseSha256, sha256Hex(attempt.persistedResponseBody));
      assert.equal(attempt.responseEnvelope.sha256, sha256Hex(attempt.responseEnvelope.body));
      assert.notEqual(attempt.responseSha256, attempt.responseEnvelope.sha256);
      // And the answer is the thing that re-validates as a benchmark response, while
      // the envelope is the wrapper it arrived inside — so a swap changes which string
      // the scorer would read as the decision.
      assert.doesNotThrow(() => JSON.parse(attempt.persistedResponseBody!).games as unknown);
      assert.ok(attempt.responseEnvelope.body.includes('"fixture":"test-factory"'), 'the envelope is the wrapper');
    }
  }
  assert.ok(checked >= 4, `the fixture reached the attempts under test (${checked})`);
});

test('the retained body goes through the artifact redaction pass, proven on the WRITTEN file', async () => {
  // The slate runs with the credential ABSENT, so the runner seals a body carrying the
  // literal value; the artifact is then built and written with it CONFIGURED. That is
  // the only ordering under which the mapper's own redaction pass is the thing being
  // measured — sealed-then-configured, exactly like `persistedResponseBody`.
  const SECRET = 'xai-synthetic-credential-8842';
  const build = async (): Promise<{ env: RunEnvelope; ctx: FireContext }> =>
    withEnvAsync('XAI_API_KEY', undefined, () =>
      fireParts({
        behaviourFor: (arm) => (arm.participantId === ARMS[ARMS.length - 1]!.participantId ? 'timeout' : 'valid'),
        envelopeFor: (answer) => sealResponseEnvelope(JSON.stringify({ providerWrapper: SECRET, output: answer })),
      }),
    );

  // Negative control first (rule 5): with nothing configured the value is written
  // verbatim, so the assertion below is about redaction and not about a string that
  // never reaches the file.
  const clean = await build();
  const cleanDir = mkdtempSync(join(tmpdir(), 'ospex-fire-'));
  try {
    const p = join(cleanDir, 'clean.json');
    withEnvAbsent('XAI_API_KEY', () => {
      writeFireArtifactV1(p, buildFireArtifact(clean.env, clean.ctx));
    });
    assert.ok(readFileSync(p, 'utf8').includes(SECRET), 'unconfigured, the value is retained verbatim');
  } finally {
    rmSync(cleanDir, { recursive: true, force: true });
  }

  const parts = await build();
  const dir = mkdtempSync(join(tmpdir(), 'ospex-fire-'));
  try {
    const filePath = join(dir, 'fire-redacted.json');
    withEnv('XAI_API_KEY', SECRET, () => {
      writeFireArtifactV1(filePath, buildFireArtifact(parts.env, parts.ctx));
    });
    const bytes = readFileSync(filePath, 'utf8');
    assert.ok(!bytes.includes(SECRET), 'the configured credential is nowhere in the durable file');
    assert.ok(bytes.includes('[REDACTED]'), 'and it was substituted rather than the whole body dropped');
    const parsed = parseFireArtifactV1(bytes);
    for (const arm of parsed.arms) {
      for (const attempt of arm.orderedAttempts) {
        if (attempt.responseEnvelope == null) continue;
        assert.ok(attempt.responseEnvelope.body.includes('[REDACTED]'), 'the retained body was substituted, not dropped');
        // Redact-then-digest: the recorded digest and length describe the string that
        // is actually stored, so the retained body still verifies against itself.
        assert.equal(sha256Hex(attempt.responseEnvelope.body), attempt.responseEnvelope.sha256);
        assert.equal(Buffer.byteLength(attempt.responseEnvelope.body, 'utf8'), attempt.responseEnvelope.bytes);
      }
    }
    assert.deepEqual(verifyFireArtifactReplay(parsed), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the deletion table: no single edit downgrades enforcement ---------------

/**
 * Each row is one hand-edit of a persisted artifact and the LITERAL outcome it must
 * produce. The table is the specification of the presence rule: what has to stay true
 * however the file is edited, and — the two `CLEAN` rows — exactly what it does NOT
 * claim.
 *
 * Every row that edits an attempt also recomputes every `armDigest`, unless the row's
 * whole point is that it did not. Without that, a row would pass on the digest check
 * alone and prove nothing about the presence rule (rule 3b).
 */
interface DeletionRow {
  readonly name: string;
  readonly edit: (raw: RawFire) => void;
  /** `CLEAN`, `PARSE_THROWS`, or the needles that must ALL appear in the violations. */
  readonly expect: 'CLEAN' | 'PARSE_THROWS' | readonly string[];
  /** Which produced fire the row edits. `mixed` (the default) has an initial leg, a
   *  repair leg and a no-receipt leg; `unreadable` adds the received-2xx-with-no-content
   *  leg, which the mixed fixture cannot carry (see {@link unreadableFire}). */
  readonly fixture?: 'mixed' | 'unreadable';
}

const NO_ENVELOPE = 'no response envelope was retained';

const DELETION_TABLE: readonly DeletionRow[] = [
  {
    name: 'no edit at all — the control that the rule is not always-failing',
    edit: () => {},
    expect: 'CLEAN',
  },
  {
    name: 'delete the envelope from one received leg, leaving the digest alone',
    edit: (raw) => {
      delete (repairArm(raw)['orderedAttempts'] as RawFire[])[0]!['responseEnvelope'];
    },
    // Two independent checks fire. The digest one is what this surface has and the run
    // file does not: the deletion is DETECTABLE, not merely refused.
    expect: ['armDigest does not recompute', NO_ENVELOPE],
  },
  {
    name: 'delete the envelope from one received leg AND forge that arm digest',
    edit: (raw) => {
      delete (repairArm(raw)['orderedAttempts'] as RawFire[])[0]!['responseEnvelope'];
      recomputeAllArmDigests(raw);
    },
    expect: [NO_ENVELOPE],
  },
  {
    name: 'null the envelope on one received leg AND forge that arm digest',
    edit: (raw) => {
      (repairArm(raw)['orderedAttempts'] as RawFire[])[0]!['responseEnvelope'] = null;
      recomputeAllArmDigests(raw);
    },
    expect: [NO_ENVELOPE],
  },
  {
    name: 'delete the envelope from the REPAIR leg only, and forge the digests',
    edit: (raw) => {
      delete (repairArm(raw)['orderedAttempts'] as RawFire[])[1]!['responseEnvelope'];
      recomputeAllArmDigests(raw);
    },
    // #92 covers every initial AND repair attempt, so the message must name the repair.
    expect: ['attempt 2 (repair)', NO_ENVELOPE],
  },
  {
    name: 'strip all four optional keys from ONE leg only and forge every digest',
    edit: (raw) => {
      const attempt = (repairArm(raw)['orderedAttempts'] as RawFire[])[0]!;
      for (const key of OPTIONAL_KEYS) delete attempt[key];
      recomputeAllArmDigests(raw);
    },
    // A local rewrite buys nothing: exemption is a property of the WHOLE artifact.
    expect: [NO_ENVELOPE],
  },
  {
    name: 'null httpStatus and drop the envelope — the answer text and transport still say a response came back',
    edit: (raw) => {
      const attempt = (repairArm(raw)['orderedAttempts'] as RawFire[])[0]!;
      delete attempt['responseEnvelope'];
      attempt['httpStatus'] = null;
      recomputeAllArmDigests(raw);
    },
    expect: [NO_ENVELOPE],
  },
  // The four receipt carriers, one row each, every row leaving exactly ONE standing
  // (rule 3k). Without this sweep a predicate consulting only some of them survives.
  {
    name: 'receipt carried by the answer text alone',
    edit: (raw) => {
      const attempt = (repairArm(raw)['orderedAttempts'] as RawFire[])[0]!;
      delete attempt['responseEnvelope'];
      attempt['reportedModelId'] = null;
      attempt['httpStatus'] = null;
      attempt['transport'] = 'provider_error';
      recomputeAllArmDigests(raw);
    },
    expect: [NO_ENVELOPE],
  },
  {
    name: 'receipt carried by the reported model id alone',
    edit: (raw) => {
      const attempt = (repairArm(raw)['orderedAttempts'] as RawFire[])[0]!;
      delete attempt['responseEnvelope'];
      attempt['persistedResponseBody'] = null;
      attempt['responseSha256'] = null;
      attempt['httpStatus'] = null;
      attempt['transport'] = 'provider_error';
      recomputeAllArmDigests(raw);
    },
    expect: [NO_ENVELOPE],
  },
  {
    name: 'receipt carried by the 2xx status alone',
    edit: (raw) => {
      const attempt = (repairArm(raw)['orderedAttempts'] as RawFire[])[0]!;
      delete attempt['responseEnvelope'];
      attempt['persistedResponseBody'] = null;
      attempt['responseSha256'] = null;
      attempt['reportedModelId'] = null;
      attempt['transport'] = 'provider_error';
      recomputeAllArmDigests(raw);
    },
    expect: [NO_ENVELOPE],
  },
  {
    name: 'receipt carried by the ok transport alone',
    edit: (raw) => {
      const attempt = (repairArm(raw)['orderedAttempts'] as RawFire[])[0]!;
      delete attempt['responseEnvelope'];
      attempt['persistedResponseBody'] = null;
      attempt['responseSha256'] = null;
      attempt['reportedModelId'] = null;
      attempt['httpStatus'] = null;
      recomputeAllArmDigests(raw);
    },
    expect: [NO_ENVELOPE],
  },
  {
    name: 'delete the httpStatus KEY — required by the strict schema, so it never reaches the rule',
    edit: (raw) => {
      // No digest recomputation: `armDigest` strict-parses its own domain, so an attempt
      // missing a required field cannot even be re-digested. The forger has nothing to
      // forge here, which is a stronger position than the run path's fail-closed read.
      delete (repairArm(raw)['orderedAttempts'] as RawFire[])[0]!['httpStatus'];
    },
    // The run path had to read an absent status key fail-closed. Here the schema does it.
    expect: 'PARSE_THROWS',
  },
  {
    name: 'edit the retained body and leave its digest',
    edit: (raw) => {
      (repairArm(raw)['orderedAttempts'] as RawFire[])[0]!['responseEnvelope'].body += ' tampered';
    },
    expect: ['does not match its recorded sha256', 'armDigest does not recompute'],
  },
  {
    name: 'edit the retained body and forge its sha256 but not its byte length',
    edit: (raw) => {
      const envelope = (repairArm(raw)['orderedAttempts'] as RawFire[])[0]!['responseEnvelope'];
      envelope.body += ' tampered';
      envelope.sha256 = sha256Hex(envelope.body);
      recomputeAllArmDigests(raw);
    },
    expect: ['does not match its recorded byte length'],
  },
  // --- the leg class where the carriers run out ------------------------------
  // A received 2xx the extractor could not read persists with answer text, reported
  // model id and `ok` transport ALL absent, so `httpStatus` is the only carrier left.
  // The rows above cannot reach this class: every one of them edits a leg that
  // transported `ok`, so a predicate consulting only some carriers still passes them.
  {
    fixture: 'unreadable',
    name: 'delete the envelope from an UNREADABLE-2xx leg and forge every digest',
    edit: (raw) => {
      delete unreadableLeg(raw)['responseEnvelope'];
      recomputeAllArmDigests(raw);
    },
    expect: [NO_ENVELOPE],
  },
  {
    fixture: 'unreadable',
    name: 'BOUND: on an unreadable-2xx leg the status is the ONLY carrier, so TWO edits erase the body',
    edit: (raw) => {
      const leg = unreadableLeg(raw);
      delete leg['responseEnvelope'];
      leg['httpStatus'] = null;
      recomputeAllArmDigests(raw);
    },
    // Two field edits plus the forged digests. The run path needs three on the same leg
    // class, because it also persists an `errorDetail` naming the status in prose and
    // `statusFromErrorDetail` reads it; a fire artifact persists no `errorDetail` at all,
    // so this surface is one carrier short exactly here. Stated in
    // `attemptReceivedResponse`, in the README and in the spec rather than left to be
    // found, and measured by the row above, which shows the status carrier IS load-bearing.
    expect: 'CLEAN',
  },
  // --- the rows that say what this does NOT buy ------------------------------
  {
    name: 'BOUND: re-seal an invented body coherently and forge every digest',
    edit: (raw) => {
      const envelope = (repairArm(raw)['orderedAttempts'] as RawFire[])[0]!['responseEnvelope'];
      envelope.body = JSON.stringify({ invented: 'a body nobody ever received' });
      envelope.sha256 = sha256Hex(envelope.body);
      envelope.bytes = Buffer.byteLength(envelope.body, 'utf8');
      recomputeAllArmDigests(raw);
    },
    // The envelope binds to nothing outside the file, so a coherent rewrite verifies —
    // the same residual the run path names. This is integrity, not tamper resistance.
    expect: 'CLEAN',
  },
  {
    name: 'BOUND: delete the envelope KEY from EVERY leg and forge every digest',
    edit: (raw) => {
      for (const attempt of everyAttempt(raw)) delete attempt['responseEnvelope'];
      recomputeAllArmDigests(raw);
    },
    // The exemption, earned the only way it can be: the key gone from EVERY attempt plus
    // one forged digest per arm. That is what the rule buys — no SINGLE deletion reaches
    // it on an artifact with more than one attempt. The other three optional keys are
    // deliberately NOT part of the clause; `isCoherentPreRetentionFireArtifact` says why,
    // and the intermediate-build case below is the reason.
    expect: 'CLEAN',
  },
  {
    name: 'BOUND: strip all four optional keys from EVERY leg and forge every digest',
    edit: (raw) => {
      for (const attempt of everyAttempt(raw)) for (const key of OPTIONAL_KEYS) delete attempt[key];
      recomputeAllArmDigests(raw);
    },
    expect: 'CLEAN',
  },
];

test('deletion table: no single field deletion or nulling downgrades envelope enforcement', async () => {
  const bases: Record<'mixed' | 'unreadable', RawFire> = {
    mixed: rawOf(await mixedFire()),
    unreadable: rawOf(await unreadableFire()),
  };
  // Each fixture must be one the rule actually applies to, or its rows pass vacuously.
  for (const [which, base] of Object.entries(bases)) {
    assert.equal(isCoherentPreRetentionFireArtifact(reparse(base)), false, `${which}: not exempt`);
    assert.ok(
      everyAttempt(base).filter((a) => a['responseEnvelope'] !== null).length >= 4,
      `${which}: retains bodies on at least four legs, or the rows below discriminate nothing`,
    );
    assert.deepEqual(verifyFireArtifactReplay(reparse(base)), [], `${which}: starts clean`);
  }
  // And the unreadable fixture must really carry the leg its rows are about: a received
  // 2xx with EVERY other carrier absent. Without this the two rows below would be
  // measuring an ordinary `ok` leg and could not distinguish the bound they state.
  const unreadable = unreadableLeg(bases.unreadable);
  assert.equal(unreadable['transport'], 'provider_error');
  assert.equal(unreadable['httpStatus'], 200);
  assert.equal(unreadable['persistedResponseBody'], null);
  assert.equal(unreadable['reportedModelId'], null);
  assert.ok(unreadable['responseEnvelope'].body.includes(UNREADABLE_BODY_MARKER), 'and it retained its body');

  for (const row of DELETION_TABLE) {
    const base = bases[row.fixture ?? 'mixed'];
    const raw = JSON.parse(JSON.stringify(base)) as RawFire;
    row.edit(raw);
    if (row.expect === 'PARSE_THROWS') {
      assert.throws(() => reparse(raw), `${row.name}: must fail the strict parse`);
      continue;
    }
    const violations = verifyFireArtifactReplay(reparse(raw));
    if (row.expect === 'CLEAN') {
      assert.deepEqual(violations, [], `${row.name}: must verify clean`);
      continue;
    }
    for (const needle of row.expect) {
      assert.ok(has(violations, needle), `${row.name}: expected a violation containing "${needle}", got ${JSON.stringify(violations)}`);
    }
  }
});

// --- backward compatibility --------------------------------------------------

test('a PRE-RETENTION artifact — no optional attempt key anywhere — parses, is exempt, and replays clean', async () => {
  // The CI-meaningful half of backward compatibility: `.fire-artifacts/` is gitignored,
  // so no runner outside this machine has the real archive, and a test that depended on
  // it would be green for the wrong reason (nothing to iterate) everywhere else. This
  // reconstructs the archived shape from a real produced artifact instead.
  const raw = rawOf(await mixedFire());
  for (const attempt of everyAttempt(raw)) for (const key of OPTIONAL_KEYS) delete attempt[key];
  recomputeAllArmDigests(raw);
  const parsed = reparse(raw);
  assert.equal(isCoherentPreRetentionFireArtifact(parsed), true);
  assert.deepEqual(verifyFireArtifactEnvelopes(parsed), []);
  assert.deepEqual(verifyFireArtifactReplay(parsed), []);
  for (const arm of parsed.arms) {
    for (const attempt of arm.orderedAttempts) {
      // 11 keys — the exact per-attempt shape measured on the three archived artifacts
      // on 2026-08-22, so this reconstruction is the archive's shape and not a guess.
      assert.equal(Object.keys(attempt).length, 11, JSON.stringify(Object.keys(attempt)));
    }
  }
});

test('every fire artifact already written to .fire-artifacts/ still replays clean', (t) => {
  // The local half: the real files this machine produced before any of the optional
  // attempt fields existed. The directory is gitignored, so an empty one is "nothing to
  // check here" rather than a failure — the property itself is pinned by the
  // reconstructed case above, which runs everywhere.
  const files = archivedFireArtifacts();
  if (files.length === 0) {
    t.diagnostic('no archived fire artifacts on this machine — the reconstructed pre-retention case covers the property');
    return;
  }
  for (const file of files) {
    const parsed = parseFireArtifactV1(readFileSync(file, 'utf8'));
    assert.ok(
      isCoherentPreRetentionFireArtifact(parsed),
      `${file}: carries none of the optional attempt fields, so it predates retention`,
    );
    assert.deepEqual(verifyFireArtifactEnvelopes(parsed), [], `${file}: exempt, not enforced`);
    assert.deepEqual(verifyFireArtifactReplay(parsed), [], `${file}: replays clean`);
    // And the digests recompute BYTE-IDENTICALLY over a domain that now has one more
    // optional field: an absent key contributes nothing to `canonicalize`.
    for (const arm of parsed.arms) {
      assert.equal(
        armDigest({
          cohortId: parsed.cohortId,
          fireId: parsed.fireId,
          runId: parsed.runId,
          participantId: arm.expectedArmIdentity.participantId,
          requestSha256: parsed.requestSha256,
          expectedArmIdentity: arm.expectedArmIdentity,
          orderedAttempts: arm.orderedAttempts,
          terminalOutcome: arm.terminalOutcome,
          acceptedResponseDigestOrNull: arm.acceptedResponseDigest,
          acceptedDecisionFingerprintOrNull: arm.acceptedDecisionFingerprint,
        }),
        arm.armDigest,
        `${file}: ${arm.expectedArmIdentity.participantId} armDigest is unchanged by the new field`,
      );
    }
  }
});

test('a pre-retention artifact stops being exempt the moment a responseEnvelope KEY appears — and only then', async () => {
  // The exemption is not "old file, never mind": it is a claim the whole artifact has to
  // support, and ONE envelope key anywhere makes the file a retaining-era artifact, after
  // which every received leg owes a body. An explicit `null` counts — that is a key a
  // retaining build wrote, and reading it as "absent" is the downgrade the rule refuses.
  //
  // The other three optional keys deliberately do NOT flip it, and that half is not a
  // gap: it is what stops an artifact from the build BEFORE this one — which wrote those
  // three and no envelope — from being refused. See the intermediate-build case below
  // for what that refusal would have cost.
  const raw = rawOf(await mixedFire());
  for (const attempt of everyAttempt(raw)) for (const key of OPTIONAL_KEYS) delete attempt[key];
  recomputeAllArmDigests(raw);
  assert.equal(isCoherentPreRetentionFireArtifact(reparse(raw)), true, 'the starting point is exempt');

  const withKey = (key: string): FireArtifactV1 => {
    const edited = JSON.parse(JSON.stringify(raw)) as RawFire;
    (edited['arms'] as RawFire[])[0]!['orderedAttempts'][0]![key] = null;
    recomputeAllArmDigests(edited);
    return reparse(edited);
  };

  const flipped = withKey('responseEnvelope');
  assert.equal(isCoherentPreRetentionFireArtifact(flipped), false, 'one envelope key places the file in the retaining era');
  assert.ok(has(verifyFireArtifactReplay(flipped), NO_ENVELOPE), 'and the file is now enforced');

  for (const key of PRE_ENVELOPE_OPTIONAL_KEYS) {
    const parsed = withKey(key);
    assert.equal(isCoherentPreRetentionFireArtifact(parsed), true, `${key} alone does not place the file in the retaining era`);
    assert.deepEqual(verifyFireArtifactReplay(parsed), [], `${key}: still replays clean`);
  }
});

test('an INTERMEDIATE-BUILD artifact — the three older optional keys, no envelope — parses, is exempt, and replays clean', async () => {
  // THE OPERATIONAL CASE, and the reason the exemption clause reads one key rather than
  // four. The build between 68dfc6e (2026-08-07) and envelope retention wrote
  // `searchAudit`, `providerStopReason` and `turnCompleted` on every attempt and no
  // `responseEnvelope`. Under a four-field clause every artifact it produced would be
  // enforced and therefore refused — and on the live campaign path that is not a write
  // refusal: `verifySpendEvidence` replays every installed artifact whose spend sidecar
  // claims a clean pass, so ONE such artifact already under a cohort's evidence root
  // turns every later tick's evidence scan into an `unverified_evidence` latch cause,
  // whose documented recovery is `campaign:stop` — and a cohort is armed at most once,
  // ever. Deploying a retaining build mid-campaign would have ended that campaign.
  const raw = rawOf(await mixedFire());
  for (const attempt of everyAttempt(raw)) delete attempt['responseEnvelope'];
  recomputeAllArmDigests(raw);
  const parsed = reparse(raw);

  // Fixture reach (rule 3b-reach): this really is the intermediate shape — the three
  // older keys present on every attempt, the envelope key absent — and not a
  // pre-retention artifact wearing its name, which would pass for a different reason.
  for (const attempt of everyAttempt(JSON.parse(JSON.stringify(parsed)) as RawFire)) {
    for (const key of PRE_ENVELOPE_OPTIONAL_KEYS) {
      assert.ok(Object.hasOwn(attempt, key), `the intermediate shape carries ${key}`);
    }
    assert.equal(Object.hasOwn(attempt, 'responseEnvelope'), false, 'and no envelope key');
  }
  assert.ok(everyAttempt(raw).some((a) => a['transport'] === 'ok'), 'and at least one leg received a response');

  assert.equal(isCoherentPreRetentionFireArtifact(parsed), true);
  assert.deepEqual(verifyFireArtifactEnvelopes(parsed), []);
  assert.deepEqual(verifyFireArtifactReplay(parsed), []);
});

test('BOUND: on an unreadable-2xx leg the retained body is erasable with two field edits', async () => {
  // What the calibrated claim in `attemptReceivedResponse` costs, measured rather than
  // asserted. Four carriers exist, but not on every leg: a 2xx whose body the extractor
  // could not read persists with answer text, reported model id and `ok` transport all
  // absent, so the numeric status stands alone — and that leg class is precisely the one
  // #92 exists to preserve.
  const raw = rawOf(await unreadableFire());
  assert.ok(JSON.stringify(raw).includes(UNREADABLE_BODY_MARKER), 'the produced fire retained the body');

  const envelopeOnly = JSON.parse(JSON.stringify(raw)) as RawFire;
  delete unreadableLeg(envelopeOnly)['responseEnvelope'];
  recomputeAllArmDigests(envelopeOnly);
  assert.ok(
    has(verifyFireArtifactReplay(reparse(envelopeOnly)), NO_ENVELOPE),
    'deleting the body alone is caught — the status carrier is load-bearing',
  );

  const bothEdits = JSON.parse(JSON.stringify(raw)) as RawFire;
  const leg = unreadableLeg(bothEdits);
  delete leg['responseEnvelope'];
  leg['httpStatus'] = null;
  recomputeAllArmDigests(bothEdits);
  const parsed = reparse(bothEdits);
  assert.deepEqual(verifyFireArtifactReplay(parsed), [], 'nulling the one remaining carrier as well verifies clean');
  assert.ok(
    !JSON.stringify(parsed).includes(UNREADABLE_BODY_MARKER),
    'and the retained body really is gone from the artifact — this is the loss the bound names',
  );
});
