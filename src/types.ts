/**
 * Shared types for the v0 shadow smoke harness.
 *
 * The information bundle is deliberately thin (see docs/BENCHMARK_PROMPT_V0.md
 * and the v0 data policy): game identity, scheduled start, probable starting
 * pitchers when the read path exposes them, and timestamped reference prices
 * for the markets a game supplies (1–3 of the known set; a full board carries
 * all three). Nothing else.
 */

export type MarketKey = 'moneyline' | 'spread' | 'total';

export type ProviderName = 'openai' | 'anthropic' | 'google' | 'xai';

/**
 * Arm outcome codes, per (arm, game) request. The first four are the required
 * set; the rest are deliberate extensions recorded honestly rather than
 * shoehorned: `rate_limited` (HTTP 429 — a throttle must never read as a
 * model failure), `provider_error` (other transport/HTTP failures),
 * `cutoff_missed` (the decision window closed before an acceptable response
 * existed — never emits decision records), and `dispatch_lag_exceeded` (the
 * initial request start is BEFORE `detectedAt` OR more than `maxDispatchLagMs`
 * after it — the two-sided V-lag — so it is not sent; a valid negative, §5).
 * None of the non-`valid` outcomes emit decision records.
 */
export type ArmOutcome =
  | 'valid'
  | 'invalid_schema'
  | 'timeout'
  | 'credential_missing'
  | 'rate_limited'
  | 'provider_error'
  | 'cutoff_missed'
  | 'dispatch_lag_exceeded';

/** Transport status of the repair attempt, recorded separately from outcome. */
export type RepairTransport = 'ok' | 'timeout' | 'rate_limited' | 'provider_error' | null;

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

export interface ProbablePitchers {
  away: string | null;
  home: string | null;
}

export interface GameBundle {
  /** Canonical game ID — joins to the closing-line capture keyed on the same ID. */
  gameId: string;
  league: 'mlb';
  scheduledStartUtc: string;
  awayTeam: string;
  homeTeam: string;
  /**
   * Probable starting pitchers when the games read path exposes them; null
   * otherwise (unannounced starters, or non-MLB). Carried explicitly so the
   * absence is visible in the hashed bundle.
   */
  probableStartingPitchers: ProbablePitchers | null;
  /**
   * The markets this game supplies: 1–3 of the known set (moneyline, run line,
   * total). Absence is an OMITTED key — never a key with an `undefined` value
   * (the prepared-request boundary rejects an explicit-`undefined` market). A
   * full board carries all three.
   */
  markets: {
    moneyline?: MoneylineBlock;
    runLine?: RunLineBlock;
    total?: TotalBlock;
  };
  /** Every evidenceRef a rationale may cite for this game. */
  evidenceRefs: string[];
}

/**
 * A frozen, content-hashed bundle: the whole slate (recorded for audit), and
 * one single-game instance per dispatch (what each arm actually receives —
 * games has exactly one entry and cutoffAt is that game's first pitch).
 */
export interface SlateBundle {
  schemaVersion: 1;
  label: typeof SMOKE_LABEL;
  league: 'mlb';
  /** Slate calendar day in US Eastern time (YYYY-MM-DD). */
  slateDate: string;
  /** When the bundle was assembled (UTC ISO). */
  bundleTimestamp: string;
  /** Decision deadline (UTC ISO). Per-game requests: that game's first pitch. */
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

/** A captured reference close, keyed upstream by (network, game, market). */
export interface ClosingLineRow {
  network: string;
  jsonodds_id: string;
  market: MarketKey;
  line: number | null;
  away_odds_decimal: number | null;
  home_odds_decimal: number | null;
  away_p_novig: number | null;
  home_p_novig: number | null;
  value_captured_at: string | null;
  last_polled_at: string | null;
  lock_time: string;
  poll_gap_seconds: number | null;
  confidence: 'fresh' | 'stale' | 'missing';
  source: string;
}

/** A closing-line row carrying its identity PK (the keyset-pagination key). */
export interface ClosingLineRowWithId extends ClosingLineRow {
  id: number;
}

/**
 * A `games` TABLE row over PostgREST (distinct from GamesEndpointRow, the
 * core-api games ENDPOINT shape) — the score/finality columns the totals-pair
 * extraction joins closing lines against. Note: scores latch with
 * final_type = 'Finished' while status can remain 'upcoming', so completion
 * is judged from scores + final_type, never from status.
 */
export interface GamesTableRow {
  network: string;
  jsonodds_id: string;
  sport: string;
  match_time: string;
  status: string;
  home_score: number | null;
  away_score: number | null;
  final_type: string | null;
  score_captured: boolean;
}

export interface SlateInputs {
  gamesRows: GamesEndpointRow[];
  oddsRows: CurrentOddsRow[];
  /** Wall clock when fetching began (UTC ISO). */
  fetchStartedAt: string;
  /**
   * Wall clock when fetching completed (UTC ISO) — the bundle assembly time.
   * Every market observation must be at or before this instant.
   */
  fetchCompletedAt: string;
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

/** Normalized token counts (for quick reading; the raw object is canonical). */
export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface ProviderResponse {
  rawText: string;
  reportedModelId: string | null;
  providerResponseId: string | null;
  httpStatus: number;
  usage: ProviderUsage;
  /**
   * The provider's entire usage/token object VERBATIM — every field, no
   * normalization, nothing dropped. Reasoning/thinking tokens are billed
   * separately and dominate cost on high-reasoning modes; they only survive
   * here. Dollar cost can be applied retroactively from a price table; the
   * token counts cannot be recovered after the fact.
   */
  usageRaw: unknown;
  /** Exact request parameters sent (model, endpoint, options) — no credentials. */
  requestParams: Record<string, unknown>;
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderCallOptions {
  /** Cap on generated tokens; used by preflight. Omitted = provider default. */
  maxOutputTokens?: number | undefined;
}

export interface ProviderAdapter {
  readonly provider: ProviderName;
  readonly requestedModelId: string;
  readonly credentialEnvVar: string;
  hasCredential(): boolean;
  chat(
    turns: ChatTurn[],
    timeoutMs: number,
    options?: ProviderCallOptions,
  ): Promise<ProviderResponse>;
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

export interface AttemptRecord {
  rawText: string | null;
  reportedModelId: string | null;
  providerResponseId: string | null;
  httpStatus: number | null;
  usage: ProviderUsage | null;
  usageRaw: unknown;
  requestParams: Record<string, unknown> | null;
  requestAt: string | null;
  /**
   * Attempt-SETTLED instant (offset ISO): stamped on a received provider
   * response AND on a timeout/transport failure, so it is not a truthful
   * "response received" signal on its own. Kept unchanged for record
   * compatibility; a downstream mapper derives a truthful receipt from it only
   * when a response body / HTTP status is present.
   */
  responseAt: string | null;
  /**
   * Truthful ACCEPTED instant (offset ISO): stamped only after the response
   * passed complete validation (and, for a repair, fingerprint preservation)
   * and before the accepting cutoff, immediately before `outcome: 'valid'`.
   * `null` for every non-accepted attempt (unsent, timeout, transport failure,
   * schema-invalid, or accepted after the decision cutoff).
   */
  acceptedAt: string | null;
  latencyMs: number | null;
  errorDetail: string | null;
}

/** Result of one arm on one game's frozen request. */
export interface ArmGameResult {
  arm: ArmSpec;
  gameId: string;
  requestSha256: string;
  /** The game's own decision cutoff (its scheduled first pitch). */
  cutoffAt: string;
  outcome: ArmOutcome;
  attempt: AttemptRecord;
  repair: AttemptRecord | null;
  repairUsed: boolean;
  /**
   * Transport status of the repair attempt, separate from `outcome` so a
   * throttled/failed repair is never readable as a schema failure alone.
   */
  repairTransport: RepairTransport;
  /** Parsed + validated response (present only when outcome === 'valid'). */
  parsed: BenchmarkResponse | null;
  validationErrors: string[];
  /**
   * The never-sent initial send-boundary / request-start decision instant (offset ISO): the ONE
   * clock reading a send-time gate refusal (`cutoff_missed` via the initial-dispatch gate, or
   * `dispatch_lag_exceeded`) or the legacy pre-dispatch cutoff (`cutoff_missed`) compared, when no
   * initial request was ever sent. Kept DISTINCT from `attempt.requestAt` — which stays `null` for
   * an unsent attempt so `orderedAttempts` never fabricates a phantom sent attempt (§5) — and read
   * by the producer as the persisted `initialRequestStartedAt` when the initial was never sent.
   * `null` on every SENT path (the real start lives on `attempt.requestAt`) and on any structurally
   * pre-clock refusal (`credential_missing`), which never took a reading. (B3)
   */
  refusedInitialStartAt: string | null;
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
  /**
   * The supplied reason code the system prompt refers to: absent or null
   * unless required information is missing or contradictory.
   */
  reasonCode?: 'missing_information' | 'contradictory_information' | null | undefined;
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
