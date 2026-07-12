import { redactSecrets } from '../config.js';
import { ProviderHttpError, ProviderTimeoutError } from './errors.js';

/**
 * POST JSON with a hard timeout. Every error path is redacted before it can
 * reach a record or the console; response bodies in errors are truncated.
 * HTTP 429 is surfaced via ProviderHttpError.status so the runner can
 * classify it as rate_limited rather than a model failure.
 */
export async function postJson(options: {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProviderTimeoutError(options.provider, options.timeoutMs);
      }
      throw new ProviderHttpError(
        options.provider,
        0,
        redactSecrets(error instanceof Error ? error.message : String(error)),
      );
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // fetch() resolves at headers; the abort timer can fire mid-body-read.
      if (controller.signal.aborted) {
        throw new ProviderTimeoutError(options.provider, options.timeoutMs);
      }
      throw new ProviderHttpError(
        options.provider,
        response.status,
        `response body read failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      );
    }
    if (!response.ok) {
      throw new ProviderHttpError(
        options.provider,
        response.status,
        redactSecrets(text.slice(0, 2000)),
      );
    }
    try {
      return { status: response.status, json: JSON.parse(text) as unknown };
    } catch {
      throw new ProviderHttpError(
        options.provider,
        response.status,
        `non-JSON response body: ${redactSecrets(text.slice(0, 500))}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
