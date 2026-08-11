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
 * - an arm's reported family contradicts the provider it was requested from;
 * - two arms are INDISTINGUISHABLE AS ENTRANTS: they report the byte-identical
 *   model ID under the byte-identical configuration (PROVIDER_COLLISION).
 *
 * A SUCCESSFUL response that reports no model ID is itself a failure —
 * accepted decisions require verified identity. Only arms that never
 * produced a response body (timeouts, HTTP failures, missing credentials)
 * are exempt from the reported-ID requirement; they surface as loud
 * warnings instead.
 *
 * The last rule used to be two rules — "two arms report the identical model
 * ID" and "two arms resolve to the same provider family" — and both are now
 * wrong as stated, because an arm is one competing CONFIGURATION. Two models
 * from one lab, and one model at two reasoning levels, are exactly what this
 * cohort is for. What the old rules were really guarding is intact and is what
 * the new one says: an operator who believes they are running N distinct
 * competitors must not be running fewer. Cross-lab substitution — the other
 * thing the family rule caught — is still caught twice over, by the approved-ID
 * allowlist and by the family-contradicts-provider check.
 *
 * ONE BOUND, stated because it is irreducible rather than because it is small:
 * the configuration half of an entrant's identity is verified REQUEST-side
 * only. No provider echoes a reasoning setting back, so a lab that silently
 * ignores a knob is indistinguishable here from one that honours it. What is
 * verifiable is that the declared configuration went out on the wire, which
 * `configurationEvidenceViolations` checks against each attempt's recorded
 * request. If a provider ever reports enough to close the gap — an effort
 * echo, a distinct service tier, a reasoning-token floor — this is the hook.
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
  /**
   * The digest of this arm's declared configuration — the OTHER half of what
   * makes it a distinct entrant. Supplied by the caller from the authenticated
   * roster, never derived from a response, because no response carries it.
   */
  configurationSha256: string;
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

  // Keyed by ENTRANT — reported model ID plus configuration digest — because
  // two arms sharing a model are a legitimate cohort while two arms sharing a
  // model AND its configuration are the same competitor entered twice. The key
  // is a JSON pair rather than a joined string: a model ID may contain any
  // character, and a separator a model ID can contain is a separator two
  // different pairs can spell the same way.
  const byEntrant = new Map<string, CollisionCheckInput>();

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
      const entrantKey = JSON.stringify([id.trim().toLowerCase(), arm.configurationSha256]);
      const prior = byEntrant.get(entrantKey);
      if (prior && prior.participantId !== arm.participantId) {
        failures.push(
          `PROVIDER_COLLISION: ${prior.participantId} and ${arm.participantId} report the identical model ID "${id}" under the identical configuration ${arm.configurationSha256}`,
        );
      } else {
        byEntrant.set(entrantKey, arm);
      }
    }
    for (const family of families) {
      if (family !== arm.provider) {
        failures.push(
          `PROVIDER_COLLISION: ${arm.participantId} was requested from ${arm.provider} but responses report the ${family} family (${arm.reportedModelIds.join(', ')})`,
        );
      }
    }
  }

  return { failures, warnings };
}
