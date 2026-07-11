/**
 * Shared types for the v0 shadow smoke harness.
 *
 * The information bundle is deliberately thin (see docs/BENCHMARK_PROMPT_V0.md
 * and the v0 data policy): game identity, scheduled start, and timestamped
 * reference prices for the three fixed markets. Nothing else.
 */

export type MarketKey = 'moneyline' | 'spread' | 'total';

export type ProviderName = 'openai' | 'anthropic' | 'google' | 'xai';

/**
 * Arm-level outcome codes. The first four are the required set;
 * `provider_error` is a deliberate extension covering transport/HTTP
 * failures (4xx/5xx, DNS, connection reset) that are neither a timeout nor
 * a schema violation — recorded honestly rather than shoehorned.
 */
export type ArmOutcome =
  | 'valid'
  | 'invalid_schema'
  | 'timeout'
  | 'credential_missing'
  | 'provider_error';

export const SMOKE_LABEL = 'SMOKE_V0_NOT_A_COHORT';

// ---------------------------------------------------------------------------
// Frozen bundle
// ---------------------------------------------------------------------------

export interface MoneylineBlock {
  awayDecimal: number;
  homeDecimal: number;
  /** Feed-side observation timestamp of the reference quote. */
  observedAt: string;
  evidenceRef: string;
}

export interface RunLineBlock {
  /**
   * Designated run line expressed as the HOME team's handicap
   * (negative when the home team is favored). This matches the upstream
   * storage convention and the closing-line capture, so entry and close
   * compare like for like.
   */
  line: number;
  /** Away team's handicap on the same designated line (= -line). */
  awayHandicap: number;
  /** Home team's handicap on the same designated line (= line). */
  homeHandicap: number;
  awayDecimal: number;
  homeDecimal: number;
  observedAt: string;
  evidenceRef: string;
}

export interface TotalBlock {
  line: number;
  overDecimal: number;
  underDecimal: number;
  observedAt: string;
  evidenceRef: string;
}

export interface GameBundle {
  /** Canonical game ID — joins to the closing-line capture keyed on the same ID. */
  gameId: string;
  league: 'mlb';
  scheduledStartUtc: string;
  awayTeam: string;
  homeTeam: string;
  /**
   * Probable starting pitchers are NOT exposed by the existing public read
   * path (v0 finding) — carried explicitly as null rather than omitted, so
   * the absence is visible in the hashed bundle.
   */
  probableStartingPitchers: null;
  markets: {
    moneyline: MoneylineBlock;
    runLine: RunLineBlock;
    total: TotalBlock;
  };
  /** Every evidenceRef a rationale may cite for this game. */
  evidenceRefs: string[];
}

export interface SlateBundle {
  schemaVersion: 1;
  label: typeof SMOKE_LABEL;
  league: 'mlb';
  /** Slate calendar day in US Eastern time (YYYY-MM-DD). */
  slateDate: string;
  /** When the bundle was assembled (UTC ISO). */
  bundleTimestamp: string;
  /** Decision deadline: earliest scheduled start among eligible games. */
  cutoffAt: string;
  games: GameBundle[];
}

export interface ExcludedGame {
  gameId: string;
  slug: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Read-path input rows (wire shapes)
// ---------------------------------------------------------------------------

export interface GamesEndpointRow {
  gameId: string;
  slug: string;
  sport: string;
  matchTime: string;
  status: string;
  homeTeam: { name: string; abbreviation: string };
  awayTeam: { name: string; abbreviation: string };
  hasOdds: boolean;
  contestCreated: boolean;
  contestId: string | null;
  canCreateContest: boolean;
  externalIds: { jsonodds: string; sportspage: string | null; rundown: string | null };
}

export interface CurrentOddsRow {
  network: string;
  jsonodds_id: string;
  market: MarketKey;
  line: number | null;
  away_odds_american: number | null;
  home_odds_american: number | null;
  upstream_last_updated: string;
  poll_captured_at: string;
  changed_at: string;
}

export interface SlateInputs {
  gamesRows: GamesEndpointRow[];
  oddsRows: CurrentOddsRow[];
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Arms and provider calls
// ---------------------------------------------------------------------------

export interface ArmSpec {
  participantId: string;
  provider: ProviderName;
  requestedModelId: string;
  credentialEnvVar: string;
}

export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface ProviderResponse {
  rawText: string;
  reportedModelId: string | null;
  providerResponseId: string | null;
  usage: ProviderUsage;
  /** Exact request parameters sent (model, endpoint, options) — no credentials. */
  requestParams: Record<string, unknown>;
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderAdapter {
  readonly provider: ProviderName;
  readonly requestedModelId: string;
  readonly credentialEnvVar: string;
  hasCredential(): boolean;
  chat(turns: ChatTurn[], timeoutMs: number): Promise<ProviderResponse>;
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

export interface AttemptRecord {
  rawText: string | null;
  reportedModelId: string | null;
  providerResponseId: string | null;
  usage: ProviderUsage | null;
  requestParams: Record<string, unknown> | null;
  requestAt: string | null;
  responseAt: string | null;
  latencyMs: number | null;
  errorDetail: string | null;
}

export interface ArmRunResult {
  arm: ArmSpec;
  outcome: ArmOutcome;
  attempt: AttemptRecord;
  repair: AttemptRecord | null;
  repairUsed: boolean;
  /** Parsed + validated response (present only when outcome === 'valid'). */
  parsed: BenchmarkResponse | null;
  validationErrors: string[];
}

// ---------------------------------------------------------------------------
// Model output contract (mirrors docs/BENCHMARK_PROMPT_V0.md schema draft)
// ---------------------------------------------------------------------------

export interface ForecastOutput {
  market: MarketKey;
  selection: string;
  line: number | null;
  observedDecimal: number;
  probabilities: { win: number; push: number; loss: number };
  confidence: number;
  wouldAbstain: boolean;
  selectedForExecution: boolean;
  rationale: string;
  evidenceRefs: string[];
}

export interface GameForecastsOutput {
  gameId: string;
  forecasts: ForecastOutput[];
}

export interface BenchmarkResponse {
  schemaVersion: 1;
  cohortId: string;
  participantId: string;
  requestedModelId: string;
  bundleSha256: string;
  executionPolicy: 'fixed-moneyline-total' | 'model-choice-side-total';
  games: GameForecastsOutput[];
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

export interface BaselineDecision {
  participantId: string;
  policyVersion: string;
  gameId: string;
  market: MarketKey;
  selection: string;
  line: number | null;
  observedDecimal: number;
  track: 'common-cutoff';
}
