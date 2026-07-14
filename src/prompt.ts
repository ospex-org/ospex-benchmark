import { sha256Hex } from './canonical.js';
import { bundleMarketKeys, MARKET_KEYS } from './markets.js';
import { benchmarkResponseSchema, renderResponseTemplate } from './schema.js';
import type { MarketKey, SlateBundle } from './types.js';

// Bumped from shadow-smoke-v0.2: the response contract is now rendered from
// the request's own market set (a scoped line-open fire asks for the markets
// that were open at detection, not always three), so the scaffold hash is a
// function of the dispatched markets and new runs are not scaffold-comparable
// with the archived three-market smoke corpus.
export const PROMPT_SCAFFOLD_VERSION = 'shadow-smoke-v0.3';

/**
 * System prompt. Market-agnostic and constant: it instructs the participant to
 * forecast whatever markets the bundle supplies for each game. Which markets
 * are present — and how many — is stated per request in the contract notes,
 * because a line-open fire dispatches only the markets that were open (e.g.
 * moneyline + total, no run line). Do not edit here without editing
 * docs/BENCHMARK_PROMPT_V0.md — the doc is the contract.
 */
export const SYSTEM_PROMPT = `You are one participant in a preregistered sports-market decision benchmark running through Ospex.

Use only the supplied frozen information bundle and the tools explicitly declared in this request. Do not use memory of later events, external browsing, native provider search, or unstated information. Treat all reference odds as timestamped observations, not guarantees of current executable prices.

For every eligible game, forecast each market the bundle supplies for that game — any of: a moneyline side; a side on the designated spread/run line; over or under on the designated total. A bundle carries only the markets that were open at the decision instant, so forecast exactly the markets present, no more and no fewer.

For each forecast, supply win/push/loss probabilities that sum to 1, a short grounded rationale, and whether you would ordinarily abstain. Follow the cohort's declared execution policy when marking forecasts for execution: every supplied market except the spread/run line is executed.

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

/** Human phrasing per market, for the response-contract notes. */
const MARKET_NAME: Record<MarketKey, string> = {
  moneyline: '"moneyline"',
  spread: '"spread" (the designated run line)',
  total: '"total"',
};

/** English list ("a", "a and b", "a, b, and c"). */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** A market is executed under the declared policy iff it is not the spread. */
function isExecutedMarket(market: MarketKey): boolean {
  return market !== 'spread';
}

/**
 * Fixed output-contract notes RENDERED for a request's own market set: the
 * forecast count, which markets, and the execution marking all name exactly
 * the markets present in the bundle. A scoped fire (moneyline + total) and a
 * full board (all three) get different notes, so the scaffold hash differs —
 * this is intended, and recorded per request.
 */
export function buildContractNotes(markets: MarketKey[]): string {
  const ordered = MARKET_KEYS.filter((m) => markets.includes(m));
  const count = ordered.length;
  const marketList = joinList(ordered.map((m) => MARKET_NAME[m]));
  const executed = ordered.filter(isExecutedMarket);
  const spreadPresent = ordered.includes('spread');

  const executionSentence = spreadPresent
    ? `In every game, set "selectedForExecution": true on ${joinList(
        executed.map((m) => MARKET_NAME[m]),
      )} and false on the spread forecast.`
    : `In every game, set "selectedForExecution": true on every forecast (${joinList(
        executed.map((m) => MARKET_NAME[m]),
      )}).`;

  const selectionRules: string[] = [];
  const lineRules: string[] = [];
  if (ordered.includes('moneyline')) {
    selectionRules.push('for "moneyline", exactly the game\'s "awayTeam" or "homeTeam" string');
    lineRules.push('"line" is null for moneyline');
  }
  if (ordered.includes('spread')) {
    selectionRules.push('for "spread", exactly the game\'s "awayTeam" or "homeTeam" string');
    lineRules.push(
      'for "spread", copy the bundle\'s designated run-line "line" value verbatim (it is expressed as the home team\'s handicap; selecting the away team means taking the away side of that same designated line)',
    );
  }
  if (ordered.includes('total')) {
    selectionRules.push('for "total", exactly "over" or "under"');
    lineRules.push('for "total", copy the bundle\'s total "line" value verbatim');
  }

  return `Declared execution policy: fixed-moneyline-total. ${executionSentence}

Response template — use EXACTLY this structure and these field names. Do not add, rename, or omit any field:
${RESPONSE_TEMPLATE}
Each "games" entry carries ONLY "gameId" and "forecasts". "probabilities" is an object with exactly the keys "win", "push", "loss" — never an array. "confidence" is your overall confidence in the forecast, from 0 through 1. "wouldAbstain" is whether you would ordinarily abstain from this market — a non-executing signal.

Output contract:
- Return one "games" entry for every game in the bundle, each with exactly ${count} forecast${count === 1 ? '' : 's'}: one per supplied market (${marketList}). Supply a forecast for exactly the markets present in that game's bundle, no more and no fewer.
- "selection" labels: ${joinList(selectionRules)}.
- ${joinList(lineRules)}.
- "observedDecimal": copy exactly the bundle's decimal price for the side you selected ("awayDecimal"/"homeDecimal", or "overDecimal"/"underDecimal" for totals).
- "probabilities": your win/push/loss estimate for the selected side at the designated line; the three values must sum to 1. Push is 0 for moneyline and for half-run lines; integer total lines may carry push > 0.
- "evidenceRefs": at least one entry per forecast, citing only evidenceRef IDs that appear in that game's bundle entry.
- "reasonCode": the supplied reason codes are "missing_information" and "contradictory_information". Set one of them on a forecast only if required information is missing or contradictory; otherwise set null or omit the field.
- Echo "schemaVersion": 1 and the supplied "cohortId", "participantId", "requestedModelId", "bundleSha256", and "executionPolicy" values exactly.
- Respond with ONLY the JSON object — no prose, no code fences.`;
}

export interface PromptInputs {
  cohortId: string;
  participantId: string;
  requestedModelId: string;
  executionPolicy: 'fixed-moneyline-total';
  bundleSha256: string;
  bundle: SlateBundle;
}

/** The union of markets across the bundle's games (single-game per request). */
function bundleMarketSet(bundle: SlateBundle): MarketKey[] {
  const present = new Set<MarketKey>();
  for (const game of bundle.games) {
    for (const market of bundleMarketKeys(game)) present.add(market);
  }
  return MARKET_KEYS.filter((m) => present.has(m));
}

export function buildUserMessage(inputs: PromptInputs): string {
  const contractNotes = buildContractNotes(bundleMarketSet(inputs.bundle));
  const payload = {
    cohortId: inputs.cohortId,
    participantId: inputs.participantId,
    requestedModelId: inputs.requestedModelId,
    executionPolicy: inputs.executionPolicy,
    bundleSha256: inputs.bundleSha256,
    decisionCutoffUtc: inputs.bundle.cutoffAt,
    bundle: inputs.bundle,
  };
  return `${contractNotes}\n\nRequest:\n${JSON.stringify(payload, null, 2)}`;
}

/**
 * The scaffold hash for a request's market set: the constant system prompt
 * plus the market-specific contract notes. Varies by market set, so it is
 * recorded per request rather than once per run.
 */
export function promptScaffoldSha256(markets: MarketKey[]): string {
  return sha256Hex(`${SYSTEM_PROMPT}\n---\n${buildContractNotes(markets)}`);
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
