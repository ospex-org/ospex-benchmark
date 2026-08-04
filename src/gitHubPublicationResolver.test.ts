import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubPublicationResolver } from './gitHubPublicationResolver.js';
import type { FetchLike } from './gitHubPublicationResolver.js';
import type { ManifestPublicationV1 } from './manifestPublication.js';

/**
 * The concrete public-Git resolver over an injected fetch: the exact effective URLs it
 * hits (asserted POST-normalization, not merely as constructed strings), the strict shape
 * check on the commits endpoint, the sha-echo substitution guard, the CANONICAL-PATH
 * defense of the commit pin (a `..` segment would otherwise let URL normalization collapse
 * the pinned `<sha>/` prefix into a moving ref — refused BEFORE any network request), the
 * full-exchange deadline (a body that stalls past it aborts and rejects rather than
 * hanging a scheduled tick), and the accepted-size bounds. Every failure mode THROWS —
 * `verifyPublication` turns a resolver rejection into a publication refusal, so a throwing
 * resolver is the fail-closed contract.
 */

const SHA = 'ab'.repeat(20);
const DESCRIPTOR: ManifestPublicationV1 = {
  repositoryOwner: 'ospex-org',
  repositoryName: 'ospex-benchmark',
  path: 'manifests/campaign.json',
  commitSha: SHA,
};
const COMMITTED_AT = '2026-08-01T00:00:00Z';
const BLOB = Buffer.from('{"the":"manifest bytes"}', 'utf8');

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

interface Scripted {
  ok?: boolean;
  status?: number;
  json?: unknown;
  bytes?: Buffer;
  reject?: Error;
  /** Delay body delivery by this long — unless the request signal aborts first, in which
   *  case the body read rejects immediately (mirroring undici's signal-tied body reads). */
  bodyDelayMs?: number;
}

function fakeFetch(responses: Scripted[]): { fetch: FetchLike; calls: Call[]; aborted: () => boolean } {
  const calls: Call[] = [];
  let sawAbort = false;
  const deliver = <T>(value: T, delayMs: number | undefined, signal: AbortSignal): Promise<T> => {
    if (delayMs === undefined) return Promise.resolve(value);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => resolve(value), delayMs);
      signal.addEventListener('abort', () => {
        sawAbort = true;
        clearTimeout(timer);
        reject(new Error('body read aborted by signal'));
      });
    });
  };
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected fetch: ${url}`);
    if (next.reject) throw next.reject;
    const toArrayBuffer = (bytes: Buffer): ArrayBuffer => {
      const out = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(out).set(bytes);
      return out;
    };
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      arrayBuffer: () => deliver(toArrayBuffer(next.bytes ?? Buffer.alloc(0)), next.bodyDelayMs, init.signal),
      text: () => deliver(JSON.stringify(next.json ?? ''), next.bodyDelayMs, init.signal),
    };
  };
  return { fetch, calls, aborted: () => sawAbort };
}

function commitJson(over: Record<string, unknown> = {}): unknown {
  return { sha: SHA, commit: { committer: { date: COMMITTED_AT, name: 'x' }, message: 'publish' }, extra: 1, ...over };
}

test('resolves the committer timestamp then the exact blob bytes, from the exact EFFECTIVE URLs', async () => {
  const { fetch, calls } = fakeFetch([{ json: commitJson() }, { bytes: BLOB }]);
  const resolved = await new GitHubPublicationResolver(fetch).resolve(DESCRIPTOR);
  assert.equal(resolved.committerTimestamp, COMMITTED_AT);
  assert.ok(Buffer.from(resolved.blobBytes).equals(BLOB), 'the blob bytes are exact');
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      `https://api.github.com/repos/ospex-org/ospex-benchmark/commits/${SHA}`,
      `https://raw.githubusercontent.com/ospex-org/ospex-benchmark/${SHA}/manifests/campaign.json`,
    ],
  );
  // The reviewer-required post-normalization assertion: the EFFECTIVE URL — what fetch
  // actually targets after WHATWG normalization — still carries the exact commit pin.
  assert.equal(
    new URL(calls[1]!.url).pathname,
    `/ospex-org/ospex-benchmark/${SHA}/manifests/campaign.json`,
    'URL normalization left the pinned /{owner}/{repo}/{sha}/ prefix intact',
  );
});

test('NON-CANONICAL paths are refused BEFORE any network request — the commit pin cannot be re-shaped', async () => {
  for (const path of [
    '../main/package.json', // the reviewer's reproduction: normalizes to a MOVING ref
    './package.json',
    'a/../../b', // repeated traversal
    'a/%2e%2e/b', // percent-encoded traversal variant (the % alphabet is rejected outright)
    'a\\b', // backslash ambiguity
    'a//b', // empty segment
    '/etc/passwd', // absolute
    'a/', // trailing empty segment
    'a\u0001b', // control character
    'a b/c.json', // outside the canonical alphabet
  ]) {
    const { fetch, calls } = fakeFetch([]);
    await assert.rejects(
      () => new GitHubPublicationResolver(fetch).resolve({ ...DESCRIPTOR, path }),
      /non-canonical publication path/,
      path,
    );
    assert.equal(calls.length, 0, `${path}: refused with ZERO network requests`);
  }
});

test('the deadline covers COMMIT-JSON body consumption: a stalled body aborts and rejects', async () => {
  const { fetch, aborted } = fakeFetch([{ json: commitJson(), bodyDelayMs: 300 }]);
  await assert.rejects(
    () => new GitHubPublicationResolver(fetch, { timeoutMs: 25 }).resolve(DESCRIPTOR),
    /aborted/,
    'the body read rejects instead of the resolver hanging or succeeding late',
  );
  assert.equal(aborted(), true, 'the abort signal actually fired during the body read');
});

test('the deadline covers BLOB body consumption: a stalled byte stream aborts and rejects', async () => {
  const { fetch, aborted } = fakeFetch([{ json: commitJson() }, { bytes: BLOB, bodyDelayMs: 300 }]);
  await assert.rejects(() => new GitHubPublicationResolver(fetch, { timeoutMs: 25 }).resolve(DESCRIPTOR), /aborted/);
  assert.equal(aborted(), true);
});

test('the deadline covers NON-OK error text: a stalled error body still refuses with the status, having aborted the read', async () => {
  const { fetch, aborted } = fakeFetch([{ ok: false, status: 503, json: { message: 'slow error' }, bodyDelayMs: 300 }]);
  await assert.rejects(
    () => new GitHubPublicationResolver(fetch, { timeoutMs: 25 }).resolve(DESCRIPTOR),
    /HTTP 503/,
    'the refusal names the status even when the error body never arrives',
  );
  assert.equal(aborted(), true, 'the error-text read was abandoned at the deadline, not awaited forever');
});

test('accepted-size bounds: an oversized commit response and an oversized blob each refuse', async () => {
  const hugeJson = fakeFetch([{ json: { pad: 'x'.repeat(5 * 1024 * 1024 + 1), ...(commitJson() as object) } }]);
  await assert.rejects(() => new GitHubPublicationResolver(hugeJson.fetch).resolve(DESCRIPTOR), /exceeds the accepted size bound/);

  const hugeBlob = fakeFetch([{ json: commitJson() }, { bytes: Buffer.alloc(1024 * 1024 + 1) }]);
  await assert.rejects(() => new GitHubPublicationResolver(hugeBlob.fetch).resolve(DESCRIPTOR), /exceeds the accepted size bound/);
});

test('a non-OK commit response throws with the status — never a silent pass', async () => {
  const { fetch } = fakeFetch([{ ok: false, status: 404, json: { message: 'Not Found' } }]);
  await assert.rejects(() => new GitHubPublicationResolver(fetch).resolve(DESCRIPTOR), /HTTP 404/);
});

test('a malformed commit response shape throws: missing committer date, offset-less date, non-object', async () => {
  for (const bad of [
    commitJson({ commit: { committer: {} } }),
    commitJson({ commit: { committer: { date: '2026-08-01T00:00:00' } } }), // no offset
    'not an object',
  ]) {
    const { fetch } = fakeFetch([{ json: bad }]);
    await assert.rejects(
      () => new GitHubPublicationResolver(fetch).resolve(DESCRIPTOR),
      /not the expected shape/,
      JSON.stringify(bad).slice(0, 60),
    );
  }
});

test('a commit endpoint that resolves a DIFFERENT sha than requested throws — the substitution guard', async () => {
  const { fetch } = fakeFetch([{ json: commitJson({ sha: 'cd'.repeat(20) }) }]);
  await assert.rejects(() => new GitHubPublicationResolver(fetch).resolve(DESCRIPTOR), /not the requested/);
});

test('a non-OK blob response throws after a good commit response', async () => {
  const { fetch } = fakeFetch([{ json: commitJson() }, { ok: false, status: 404, json: { message: 'Not Found' } }]);
  await assert.rejects(() => new GitHubPublicationResolver(fetch).resolve(DESCRIPTOR), /HTTP 404/);
});

test('a fetch rejection propagates — an unresolvable precommitment must never read as resolved', async () => {
  const { fetch } = fakeFetch([{ reject: new Error('getaddrinfo ENOTFOUND api.github.com') }]);
  await assert.rejects(() => new GitHubPublicationResolver(fetch).resolve(DESCRIPTOR), /ENOTFOUND/);
});
