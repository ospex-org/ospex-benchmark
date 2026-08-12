import { readFileSync } from 'node:fs';
import { buildBundle } from './bundle.js';
import { fireEligibleGame } from './watch.js';
import { makeValidResponse, TEST_ARM } from './testFactories.js';
import { ARMS } from './providers/index.js';
import { parseRunArtifact } from './servingProjection.js';
import { SqlBenchmarkServingPort } from './servingStore.js';

/** The arm this fixture impersonates when `enrolled` is asked for. Named, so
 *  the registry entry and the dispatched arm cannot drift apart silently. */
const ENROLLED_PARTICIPANT_ID = 'openai-gpt-5.6-sol';
import type { JsonRecord } from './servingProjection.js';
import type { BenchmarkServingPort } from './servingStore.js';
import type { ArmSpec } from './types.js';
import type { BuildResult } from './bundle.js';
import type { WatchGateProvenance } from './watch.js';
import type {
  CurrentOddsRow,
  GamesEndpointRow,
  MarketKey,
  ProviderAdapter,
  ProviderResponse,
  SlateInputs,
} from './types.js';

/**
 * Fires one game for real and hands back the artifact it wrote.
 *
 * Shared by the projection and publisher suites because both must read a file
 * the RUNNER produced rather than one a test author typed. The reader's only
 * contract is with `buildRecords`, and a hand-written fixture would keep
 * passing on the day a field there is renamed — which is exactly the failure
 * that would silently empty the projection.
 */

const GAME_ID = '00000000-0000-4000-8000-0000000prj01';
const FETCH_COMPLETED_AT = '2026-07-20T12:00:00.000Z';
const MATCH_TIME = '2026-07-20T23:10:00+00:00';
const QUOTE_AT = '2026-07-20T11:55:00.000Z';
const NOW_MS = Date.parse('2026-07-20T12:00:30.000Z');

export const TEST_SLATE_DATE = '2026-07-20';
export const TEST_COHORT_ID = `watch-v0-${TEST_SLATE_DATE}`;

function gamesRow(gameId: string): GamesEndpointRow {
  return {
    gameId,
    slug: 'mil-pit-2026-07-20',
    sport: 'mlb',
    matchTime: MATCH_TIME,
    status: 'upcoming',
    homeTeam: { name: 'Pittsburgh Pirates', abbreviation: 'PIT' },
    awayTeam: { name: 'Milwaukee Brewers', abbreviation: 'MIL' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: false,
    externalIds: { jsonodds: gameId, sportspage: null, rundown: null },
  };
}

function oddsRow(market: MarketKey, line: number | null, gameId: string): CurrentOddsRow {
  return {
    network: 'polygon',
    jsonodds_id: gameId,
    market,
    line,
    away_odds_american: market === 'moneyline' ? -135 : 122,
    home_odds_american: market === 'moneyline' ? 122 : -152,
    upstream_last_updated: QUOTE_AT,
    poll_captured_at: QUOTE_AT,
    changed_at: QUOTE_AT,
  };
}

export function fullBoardInputs(gameId: string = GAME_ID): SlateInputs {
  return {
    gamesRows: [gamesRow(gameId)],
    oddsRows: [
      oddsRow('moneyline', null, gameId),
      oddsRow('spread', 1.5, gameId),
      oddsRow('total', 8.5, gameId),
    ],
    fetchStartedAt: '2026-07-20T11:59:58.000Z',
    fetchCompletedAt: FETCH_COMPLETED_AT,
  };
}

/**
 * How the stub arm behaves.
 *
 * `unsent` and `repaired` exist because a fixture where every call succeeds on
 * the first try cannot discriminate several of the projector's rules from their
 * absence: an attempt is only provably marked unsent when one never was, an
 * instant is only provably withheld when nothing came back, and ordinal 1 only
 * appears when a repair ran.
 */
export type StubBehaviour = 'ok' | 'unsent' | 'transport-failure' | 'repaired';

function stubAdapter(
  build: BuildResult,
  cohortId: string,
  behaviour: StubBehaviour,
  arm: ArmSpec,
): ProviderAdapter {
  const valid = (): string => JSON.stringify(makeValidResponse(build.requests[0]!, arm, cohortId));
  let call = 0;
  return {
    provider: arm.provider,
    requestedModelId: arm.requestedModelId,
    credentialEnvVar: arm.credentialEnvVar,
    // No credential is the one refusal that happens before any clock is read,
    // so the attempt it produces carries neither a request instant nor any
    // response field — exactly the shape the projection's unsent rule describes.
    hasCredential: () => behaviour !== 'unsent',
    chat(): Promise<ProviderResponse> {
      call += 1;
      // Sent, and nothing came back. The runner stamps the attempt's settle
      // instant on this path too, so it is the ONLY input that discriminates a
      // truthful receipt from the raw field — an arm that never sent has every
      // response field null already and cannot tell the two apart.
      if (behaviour === 'transport-failure') {
        return Promise.reject(new Error('synthetic transport failure'));
      }
      // The repair is offered only when the initial body yields a complete
      // decision fingerprint, so that the repair can be proved to preserve it —
      // an unparseable or shape-invalid first body is refused outright and no
      // repair is sent. This one is fully shape-valid and identical in every
      // forecast; it fails on the envelope's cohort, which the fingerprint does
      // not cover. The repair then returns the same forecasts correctly framed.
      const rawText =
        behaviour === 'repaired' && call === 1
          ? JSON.stringify({
              ...makeValidResponse(build.requests[0]!, arm, cohortId),
              cohortId: 'not-the-cohort-this-run-authenticated',
            })
          : valid();
      return Promise.resolve({
        rawText,
        // The body must report the id the arm is APPROVED for, or the
        // artifact contradicts itself and the identity gate refuses it.
        reportedModelId: arm.requestedModelId,
        providerResponseId: 'stub-response',
        httpStatus: 200,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        usageRaw: { prompt_tokens: 100, completion_tokens: 50 },
        requestParams: { stub: true },
        searchAudit: null,
      });
    },
  };
}

export interface FiredRun {
  readonly runFile: string;
  readonly records: readonly JsonRecord[];
  readonly cohortId: string;
}

export interface FireOptions {
  readonly outDir: string;
  /**
   * Relabel the fired arm as a production one.
   *
   * `TEST_ARM` is deliberately absent from the projection's registry, so a run
   * fired under it publishes no model rows — which is itself under test. A case
   * that needs published model rows sets this.
   */
  readonly enrolled?: boolean;
  readonly mode?: 'live' | 'dry-run';
  readonly behaviour?: StubBehaviour;
  /**
   * Dispatch the enrolled participant under a model it does not run.
   *
   * Produces a SELF-CONSISTENT artifact — records and archived body agree —
   * that disagrees only with the registry. Patching the file cannot make
   * this, because the body echoes the identity and the verifier re-reads it,
   * and a patched file is refused for the wrong reason.
   */
  readonly contradictModel?: boolean;
  /**
   * Which game the fixture fires.
   *
   * Varying it is how a case gets a decision key of its own: a decision is
   * (cohort, participant, game, market), and the fixture's cohort is derived
   * from the slate date and so is the same on every run. Two runs over one game
   * therefore collide — and not benignly, because the run id is fresh each time
   * and the seal's drift check compares it, so the second run reports a
   * CONTRADICTION rather than a duplicate.
   */
  readonly gameId?: string;
  /**
   * Where the fire publishes.
   *
   * Defaults to the shipped unconfigured port, so a fixture run writes its
   * artifact and publishes nothing — which is what makes this usable from the
   * pure suite. A case that wants to see what the fire SENDS supplies a
   * recording port, and a case that wants it in a database supplies a real one.
   */
  readonly serving?: BenchmarkServingPort;
  /** The fire's log sink. A case that needs the PUBLISHER's own line to throw
   *  supplies one; everything else keeps the silent default. */
  readonly log?: (line: string) => void;
}

export async function firedRun(options: FireOptions): Promise<FiredRun> {
  const inputs = fullBoardInputs(options.gameId ?? GAME_ID);
  const build = buildBundle(inputs, TEST_SLATE_DATE, { requireFuture: false });
  const provenance: WatchGateProvenance = {
    detectedAt: new Date(NOW_MS).toISOString(),
    boardCompletedAt: '2026-07-20T11:50:00.000Z',
    openerAgeMinutes: 10,
    lateThresholdMinutes: 60,
  };
  let clock = NOW_MS;
  // Dispatch the ENROLLED arm when one is asked for, so the archived body, the
  // recorded ids and the registry all agree from the moment the file is
  // written. TEST_ARM stays the default because "not enrolled" is itself under
  // test.
  const enrolled = ARMS.find((entry) => entry.participantId === ENROLLED_PARTICIPANT_ID);
  if (enrolled === undefined) {
    throw new Error(`the fixture arm "${ENROLLED_PARTICIPANT_ID}" is no longer in ARMS`);
  }
  const arm: ArmSpec =
    options.enrolled === true
      ? {
          ...TEST_ARM,
          participantId: enrolled.participantId,
          provider: enrolled.provider,
          requestedModelId:
            options.contradictModel === true
              ? 'a-model-this-arm-does-not-run'
              : enrolled.requestedModelId,
          configuration: enrolled.configuration,
        }
      : TEST_ARM;

  const outcome = await fireEligibleGame(build, inputs, TEST_SLATE_DATE, provenance, {
    arms: [arm],
    adapters: new Map([
      [arm.participantId, stubAdapter(build, TEST_COHORT_ID, options.behaviour ?? 'ok', arm)],
    ]),
    approvedReportedModelIds: () => [arm.requestedModelId],
    outDir: options.outDir,
    timeoutMs: 60_000,
    maxOutputTokens: 16000,
    mode: options.mode ?? 'live',
    clockMode: 'wall',
    // Monotonic, so recorded instants are ordered and latency is exact.
    nowMs: () => (clock += 5),
    log: options.log ?? ((): undefined => undefined),
    logError: () => undefined,
    serving: options.serving ?? new SqlBenchmarkServingPort(null),
  });

  return {
    runFile: outcome.runFile,
    records: parseRunArtifact(readFileSync(outcome.runFile, 'utf8')),
    cohortId: TEST_COHORT_ID,
  };
}

/**
 * Forge a contradictory identity: a record naming an enrolled arm while
 * declaring a model that arm does not run.
 *
 * Exists ONLY for the case that asserts such an artifact is refused. The honest
 * way to get enrolled output is `firedRun({ enrolled: true })`, which dispatches
 * the real arm so the archived body agrees with the records — a record-level
 * relabel cannot, because the body echoes the participant id and the accepted
 * model id and the verifier re-validates it.
 */
export function withContradictoryModel(records: readonly JsonRecord[]): JsonRecord[] {
  return records.map((record) =>
    record['requestedModelId'] === undefined
      ? record
      : { ...record, requestedModelId: 'not-the-model-this-arm-runs' },
  );
}
