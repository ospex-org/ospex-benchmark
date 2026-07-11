import type { ProviderName } from '../types.js';

/**
 * PROVIDER_COLLISION — hard runtime assertion.
 *
 * The check works on RESPONSE-REPORTED model IDs, not requested ones: a
 * gateway can happily accept "claude-fable-5" and route it to something else,
 * and the only trace is what the response metadata reports. If two arms
 * resolve to the same provider family — or an arm's reported family
 * contradicts the provider it was requested from — the run fails loudly and
 * names them.
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
  reportedModelId: string | null;
}

export interface CollisionCheckResult {
  failures: string[];
  warnings: string[];
}

export function checkProviderCollision(arms: CollisionCheckInput[]): CollisionCheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  const byFamily = new Map<ProviderName, CollisionCheckInput[]>();
  const unclassified: CollisionCheckInput[] = [];

  for (const arm of arms) {
    if (arm.reportedModelId === null) {
      warnings.push(
        `${arm.participantId}: no response-reported model ID available — provider identity unverified`,
      );
      continue;
    }
    const family = classifyFamily(arm.reportedModelId);
    if (family === null) {
      warnings.push(
        `${arm.participantId}: reported model "${arm.reportedModelId}" does not match any known family — provider identity unverified`,
      );
      unclassified.push(arm);
      continue;
    }
    if (family !== arm.provider) {
      failures.push(
        `PROVIDER_COLLISION: ${arm.participantId} was requested from ${arm.provider} but the response reports "${arm.reportedModelId}" (${family} family)`,
      );
    }
    const list = byFamily.get(family) ?? [];
    list.push(arm);
    byFamily.set(family, list);
  }

  for (const [family, members] of byFamily) {
    if (members.length > 1) {
      const names = members
        .map((m) => `${m.participantId} (reported "${m.reportedModelId ?? 'unknown'}")`)
        .join(', ');
      failures.push(`PROVIDER_COLLISION: multiple arms resolve to the ${family} family: ${names}`);
    }
  }

  // Fallback for unclassifiable IDs: byte-identical reported IDs across arms
  // are still a collision even when the family is unknown.
  const seen = new Map<string, CollisionCheckInput>();
  for (const arm of unclassified) {
    const key = (arm.reportedModelId ?? '').trim().toLowerCase();
    const prior = seen.get(key);
    if (prior) {
      failures.push(
        `PROVIDER_COLLISION: ${prior.participantId} and ${arm.participantId} report the identical model ID "${arm.reportedModelId}"`,
      );
    } else {
      seen.set(key, arm);
    }
  }

  return { failures, warnings };
}
