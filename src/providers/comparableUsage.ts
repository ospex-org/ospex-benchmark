import type { ProviderName } from '../types.js';

/**
 * Derive the two cross-provider COMPARABLE usage fields from a provider's
 * verbatim usage object — without normalizing the raw object itself, which
 * stays untouched in `usageRaw`:
 *
 *   - `reasoningTokens`: the provider-reported reasoning/thinking token count.
 *   - `billableOutputTokens`: total output-rate tokens INCLUDING reasoning,
 *     under the provider's OWN semantics. openai and anthropic report
 *     reasoning as a subset already inside the output total; google and xai
 *     report it as a separate additive bucket, which makes bare
 *     output/completion counts non-comparable across the four arms — this
 *     field is the comparable one.
 *
 * Both fields are `null` — never a fabricated zero — when the provider did
 * not report enough to derive them with confidence (the FALSE-ZERO rule: an
 * absent additive bucket without a corroborating total is unknown, not zero).
 * This module is derivation-for-records only; the money guard's independent
 * arithmetic lives in conservativeSpend.ts and stays fail-closed on its own.
 */

export interface ComparableUsage {
  reasoningTokens: number | null;
  billableOutputTokens: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function own(obj: Record<string, unknown> | null, field: string): unknown {
  return obj !== null && Object.hasOwn(obj, field) ? obj[field] : undefined;
}

export function deriveComparableUsage(provider: ProviderName, usageRaw: unknown): ComparableUsage {
  const usage = record(usageRaw);
  if (usage === null) return { reasoningTokens: null, billableOutputTokens: null };
  switch (provider) {
    case 'openai': {
      // Chat shape (prompt/completion) and Responses shape (input/output) both
      // count reasoning INSIDE the output total, reported as a subset detail.
      const chatOutput = count(own(usage, 'completion_tokens'));
      const responsesOutput = count(own(usage, 'output_tokens'));
      const details =
        record(own(usage, 'completion_tokens_details')) ??
        record(own(usage, 'output_tokens_details'));
      return {
        reasoningTokens: count(own(details, 'reasoning_tokens')),
        billableOutputTokens: chatOutput ?? responsesOutput,
      };
    }
    case 'anthropic': {
      // output_tokens is the inclusive, authoritative billable total (thinking
      // folded in); output_tokens_details.thinking_tokens is a read-only
      // subset breakdown that may be absent.
      const details = record(own(usage, 'output_tokens_details'));
      return {
        reasoningTokens: count(own(details, 'thinking_tokens')),
        billableOutputTokens: count(own(usage, 'output_tokens')),
      };
    }
    case 'google': {
      // thoughtsTokenCount is ADDITIVE to candidatesTokenCount. When it is
      // absent, only a corroborating total (with or without the tool-use
      // prompt bucket) proves it was zero; otherwise billable is unknown.
      const candidates = count(own(usage, 'candidatesTokenCount'));
      if (candidates === null) return { reasoningTokens: null, billableOutputTokens: null };
      const thoughts = count(own(usage, 'thoughtsTokenCount'));
      if (thoughts !== null) {
        return { reasoningTokens: thoughts, billableOutputTokens: candidates + thoughts };
      }
      const prompt = count(own(usage, 'promptTokenCount'));
      const toolUse = count(own(usage, 'toolUsePromptTokenCount')) ?? 0;
      const total = count(own(usage, 'totalTokenCount'));
      const corroborated =
        prompt !== null &&
        total !== null &&
        (total === prompt + candidates || total === prompt + candidates + toolUse);
      return {
        reasoningTokens: null,
        billableOutputTokens: corroborated ? candidates : null,
      };
    }
    case 'xai': {
      // Chat shape: reasoning is ADDITIVE (total = prompt + completion +
      // reasoning). Responses shape: additivity is determined per response by
      // arithmetic against total_tokens; without a discriminating total the
      // larger (additive) reading is reported so the field can only overstate,
      // and with no reasoning detail at all a corroborating total must prove
      // it zero — else null.
      const chatOutput = count(own(usage, 'completion_tokens'));
      const responsesOutput = count(own(usage, 'output_tokens'));
      const output = chatOutput ?? responsesOutput;
      const input = count(own(usage, chatOutput !== null ? 'prompt_tokens' : 'input_tokens'));
      const details =
        record(own(usage, 'completion_tokens_details')) ??
        record(own(usage, 'output_tokens_details'));
      const reasoning = count(own(details, 'reasoning_tokens'));
      const total = count(own(usage, 'total_tokens'));
      if (output === null) return { reasoningTokens: reasoning, billableOutputTokens: null };
      if (reasoning === null) {
        const corroboratedZero = input !== null && total !== null && total === input + output;
        return { reasoningTokens: null, billableOutputTokens: corroboratedZero ? output : null };
      }
      if (input !== null && total !== null) {
        if (total === input + output + reasoning) {
          return { reasoningTokens: reasoning, billableOutputTokens: output + reasoning };
        }
        if (total === input + output && reasoning <= output) {
          return { reasoningTokens: reasoning, billableOutputTokens: output };
        }
        return { reasoningTokens: reasoning, billableOutputTokens: null };
      }
      return { reasoningTokens: reasoning, billableOutputTokens: output + reasoning };
    }
    default: {
      const _exhaustive: never = provider;
      void _exhaustive;
      return { reasoningTokens: null, billableOutputTokens: null };
    }
  }
}
