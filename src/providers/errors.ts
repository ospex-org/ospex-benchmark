import type { ProviderResponseEnvelope, ProviderUsage, SearchAudit } from '../types.js';

export class ProviderTimeoutError extends Error {
  constructor(provider: string, timeoutMs: number) {
    super(`${provider} call exceeded ${timeoutMs}ms`);
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderHttpError extends Error {
  readonly status: number;

  /**
   * The complete received body, sealed — on the one path that has one: a 2xx
   * whose body did not parse as JSON. Those bytes are the most likely place an
   * unrecognized provider shape shows up, and discarding them left a leg that
   * recorded nothing at all, indistinguishable downstream from a call that
   * never landed.
   *
   * `null` everywhere else, and deliberately so on a NON-2xx: a provider error
   * body is the likeliest place request content is echoed back, so that path
   * keeps its truncated `detail` and retains nothing.
   */
  readonly responseEnvelope: ProviderResponseEnvelope | null;

  /** `detail` must already be redacted/truncated by the caller. */
  constructor(
    provider: string,
    status: number,
    detail: string,
    responseEnvelope: ProviderResponseEnvelope | null = null,
  ) {
    super(`${provider} returned HTTP ${status}: ${detail}`);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.responseEnvelope = responseEnvelope;
  }
}

/**
 * A successful HTTP exchange whose body is NOT a finished turn: the provider's
 * own terminal-state field says the response did not run to completion. Every
 * adapter normalizes its provider's states through this one type — Anthropic
 * `stop_reason` other than `end_turn`/`stop_sequence` (`pause_turn`,
 * `refusal`, `max_tokens`, …), a Responses-API root `status` other than
 * `completed` (`incomplete`, `failed`, …), and a Google `finishReason` other
 * than `STOP` (`MAX_TOKENS`, `TOO_MANY_TOOL_CALLS`, safety/recitation stops,
 * a blocked prompt, …). All arrive as HTTP 200 with content that is typically
 * empty or partial.
 *
 * This is a TYPED failure rather than a returned response on purpose. Left
 * untyped, an unfinished turn reads downstream as a model that produced
 * invalid JSON — scoring a provider state as a schema failure, or worse,
 * accepting a truncated-but-parseable body as the model's decision.
 *
 * Continuation is deliberately NOT implemented: each continuation is a further
 * billable request, and the per-attempt reservation the spend accounting rests
 * on bounds ONE request per attempt. `maxServerToolContinuations` in the
 * declared tool config records that decision as configuration; raising it
 * means re-deriving the reservation, not editing an adapter.
 *
 * The call's evidence IS carried here — the HTTP status, provider response
 * id, reported model id, the extracted (possibly empty) answer text, the
 * COMPLETE response body it was extracted from, the response's own usage
 * (normalized and verbatim), the search audit, and the recorded request params
 * — so the persisted attempt records what actually happened and the money
 * guard prices what the call actually cost instead of escalating on absent
 * evidence. The runner redacts the carried text/audit
 * when it records the attempt, exactly as it does for a returned response.
 */
export class ProviderUnfinishedTurnError extends Error {
  readonly stopReason: string;
  readonly httpStatus: number;
  readonly providerResponseId: string | null;
  readonly reportedModelId: string | null;
  readonly rawText: string;
  /**
   * The complete response body. An unfinished turn is a PAID, received
   * response, so it retains an envelope on the same terms a returned response
   * does — and it is the case most likely to carry a shape the extractor of
   * the day does not recognize, which is exactly what the envelope exists for.
   */
  readonly responseEnvelope: ProviderResponseEnvelope;
  readonly usage: ProviderUsage;
  readonly usageRaw: unknown;
  readonly searchAudit: SearchAudit | null;
  readonly requestParams: Record<string, unknown>;

  constructor(input: {
    provider: string;
    stopReason: string;
    detail: string;
    httpStatus: number;
    providerResponseId: string | null;
    reportedModelId: string | null;
    rawText: string;
    responseEnvelope: ProviderResponseEnvelope;
    usage: ProviderUsage;
    usageRaw: unknown;
    searchAudit: SearchAudit | null;
    requestParams: Record<string, unknown>;
  }) {
    super(`${input.provider} returned an unfinished turn (stop_reason: ${input.stopReason}): ${input.detail}`);
    this.name = 'ProviderUnfinishedTurnError';
    this.stopReason = input.stopReason;
    this.httpStatus = input.httpStatus;
    this.providerResponseId = input.providerResponseId;
    this.reportedModelId = input.reportedModelId;
    this.rawText = input.rawText;
    this.responseEnvelope = input.responseEnvelope;
    this.usage = input.usage;
    this.usageRaw = input.usageRaw;
    this.searchAudit = input.searchAudit;
    this.requestParams = input.requestParams;
  }
}
