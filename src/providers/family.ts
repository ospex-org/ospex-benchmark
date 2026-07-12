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
 * An arm that reports NO model ID cannot be verified and is surfaced as a
 * loud warning on every artifact (absence is not a substitution).
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
    if (arm.reportedModelIds.length === 0) {
      warnings.push(
        `${arm.participantId}: no response-reported model ID available — provider identity unverified`,
      );
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
