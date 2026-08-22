import { redactAndTruncate, redactSecrets } from '../config.js';
import {
  ProviderHttpError,
  ProviderTimeoutError,
  ProviderUnfinishedTurnError,
  ProviderUnreadableResponseError,
} from './errors.js';
import { sealResponseEnvelope } from './responseEnvelope.js';
import type { ProviderResponseEnvelope } from '../types.js';

/** One provider request, as every adapter states it. */
export interface ProviderRequest {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}

/** What an adapter's extractor is handed: the parse, the status it arrived
 *  with, and the bytes already sealed. */
export interface ReceivedResponse {
  /**
   * The parsed body. `unknown` rather than an object type on purpose —
   * `JSON.parse` accepts `null`, numbers, strings and arrays, and every
   * adapter's extractor casts this to the shape its provider documents. The
   * cast is a claim about a remote system, which is why the read below is
   * guarded.
   */
  readonly json: unknown;
  readonly status: number;
  readonly responseEnvelope: ProviderResponseEnvelope;
}

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
 * A 2xx RETAINS ITS BODY WHATEVER THE BODY TURNED OUT TO BE — including an
 * empty one, which retains an empty envelope. The parseable bodies return here
 * as `bodyText` for `postJsonAndRead` to seal; a 2xx whose bytes are not JSON
 * at all carries the same sealed bytes on the `ProviderHttpError` it throws,
 * so the two are one rule rather than a distinction the JSON parser happened
 * to draw. That distinction was an accident with teeth: a 200 was recorded
 * with every content field null and read downstream as "nothing came back", so
 * the exact shape #92 exists to preserve — a body no parser of the day
 * understood — was the shape most likely to be discarded.
 *
 * Retaining the bytes here is only half of it, and the half that is easy to
 * get wrong is the other one: an adapter still has to survive READING them.
 * `postJsonAndRead` owns that, and the reason the parse is handed over rather
 * than returned is that a body which parses can still be a shape no extractor
 * can walk.
 *
 * A NON-2XX retains nothing, deliberately and unchanged: a provider error body
 * is the likeliest place request content is echoed back, and widening
 * retention to it would put an unbounded copy of that into evidence. It keeps
 * the truncated `detail` it always had.
 *
 * A BODY THAT WAS NEVER READ reports status 0, not the status on the headers.
 * `fetch` resolves at the headers, so a connection can drop mid-body; that is
 * a transport failure that happens to have seen a status line, and calling it
 * a 2xx would make it a receipt owing an envelope no code could produce —
 * refusing an untampered run file over an ordinary network event.
 *
 * NOT EXPORTED. `postJsonAndRead` is the only way to a parsed body, because
 * sealing the envelope and reading the parse have to happen under one guard —
 * see that function.
 */
async function postJson(options: ProviderRequest): Promise<{
  status: number;
  json: unknown;
  bodyText: string;
}> {
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
        // STATUS 0 — the same "no HTTP exchange completed" code the
        // fetch-failure branch above reports, and not the status on the
        // headers. A body that was never read is not a receipt: reporting
        // `response.status` here would make an ordinary dropped connection a
        // 2xx that owes an envelope which cannot exist, and one such leg
        // refuses the whole run file for scoring and for publication. Nothing
        // is retained on this path because there is nothing to retain.
        0,
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

/**
 * Send one provider request and READ its response under a single guard.
 *
 * This is the only exported way to a parsed provider body, and that is the
 * design rather than a convenience. Each adapter used to call `postJson`, seal
 * the envelope itself, cast the parse to its provider's shape and dereference
 * it — four sites, so the guarantee "a 2xx keeps its bytes" was four separate
 * properties and a fifth adapter would have started life without any of them.
 * Sealing and reading now happen here, once, and an adapter cannot obtain a
 * parse it has not routed through this catch.
 *
 * ANY throw out of `read` becomes `ProviderUnreadableResponseError`, carrying
 * the sealed envelope and the status the body arrived with. That is the whole
 * fix: a `TypeError` from walking an unexpected shape used to escape untyped,
 * and the runner — which recognizes only the provider error types — discarded
 * the envelope and the status with it, persisting a leg that read as a call
 * that never landed.
 *
 * `ProviderUnfinishedTurnError` passes through unchanged: an extractor raises
 * it deliberately, having already read the provider's own terminal state, and
 * it carries this same envelope and status by construction.
 *
 * The result is AWAITED inside the try, so a `read` that returns a promise is
 * covered on the same terms as a synchronous one; every current extractor is
 * synchronous and nothing here requires that to stay true.
 */
export async function postJsonAndRead<T>(
  request: ProviderRequest,
  read: (received: ReceivedResponse) => T | Promise<T>,
): Promise<T> {
  const { status, json, bodyText } = await postJson(request);
  // The complete body, retained as received: every later re-extraction of this
  // call's search audit reads THIS, not the normalized result the reader
  // returns. Sealed BEFORE the read, so the bytes survive a read that throws.
  const responseEnvelope = sealResponseEnvelope(bodyText);
  try {
    return await read({ json, status, responseEnvelope });
  } catch (error) {
    if (error instanceof ProviderUnfinishedTurnError) throw error;
    throw new ProviderUnreadableResponseError({
      provider: request.provider,
      httpStatus: status,
      responseEnvelope,
      detail: `the response body is JSON, and this build's ${request.provider} extractor could not read it: ${redactAndTruncate(
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        300,
      )}`,
    });
  }
}
