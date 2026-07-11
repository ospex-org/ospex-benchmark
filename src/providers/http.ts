import { redactSecrets } from '../config.js';
import { ProviderHttpError, ProviderTimeoutError } from './errors.js';

/**
 * POST JSON with a hard timeout. Every error path is redacted before it can
 * reach a record or the console; response bodies in errors are truncated.
 */
export async function postJson(options: {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}): Promise<unknown> {
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
    const text = await response.text();
    if (!response.ok) {
      throw new ProviderHttpError(
        options.provider,
        response.status,
        redactSecrets(text.slice(0, 2000)),
      );
    }
    try {
      return JSON.parse(text) as unknown;
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
