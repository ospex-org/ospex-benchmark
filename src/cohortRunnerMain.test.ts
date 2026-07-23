import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CohortBootError, assertBootedCohort, cohortBoot } from './cohortBoot.js';
import { runCohortTick } from './cohortRunner.js';
import {
  buildRehearsalTickInput,
  classifyStoreFireResult,
  decodeManifestText,
  formatTickResult,
  selfResolvePublication,
} from './cohortRunnerMain.js';
import { DEMO_PROVIDER_CALL_TIMEOUT_MS, buildDemoFixture } from './demoFixture.js';
import { RehearsalClaimPort } from './lineOpenClaim.js';
import { discover } from './lineOpenRead.js';
import { parseManifest } from './manifest.js';
import { assertPublicationVerified } from './manifestPublication.js';
import { buildRehearsalManifest } from './rehearsalManifest.js';
import { defaultExpectedArms } from './scoring.js';
import { STORE_SCHEMA_VERSION } from './store/constants.js';
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
  const booted = cohortBoot({ live: false, manifestBytes: bytes });
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
  // The adapter map covers the whole expected roster (required for the pre-claim plan build).
  for (const arm of defaultExpectedArms()) {
    assert.ok(input.adapters.has(arm.participantId), `adapter present for ${arm.participantId}`);
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

test('--live is rejected by cohortBoot (the mechanism the CLI routes into)', () => {
  const { bytes } = buildRehearsalManifest(FIXED_NOW);
  assert.throws(
    () => cohortBoot({ live: true, manifestBytes: bytes }),
    (e: unknown) => e instanceof CohortBootError && /--live is hard-disabled/.test(e.violations.join('; ')),
  );
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

const installedSettledOutcome = (path: string): LineOpenFireOutcome =>
  ({
    kind: 'Installed',
    install: { path, created: true },
    completion: { status: 'settled' },
  }) as unknown as LineOpenFireOutcome;

const installedUnsettledOutcome = (path: string): LineOpenFireOutcome =>
  ({
    kind: 'Installed',
    install: { path, created: true },
    completion: { status: 'unsettled', reason: 'store_complete_failed' },
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

test('the spawned CLI hard-disables --live before any DB work under --store=postgres --fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-fire-live-'));
  const outDir = join(dir, 'artifacts');
  const { status, signal, out } = runCli(['--store=postgres', '--fixture', '--live', '--out', outDir], {
    STORE_DATABASE_URL: UNREACHABLE_STORE_URL,
  });

  // A real nonzero exit (not a timeout kill, which would leave status === null).
  assert.ok(
    typeof status === 'number' && status !== 0,
    `expected a nonzero exit; status=${String(status)} signal=${String(signal)} out=${out}`,
  );
  // The refusal is the --live hard-disable surfaced from cohortBoot...
  assert.ok(/--live rejected by cohortBoot/.test(out), `expected the --live hard-disable message; out=${out}`);
  // ...raised BEFORE the store branch: no DB connection was attempted against the unreachable URL,
  // and DB setup was never reached.
  assert.ok(!/ECONNREFUSED/i.test(out), `must not surface a DB connection error; out=${out}`);
  assert.ok(!/store schema \+ functions applied/.test(out), `must not reach DB setup; out=${out}`);
  // And no artifact was produced.
  assert.ok(!existsSync(outDir), 'no artifact directory should be created');
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
