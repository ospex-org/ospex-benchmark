import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cohortBoot } from './cohortBoot.js';
import { evaluateCandidate } from './detection.js';
import {
  EscalationLatchedError,
  composeEscalationLatch,
  latchGuardedClaimPort,
  unresolvedFireLatchSource,
} from './escalationLatch.js';
import type { UnresolvedFire, UnresolvedFireRead } from './escalationLatch.js';
import { escalationEvidenceLatchSource } from './escalationEvidenceScan.js';
import { FireArtifactSink, nodeArtifactFs } from './fireArtifactSink.js';
import { StoreClaimPort } from './lineOpenClaim.js';
import type { ClaimPort } from './lineOpenClaim.js';
import { scopeKeyOf } from './lineOpenDispatch.js';
import { runOneFire } from './lineOpenSpine.js';
import type { LineOpenRunOptions } from './lineOpenSpine.js';
import { checkPublication } from './manifestPublication.js';
import { MARKET_POLICY_DIGEST, MARKET_POLICY_VERSION } from './marketPolicy.js';
import { SPEND_GUARD_PRICE_TABLE_VERSION, modelPriceTableDigest } from './modelPriceTable.js';
import { sealPreparedFire } from './preparedFire.js';
import type { PreparedFireSnapshot } from './preparedFire.js';
import { promptScaffoldSha256 } from './prompt.js';
import { SCORING_POLICY_VERSION, defaultExpectedArms } from './scoring.js';
import { mintInjectedAdapterCapability } from './cohortAdapterCapability.js';
import { STORE_SCHEMA_VERSION } from './store/constants.js';
import type { CandidateInput } from './detection.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';
import type {
  AcquireRepairLeaseRequest,
  AdmitDispatchRequest,
  AdmitResult,
  AtomicStore,
  CompleteClaimRequest,
  CompleteResult,
  InitCohortBudgetRequest,
  InitResult,
  ReleaseLeaseRequest,
  ReleaseResult,
  RepairLeaseResult,
} from './store/contract.js';
import type {
  BenchmarkResponse,
  ChatTurn,
  GameBundle,
  MarketKey,
  ProviderAdapter,
  ProviderName,
  ProviderResponse,
} from './types.js';

/**
 * The escalation-latch ACCEPTANCE battery — the exact sequence docs/CAMPAIGN-ACTIVATION.md
 * specifies: force an INSTALLED escalation (a real billable fire through the real spine,
 * its artifact and escalated spend sidecar durably on a real filesystem), FAIL the disarm
 * write, RESTART (every object rebuilt fresh over the same durable substrate), tick again —
 * and prove no provider call is reachable: the latch-guarded claim port refuses the
 * admission before any adapter is invoked, so the fresh tick's provider adapters are
 * tripwires that must never fire.
 *
 * The durable substrate is a real temp directory (the evidence side, scanned by the real
 * `escalationEvidenceLatchSource`) plus an in-memory store whose fires/claims/leases
 * persist across the "restart" and whose unresolved-fire read implements the SAME predicate
 * as `SqlUnresolvedFireReadPort` — pending fires with no unreleased, unexpired lease. The
 * SQL twin of that predicate is proven against real Postgres by `yarn store:campaign-auth`
 * conformance; what this battery proves is the composition: escalation → durable state →
 * restart → refused admission → zero provider contact. Controls pin the latch as the ONLY
 * refusing gate (a cleanly settled prior fire dispatches), and each source holds the latch
 * ALONE (the evidence scan after a recovery settle; the store shadow when the sidecar file
 * is gone).
 */

// --- shared instants / identity (the spine fixture's boundary-safe values) ---

const GAME_ID = '00000000-0000-4000-8000-0000000000f1';
const GAME_ID2 = '00000000-0000-4000-8000-0000000000f2';
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
const OWNER = 'owner-host-1234-abc';
const CODE_ARMS = defaultExpectedArms();
const MARKETS: readonly MarketKey[] = ['moneyline'];
const ANTHROPIC_ARM_ID = CODE_ARMS.find((a) => a.provider === 'anthropic')!.participantId;
/** One token above the smallest usage that derives EXACTLY the $100 per-attempt
 *  reservation on the conservative guard table — the smallest expressible breach. */
const OVER_CAP_USAGE = { input_tokens: 10_000_001, output_tokens: 0 };

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
    })),
    toolInferenceConfigSha256: 'c'.repeat(64),
    baselinePolicyVersion: 'baselines-v0.3.0',
    repairPolicyVersion: 'repair-v1',
    scoringPolicyVersion: SCORING_POLICY_VERSION,
    uncertaintyPolicyVersion: 'uncertainty-v1',
    // A BILLABLE fire must be judged under the conservative guard table it precommitted to.
    modelPriceTableVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
    modelPriceTableDigest: modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION),
    spendReservationPolicyVersion: 'fixed-attempt-v1',
    runnerCommitSha: 'e'.repeat(40),
    constants: {
      pollIntervalMs: 30_000,
      cleanEntryWindowMs: 120_000,
      gameDiscoveryWindowHours: 168,
      maxClockSkewMs: 5_000,
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

function scopedGame(gameId: string): GameBundle {
  return {
    gameId,
    league: 'mlb',
    scheduledStartUtc: CUTOFF,
    awayTeam: 'Milwaukee Brewers',
    homeTeam: 'Pittsburgh Pirates',
    probableStartingPitchers: null,
    markets: {
      moneyline: { awayDecimal: 1.74627, homeDecimal: 2.17, observedAt: OBSERVED_AT, evidenceRef: `ev:${gameId}:moneyline` },
    },
    evidenceRefs: [`ev:${gameId}:identity`, `ev:${gameId}:schedule`, `ev:${gameId}:moneyline`],
  };
}

function historyRow(gameId: string): TwoSidedHistoryRow {
  return {
    id: 1,
    jsonodds_id: gameId,
    market: 'moneyline',
    source: 'jsonodds',
    line: null,
    away_odds_american: -134,
    away_odds_decimal: 1.74627,
    home_odds_american: 117,
    home_odds_decimal: 2.17,
    captured_at: OPENER_AT,
    captured_at_ms: Date.parse(OPENER_AT),
  };
}

function candidateInput(gameId: string): CandidateInput {
  return {
    gameId,
    sport: 'mlb',
    market: 'moneyline',
    sportAllowList: ['mlb'],
    marketPolicyVersion: MARKET_POLICY_VERSION,
    opener: historyRow(gameId),
    detectedAt: DETECTED_AT,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    cleanEntryWindowMs: 120_000,
    maxClockSkewMs: 5_000,
  };
}

function sealed(gameId: string): PreparedFireSnapshot {
  const json = manifestJson();
  const bytes = new TextEncoder().encode(json);
  return sealPreparedFire({
    game: scopedGame(gameId),
    slug: `mil-pit-${gameId.slice(-4)}`,
    slateDate: '2026-07-18',
    bundleTimestamp: BUNDLE_TS,
    booted: cohortBoot({ manifestBytes: json }),
    publication: checkPublication({
      localManifestBytes: bytes,
      publication: { repositoryOwner: 'ospex-org', repositoryName: 'ospex-benchmark', path: 'manifests/cohort.json', commitSha: 'a'.repeat(40) },
      resolved: { blobBytes: bytes, committerTimestamp: COMMITTER_TS },
    }),
    detectedAt: DETECTED_AT,
    bundleBuiltAt: BUNDLE_BUILT_AT,
    proposedMarkets: MARKETS,
    perMarket: MARKETS.map(() => ({
      candidateInput: candidateInput(gameId),
      verdict: evaluateCandidate(candidateInput(gameId)),
      historyRows: [historyRow(gameId)],
      historyWatermark: null,
    })),
  });
}

function validBody(participantId: string, requestedModelId: string, cohortId: string, bundleSha: string, game: GameBundle): string {
  const body: BenchmarkResponse = {
    schemaVersion: 1,
    cohortId,
    participantId,
    requestedModelId,
    bundleSha256: bundleSha,
    executionPolicy: 'fixed-moneyline-total',
    games: [
      {
        gameId: game.gameId,
        forecasts: [
          {
            market: 'moneyline',
            selection: game.awayTeam,
            line: null,
            observedDecimal: game.markets.moneyline!.awayDecimal,
            probabilities: { win: 0.55, push: 0, loss: 0.45 },
            confidence: 0.6,
            wouldAbstain: false,
            selectedForExecution: true,
            rationale: 'r',
            evidenceRefs: [game.markets.moneyline!.evidenceRef],
            reasonCode: null,
          },
        ],
      },
    ],
  };
  return JSON.stringify(body);
}

/** Minimal per-provider usage the conservative arithmetic prices without ambiguity. */
function pricedUsageFor(provider: string): unknown {
  switch (provider) {
    case 'openai':
      return { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    case 'anthropic':
      return { input_tokens: 1, output_tokens: 1 };
    case 'google':
      return { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 0, totalTokenCount: 2 };
    case 'xai':
      return { prompt_tokens: 1, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
    default:
      throw new Error(`no priced usage fixture for provider ${provider}`);
  }
}

function respondingAdapters(
  snapshot: PreparedFireSnapshot,
  game: GameBundle,
  usageRawFor: (participantId: string, provider: string) => unknown,
): { map: Map<string, ProviderAdapter>; calls: () => number } {
  let calls = 0;
  const map = new Map<string, ProviderAdapter>();
  for (const id of snapshot.expectedArmIdentities) {
    map.set(id.participantId, {
      provider: id.provider as ProviderName,
      requestedModelId: id.requestedModelId,
      credentialEnvVar: 'SYNTHETIC_TEST_CREDENTIAL',
      hasCredential: () => true,
      async chat(_turns: ChatTurn[], _timeoutMs: number): Promise<ProviderResponse> {
        calls += 1;
        return {
          rawText: validBody(id.participantId, id.requestedModelId, snapshot.booted.cohortId, snapshot.prepared.requestSha256, game),
          reportedModelId: id.requestedModelId,
          providerResponseId: 'x',
          httpStatus: 200,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          usageRaw: usageRawFor(id.participantId, id.provider),
          requestParams: {},
        };
      },
    });
  }
  return { map, calls: () => calls };
}

/** Adapters that must NEVER be reached: `chat` records the contact and throws. */
function tripwireAdapters(snapshot: PreparedFireSnapshot): { map: Map<string, ProviderAdapter>; touched: () => number } {
  let touched = 0;
  const map = new Map<string, ProviderAdapter>();
  for (const id of snapshot.expectedArmIdentities) {
    map.set(id.participantId, {
      provider: id.provider as ProviderName,
      requestedModelId: id.requestedModelId,
      credentialEnvVar: 'SYNTHETIC_TEST_CREDENTIAL',
      hasCredential: () => true,
      async chat(): Promise<ProviderResponse> {
        touched += 1;
        throw new Error('TRIPWIRE: a provider was contacted after an installed escalation');
      },
    });
  }
  return { map, touched: () => touched };
}

// --- the durable substrate: an in-memory store whose state survives the "restart" -------

interface FireRow {
  status: 'pending' | 'completed';
  admittedAt: string;
}
interface ClaimRow {
  fireId: string;
  status: 'pending' | 'completed';
}
interface LeaseRow {
  fireId: string;
  released: boolean;
  expiresAtMs: number;
}

/** The durable rows. The tests hold ONE instance across phases; every store facade and
 *  latch read is rebuilt fresh over it, which is what "restart" means here. */
class DurableCohortState {
  readonly fires = new Map<string, FireRow>();
  readonly claims = new Map<string, ClaimRow>(); // key: `${gameId}::${market}`
  readonly leases = new Map<string, LeaseRow>();
}

/** A fresh store facade over the durable rows: full-scope auto-admit that RECORDS the
 *  fire/claims/leases, release marks the lease released, complete settles fire + claims.
 *  Repair and budget-init are outside these scenarios and fail loud if reached. */
function storeOver(state: DurableCohortState, rosterSize: number, nowMs: () => number): AtomicStore {
  return {
    initCohortBudget(_req: InitCohortBudgetRequest): Promise<InitResult> {
      throw new Error('acceptance battery: budget init is not part of these scenarios');
    },
    async admitDispatch(req: AdmitDispatchRequest): Promise<AdmitResult> {
      if (state.fires.has(req.fireId)) throw new Error('acceptance battery: unexpected fire replay');
      const scope = req.scopeReservations[scopeKeyOf(req.proposedMarkets)];
      if (scope === undefined) throw new Error('acceptance battery: missing full-scope reservation');
      state.fires.set(req.fireId, { status: 'pending', admittedAt: new Date(nowMs()).toISOString() });
      for (const market of req.proposedMarkets) {
        state.claims.set(`${req.gameId}::${market}`, { fireId: req.fireId, status: 'pending' });
      }
      const leases = Array.from({ length: rosterSize }, (_, armIndex) => {
        const leaseId = `lease-${req.fireId.slice(0, 8)}-${armIndex}`;
        state.leases.set(leaseId, { fireId: req.fireId, released: false, expiresAtMs: nowMs() + 600_000 });
        return { leaseId, armIndex, expiresAt: new Date(nowMs() + 600_000).toISOString(), state: 'live' as const };
      });
      return {
        outcome: 'admitted',
        claimedKeys: req.proposedMarkets.map((market) => ({ gameId: req.gameId, market })),
        preparedBytesDigest: scope.preparedBytesDigest,
        initialLeases: leases,
        dispatchAuthorized: true,
      };
    },
    acquireRepairLease(_req: AcquireRepairLeaseRequest): Promise<RepairLeaseResult> {
      throw new Error('acceptance battery: no repair path is exercised');
    },
    async releaseLease(req: ReleaseLeaseRequest): Promise<ReleaseResult> {
      const lease = state.leases.get(req.leaseId);
      if (lease !== undefined) lease.released = true;
      return { outcome: 'released' };
    },
    async completeClaim(req: CompleteClaimRequest): Promise<CompleteResult> {
      const fire = state.fires.get(req.fireId);
      if (fire !== undefined) fire.status = 'completed';
      for (const claim of state.claims.values()) {
        if (claim.fireId === req.fireId) claim.status = 'completed';
      }
      return { outcome: 'completed' };
    },
  };
}

/** The SAME predicate as `SqlUnresolvedFireReadPort`, over the durable rows: pending
 *  fires minus any fire holding an unreleased, unexpired lease. */
function unresolvedFireReadOver(state: DurableCohortState, nowMs: () => number): UnresolvedFireRead {
  return {
    async unresolvedFires(_cohortId: string): Promise<readonly UnresolvedFire[]> {
      const out: UnresolvedFire[] = [];
      for (const [fireId, fire] of state.fires) {
        if (fire.status !== 'pending') continue;
        let live = false;
        for (const lease of state.leases.values()) {
          if (lease.fireId === fireId && !lease.released && lease.expiresAtMs > nowMs()) live = true;
        }
        if (!live) out.push({ fireId, admittedAt: fire.admittedAt });
      }
      return out.sort((a, b) => (a.admittedAt < b.admittedAt ? -1 : a.admittedAt > b.admittedAt ? 1 : a.fireId < b.fireId ? -1 : 1));
    },
  };
}

const RUN_OPTIONS: LineOpenRunOptions = {
  timeoutMs: 600_000,
  maxOutputTokens: 16_000,
  executionPolicy: 'fixed-moneyline-total',
  baselinePolicyVersion: 'baselines-v0.3.0',
};
const ADMISSION = { ownerId: OWNER, expectedSchemaVersion: STORE_SCHEMA_VERSION } as const;

/** Run one billable fire through the REAL spine over the durable substrate. */
async function runBillableFire(
  state: DurableCohortState,
  artifactRoot: string,
  gameId: string,
  input: { claimPort?: ClaimPort; adapters: Map<string, ProviderAdapter> },
): Promise<Awaited<ReturnType<typeof runOneFire>>> {
  const snapshot = sealed(gameId);
  return runOneFire({
    snapshot,
    capability: mintInjectedAdapterCapability({ adapters: input.adapters, billingClass: 'billable' }),
    claimPort: input.claimPort ?? new StoreClaimPort(storeOver(state, snapshot.expectedArmIdentities.length, () => NOW_MS)),
    sink: new FireArtifactSink(artifactRoot, nodeArtifactFs),
    runOptions: RUN_OPTIONS,
    admission: ADMISSION,
    now: () => NOW_MS,
  });
}

function spendSidecarFiles(artifactRoot: string, cohortId: string): string[] {
  return readdirSync(join(artifactRoot, cohortId)).filter((name) => name.endsWith('-spend.json')).sort();
}

/** Escalate one real fire and return the durable facts the later phases run against. */
async function installEscalation(state: DurableCohortState, artifactRoot: string): Promise<{ cohortId: string; fireId: string }> {
  const snapshot = sealed(GAME_ID);
  const { map } = respondingAdapters(snapshot, scopedGame(GAME_ID), (participantId, provider) =>
    participantId === ANTHROPIC_ARM_ID ? OVER_CAP_USAGE : pricedUsageFor(provider),
  );
  const outcome = await runBillableFire(state, artifactRoot, GAME_ID, { adapters: map });
  assert.equal(outcome.kind, 'InstalledEscalated');
  if (outcome.kind !== 'InstalledEscalated') throw new Error('unreachable');
  assert.equal(outcome.reason, 'spend_attempt_over_reservation');

  const cohortId = snapshot.booted.cohortId;
  const fireId = snapshot.fireId;
  // The INSTALLED escalation evidence: the real sidecar bytes on the real filesystem.
  const sidecars = spendSidecarFiles(artifactRoot, cohortId);
  assert.equal(sidecars.length, 1);
  const persisted = JSON.parse(readFileSync(join(artifactRoot, cohortId, sidecars[0]!), 'utf8')) as { reason: unknown };
  assert.equal(persisted.reason, 'spend_attempt_over_reservation');
  // The store's durable shadow: the claim retained pending, every lease already settled.
  assert.equal(state.fires.get(fireId)?.status, 'pending', 'an escalated claim is never settled');
  assert.ok([...state.leases.values()].every((l) => l.released), 'every lease settled before the guard ran');
  return { cohortId, fireId };
}

/** The fresh-process harness: everything rebuilt over the durable substrate. */
function restartHarness(state: DurableCohortState, artifactRoot: string, rosterSize: number) {
  const latch = composeEscalationLatch([
    unresolvedFireLatchSource(unresolvedFireReadOver(state, () => NOW_MS)),
    escalationEvidenceLatchSource(artifactRoot),
  ]);
  const claimPort = latchGuardedClaimPort(new StoreClaimPort(storeOver(state, rosterSize, () => NOW_MS)), latch);
  return { latch, claimPort };
}

// ===========================================================================
// the acceptance sequence
// ===========================================================================

test('installed escalation + failed disarm + restart: a fresh tick cannot reach a provider call', async () => {
  const state = new DurableCohortState();
  const artifactRoot = mkdtempSync(join(tmpdir(), 'escalation-latch-acceptance-'));

  // (1) Force an INSTALLED escalation through the real spine.
  const { cohortId, fireId } = await installEscalation(state, artifactRoot);
  const filesAfterEscalation = readdirSync(join(artifactRoot, cohortId)).sort();

  // (2) The disarm write FAILS — the authorization record stays live. The latch must make
  //     this failure safe: nothing below may depend on the disarm having landed.
  let disarmedAt: string | null = null;
  const disarm = async (): Promise<void> => {
    throw new Error('disarm write lost: connection reset before commit');
  };
  await assert.rejects(disarm(), /disarm write lost/);
  assert.equal(disarmedAt, null, 'the authorization was NOT disarmed');

  // (3) RESTART: every object rebuilt fresh over the same durable substrate — no in-memory
  //     flag from the escalated run survives into this harness.
  const snapshot2 = sealed(GAME_ID2);
  const { latch, claimPort } = restartHarness(state, artifactRoot, snapshot2.expectedArmIdentities.length);
  const tripwire = tripwireAdapters(snapshot2);

  // (4) Tick again: the admission is refused by the typed latch error, carrying BOTH
  //     durable causes — the store's unresolved fire AND the installed evidence itself.
  await assert.rejects(
    runBillableFire(state, artifactRoot, GAME_ID2, { claimPort, adapters: tripwire.map }),
    (error: unknown) => {
      assert.ok(error instanceof EscalationLatchedError, `expected the latch refusal, got: ${String(error)}`);
      const kinds = error.causes.map((c) => c.kind).sort();
      assert.deepEqual(kinds, ['escalation_evidence', 'unresolved_fire']);
      const unresolved = error.causes.find((c) => c.kind === 'unresolved_fire');
      assert.equal(unresolved?.kind === 'unresolved_fire' ? unresolved.fireId : null, fireId);
      const evidence = error.causes.find((c) => c.kind === 'escalation_evidence');
      assert.ok(
        evidence?.kind === 'escalation_evidence' &&
          evidence.path.endsWith('-spend.json') &&
          evidence.reason === 'spend_attempt_over_reservation',
      );
      return true;
    },
  );

  // NO provider call was reachable, and nothing new was admitted or written.
  assert.equal(tripwire.touched(), 0, 'no provider adapter was ever invoked');
  assert.deepEqual([...state.fires.keys()], [fireId], 'no new fire was admitted');
  assert.deepEqual(readdirSync(join(artifactRoot, cohortId)).sort(), filesAfterEscalation, 'no new artifact or sidecar was written');

  // The latch itself reports the same verdict directly (what campaign:tick surfaces).
  const verdict = await latch.check(cohortId);
  assert.equal(verdict.latched, true);
});

// ===========================================================================
// controls — the latch is the ONLY refusing gate, and each source holds it alone
// ===========================================================================

test('negative control: after a CLEANLY SETTLED billable fire, the identical restart harness dispatches', async () => {
  const state = new DurableCohortState();
  const artifactRoot = mkdtempSync(join(tmpdir(), 'escalation-latch-clean-'));

  // (1) A clean billable pass through the same spine: settles, and installs a sidecar with
  //     reason null — evidence of a pass, NOT an escalation.
  const snapshot1 = sealed(GAME_ID);
  const clean = respondingAdapters(snapshot1, scopedGame(GAME_ID), (_id, provider) => pricedUsageFor(provider));
  const first = await runBillableFire(state, artifactRoot, GAME_ID, { adapters: clean.map });
  assert.equal(first.kind, 'Installed');
  if (first.kind !== 'Installed') return;
  assert.deepEqual(first.completion, { status: 'settled' });
  const cohortId = snapshot1.booted.cohortId;
  assert.equal(spendSidecarFiles(artifactRoot, cohortId).length, 1, 'the clean pass installed its spend evidence');

  // (2) The IDENTICAL restart harness — same latch composition, same guarded port shape —
  //     over the settled substrate: the second fire dispatches and installs. This is what
  //     pins the latch as the only thing that refused in the acceptance sequence: the
  //     harness itself can dispatch whenever no latch cause exists.
  const snapshot2 = sealed(GAME_ID2);
  const { claimPort } = restartHarness(state, artifactRoot, snapshot2.expectedArmIdentities.length);
  const responding = respondingAdapters(snapshot2, scopedGame(GAME_ID2), (_id, provider) => pricedUsageFor(provider));
  const second = await runBillableFire(state, artifactRoot, GAME_ID2, { claimPort, adapters: responding.map });
  assert.equal(second.kind, 'Installed');
  assert.equal(responding.calls(), snapshot2.expectedArmIdentities.length, 'every arm dispatched exactly once');
});

test('the evidence source ALONE holds the latch after a recovery settle clears the store shadow', async () => {
  const state = new DurableCohortState();
  const artifactRoot = mkdtempSync(join(tmpdir(), 'escalation-latch-evidence-'));
  const { fireId } = await installEscalation(state, artifactRoot);

  // A reviewed recovery path later settles the escalated claim — the store shadow clears...
  const snapshot2 = sealed(GAME_ID2);
  await storeOver(state, snapshot2.expectedArmIdentities.length, () => NOW_MS).completeClaim({
    cohortId: snapshot2.booted.cohortId,
    fireId,
    expectedSchemaVersion: STORE_SCHEMA_VERSION,
  });
  assert.deepEqual(await unresolvedFireReadOver(state, () => NOW_MS).unresolvedFires(snapshot2.booted.cohortId), []);

  // ...but the installed evidence still holds the latch: the campaign stays over.
  const { claimPort } = restartHarness(state, artifactRoot, snapshot2.expectedArmIdentities.length);
  const tripwire = tripwireAdapters(snapshot2);
  await assert.rejects(
    runBillableFire(state, artifactRoot, GAME_ID2, { claimPort, adapters: tripwire.map }),
    (error: unknown) => {
      assert.ok(error instanceof EscalationLatchedError);
      assert.deepEqual(error.causes.map((c) => c.kind), ['escalation_evidence']);
      return true;
    },
  );
  assert.equal(tripwire.touched(), 0);
});

test('the store source ALONE holds the latch when the escalation sidecar file is gone', async () => {
  const state = new DurableCohortState();
  const artifactRoot = mkdtempSync(join(tmpdir(), 'escalation-latch-store-'));
  const { cohortId, fireId } = await installEscalation(state, artifactRoot);

  // The evidence file disappears (the same durable picture as a sidecar install that
  // failed mid-escalation): the store's retained claim STILL latches.
  for (const name of spendSidecarFiles(artifactRoot, cohortId)) {
    rmSync(join(artifactRoot, cohortId, name));
  }
  assert.deepEqual(await escalationEvidenceLatchSource(artifactRoot).causes(cohortId), []);

  const snapshot2 = sealed(GAME_ID2);
  const { claimPort } = restartHarness(state, artifactRoot, snapshot2.expectedArmIdentities.length);
  const tripwire = tripwireAdapters(snapshot2);
  await assert.rejects(
    runBillableFire(state, artifactRoot, GAME_ID2, { claimPort, adapters: tripwire.map }),
    (error: unknown) => {
      assert.ok(error instanceof EscalationLatchedError);
      assert.deepEqual(error.causes.map((c) => ({ kind: c.kind, fireId: c.kind === 'unresolved_fire' ? c.fireId : null })), [
        { kind: 'unresolved_fire', fireId },
      ]);
      return true;
    },
  );
  assert.equal(tripwire.touched(), 0);
});
