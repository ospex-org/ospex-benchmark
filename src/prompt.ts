import { sha256Hex } from './canonical.js';
import type { SlateBundle } from './types.js';

export const PROMPT_SCAFFOLD_VERSION = 'shadow-smoke-v0';

/**
 * System prompt, VERBATIM from docs/BENCHMARK_PROMPT_V0.md ("System prompt
 * draft"). Do not edit here without editing the doc — the doc is the contract.
 */
export const SYSTEM_PROMPT = `You are one participant in a preregistered sports-market decision benchmark running through Ospex.

Use only the supplied frozen information bundle and the tools explicitly declared in this request. Do not use memory of later events, external browsing, native provider search, or unstated information. Treat all reference odds as timestamped observations, not guarantees of current executable prices.

For every eligible game, forecast all three supplied fixed markets:
1. Select a moneyline side.
2. Select a side on the designated spread/run line.
3. Select over or under on the designated total.

For each forecast, supply win/push/loss probabilities that sum to 1, a short grounded rationale, and whether you would ordinarily abstain. Follow the cohort's declared execution policy when marking exactly two forecasts for execution: either fixed moneyline+total or model-choice moneyline/spread+total.

Use the exact market, line, team/side labels, and observed decimal prices from the bundle. Do not size stakes. A fixed equal-risk policy is applied by the harness.

Return only JSON matching the requested schema. Do not add prose outside the JSON. Ground each rationale in evidenceRef IDs from the frozen bundle. If required information is missing or contradictory, record the supplied reason code rather than inventing facts.`;

/**
 * Fixed output-contract notes: operational details the schema draft leaves to
 * the harness (exact selection labels, line echoing, execution marking under
 * the declared policy). Identical for every arm; part of the hashed scaffold.
 */
export const CONTRACT_NOTES = `Declared execution policy: fixed-moneyline-total. In every game, set "selectedForExecution": true on the moneyline forecast and the total forecast, and false on the spread forecast.

Output contract:
- Return one "games" entry for every game in the bundle, each with exactly three forecasts: one "market": "moneyline", one "market": "spread" (the designated run line), and one "market": "total".
- "selection" labels: for "moneyline" and "spread", exactly the game's "awayTeam" or "homeTeam" string from the bundle; for "total", exactly "over" or "under".
- "line": null for moneyline. For "spread", copy the bundle's designated run-line "line" value verbatim (it is expressed as the home team's handicap; selecting the away team means taking the away side of that same designated line). For "total", copy the bundle's total "line" value verbatim.
- "observedDecimal": copy exactly the bundle's decimal price for the side you selected ("awayDecimal"/"homeDecimal", or "overDecimal"/"underDecimal" for totals).
- "probabilities": your win/push/loss estimate for the selected side at the designated line; the three values must sum to 1. Push is 0 for moneyline and for half-run lines; integer total lines may carry push > 0.
- "evidenceRefs": cite only evidenceRef IDs that appear in that game's bundle entry.
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
