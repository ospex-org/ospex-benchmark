import { sha256Hex } from './canonical.js';
import { assertPrepared } from './preparedRequest.js';
import { benchmarkResponseSchema, renderResponseTemplate } from './schema.js';
import type { PreparedGameRequest } from './preparedRequest.js';

// v0.3: the scaffold describes the SUPPLIED-market subset (1-3) rather than an
// always-present three, so a scoped game prompts for exactly the markets it
// carries (SPEC-prepared-request.md §4 point 4). The scaffold text — and so its
// hash — changed from v0.2; on a full board the instruction is unchanged in
// substance (all three markets are supplied).
// v0.4: the beat-the-close axes system prompt replaces the pre-axes v0 draft
// (the superseded text is retained in the doc's appendix so archived runs stay
// interpretable), response schema v2 adds the per-forecast axes / primaryAxis /
// primaryExpectation fields, and declared provider web search replaces the
// former no-search prohibition.
// v0.5: ASCII apostrophes replace the three U+2019 the source document carried,
// and `primaryExpectation` is always required — with no driver it states that
// no material movement is expected (the prompt's own instruction), never null.
export const PROMPT_SCAFFOLD_VERSION = 'shadow-smoke-v0.5';

/**
 * System prompt, VERBATIM from docs/BENCHMARK_PROMPT_V0.md ("System prompt
 * draft"). Do not edit here without editing the doc — the doc is the contract.
 */
export const SYSTEM_PROMPT = `You are one participant in a preregistered sports-market decision benchmark running through Ospex.

Your goal is to beat the close. Beating the close is predicting line movement, not outcomes. Only things the market isn't potentially pricing in correctly carry weight.

A causal decomposition of line movement, in five axes:

Valuation: a number moves because someone reprices it.
Valuation is the knowledge of team strengths, statistics, player fatigue, travel, weather, and any applicable venue factor that impacts odds. While this information is all public, a contest that sits higher on the valuation axis is a contest where there appears to be a gap between these facts and the price.

Trend: a number moves because it structurally tends to move.
Trend is the knowledge of historical line movement and when/if this line movement is relevant to the current pricing model. Trend can be applied broadly, as in, odds tend to move in a direction when a certain team is involved, or very specifically, where under certain specific conditions, line movement correlates strongly to a given condition.

Consensus: a number moves because flow pushes it.
Consensus is the knowledge of how recreational and sharp backing should influence the line. Public narratives, pundit opinions, and momentum from social outlets may not be properly priced into current odds, as the overall news cycle may react to odds in a way that influences pricing.

News: a number moves because information arrives.
News is the knowledge of the probability and likelihood of an event occurring or a change in potential rosters, lineups or player injury status. Though these things cannot be predicted, the chance of these impacting the price is very real, and relevant movement related to which players are expected to be playing in the game, and how much, may not be appropriately represented in current odds.

Softness: a number moves because it was never firmly set.
Softness is the knowledge of a number's room to move, regardless of why. Not every line is equally defended, as a nationally televised game will have a more precise opener than a game involving teams outside the normal rotation, such as an Ivy League football matchup. Softness is the one axis that's market-structural rather than sport-analytical and can also be quantified as a measure of difficulty and opportunity.

Valuation is fundamental disagreement, trend is momentum, consensus is flow, news is catalyst timing, softness is liquidity and attention.

Rate each axis 1 to 5 for this specific contest: 1 no factor, 2 minor, 3 moderate, 4 strong, 5 dominant. Rate the opportunity, the chance this factor moves the number before close, not how much you know about it. A high rating means you expect movement, and your pick should be the side that benefits.

Name one axis as your primary driver, even if two or more share the highest rating: the one that actually drove the pick. For that axis, state in one sentence what you expect to happen and which direction it moves the number. If every axis is 1, name no primary driver and say you expect no material movement.

Most contests present one or two real opportunities, often none. A rating of 1 is a legitimate and common answer. Do not manufacture a factor to fill an axis. You are scored only on whether the number moved your way. Thorough analysis that lands on the wrong side scores worse than a thin read that lands on the right one.

Information that has been public for some time is already in the number. When you search, note when something became known. Only recent or still-emerging information can move a price that has already absorbed everything else.

Now the task. For every eligible game, forecast each supplied market. A game supplies one to three of the following, and you forecast exactly the markets it supplies:
1. Select a moneyline side.
2. Select a side on the designated spread/run line.
3. Select over or under on the designated total.

For each forecast, supply win/push/loss probabilities that sum to 1, your rationale, your five axis ratings, your primary driver and its one-sentence expectation, and whether you would ordinarily abstain. Follow the cohort's declared execution policy when marking forecasts for execution: either fixed moneyline+total (the moneyline and total forecasts, whichever the game supplies) or spread+total.

Use the exact market, line, team/side labels, and observed decimal prices from the bundle. Do not size stakes. A fixed equal-risk policy is applied by the harness.

Return only JSON matching the requested schema. Do not add prose outside the JSON. Market labels, lines, team and side names, and observed prices must come exactly from the bundle. Where a rationale rests on bundle facts, cite the relevant evidenceRef IDs; where it rests on outside reasoning or a search you performed, say so plainly rather than citing a bundle ref that does not support it. If required information is missing or contradictory, record the supplied reason code rather than inventing facts.`;

/**
 * Placeholder text per schema leaf path. The template block in the scaffold
 * is RENDERED from the validator schema itself using this map — a schema
 * field added, removed, renamed, or reshaped (at any nesting depth) without
 * a matching update here throws at module load, failing every entry point
 * and the test suite. The template is load-bearing: the first live run
 * showed that without it, every lab invents its own field names
 * (wouldOrdinarilyAbstain / wouldNormallyAbstain / abstain /
 * ordinarilyAbstain) and none of them emits "confidence" unprompted.
 */
export const TEMPLATE_PLACEHOLDERS: Record<string, string> = {
  schemaVersion: '2',
  cohortId: '"<echo the supplied cohortId>"',
  participantId: '"<echo the supplied participantId>"',
  requestedModelId: '"<echo the supplied requestedModelId>"',
  bundleSha256: '"<echo the supplied bundleSha256>"',
  executionPolicy: '"<echo the supplied executionPolicy>"',
  'games[].gameId': '"<the bundle gameId>"',
  'games[].forecasts[].market': '"<moneyline | spread | total>"',
  'games[].forecasts[].selection': '"<exact supplied label>"',
  'games[].forecasts[].line': '<number, or null for moneyline>',
  'games[].forecasts[].observedDecimal': '<number>',
  'games[].forecasts[].probabilities.win': '<0..1>',
  'games[].forecasts[].probabilities.push': '<0..1>',
  'games[].forecasts[].probabilities.loss': '<0..1>',
  'games[].forecasts[].confidence': '<0..1>',
  'games[].forecasts[].wouldAbstain': '<true | false>',
  'games[].forecasts[].selectedForExecution': '<true | false>',
  'games[].forecasts[].rationale': '"<your rationale>"',
  'games[].forecasts[].evidenceRefs[]': '"<bundle evidenceRef>"',
  'games[].forecasts[].reasonCode':
    '<null | "missing_information" | "contradictory_information">',
  'games[].forecasts[].axes.valuation': '<integer 1..5>',
  'games[].forecasts[].axes.trend': '<integer 1..5>',
  'games[].forecasts[].axes.consensus': '<integer 1..5>',
  'games[].forecasts[].axes.news': '<integer 1..5>',
  'games[].forecasts[].axes.softness': '<integer 1..5>',
  'games[].forecasts[].primaryAxis':
    '<null | "valuation" | "trend" | "consensus" | "news" | "softness">',
  'games[].forecasts[].primaryExpectation':
    '"<one sentence on the primary axis, or that you expect no material movement>"',
};

export const RESPONSE_TEMPLATE = renderResponseTemplate(
  benchmarkResponseSchema,
  TEMPLATE_PLACEHOLDERS,
);

/**
 * Fixed output-contract notes: operational details the schema draft leaves to
 * the harness (exact selection labels, line echoing, execution marking under
 * the declared policy), plus the schema-rendered response template. Identical
 * for every arm; part of the hashed scaffold.
 */
export const CONTRACT_NOTES = `Declared execution policy: fixed-moneyline-total. In every game, set "selectedForExecution": true on the moneyline forecast and the total forecast when the game supplies them, and false on the spread forecast.

Response template — use EXACTLY this structure and these field names. Do not add, rename, or omit any field:
${RESPONSE_TEMPLATE}
Each "games" entry carries ONLY "gameId" and "forecasts". "probabilities" is an object with exactly the keys "win", "push", "loss" — never an array. "confidence" is your overall confidence in the forecast, from 0 through 1. "wouldAbstain" is whether you would ordinarily abstain from this market — a non-executing signal.

Output contract:
- Return one "games" entry for every game in the bundle. For each game, return exactly one forecast per market the game supplies — a game supplies one to three of "market": "moneyline", "market": "spread" (the designated run line), and "market": "total". Forecast every market the game supplies and no market it does not.
- "selection" labels: for "moneyline" and "spread", exactly the game's "awayTeam" or "homeTeam" string from the bundle; for "total", exactly "over" or "under".
- "line": null for moneyline. For "spread", copy the bundle's designated run-line "line" value verbatim (it is expressed as the home team's handicap; selecting the away team means taking the away side of that same designated line). For "total", copy the bundle's total "line" value verbatim.
- "observedDecimal": copy exactly the bundle's decimal price for the side you selected ("awayDecimal"/"homeDecimal", or "overDecimal"/"underDecimal" for totals).
- "probabilities": your win/push/loss estimate for the selected side at the designated line; the three values must sum to 1. Push is 0 for moneyline and for half-run lines; integer total lines may carry push > 0.
- "evidenceRefs": every entry must be an evidenceRef ID that appears in that game's bundle entry. Cite the refs your rationale actually rests on; where the rationale rests on outside reasoning or a search you performed, say so in the rationale and leave this array empty rather than citing a ref that does not support it.
- "reasonCode": the supplied reason codes are "missing_information" and "contradictory_information". Set one of them on a forecast only if required information is missing or contradictory; otherwise set null or omit the field.
- "axes": your ratings on the five axes defined above — "valuation", "trend", "consensus", "news", "softness" — as integers 1 through 5, all five keys present, for this market.
- "primaryAxis": the one axis you name as the primary driver, or null when every axis is rated 1. Name a driver whenever any axis is above 1, including when two or more share the highest rating.
- "primaryExpectation": your one sentence on the primary axis — what you expect to happen and which direction it moves the number. When "primaryAxis" is null, state in this field that you expect no material movement. Never null.
- Echo "schemaVersion": 2 and the supplied "cohortId", "participantId", "requestedModelId", "bundleSha256", and "executionPolicy" values exactly.
- Respond with ONLY the JSON object — no prose, no code fences.`;

/**
 * The user-message builder is guarded to a `PreparedGameRequest`: the only
 * value it will serialize is the normalized, hash-verified, frozen request the
 * prepared boundary produces (SPEC-prepared-request.md §2.3). A caller cannot
 * hand it a raw bundle, so the bytes the model sees always canonicalize back to
 * the exact bytes behind `requestSha256` — the hashed request IS the prompted
 * request. Both `bundleSha256` and `decisionCutoffUtc` are taken from the
 * prepared request's derived fields, never from a separately-supplied value.
 */
export interface PromptInputs {
  cohortId: string;
  participantId: string;
  requestedModelId: string;
  executionPolicy: 'fixed-moneyline-total';
  request: PreparedGameRequest;
}

export function buildUserMessage(inputs: PromptInputs): string {
  // Read the request EXACTLY ONCE, then guard THAT captured value. inputs.request
  // could be a getter; re-reading it after the check would let a caller return a
  // branded request to assertPrepared and a different (unprepared) one to the
  // serializer — check one object, prompt another. The single read closes that.
  const { request } = inputs;
  assertPrepared(request);
  const payload = {
    cohortId: inputs.cohortId,
    participantId: inputs.participantId,
    requestedModelId: inputs.requestedModelId,
    executionPolicy: inputs.executionPolicy,
    bundleSha256: request.requestSha256,
    decisionCutoffUtc: request.cutoffAt,
    bundle: request.requestBundle,
  };
  return `${CONTRACT_NOTES}\n\nRequest:\n${JSON.stringify(payload, null, 2)}`;
}

export function promptScaffoldSha256(): string {
  return sha256Hex(`${SYSTEM_PROMPT}\n---\n${CONTRACT_NOTES}`);
}

/**
 * Deterministic format-repair instruction. It restates the validator errors
 * and demands the same decisions in valid schema — it may not carry new
 * market information and may not invite a new decision.
 */
export function buildRepairInstruction(errors: string[]): string {
  const list = errors.map((e) => `- ${e}`).join('\n');
  return `Your previous response did not satisfy the required JSON schema. Validator errors:\n${list}\n\nReturn the exact same forecasts and decisions as a single valid JSON object matching the schema. Do not change any selection, probability, confidence, abstention, or execution marking. Do not add prose or code fences.`;
}
