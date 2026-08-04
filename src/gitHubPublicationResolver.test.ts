import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubPublicationResolver } from './gitHubPublicationResolver.js';
import type { FetchLike } from './gitHubPublicationResolver.js';
import type { ManifestPublicationV1 } from './manifestPublication.js';

/**
 * The concrete public-Git resolver over an injected fetch: the exact URLs it hits, the
 * strict shape check on the commits endpoint, the sha-echo substitution guard, and that
 * every failure mode THROWS — `verifyPublication` turns a resolver rejection into a
 * publication refusal, so a throwing resolver is the fail-closed contract.
 */

const SHA = 'ab'.repeat(20);
const DESCRIPTOR: ManifestPublicationV1 = {
  repositoryOwner: 'ospex-org',
  repositoryName: 'ospex-benchmark',
  path: 'manifests/campaign a#1.json', // a space and a hash — each segment must be encoded
  commitSha: SHA,
};
const COMMITTED_AT = '2026-08-01T00:00:00Z';
const BLOB = Buffer.from('{"the":"manifest bytes"}', 'utf8');

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function fakeFetch(
  responses: Array<{ ok?: boolean; status?: number; json?: unknown; bytes?: Buffer; reject?: Error }>,
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected fetch: ${url}`);
    if (next.reject) throw next.reject;
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.json,
      arrayBuffer: async () => {
        const bytes = next.bytes ?? Buffer.alloc(0);
        const out = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(out).set(bytes);
        return out;
      },
      text: async () => JSON.stringify(next.json ?? ''),
    };
  };
  return { fetch, calls };
}

function commitJson(over: Record<string, unknown> = {}): unknown {
  return { sha: SHA, commit: { committer: { date: COMMITTED_AT, name: 'x' }, message: 'publish' }, extra: 1, ...over };
}

test('resolves the committer timestamp then the exact blob bytes, from the exact public URLs', async () => {
  const { fetch, calls } = fakeFetch([{ json: commitJson() }, { bytes: BLOB }]);
  const resolved = await new GitHubPublicationResolver(fetch).resolve(DESCRIPTOR);
  assert.equal(resolved.committerTimestamp, COMMITTED_AT);
  assert.ok(Buffer.from(resolved.blobBytes).equals(BLOB), 'the blob bytes are exact');
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      `https://api.github.com/repos/ospex-org/ospex-benchmark/commits/${SHA}`,
      `https://raw.githubusercontent.com/ospex-org/ospex-benchmark/${SHA}/manifests/campaign%20a%231.json`,
    ],
    'the commits endpoint, then the raw host with every path segment percent-encoded',
  );
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
