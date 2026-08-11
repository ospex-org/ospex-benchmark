/**
 * Shared types for the v0 shadow smoke harness.
 *
 * The information bundle is deliberately thin (see docs/BENCHMARK_PROMPT_V0.md
 * and the v0 data policy): game identity, scheduled start, probable starting
 * pitchers when the read path exposes them, and timestamped reference prices
 * for the markets a game supplies (1–3 of the known set; a full board carries
 * all three). Nothing else.
 */

import type { ParticipantConfiguration } from './participantConfiguration.js';

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
  /**
   * The CURRENT RETAINED SAFETY FLOOR on `match_time`, maintained DB-side by a
   * trigger (ospex-indexer migration 070).
   *
   * ⚠ SCOPE — do not restate this as "the earliest start ever recorded" or as
   * "it never rises". What 070 enforces is narrower: the trigger recomputes the
   * floor from OLD on any statement whose SET list NAMES `match_time`, so
   * ordinary feed writes cannot raise it. It deliberately leaves one way up —
   * an explicit operator-remedy UPDATE naming `earliest_match_time` ALONE — and
   * `earliest_match_time <= match_time` is **not** an enforced invariant.
   * Exactly ONE value is retained, so this is not a history of previously
   * recorded starts and cannot answer membership questions about them.
   *
   * Nullable: rows written before the floor existed, and any row whose floor
   * has not been established, carry null. A consumer must treat null as "no
   * floor known" rather than substituting `match_time`.
   */
  earliest_match_time: string | null;
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
  /**
   * The provider-native settings this arm competes under, in the lab's own
   * vocabulary. This is what makes an ARM the unit of competition rather than
   * a model: one model at two reasoning levels is two arms that differ only
   * here, and `participantConfiguration.ts` owns the digest that distinguishes
   * them.
   *
   * REQUIRED, and `{}` is a real value meaning "sets no knobs" — not an
   * absence. An optional field would let two logically identical rosters
   * canonicalize differently and mint two cohort identities for one cohort.
   */
  configuration: ParticipantConfiguration;
}

/**
 * Normalized token counts (for quick reading; the raw object is canonical).
 *
 * `reasoningTokens` / `billableOutputTokens` are the two DERIVED comparable
 * fields (raw usage is never normalized across providers — the raw object
 * stays verbatim in `usageRaw`):
 *   - `reasoningTokens`: the provider-reported reasoning/thinking token count
 *     (openai `output_tokens_details.reasoning_tokens`, anthropic
 *     `output_tokens_details.thinking_tokens`, google `thoughtsTokenCount`,
 *     xai `output_tokens_details.reasoning_tokens`); `null` when the provider
 *     reported none — never a fabricated zero.
 *   - `billableOutputTokens`: total output-rate tokens INCLUDING reasoning,
 *     under each provider's own semantics (openai/anthropic count reasoning
 *     inside the output total; google/xai report it as a separate additive
 *     bucket); `null` when it cannot be derived with confidence.
 *
 * Both are OPTIONAL (not `field: null`) so that records and artifacts
 * persisted before these fields existed keep parsing and keep recomputing
 * their original digests (canonicalize binds only present keys).
 */
export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens?: number | null | undefined;
  billableOutputTokens?: number | null | undefined;
}

/** One executed web-search query, as reported by the provider. */
export interface SearchAuditQuery {
  query: string;
}

/** One result/citation reference the provider surfaced (url + title when given). */
export interface SearchAuditResult {
  url: string;
  title: string | null;
}

/**
 * The per-attempt web-search audit trail: every executed query and every
 * result reference the provider reported, extracted verbatim from the
 * response envelope so what each arm looked at is auditable after the fact.
 * `searchCount` is the provider's own usage counter when one exists
 * (anthropic `server_tool_use.web_search_requests`, xai
 * `server_side_tool_usage_details.web_search_calls`); `null` where the
 * provider reports none (openai, google). `incomplete` carries reasons the
 * audit may be partial (e.g. google grounding metadata missing while tool-use
 * tokens prove a search ran) — an empty array means no known gap.
 */
export interface SearchAudit {
  queries: SearchAuditQuery[];
  results: SearchAuditResult[];
  searchCount: number | null;
  incomplete: string[];
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
  /**
   * The web-search audit extracted from this response (queries + result
   * references), or `null` when the response carried no search activity.
   */
  searchAudit: SearchAudit | null;
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderCallOptions {
  /** Cap on generated tokens; used by preflight. Omitted = provider default. */
  maxOutputTokens?: number | undefined;
  /**
   * Whether this call carries the cohort's declared server-side tools.
   * `'declared'` (the default) sends the tool configuration; `'none'` sends no
   * tools at all.
   *
   * The repair attempt uses `'none'`: a repair is format-only and may carry no
   * new market information (docs/BENCHMARK_PROMPT_V0.md, "Parsing and repair
   * policy"). A repair that could search would let the model gather fresh
   * information for a second, independent read of the market — which is a new
   * decision, not a reformatting of the first one.
   */
  tools?: 'declared' | 'none' | undefined;
  /**
   * The dispatching arm's declared configuration, merged into the request
   * body. Passed per CALL rather than held by the adapter deliberately: the
   * authorized dispatch path binds an arm's identity from the authenticated
   * roster and never from the adapter it looked up, so the setting an arm
   * competes under has to arrive by the same route as the identity it is part
   * of. An adapter holding its own copy would be a second, unchecked source.
   *
   * Omitted is treated as `{}`. That default is fail-OPEN — a caller that
   * forgets sends no knobs and the provider answers anyway — so it is not
   * relied on: `configurationEvidenceViolations` compares the roster's
   * declared configuration against what each attempt recorded, and a dropped
   * configuration makes the run unscoreable rather than quietly cheaper.
   */
  configuration?: ParticipantConfiguration | undefined;
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
  /** The redacted web-search audit for this attempt (`null`: no search activity). */
  searchAudit: SearchAudit | null;
  requestParams: Record<string, unknown> | null;
  /**
   * The provider's own terminal-state string when the response was an
   * UNFINISHED turn (Anthropic stop_reason / Responses root status / Google
   * finishReason — e.g. "pause_turn", "incomplete", "MAX_TOKENS"). `null` on a
   * finished turn and when no response was received. This is the STRUCTURED
   * completion evidence, not prose: downstream verification reads it, never
   * `errorDetail`.
   */
  providerStopReason: string | null;
  /**
   * Whether the provider declared this attempt's turn FINISHED: `true` for a
   * returned response (an adapter returns only on its provider's final state),
   * `false` for a typed unfinished turn, `null` when no response was received
   * (timeout / transport / HTTP failure). Provider completion status is
   * AUTHORITATIVE over body shape — a `false` here is what lets an archived
   * body that happens to parse as valid JSON be truthfully refused.
   */
  turnCompleted: boolean | null;
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

/** The five named analysis axes a v2 forecast scores (response schema v2). */
export const AXIS_NAMES = ['valuation', 'trend', 'consensus', 'news', 'softness'] as const;
export type AxisName = (typeof AXIS_NAMES)[number];

/** Integer 1–5 score per named analysis axis (response schema v2). */
export type AxesScores = Record<AxisName, number>;

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
  /**
   * Response schema v2 (REQUIRED there; absent on v1 records): integer 1–5
   * scores on the five named analysis axes.
   */
  axes?: AxesScores | undefined;
  /**
   * Response schema v2: the single axis that most drives this forecast, or
   * null when no axis dominates. Absent on v1 records.
   */
  primaryAxis?: AxisName | null | undefined;
  /**
   * Response schema v2: one sentence stating the expected development on the
   * primary axis; with no driver it states that no material movement is
   * expected. The current validator rejects null — the null arm of this type
   * exists because replay surfaces normalize an absent v1-era field to `null`
   * (records.ts binds `?? null`). Absent on v1 records.
   */
  primaryExpectation?: string | null | undefined;
}

export interface GameForecastsOutput {
  gameId: string;
  forecasts: ForecastOutput[];
}

export interface BenchmarkResponse {
  /** 1 = pre-axes records (replay only); 2 = current (axes + provider search). */
  schemaVersion: 1 | 2;
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
