import { sha256Hex } from './canonical.js';
import { benchmarkResponseSchema, renderResponseTemplate } from './schema.js';
import type { SlateBundle } from './types.js';

export const PROMPT_SCAFFOLD_VERSION = 'shadow-smoke-v0.3';

/**
 * System prompt, VERBATIM from docs/BENCHMARK_PROMPT_V0.md ("System prompt
 * draft"). Do not edit here without editing the doc — the doc is the contract.
 */
export const SYSTEM_PROMPT = `You are one participant in a preregistered sports-market decision benchmark running through Ospex.

Use only the supplied frozen information bundle and the tools explicitly declared in this request. Do not use memory of later events, external browsing, native provider search, or unstated information. Treat all reference odds as timestamped observations, not guarantees of current executable prices.

For every eligible game, forecast each market supplied in that game's frozen bundle entry (listed under "markets"), and only those markets: a moneyline side, a side on the designated spread/run line, and over or under on the designated total, for whichever of the three the bundle carries. Do not forecast a market the bundle does not carry.

For each forecast, supply win/push/loss probabilities that sum to 1, a short grounded rationale, and whether you would ordinarily abstain. Follow the cohort's declared execution policy when marking forecasts for execution: under the fixed policy, mark the moneyline and the total (whichever are present) and never the spread/run line.

Use the exact market, line, team/side labels, and observed decimal prices from the bundle. Do not size stakes. A fixed equal-risk policy is applied by the harness.

Return only JSON matching the requested schema. Do not add prose outside the JSON. Ground each rationale in evidenceRef IDs from the frozen bundle. If required information is missing or contradictory, record the supplied reason code rather than inventing facts.`;

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
  schemaVersion: '1',
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
  'games[].forecasts[].rationale': '"<short grounded rationale>"',
  'games[].forecasts[].evidenceRefs[]': '"<bundle evidenceRef>"',
  'games[].forecasts[].reasonCode':
    '<null | "missing_information" | "contradictory_information">',
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
export const CONTRACT_NOTES = `Declared execution policy: fixed-moneyline-total. In every game, set "selectedForExecution": true on the moneyline and total forecasts that the bundle carries, and false on the spread forecast; a market absent from the bundle has no forecast.

Response template — use EXACTLY this structure and these field names. Do not add, rename, or omit any field:
${RESPONSE_TEMPLATE}
Each "games" entry carries ONLY "gameId" and "forecasts". "probabilities" is an object with exactly the keys "win", "push", "loss" — never an array. "confidence" is your overall confidence in the forecast, from 0 through 1. "wouldAbstain" is whether you would ordinarily abstain from this market — a non-executing signal.

Output contract:
- Return one "games" entry for every game in the bundle. For each game, return exactly one forecast per market listed under that game's "markets" — some dispatches carry all three ("moneyline", "spread" [the designated run line], "total"), others carry fewer. Do not add a forecast for a market the bundle does not carry, and do not omit one it does.
- "selection" labels: for "moneyline" and "spread", exactly the game's "awayTeam" or "homeTeam" string from the bundle; for "total", exactly "over" or "under".
- "line": null for moneyline. For "spread", copy the bundle's designated run-line "line" value verbatim (it is expressed as the home team's handicap; selecting the away team means taking the away side of that same designated line). For "total", copy the bundle's total "line" value verbatim.
- "observedDecimal": copy exactly the bundle's decimal price for the side you selected ("awayDecimal"/"homeDecimal", or "overDecimal"/"underDecimal" for totals).
- "probabilities": your win/push/loss estimate for the selected side at the designated line; the three values must sum to 1. Push is 0 for moneyline and for half-run lines; integer total lines may carry push > 0.
- "evidenceRefs": at least one entry per forecast, citing only evidenceRef IDs that appear in that game's bundle entry.
- "reasonCode": the supplied reason codes are "missing_information" and "contradictory_information". Set one of them on a forecast only if required information is missing or contradictory; otherwise set null or omit the field.
- Echo "schemaVersion": 1 and the supplied "cohortId", "participantId", "requestedModelId", "bundleSha256", and "executionPolicy" values exactly.
- Respond with ONLY the JSON object — no prose, no code fences.`;

export interface PromptInputs {
  cohortId: string;
  participantId: string;
  requestedModelId: string;
  executionPolicy: 'fixed-moneyline-total';
  bundleSha256: string;
  bundle: SlateBundle;
}

export function buildUserMessage(inputs: PromptInputs): string {
  const payload = {
    cohortId: inputs.cohortId,
    participantId: inputs.participantId,
    requestedModelId: inputs.requestedModelId,
    executionPolicy: inputs.executionPolicy,
    bundleSha256: inputs.bundleSha256,
    decisionCutoffUtc: inputs.bundle.cutoffAt,
    bundle: inputs.bundle,
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
