import type { ProviderName } from '../types.js';

/**
 * Model identity — hard runtime assertions, fail-closed.
 *
 * The checks work on RESPONSE-REPORTED model IDs, not requested ones: a
 * gateway can happily accept "claude-fable-5" and route it to something else,
 * and the only trace is what the response metadata reports. Failures:
 *
 * - an arm reports any ID outside its approved list (exact requested ID plus
 *   explicitly approved aliases) — same-family substitutions included;
 * - an arm's reported IDs drift across games/attempts;
 * - two arms resolve to the same provider family (PROVIDER_COLLISION);
 * - an arm's reported family contradicts the provider it was requested from;
 * - two arms report the byte-identical model ID.
 *
 * A SUCCESSFUL response that reports no model ID is itself a failure —
 * accepted decisions require verified identity. Only arms that never
 * produced a response body (timeouts, HTTP failures, missing credentials)
 * are exempt from the reported-ID requirement; they surface as loud
 * warnings instead.
 */
export function classifyFamily(modelId: string): ProviderName | null {
  const id = modelId.toLowerCase();
  if (id.includes('claude')) return 'anthropic';
  if (id.includes('gemini') || id.includes('palm') || id.includes('bison')) return 'google';
  if (id.includes('grok')) return 'xai';
  if (/(^|[^a-z])gpt|davinci|^o[0-9]|chatgpt/.test(id)) return 'openai';
  return null;
}

export interface CollisionCheckInput {
  participantId: string;
  provider: ProviderName;
  requestedModelId: string;
  /** Exact reported IDs accepted for this arm (requested ID + approved aliases). */
  approvedReportedModelIds: string[];
  /** Distinct response-reported model IDs observed across the arm's games. */
  reportedModelIds: string[];
  /**
   * Number of SUCCESSFUL provider responses (a body came back) that carried
   * no reported model ID. Any such response fails the run.
   */
  unidentifiedResponses: number;
}

export interface CollisionCheckResult {
  failures: string[];
  warnings: string[];
}

export function checkProviderCollision(arms: CollisionCheckInput[]): CollisionCheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  const byFamily = new Map<ProviderName, CollisionCheckInput[]>();
  const byReportedId = new Map<string, CollisionCheckInput>();

  for (const arm of arms) {
    if (arm.unidentifiedResponses > 0) {
      failures.push(
        `MODEL_IDENTITY: ${arm.participantId} returned ${arm.unidentifiedResponses} response(s) without a reported model ID — accepted decisions require verified identity`,
      );
    }
    if (arm.reportedModelIds.length === 0) {
      if (arm.unidentifiedResponses === 0) {
        warnings.push(
          `${arm.participantId}: no successful response, so no reported model ID — provider identity unverified`,
        );
      }
      continue;
    }

    // Fail-closed: every reported ID must be exactly approved for this arm.
    const approved = new Set(arm.approvedReportedModelIds);
    for (const id of arm.reportedModelIds) {
      if (!approved.has(id)) {
        failures.push(
          `MODEL_IDENTITY: ${arm.participantId} reported unapproved model ID "${id}" (approved: ${[...approved].join(', ')})`,
        );
      }
    }

    // Model drift across games/attempts is a failure even among approved IDs.
    if (arm.reportedModelIds.length > 1) {
      failures.push(
        `MODEL_IDENTITY: ${arm.participantId} reported model drift across games/attempts: ${arm.reportedModelIds.join(', ')}`,
      );
    }

    const families = new Set<ProviderName>();
    for (const id of arm.reportedModelIds) {
      const family = classifyFamily(id);
      if (family === null) {
        warnings.push(
          `${arm.participantId}: reported model "${id}" does not match any known family`,
        );
      } else {
        families.add(family);
      }
      const prior = byReportedId.get(id.trim().toLowerCase());
      if (prior && prior.participantId !== arm.participantId) {
        failures.push(
          `PROVIDER_COLLISION: ${prior.participantId} and ${arm.participantId} report the identical model ID "${id}"`,
        );
      } else {
        byReportedId.set(id.trim().toLowerCase(), arm);
      }
    }
    for (const family of families) {
      if (family !== arm.provider) {
        failures.push(
          `PROVIDER_COLLISION: ${arm.participantId} was requested from ${arm.provider} but responses report the ${family} family (${arm.reportedModelIds.join(', ')})`,
        );
      }
      const list = byFamily.get(family) ?? [];
      if (!list.includes(arm)) list.push(arm);
      byFamily.set(family, list);
    }
  }

  for (const [family, members] of byFamily) {
    if (members.length > 1) {
      const names = members
        .map((m) => `${m.participantId} (reported "${m.reportedModelIds.join(', ')}")`)
        .join(', ');
      failures.push(`PROVIDER_COLLISION: multiple arms resolve to the ${family} family: ${names}`);
    }
  }

  return { failures, warnings };
}
