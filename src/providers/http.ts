import { redactAndTruncate, redactSecrets } from '../config.js';
import { ProviderHttpError, ProviderTimeoutError } from './errors.js';
import { sealResponseEnvelope } from './responseEnvelope.js';

/**
 * POST JSON with a hard timeout. Every error path is redacted before it can
 * reach a record or the console; response bodies in errors are truncated.
 * HTTP 429 is surfaced via ProviderHttpError.status so the runner can
 * classify it as rate_limited rather than a model failure.
 *
 * On success the RECEIVED BODY TEXT is returned beside the parse. Before this,
 * the text was a local that died with the call, so no adapter could retain a
 * response envelope even if it wanted to — the extractor's normalized output
 * was the only thing that survived a run, and an unrecognized shape could
 * never be re-read (#92). `bodyText` is the bytes as received: un-redacted and
 * un-canonicalized, for `sealResponseEnvelope` to bind.
 *
 * EVERY 2xx RETAINS ITS BODY. The parseable ones return it as `bodyText`; a
 * 2xx whose body does not parse as JSON carries the same sealed bytes on the
 * `ProviderHttpError` it throws, so the two are one rule rather than a
 * distinction the JSON parser happened to draw. That distinction was an
 * accident with teeth: a 200 was recorded with every content field null and
 * read downstream as "nothing came back", so the exact shape #92 exists to
 * preserve — a body no parser of the day understood — was the shape most
 * likely to be discarded. An empty 200 body follows the same rule and retains
 * an empty envelope; so does a 2xx whose JSON is not an object (a bare `42`),
 * which already returned through the parseable path.
 *
 * A NON-2XX retains nothing, deliberately and unchanged: a provider error body
 * is the likeliest place request content is echoed back, and widening
 * retention to it would put an unbounded copy of that into evidence. It keeps
 * the truncated `detail` it always had.
 */
export async function postJson(options: {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}): Promise<{ status: number; json: unknown; bodyText: string }> {
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
        redactAndTruncate(text, 2000),
      );
    }
    try {
      return { status: response.status, json: JSON.parse(text) as unknown, bodyText: text };
    } catch {
      throw new ProviderHttpError(
        options.provider,
        response.status,
        `non-JSON response body: ${redactAndTruncate(text, 500)}`,
        // The received bytes, sealed on the same terms as a parseable body.
        // The truncated detail above stays for the human reading a log; this is
        // the evidence, and it is what makes the leg a receipt rather than a
        // record that looks like silence.
        sealResponseEnvelope(text),
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
