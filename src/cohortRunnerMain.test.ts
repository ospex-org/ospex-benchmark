import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CanaryAuthorizationError, assertCohortAdapterCapability } from './cohortAdapterCapability.js';
import { assertBootedCohort, cohortBoot } from './cohortBoot.js';
import { runCohortTick } from './cohortRunner.js';
import { CROSSING_PROFILE } from './crossingProfile.js';
import { observeRealAdapterCredentials, resolveLiveIntent } from './liveIntent.js';
import {
  buildRehearsalTickInput,
  classifyStoreFireResult,
  decodeManifestText,
  formatTickResult,
  installedArtifactPaths,
  runStoreBackedFire,
  selfResolvePublication,
} from './cohortRunnerMain.js';
import type { StoreFireDeps } from './cohortRunnerMain.js';
import { DEMO_PROVIDER_CALL_TIMEOUT_MS, buildDemoFixture } from './demoFixture.js';
import { RehearsalClaimPort } from './lineOpenClaim.js';
import { discover } from './lineOpenRead.js';
import { parseManifest } from './manifest.js';
import { assertPublicationVerified } from './manifestPublication.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import { defaultExpectedArms } from './scoring.js';
import { STORE_SCHEMA_VERSION } from './store/constants.js';
import type { AtomicStore } from './store/contract.js';
import type { CohortTickInput, CohortTickResult, FireOutcomeSummary } from './cohortRunner.js';
import type { DiscoverFn, DiscoveryReads, ReadMarketEvidenceFn } from './lineOpenRead.js';
import type { LineOpenReadConfig } from './lineOpenRead.js';
import type { LineOpenFireOutcome } from './lineOpenSpine.js';
import type { CurrentOddsRow, GamesEndpointRow, MarketKey } from './types.js';
import type { TwoSidedHistoryRow } from './oddsHistory.js';

/**
 * The rehearsal (dry-run) runner entrypoint core, driven WITHOUT env or network: the
 * in-process manifest boots, its publication self-resolves through the pure check, and
 * a full `runCohortTick` runs over genuinely-branded discovery (the real `discover` seam
 * with injected fake reads) + the report-only claim port. Every fire is a `WouldAdmit`
 * rehearsal outcome; nothing is admitted or installed.
 */

// Times aligned so the fixture rows fall inside the manifest's now-relative window.
const FIXED_NOW = Date.parse('2026-07-18T12:00:40.000Z');
const DISCO_MS = Date.parse('2026-07-18T12:00:00.000Z');
const DETECT_MS = DISCO_MS + 5_000;
const OPENER_AT = '2026-07-18T11:59:05.000Z';
const QUOTE_AT = '2026-07-18T11:59:00+00:00';
const MATCH_TIME = '2026-07-18T20:00:00+00:00';

const DUMMY_CONFIG: LineOpenReadConfig = {
  apiUrl: 'http://unused.invalid',
  supabaseUrl: 'http://unused.invalid',
  anonKey: 'unused',
};

/** UTF-8 encode a canonical manifest string to its raw bytes. */
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * A valid generated manifest with ONE byte inside its (schema-accepted, non-code-checked)
 * `uncertaintyPolicyVersion` value flipped to 0xff — a file that is well-formed JSON logically
 * but carries an invalid UTF-8 byte. Under silent replacement it would boot fine (the field
 * only needs a non-empty string); the fatal decoder must reject it instead.
 */
function invalidUtf8ManifestBytes(): Buffer {
  const { bytes } = buildRehearsalManifest(FIXED_NOW);
  const raw = Buffer.from(bytes, 'utf8');
  const at = raw.indexOf(Buffer.from('uncertainty-v1', 'utf8'));
  assert.ok(at >= 0, 'the uncertaintyPolicyVersion value must be present to corrupt');
  raw[at] = 0xff; // an invalid UTF-8 lead byte inside the accepted string value
  return raw;
}

// --- read-path row fixtures (mirrors cohortRunner.test.ts) ------------------

function makeGame(over: Partial<GamesEndpointRow> = {}): GamesEndpointRow {
  const gameId = over.gameId ?? 'g1';
  return {
    gameId,
    slug: `slug-${gameId}`,
    sport: 'mlb',
    matchTime: MATCH_TIME,
    status: 'upcoming',
    homeTeam: { name: 'Home Nine', abbreviation: 'HOM' },
    awayTeam: { name: 'Away Nine', abbreviation: 'AWY' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: true,
    externalIds: { jsonodds: gameId, sportspage: null, rundown: null },
    ...over,
  };
}

function makeOdds(over: Partial<CurrentOddsRow> = {}): CurrentOddsRow {
  return {
    network: 'polygon',
    jsonodds_id: 'g1',
    market: 'moneyline',
    line: null,
    away_odds_american: -120,
    home_odds_american: 110,
    upstream_last_updated: QUOTE_AT,
    poll_captured_at: QUOTE_AT,
    changed_at: QUOTE_AT,
    ...over,
  };
}

function makeHistory(gameId: string, market: MarketKey): TwoSidedHistoryRow {
  return {
    id: 1,
    jsonodds_id: gameId,
    market,
    source: 'jsonodds',
    line: null,
    away_odds_american: -120,
    away_odds_decimal: 1.83333,
    home_odds_american: 110,
    home_odds_decimal: 2.1,
    captured_at: OPENER_AT,
    captured_at_ms: Date.parse(OPENER_AT),
  };
}

function discoveryReads(games: GamesEndpointRow[], odds: CurrentOddsRow[]): DiscoveryReads {
  return {
    readGames: async (sport) => games.filter((g) => g.sport === sport),
    readCurrentOdds: async () => odds,
    now: () => DISCO_MS,
  };
}

function fixtureDiscoverFn(games: GamesEndpointRow[], odds: CurrentOddsRow[]): DiscoverFn {
  return (booted) => discover(booted, discoveryReads(games, odds));
}

function fixtureEvidenceReader(): ReadMarketEvidenceFn {
  return async (_booted, gameId, market) => ({
    gameId,
    market,
    historyRows: [makeHistory(gameId, market)],
    historyWatermark: null,
    readCompletedAt: '2026-07-18T12:00:01.000Z',
  });
}

function tickClock(): () => number {
  const values = [DETECT_MS, DETECT_MS + 1_000, DETECT_MS + 2_000, DETECT_MS + 3_000];
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

/** A rehearsal tick input with the two read seams overridden by genuinely-branded
 *  fixtures, so the whole tick runs with NO network. */
function fixtureTickInput(bytes: string, games: GamesEndpointRow[], odds: CurrentOddsRow[]): CohortTickInput {
  const base = buildRehearsalTickInput({
    manifestBytes: enc(bytes),
    config: DUMMY_CONFIG,
    now: tickClock(),
    ownerId: 'test-owner',
  });
  return { ...base, discover: fixtureDiscoverFn(games, odds), readMarketEvidence: fixtureEvidenceReader() };
}

// ===========================================================================

test('selfResolvePublication yields a genuine PublicationVerified bound to the booted cohort', () => {
  const { bytes } = buildRehearsalManifest(FIXED_NOW);
  const booted = cohortBoot({ manifestBytes: bytes });
  const publication = selfResolvePublication(enc(bytes));
  assert.doesNotThrow(() => assertPublicationVerified(publication));
  assert.equal(publication.cohortId, booted.cohortId, 'publication is verified for THIS cohort');
  assert.ok(
    Date.parse(publication.committerTimestamp) < Date.parse(booted.manifest.windowStart),
    'committer timestamp is strictly before windowStart',
  );
});

test('buildRehearsalTickInput wires a report-only claim, a no-op sink, a full roster, and derived options', () => {
  const { bytes, manifest } = buildRehearsalManifest(FIXED_NOW);
  const input = buildRehearsalTickInput({ manifestBytes: enc(bytes), config: DUMMY_CONFIG, now: () => FIXED_NOW, ownerId: 'owner-x' });

  assert.doesNotThrow(() => assertBootedCohort(input.booted));
  assert.doesNotThrow(() => assertPublicationVerified(input.publication));
  assert.ok(input.claimPort instanceof RehearsalClaimPort, 'the claim port is report-only');
  // The sink is a never-called no-op: invoking it is a broken invariant and throws.
  assert.throws(() => (input.sink.install as unknown as () => never)());
  assert.throws(() => (input.sink.installSpendEscalationSidecar as unknown as () => never)());
  // The adapter authority is a MINTED capability (not a raw map), known-zero, covering the
  // whole expected roster (required for the pre-claim plan build).
  assert.doesNotThrow(() => assertCohortAdapterCapability(input.capability));
  assert.equal(input.capability.billingClass, 'known-zero');
  const adapters = input.capability.adapters();
  for (const arm of defaultExpectedArms()) {
    assert.ok(adapters.has(arm.participantId), `adapter present for ${arm.participantId}`);
  }
  // Run options + admission are derived from the booted manifest / store constants.
  assert.equal(input.runOptions.timeoutMs, manifest.constants.providerCallTimeoutMs);
  assert.equal(input.runOptions.maxOutputTokens, manifest.constants.maxOutputTokens);
  assert.equal(input.runOptions.baselinePolicyVersion, 'baselines-v0.3.0');
  assert.equal(input.admission.expectedSchemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(input.admission.ownerId, 'owner-x');
});

test('a rehearsal tick discovers, projects one prepared candidate, and reports it as WouldAdmit', async () => {
  const { bytes } = buildRehearsalManifest(FIXED_NOW);
  const games = [makeGame({ gameId: 'g1' })];
  const odds = [makeOdds({ jsonodds_id: 'g1', market: 'moneyline' })];

  const result = await runCohortTick(fixtureTickInput(bytes, games, odds));

  assert.equal(result.discoveredCount, 1);
  assert.deepEqual(
    result.dispositions.map((d) => ({ ...d })),
    [{ gameId: 'g1', market: 'moneyline', outcome: 'prepared' }],
  );
  assert.equal(result.fireOutcomes.length, 1);
  assert.equal(result.fireOutcomes[0]!.outcome.kind, 'NotAdmitted');
  assert.equal(result.admittedCount, 0, 'a rehearsal admits nothing');

  const rendered = formatTickResult(result);
  assert.ok(rendered.some((l) => /discovered 1 candidate/.test(l)));
  assert.ok(rendered.some((l) => /g1 moneyline: prepared/.test(l)), 'the prepared disposition renders');
  assert.ok(rendered.some((l) => /NotAdmitted\/WouldAdmit/.test(l)), 'the WouldAdmit rehearsal line renders');
  assert.ok(rendered.some((l) => /admitted 0 fire/.test(l)));
});

test('a rehearsal tick over an empty discovery renders a zero-candidate result (no network)', async () => {
  const { bytes } = buildRehearsalManifest(FIXED_NOW);
  const result = await runCohortTick(fixtureTickInput(bytes, [], []));

  assert.equal(result.discoveredCount, 0);
  assert.equal(result.dispositions.length, 0);
  assert.equal(result.fireOutcomes.length, 0);
  assert.equal(result.admittedCount, 0);
  assert.ok(formatTickResult(result).some((l) => /discovered 0 candidate/.test(l)));
});

test('invalid-UTF-8 manifest bytes THROW at the fatal decode — never silently rewritten', () => {
  const raw = invalidUtf8ManifestBytes();
  // The fatal decoder rejects the byte outright...
  assert.throws(() => decodeManifestText(raw));
  // ...and both entry helpers that consume raw manifest bytes propagate that rejection.
  assert.throws(() => selfResolvePublication(raw));
  assert.throws(() =>
    buildRehearsalTickInput({ manifestBytes: raw, config: DUMMY_CONFIG, now: () => FIXED_NOW, ownerId: 'x' }),
  );
});

test('the spawned CLI exits nonzero and emits nothing on an invalid-UTF-8 --manifest file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-dry-utf8-'));
  const invalidPath = join(dir, 'invalid-manifest.json');
  const outPath = join(dir, 'emitted.json');
  writeFileSync(invalidPath, invalidUtf8ManifestBytes()); // raw bytes, incl. the 0xff

  // Drive the ACTUAL CLI the way `yarn runner:dry` does (tsx on the entry module).
  const scriptPath = fileURLToPath(new URL('./cohortRunnerMain.ts', import.meta.url));
  const repoRoot = dirname(dirname(scriptPath));
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', scriptPath, '--manifest', invalidPath, '--emit-manifest', outPath],
    { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
  );

  // A real nonzero exit (not a timeout kill, which would leave status === null).
  assert.ok(
    typeof result.status === 'number' && result.status !== 0,
    `expected a nonzero exit; status=${String(result.status)} signal=${String(result.signal)} stderr=${result.stderr ?? ''}`,
  );
  // The corrupted manifest was NOT normalized-and-emitted: no output file exists.
  assert.ok(!existsSync(outPath), 'a corrupted manifest must not be rewritten and emitted');
});

// ===========================================================================
// Store-backed fire: result classification (the `runner:fire` exit code) +
// up-front option-combination refusals (before any DB / artifact work).
// ===========================================================================

/** Synthesize a `FireOutcomeSummary`. The classifier reads only `outcome.kind`,
 *  `outcome.completion.status`, and (via `installedArtifactPaths`) `outcome.install.path`, so a
 *  shape-minimal cast drives it without standing up the store, spine, sink, or a real permit/artifact. */
function fireSummary(fireId: string, outcome: LineOpenFireOutcome): FireOutcomeSummary {
  return { fireId, gameId: 'g1', market: 'moneyline', outcome };
}

const notAdmittedOutcome = (): LineOpenFireOutcome =>
  ({ kind: 'NotAdmitted', outcome: { kind: 'WouldAdmit' } }) as unknown as LineOpenFireOutcome;

const installedSettledOutcome = (
  path: string,
  sidecar: { path: string; created: boolean; sha256: string } | null = null,
): LineOpenFireOutcome =>
  ({
    kind: 'Installed',
    install: { path, created: true },
    completion: { status: 'settled' },
    sidecar,
  }) as unknown as LineOpenFireOutcome;

const installedUnsettledOutcome = (path: string): LineOpenFireOutcome =>
  ({
    kind: 'Installed',
    install: { path, created: true },
    completion: { status: 'unsettled', reason: 'store_complete_failed' },
    sidecar: null,
  }) as unknown as LineOpenFireOutcome;

/** Wrap synthesized fire outcomes in a minimal `CohortTickResult` (the classifier reads only
 *  `fireOutcomes`). */
function tickResultOf(fireOutcomes: FireOutcomeSummary[]): CohortTickResult {
  return {
    discoveredCount: fireOutcomes.length,
    dispositions: [],
    fireOutcomes,
    admittedCount: fireOutcomes.filter((f) => f.outcome.kind === 'Installed').length,
  };
}

/** Drive the ACTUAL CLI the way `yarn runner:fire` does (tsx on the entry module), returning the
 *  exit status and the combined stdout+stderr. `env` overrides are merged over the real environment. */
function runCli(args: string[], env: Record<string, string> = {}): {
  status: number | null;
  signal: NodeJS.Signals | null;
  out: string;
} {
  const scriptPath = fileURLToPath(new URL('./cohortRunnerMain.ts', import.meta.url));
  const repoRoot = dirname(dirname(scriptPath));
  const result = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
    // Explicit empty stdin: any read sees immediate EOF (the attended confirm must refuse).
    input: '',
  });
  return { status: result.status, signal: result.signal, out: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

/** An intentionally-unreachable Postgres URL: a connection attempt fails immediately with
 *  ECONNREFUSED, so any DB touch surfaces distinctively in the CLI output. */
const UNREACHABLE_STORE_URL = 'postgres://x:x@127.0.0.1:1/nope';

test('classifyStoreFireResult accepts exactly one Installed/settled fire with one artifact path', () => {
  const result = tickResultOf([fireSummary('f1', installedSettledOutcome('/out/cohort/fire-a.json'))]);
  assert.deepEqual(classifyStoreFireResult(result), { ok: true });
});

test('classifyStoreFireResult rejects a NotAdmitted / no-artifact result (nonzero)', () => {
  const result = tickResultOf([fireSummary('f1', notAdmittedOutcome())]);
  assert.equal(classifyStoreFireResult(result).ok, false);
});

test('classifyStoreFireResult rejects an Installed but unsettled result (nonzero)', () => {
  const result = tickResultOf([fireSummary('f1', installedUnsettledOutcome('/out/cohort/fire-a.json'))]);
  assert.equal(classifyStoreFireResult(result).ok, false);
});

test('classifyStoreFireResult rejects zero fires and any non-unit fire/path cardinality (nonzero)', () => {
  // Zero fire outcomes.
  assert.equal(classifyStoreFireResult(tickResultOf([])).ok, false);
  // More than one fire (and, correspondingly, more than one installed artifact path).
  const twoInstalled = tickResultOf([
    fireSummary('f1', installedSettledOutcome('/out/cohort/fire-a.json')),
    fireSummary('f2', installedSettledOutcome('/out/cohort/fire-b.json')),
  ]);
  assert.equal(classifyStoreFireResult(twoInstalled).ok, false);
});

// ---------------------------------------------------------------------------
// B1-R4 — every LineOpenFireOutcome consumer handles CoverageMiss fail-closed.
// A CoverageMiss has NO `.outcome` field, so the legacy `'reason' in outcome.outcome`
// path in describeOutcome would throw on it; the dedicated CoverageMiss case must be
// handled first. Deleting that case turns the formatTickResult / classifier tests red.
// ---------------------------------------------------------------------------

/** Synthesize a pre-claim `CoverageMiss` outcome. The consumers read only `outcome.kind` and (via
 *  describeOutcome) `outcome.reason`, so a shape-minimal cast drives them without the spine. */
const coverageMissOutcome = (reason = 'first_pitch_before_claim'): LineOpenFireOutcome =>
  ({
    kind: 'CoverageMiss',
    reason,
    operands: {
      preClaimReadingAt: '2026-07-18T20:00:00.000Z',
      scheduledAtAtFire: '2026-07-18T20:00:00.000Z',
      windowEnd: '2026-07-19T00:00:00.000Z',
      detectedAt: '2026-07-18T12:00:30.000Z',
    },
  }) as unknown as LineOpenFireOutcome;

test('B1-R4: classifyStoreFireResult treats a CoverageMiss as a non-installed non-success (no throw)', () => {
  const result = tickResultOf([fireSummary('f1', coverageMissOutcome('first_pitch_before_claim'))]);
  assert.equal(classifyStoreFireResult(result).ok, false, 'a coverage miss installed no artifact');
});

test('B1-R4: formatTickResult renders a CoverageMiss line without throwing', () => {
  const result = tickResultOf([fireSummary('f1', coverageMissOutcome('window_end_before_claim'))]);
  const lines = formatTickResult(result); // must not throw (describeOutcome CoverageMiss case)
  assert.ok(
    lines.some((l) => /CoverageMiss\/window_end_before_claim/.test(l)),
    'the CoverageMiss reason renders on the fire-outcome line',
  );
});

test('B1-R4: installedArtifactPaths ignores a CoverageMiss (it installed no artifact)', () => {
  const result = tickResultOf([fireSummary('f1', coverageMissOutcome())]);
  assert.deepEqual(installedArtifactPaths(result), []);
});

// ---------------------------------------------------------------------------
// Every LineOpenFireOutcome consumer handles a spend-guard escalation truthfully:
// the fire DID durably install (its path must survive; the message must not claim
// otherwise) but it is NOT a completed demo (nonzero), and the rendered line names
// the escalation reason.
// ---------------------------------------------------------------------------

/** Synthesize an `InstalledEscalated` outcome. The consumers read only `outcome.kind`,
 *  `outcome.reason`, `outcome.offenders.length`, `outcome.install.path`, and `outcome.sidecar`. */
const installedEscalatedOutcome = (path: string): LineOpenFireOutcome =>
  ({
    kind: 'InstalledEscalated',
    install: { path, created: true },
    sidecar: { path: `${path.replace(/\.json$/, '')}-spend.json`, created: true, sha256: 'ab'.repeat(32) },
    reason: 'spend_attempt_over_reservation',
    offenders: [{ participantId: 'arm-1', role: 'initial', status: 'breach', derivedActualUsdMicros: 100_000_010 }],
  }) as unknown as LineOpenFireOutcome;

test('classifyStoreFireResult rejects an escalated fire with an HONEST reason — installed, not settled', () => {
  const result = tickResultOf([fireSummary('f1', installedEscalatedOutcome('/out/cohort/fire-a.json'))]);
  const classification = classifyStoreFireResult(result);
  assert.equal(classification.ok, false, 'an escalated fire is never a completed demo');
  if (classification.ok) return;
  // The message must not claim "installed no artifact" — the whole point of post-install
  // escalation is that the evidence exists; what failed is settlement.
  assert.doesNotMatch(classification.reason, /installed no artifact/);
  assert.match(classification.reason, /spend guard refused settlement/);
  assert.match(classification.reason, /spend_attempt_over_reservation/);
});

test('formatTickResult renders an escalated fire as an escalation with its reason AND the sidecar evidence', () => {
  const result = tickResultOf([fireSummary('f1', installedEscalatedOutcome('/out/cohort/fire-a.json'))]);
  const lines = formatTickResult(result);
  assert.ok(
    lines.some((l) => /InstalledEscalated\/spend_attempt_over_reservation/.test(l)),
    'the escalation reason renders on the fire-outcome line',
  );
  // The operator report carries the durable escalation evidence: sidecar path + its hash.
  assert.ok(
    lines.some((l) => l.includes('/out/cohort/fire-a-spend.json') && l.includes('ab'.repeat(32))),
    'the sidecar path and sha256 render in the operator report',
  );
});

test('formatTickResult renders the CLEAN billable sidecar line, and prints none for a known-zero fire', () => {
  const withSidecar = tickResultOf([
    fireSummary(
      'f1',
      installedSettledOutcome('/out/cohort/fire-a.json', {
        path: '/out/cohort/fire-a-spend.json',
        created: true,
        sha256: 'cd'.repeat(32),
      }),
    ),
  ]);
  const lines = formatTickResult(withSidecar);
  assert.ok(
    lines.some((l) => l.includes('/out/cohort/fire-a-spend.json') && l.includes('cd'.repeat(32))),
    'the clean billable fire reports its durable spend evidence',
  );

  const knownZero = formatTickResult(tickResultOf([fireSummary('f1', installedSettledOutcome('/out/cohort/fire-a.json'))]));
  assert.ok(!knownZero.some((l) => /sidecar:/.test(l)), 'a known-zero fire prints no sidecar line — output unchanged');
});

test('installedArtifactPaths KEEPS an escalated fire path — its evidence durably installed', () => {
  const result = tickResultOf([
    fireSummary('f1', installedSettledOutcome('/out/cohort/fire-a.json')),
    fireSummary('f2', installedEscalatedOutcome('/out/cohort/fire-b.json')),
  ]);
  assert.deepEqual(installedArtifactPaths(result), ['/out/cohort/fire-a.json', '/out/cohort/fire-b.json']);
});

test('B1-R4: runStoreBackedFire exits nonzero for a CoverageMiss tick (classifier wired to the exit)', async () => {
  const result = tickResultOf([fireSummary('f1', coverageMissOutcome())]);
  const code = await runStoreBackedFire(FIRE_OPTIONS, fakeStoreFireDeps(result));
  assert.notEqual(code, 0, 'a coverage miss must not report the demo as complete');
});

// ---------------------------------------------------------------------------
// Owner-level: `runStoreBackedFire` USES the classifier verdict for its exit code.
// The pure classifier tests above prove the VERDICT; these drive the REAL owner
// function (no DB) with injected seams so the classifier call is actually EXERCISED
// on the exit path — bypassing it (an unconditional `return 0`) turns the two
// non-ok cases red. `openStore` yields a fake initialized store (so the real boot +
// `assertCohortBudgetInitialized` pass) and nothing else is touched, since `runTick`
// is faked — the claim port / sink / adapters are constructed but never exercised.
// ---------------------------------------------------------------------------

/** A fake `AtomicStore` whose `initCohortBudget` reports `initialized` (so `assertCohortBudgetInitialized`
 *  passes); every other method throws, because the faked `runTick` never reaches the claim / lease /
 *  completion calls. */
function fakeInitializedStore(): AtomicStore {
  const unreached = (): never => {
    throw new Error('the faked runTick never exercises the store beyond initCohortBudget');
  };
  return {
    initCohortBudget: async () => ({ outcome: 'initialized' as const }),
    admitDispatch: unreached,
    acquireRepairLease: unreached,
    releaseLease: unreached,
    completeClaim: unreached,
  };
}

/** Store-fire deps that open the fake store (no DB) and return `result` from the (never-DB) tick.
 *  Live resolution defaults to the REAL resolver (which returns `MockRequested` for `live: false`,
 *  proving the default path flows through the production tri-state seam). */
function fakeStoreFireDeps(result: CohortTickResult, over: Partial<StoreFireDeps> = {}): StoreFireDeps {
  return {
    openStore: async () => ({ store: fakeInitializedStore(), close: async () => {} }),
    runTick: async () => result,
    resolveLive: ({ live, booted }) =>
      resolveLiveIntent({
        live,
        booted,
        observeCredentials: (ids) => new Map(ids.map((id) => [id, false])),
        print: () => {},
        confirm: async () => null,
      }),
    ...over,
  };
}

/** The fixture CLI options the store-backed fire consumes: `--fixture` is required (else it exits 2
 *  before the tick), and an explicit `outDir` keeps the never-installing sink off the repo default. */
const FIRE_OPTIONS = {
  manifestPath: null,
  emitManifestPath: null,
  store: 'postgres',
  fixture: true,
  outDir: join(tmpdir(), 'runner-fire-owner-never-written'),
  live: false,
};

test('runStoreBackedFire returns 0 for exactly one Installed/settled fire with one artifact path', async () => {
  const result = tickResultOf([fireSummary('f1', installedSettledOutcome('/out/cohort/fire-a.json'))]);
  const code = await runStoreBackedFire(FIRE_OPTIONS, fakeStoreFireDeps(result));
  assert.equal(code, 0, 'a completed demo (one Installed/settled fire, one path) exits 0');
});

test('runStoreBackedFire returns nonzero for a NotAdmitted / no-artifact tick (classifier is wired to the exit)', async () => {
  const result = tickResultOf([fireSummary('f1', notAdmittedOutcome())]);
  const code = await runStoreBackedFire(FIRE_OPTIONS, fakeStoreFireDeps(result));
  assert.notEqual(code, 0, 'nothing installed must not report success — bypassing the classifier call turns this red');
});

test('runStoreBackedFire returns nonzero for an Installed but unsettled tick (classifier is wired to the exit)', async () => {
  const result = tickResultOf([fireSummary('f1', installedUnsettledOutcome('/out/cohort/fire-a.json'))]);
  const code = await runStoreBackedFire(FIRE_OPTIONS, fakeStoreFireDeps(result));
  assert.notEqual(code, 0, 'an unsettled completion must not report success — bypassing the classifier call turns this red');
});

test('the spawned CLI refuses --live (missing credentials) BEFORE any DB work — and never runs mock instead', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-fire-live-'));
  const outDir = join(dir, 'artifacts');
  // Pin every provider credential ABSENT: an empty value counts as set for the .env loader
  // (so a local .env cannot re-supply it) and reads as undefined for the adapters' probes.
  const { status, signal, out } = runCli(['--store=postgres', '--fixture', '--live', '--out', outDir], {
    STORE_DATABASE_URL: UNREACHABLE_STORE_URL,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    GEMINI_API_KEY: '',
    GOOGLE_API_KEY: '',
    XAI_API_KEY: '',
  });

  // A real nonzero exit (not a timeout kill, which would leave status === null).
  assert.ok(
    typeof status === 'number' && status !== 0,
    `expected a nonzero exit; status=${String(status)} signal=${String(signal)} out=${out}`,
  );
  // The tri-state resolution refused (no usable credentials) and said so — with NO mock fallback.
  assert.ok(/--live refused — no mock fallback/.test(out), `expected the live refusal message; out=${out}`);
  assert.ok(/no usable credential/.test(out), `expected the credential violations; out=${out}`);
  // Refused BEFORE the store was opened: no DB connection was attempted against the unreachable
  // URL, and DB setup was never reached — a refused live request touches nothing.
  assert.ok(!/ECONNREFUSED/i.test(out), `must not surface a DB connection error; out=${out}`);
  assert.ok(!/store schema \+ functions applied/.test(out), `must not reach DB setup; out=${out}`);
  // No dispatch of ANY kind ran (the mock demo would have printed its dispatch line).
  assert.ok(!/dispatching the/.test(out), `must not dispatch mock OR live; out=${out}`);
  // And no artifact was produced.
  assert.ok(!existsSync(outDir), 'no artifact directory should be created');
});

test('the spawned CLI drives the PRODUCTION confirm seam to EOF: terms print, the run refuses, no DB is touched', () => {
  // Synthetic credentials satisfy every pre-prompt gate, so this is the one test that
  // executes PRODUCTION_STORE_FIRE_DEPS.resolveLive end to end — the real credential
  // probe, the real term printing, and the real readline confirm hitting immediate EOF
  // on the empty piped stdin. EOF refuses, so no capability is minted and the unreachable
  // store URL is never dialed. (No affirmative answer is possible on this stdin, so no
  // dispatch of any kind is reachable.)
  const dir = mkdtempSync(join(tmpdir(), 'runner-fire-live-eof-'));
  const outDir = join(dir, 'artifacts');
  const { status, signal, out } = runCli(['--store=postgres', '--fixture', '--live', '--out', outDir], {
    STORE_DATABASE_URL: UNREACHABLE_STORE_URL,
    OPENAI_API_KEY: 'synthetic-test-credential',
    ANTHROPIC_API_KEY: 'synthetic-test-credential',
    GEMINI_API_KEY: 'synthetic-test-credential',
    GOOGLE_API_KEY: '',
    XAI_API_KEY: 'synthetic-test-credential',
  });

  assert.ok(
    typeof status === 'number' && status !== 0,
    `expected a nonzero exit; status=${String(status)} signal=${String(signal)} out=${out}`,
  );
  // The terms printed BEFORE the prompt (the run was authorizable up to the confirmation),
  // and the PRODUCTION readline seam emitted the exact [Y/n] prompt label end to end.
  assert.ok(/ATTENDED LIVE CROSSING/.test(out), `the terms header printed; out=${out}`);
  assert.ok(out.includes('$800.00'), `the $800 ceiling printed; out=${out}`);
  assert.ok(
    out.includes('proceed with the attended live crossing? [Y/n]'),
    `the exact [Y/n] prompt reached stdout through the production seam; out=${out}`,
  );
  // The EOF refusal, with no mock fallback and no DB/dispatch of any kind.
  assert.ok(/--live refused — no mock fallback/.test(out), `the refusal printed; out=${out}`);
  assert.ok(/EOF/.test(out), `the refusal names EOF; out=${out}`);
  assert.ok(!/ECONNREFUSED/i.test(out), `must not dial the store; out=${out}`);
  assert.ok(!/store schema \+ functions applied/.test(out), `must not reach DB setup; out=${out}`);
  assert.ok(!/dispatching the/.test(out), `must not dispatch mock OR live; out=${out}`);
  assert.ok(!existsSync(outDir), 'no artifact directory should be created');
});

test('the spawned CLI refuses --live outside the store-backed crossing path (rehearsal), nonzero', () => {
  const { status, out } = runCli(['--store=rehearsal', '--live']);
  assert.ok(typeof status === 'number' && status !== 0, `expected a nonzero exit; out=${out}`);
  assert.ok(/--live is only valid on the store-backed crossing path/.test(out), `expected the combo refusal; out=${out}`);
  // Refused BEFORE the banner: no rehearsal mode line printed, no tick ran.
  assert.ok(!/REHEARSAL \(dry-run\)/.test(out), `no rehearsal banner; out=${out}`);
  assert.ok(!/discovered \d+ candidate/.test(out), `no rehearsal tick ran; out=${out}`);
});

test('the spawned CLI refuses --emit-manifest with --store=postgres before any DB work, writing no file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-fire-emit-'));
  const outPath = join(dir, 'emitted.json');
  const { status, out } = runCli(['--store=postgres', '--fixture', '--emit-manifest', outPath], {
    STORE_DATABASE_URL: UNREACHABLE_STORE_URL,
  });

  assert.ok(typeof status === 'number' && status !== 0, `expected a nonzero exit; out=${out}`);
  assert.ok(!existsSync(outPath), 'the emit file must not be written under --store=postgres');
  assert.ok(!/ECONNREFUSED/i.test(out), `must not touch the DB; out=${out}`);
});

test('the spawned CLI refuses --fixture in a non-postgres store (rehearsal), writing no emit file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-fire-fixture-'));
  const outPath = join(dir, 'emitted.json');
  const { status, out } = runCli(['--store=rehearsal', '--fixture', '--emit-manifest', outPath]);

  assert.ok(typeof status === 'number' && status !== 0, `expected a nonzero exit; out=${out}`);
  assert.ok(!existsSync(outPath), 'the emit file must not be written when --fixture is refused');
});

test('the demo fixture manifest pins providerCallTimeoutMs to the fast demo timeout', () => {
  const anchor = Date.parse('2026-07-18T12:00:00.000Z');
  const fixture = buildDemoFixture(anchor);
  const manifest = parseManifest(JSON.parse(decodeManifestText(fixture.manifestBytes)) as unknown);
  // The fast-timeout claim is load-bearing: the always-timing-out mock arm settles in ~1s.
  assert.equal(manifest.constants.providerCallTimeoutMs, DEMO_PROVIDER_CALL_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Tri-state live wiring: the store-fire builder's adapter selection is owned by
// the resolution. MockRequested keeps the known-zero mock demo byte-identical;
// LiveRefused exits nonzero having touched NOTHING; LiveAuthorized mints the
// REAL billable capability through the gated producer (which re-validates the
// authorization itself — a stale one is refused loudly before any store work).
// ---------------------------------------------------------------------------

/** Synthetic provider credentials for the no-dispatch wiring tests (never real keys); the
 *  Google arm exercises its primary env var. */
const SYNTHETIC_PROVIDER_ENV: Record<string, string | undefined> = {
  OPENAI_API_KEY: 'synthetic-test-credential',
  ANTHROPIC_API_KEY: 'synthetic-test-credential',
  GEMINI_API_KEY: 'synthetic-test-credential',
  GOOGLE_API_KEY: undefined,
  XAI_API_KEY: 'synthetic-test-credential',
};

/** Run `fn` with `vars` applied to the environment (undefined = deleted), restoring after. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Run `fn` under a THROWING `globalThis.fetch`: proof the wiring under test never
 *  reaches the network (minting captures facades; the faked tick dispatches nothing). */
async function withThrowingFetch<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('network reached during a non-dispatching wiring test');
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('the default (no --live) store fire resolves MockRequested and mints the known-zero mock capability over the DEMO manifest', async () => {
  let captured: CohortTickInput | undefined;
  const result = tickResultOf([fireSummary('f1', installedSettledOutcome('/out/cohort/fire-a.json'))]);
  const code = await runStoreBackedFire(
    FIRE_OPTIONS,
    fakeStoreFireDeps(result, {
      runTick: async (input) => {
        captured = input;
        return result;
      },
    }),
  );
  assert.equal(code, 0);
  assert.ok(captured, 'the tick ran');
  assert.doesNotThrow(() => assertCohortAdapterCapability(captured!.capability));
  assert.equal(captured!.capability.billingClass, 'known-zero', 'the default path stays known-zero');
  // The PRODUCTION mock capability, not any known-zero stand-in: the whole expected
  // roster is present (an empty or partial capability would break the pre-claim plan).
  const adapters = captured!.capability.adapters();
  for (const arm of defaultExpectedArms()) {
    assert.ok(adapters.has(arm.participantId), `mock adapter present for ${arm.participantId}`);
  }
  // The DEMO manifest, not the crossing manifest: fast mock timeout and the demo caps.
  assert.equal(captured!.booted.manifest.constants.providerCallTimeoutMs, DEMO_PROVIDER_CALL_TIMEOUT_MS);
  assert.equal(captured!.booted.manifest.cohortSpendCapUsdMicros, 1_000_000_000);
});

test('a resolution that DISAGREES with the live flag is refused by the coherence guard — both directions', async () => {
  // live:true resolved as MockRequested = the banned silent downgrade; live:false resolved
  // as LiveAuthorized/LiveRefused = an escalation the operator never armed. Either way:
  // nonzero, nothing opened, no tick, no capability path taken.
  const cases: readonly { live: boolean; resolution: () => unknown }[] = [
    { live: true, resolution: () => ({ kind: 'MockRequested' }) },
    { live: false, resolution: () => ({ kind: 'LiveRefused', violations: ['x'] }) },
  ];
  for (const { live, resolution } of cases) {
    const events: string[] = [];
    const deps: StoreFireDeps = {
      openStore: async () => {
        events.push('openStore');
        return { store: fakeInitializedStore(), close: async () => {} };
      },
      runTick: async () => {
        events.push('runTick');
        return tickResultOf([]);
      },
      resolveLive: async () => resolution() as never,
    };
    const code = await runStoreBackedFire({ ...FIRE_OPTIONS, live }, deps);
    assert.notEqual(code, 0, `live=${live}: incoherent resolution exits nonzero`);
    assert.deepEqual(events, [], `live=${live}: nothing was touched`);
  }
});

test('the LIVE fixture seams anchor AFTER the resolution — a slow attended confirmation cannot stale the snapshot', async () => {
  // The resolution (production: the human [Y/n] prompt) is unbounded; the projector's
  // freshness gate compares detection to the seams' fetchCompletedAt with a 30s budget.
  // So the seams must anchor after the resolution returns, not at the boot anchor.
  let resolutionDoneMs = 0;
  let captured: CohortTickInput | undefined;
  const result = tickResultOf([fireSummary('f1', installedSettledOutcome('/out/cohort/fire-a.json'))]);
  const deps: StoreFireDeps = fakeStoreFireDeps(result, {
    runTick: async (input) => {
      captured = input;
      return result;
    },
    resolveLive: ({ live, booted }) =>
      resolveLiveIntent({
        live,
        booted,
        observeCredentials: observeRealAdapterCredentials,
        print: () => {},
        confirm: async () => {
          // A measurably slow attended confirmation (well under test-timeout, well over 0).
          await new Promise((r) => setTimeout(r, 120));
          resolutionDoneMs = Date.now();
          return 'y';
        },
      }),
  });
  await withEnv(SYNTHETIC_PROVIDER_ENV, () =>
    withThrowingFetch(async () => {
      const code = await runStoreBackedFire({ ...FIRE_OPTIONS, live: true }, deps);
      assert.equal(code, 0);
    }),
  );
  assert.ok(captured && resolutionDoneMs > 0, 'the tick ran after a timed confirmation');
  const discovery = await captured!.discover(captured!.booted);
  assert.ok(
    Date.parse(discovery.fetchCompletedAt) >= resolutionDoneMs,
    `the discovery snapshot (${discovery.fetchCompletedAt}) must be anchored at/after the ` +
      `confirmation completed (${new Date(resolutionDoneMs).toISOString()}) — anchoring it before ` +
      `the unbounded prompt would spend the 30s freshness budget on human reading time`,
  );
});

test('runStoreBackedFire exits 2 on LiveRefused having touched NOTHING — no store open, no tick, no mock fallback', async () => {
  const events: string[] = [];
  const deps: StoreFireDeps = {
    openStore: async () => {
      events.push('openStore');
      return { store: fakeInitializedStore(), close: async () => {} };
    },
    runTick: async () => {
      events.push('runTick');
      return tickResultOf([]);
    },
    resolveLive: async () => ({ kind: 'LiveRefused', violations: ['injected refusal'] }),
  };
  const code = await runStoreBackedFire({ ...FIRE_OPTIONS, live: true }, deps);
  assert.equal(code, 2, 'a refused live request exits nonzero');
  assert.deepEqual(events, [], 'neither the store nor the tick was touched — and no mock ran in its place');
});

test('--live + full authorization mints the REAL billable capability over the CROSSING manifest — terms printed, no dispatch, no network', async () => {
  const printed: string[] = [];
  let captured: CohortTickInput | undefined;
  const result = tickResultOf([fireSummary('f1', installedSettledOutcome('/out/cohort/fire-a.json'))]);
  const deps: StoreFireDeps = fakeStoreFireDeps(result, {
    runTick: async (input) => {
      captured = input;
      return result;
    },
    // The REAL resolver + the REAL credential probe (over synthetic env), scripted 'y'.
    resolveLive: ({ live, booted }) =>
      resolveLiveIntent({
        live,
        booted,
        observeCredentials: observeRealAdapterCredentials,
        print: (line) => printed.push(line),
        confirm: async () => 'y',
      }),
  });
  // The assertions run INSIDE the synthetic-env scope: the capability's facades are
  // LIVE-BOUND to the real adapters' env probes (deliberately — proven in the capability
  // suite), so `hasCredential()` must be read while the synthetic credentials exist.
  await withEnv(SYNTHETIC_PROVIDER_ENV, () =>
    withThrowingFetch(async () => {
      const code = await runStoreBackedFire({ ...FIRE_OPTIONS, live: true }, deps);
      assert.equal(code, 0);
      assert.ok(captured, 'the tick ran');

      // The printed terms carry the exact facts: cohortId, the $800 ceiling, call cap 8, one fire.
      assert.ok(printed.some((l) => l.includes(captured!.booted.cohortId)), 'the exact cohortId was printed');
      assert.ok(printed.some((l) => l.includes('$800.00')), 'the $800 reservation ceiling was printed');
      assert.ok(printed.some((l) => /provider call cap 8/.test(l)), 'the 8-call cap was printed');
      assert.ok(printed.some((l) => /one fire maximum/.test(l)), 'the one-fire limit was printed');

      // The CROSSING manifest (not the demo): pinned caps, conservative guard table, real timeout.
      const manifest = captured!.booted.manifest;
      assert.equal(manifest.cohortSpendCapUsdMicros, CROSSING_PROFILE.cohortSpendCapUsdMicros);
      assert.equal(manifest.cohortCallCap, CROSSING_PROFILE.cohortCallCap);
      assert.equal(manifest.constants.maxDispatchesPerTick, CROSSING_PROFILE.maxDispatchesPerTick);
      assert.equal(manifest.constants.maxConcurrentProviderRequests, CROSSING_PROFILE.maxConcurrentProviderRequests);
      assert.equal(manifest.modelPriceTableVersion, 'prices-v2');
      assert.equal(captured!.runOptions.timeoutMs, 300_000, 'the crossing keeps the production provider timeout');

      // The capability is REAL and billable: the gated producer minted the four real adapter
      // identities (complete identity tuples, in roster order), each with a usable credential.
      assert.doesNotThrow(() => assertCohortAdapterCapability(captured!.capability));
      assert.equal(captured!.capability.billingClass, 'billable');
      const adapters = captured!.capability.adapters();
      assert.deepEqual(
        [...adapters.entries()].map(([id, a]) => ({
          id,
          provider: a.provider,
          requestedModelId: a.requestedModelId,
          credentialEnvVar: a.credentialEnvVar,
          hasCredential: a.hasCredential(),
        })),
        [
          { id: 'openai-gpt-5.6-sol', provider: 'openai', requestedModelId: 'gpt-5.6-sol', credentialEnvVar: 'OPENAI_API_KEY', hasCredential: true },
          { id: 'anthropic-claude-fable-5', provider: 'anthropic', requestedModelId: 'claude-fable-5', credentialEnvVar: 'ANTHROPIC_API_KEY', hasCredential: true },
          { id: 'google-gemini-3.1-pro-preview', provider: 'google', requestedModelId: 'gemini-3.1-pro-preview', credentialEnvVar: 'GEMINI_API_KEY', hasCredential: true },
          { id: 'xai-grok-4.5', provider: 'xai', requestedModelId: 'grok-4.5', credentialEnvVar: 'XAI_API_KEY', hasCredential: true },
        ],
      );
    }),
  );
});

test('a LiveAuthorized resolution with a STALE authorization is refused by the gated producer — loud, before any store work', async () => {
  const events: string[] = [];
  const deps: StoreFireDeps = {
    openStore: async () => {
      events.push('openStore');
      return { store: fakeInitializedStore(), close: async () => {} };
    },
    runTick: async () => {
      events.push('runTick');
      return tickResultOf([]);
    },
    // A shape-valid authorization for ANOTHER cohort (equal caps, wrong cohortId): the
    // producer must not trust the resolution — it re-binds to the booted cohort itself.
    resolveLive: async ({ booted }) => ({
      kind: 'LiveAuthorized',
      authorization: {
        cohortId: 'f'.repeat(64),
        participantIds: booted.manifest.expectedArmRoster.map((a) => a.participantId),
        modelPriceTableVersion: booted.manifest.modelPriceTableVersion,
        modelPriceTableDigest: booted.manifest.modelPriceTableDigest,
        liveOptIn: true,
        observedCredentialedParticipantIds: booted.manifest.expectedArmRoster.map((a) => a.participantId),
        cohortSpendCapUsdMicros: CROSSING_PROFILE.cohortSpendCapUsdMicros,
        cohortCallCap: CROSSING_PROFILE.cohortCallCap,
        maxConcurrentProviderRequests: CROSSING_PROFILE.maxConcurrentProviderRequests,
        maxDispatchesPerTick: CROSSING_PROFILE.maxDispatchesPerTick,
        maxRepairAttemptsPerArm: CROSSING_PROFILE.maxRepairAttemptsPerArm,
      },
    }),
  };
  await withEnv(SYNTHETIC_PROVIDER_ENV, () =>
    assert.rejects(
      () => runStoreBackedFire({ ...FIRE_OPTIONS, live: true }, deps),
      (e: unknown) => e instanceof CanaryAuthorizationError && /cohortId/.test(e.message),
    ),
  );
  assert.deepEqual(events, [], 'refused before the store was ever opened');
});
