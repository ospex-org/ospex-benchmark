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
