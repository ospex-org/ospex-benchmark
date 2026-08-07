export class ProviderTimeoutError extends Error {
  constructor(provider: string, timeoutMs: number) {
    super(`${provider} call exceeded ${timeoutMs}ms`);
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderHttpError extends Error {
  readonly status: number;

  /** `detail` must already be redacted/truncated by the caller. */
  constructor(provider: string, status: number, detail: string) {
    super(`${provider} returned HTTP ${status}: ${detail}`);
    this.name = 'ProviderHttpError';
    this.status = status;
  }
}

/**
 * A successful HTTP response that is NOT a finished turn: the provider paused
 * its own server-side tool loop and expects the conversation to be sent back to
 * continue (Anthropic `stop_reason: "pause_turn"`), or declined the request
 * outright (`stop_reason: "refusal"`). Both arrive as HTTP 200 with content
 * that is typically empty or partial.
 *
 * This is a TYPED failure rather than a returned response on purpose. Left
 * untyped, an unfinished turn reads downstream as a model that produced
 * invalid JSON — scoring a protocol state as a schema failure, and inviting a
 * repair that is unrelated to what actually happened.
 *
 * Continuation is deliberately NOT implemented: each continuation is a further
 * billable request, and the per-attempt reservation the spend proof rests on
 * bounds ONE request per attempt. `maxServerToolContinuations` in the declared
 * tool config records that decision as configuration; raising it means
 * re-deriving the bound, not editing an adapter.
 *
 * The paused/refused response's own `usage` and search audit ARE carried here,
 * so the money guard prices what the call actually cost instead of escalating
 * on absent evidence.
 */
export class ProviderUnfinishedTurnError extends Error {
  readonly stopReason: string;
  readonly usage: unknown;
  readonly searchAudit: unknown;

  constructor(input: {
    provider: string;
    stopReason: string;
    detail: string;
    usage: unknown;
    searchAudit: unknown;
  }) {
    super(`${input.provider} returned an unfinished turn (stop_reason: ${input.stopReason}): ${input.detail}`);
    this.name = 'ProviderUnfinishedTurnError';
    this.stopReason = input.stopReason;
    this.usage = input.usage;
    this.searchAudit = input.searchAudit;
  }
}
