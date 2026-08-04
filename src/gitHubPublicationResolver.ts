import { z } from 'zod';
import { publicationPathViolation } from './manifestPublication.js';
import type { ManifestPublicationV1, PublicationResolver, ResolvedPublication } from './manifestPublication.js';

/**
 * The concrete PUBLIC-GIT resolver for manifest precommitments — the network half that
 * `manifestPublication.ts` deliberately leaves injected. Given a strict descriptor
 * (owner, repo, path, full 40-hex commit SHA), it resolves from the public GitHub surface:
 *
 *   1. the commit's COMMITTER timestamp, from the REST commits endpoint
 *      (`api.github.com/repos/{owner}/{repo}/commits/{sha}`), strictly shape-checked; and
 *   2. the EXACT blob bytes at `(commitSha, path)`, from the raw content host
 *      (`raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}`), read as raw bytes —
 *      never a decoded string — so the byte-equality check downstream compares what was
 *      actually published.
 *
 * The commit PIN is defended twice before any raw fetch: the path must be CANONICAL
 * (`publicationPathViolation` — no dot segments, no absolute form, no backslash/control/
 * percent ambiguity; a `..` segment would otherwise let WHATWG URL normalization collapse
 * `<sha>/../ref/…` into a MOVING-ref URL, removing the pin), and the effective NORMALIZED
 * URL is asserted to still carry the exact `/{owner}/{repo}/{commitSha}/` prefix — the
 * post-normalization check, not merely the pre-normalization string.
 *
 * Fail-closed and BOUNDED throughout: the deadline covers the FULL exchange — headers and
 * complete body consumption (commit JSON, blob bytes, and non-OK error text alike), so a
 * stalled body is a refusal, never a hang — and accepted response sizes are capped. A
 * non-OK response, a shape violation, a missing committer timestamp, an oversized body, or
 * a timeout THROWS, and `verifyPublication` converts any resolver rejection into a
 * publication refusal. An unresolvable precommitment must never run.
 *
 * The repositories this resolves against are PUBLIC by definition (that is the point of
 * the precommitment), so no token is sent. The unauthenticated GitHub API rate limit
 * (60/hour per address) comfortably covers a scheduled tick cadence; a limit response is a
 * non-OK status and therefore a refusal, never a silent pass.
 *
 * `fetchImpl` and `timeoutMs` are injectable so every failure mode — including a body that
 * stalls past the deadline — is unit-testable without a network.
 */

const RESOLVE_TIMEOUT_MS = 30_000;

/** Accepted-size bounds. The commits endpoint can carry per-file patch text for large
 *  commits (hence the wider bound, measured in string length — this ASCII-dominant API is
 *  ≈1 byte per unit); a campaign manifest is a few KB, so 1 MiB is deep headroom. Together
 *  with the deadline these bound both what is accepted and how long it may take. */
const MAX_COMMIT_JSON_CHARS = 5 * 1024 * 1024;
const MAX_BLOB_BYTES = 1024 * 1024;

/** The commits endpoint fields this resolver reads — everything else is ignored. The
 *  COMMITTER date (not the author date) is the instant the commit object entered history,
 *  which is what the before-windowStart rule reasons about. */
const commitResponseSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    commit: z.object({
      committer: z.object({ date: z.string().datetime({ offset: true }) }).passthrough(),
    }).passthrough(),
  })
  .passthrough();

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export interface GitHubPublicationResolverOptions {
  /** The FULL-exchange deadline (headers AND body) per request. Injectable for tests. */
  readonly timeoutMs?: number;
}

/** Encode a repo-relative path segment-by-segment. Under the canonical-path rule this is
 *  an identity mapping (the allowed alphabet is unreserved); it stays as a belt so a rule
 *  relaxation can never silently produce a URL-significant character. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export class GitHubPublicationResolver implements PublicationResolver {
  private readonly timeoutMs: number;
  constructor(
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    options: GitHubPublicationResolverOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? RESOLVE_TIMEOUT_MS;
  }

  /** One request under ONE deadline covering headers and complete body consumption: the
   *  abort timer stays armed until `read` has fully consumed the response, so a body that
   *  stalls or trickles past the deadline aborts and rejects rather than hanging a
   *  scheduled tick. Non-OK error text is read inside the same window. */
  private async fetchWithinDeadline<T>(
    url: string,
    headers: Record<string, string>,
    read: (response: Awaited<ReturnType<FetchLike>>) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { headers, signal: controller.signal });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`GET ${url} failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
      }
      return await read(response);
    } finally {
      clearTimeout(timer);
    }
  }

  async resolve(publication: ManifestPublicationV1): Promise<ResolvedPublication> {
    const { repositoryOwner, repositoryName, path, commitSha } = publication;

    // The commit pin's first defense, BEFORE any network request: only a canonical
    // repository-relative path may form a URL. (The descriptor schema already enforces
    // this for every parsed descriptor; re-asserting here keeps the resolver safe even
    // for a hand-constructed input.)
    const violation = publicationPathViolation(path);
    if (violation !== null) {
      throw new Error(`refusing to resolve a non-canonical publication path: ${violation}`);
    }

    const owner = encodeURIComponent(repositoryOwner);
    const repo = encodeURIComponent(repositoryName);
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'ospex-benchmark-publication-resolver',
    };

    // (1) The commit's committer timestamp, strictly shape-checked and size-bounded. The
    // response echoes the resolved sha; require it to EQUAL the requested one, so a host
    // that resolved a short or moved ref can never substitute a different commit's
    // timestamp.
    const commitUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}`;
    const commitText = await this.fetchWithinDeadline(commitUrl, headers, (response) => response.text());
    if (commitText.length > MAX_COMMIT_JSON_CHARS) {
      throw new Error(`commit response for ${commitSha} exceeds the accepted size bound (${commitText.length} chars)`);
    }
    let commitJson: unknown;
    try {
      commitJson = JSON.parse(commitText);
    } catch {
      throw new Error(`commit response for ${commitSha} is not JSON`);
    }
    const parsed = commitResponseSchema.safeParse(commitJson);
    if (!parsed.success) {
      throw new Error(
        `commit response for ${commitSha} is not the expected shape: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      );
    }
    if (parsed.data.sha !== commitSha) {
      throw new Error(`commit endpoint resolved ${parsed.data.sha}, not the requested ${commitSha}`);
    }

    // (2) The exact blob bytes at (commitSha, path) — raw bytes, size-bounded. The commit
    // pin's second defense: the EFFECTIVE, NORMALIZED URL must still carry the exact
    // `/{owner}/{repo}/{commitSha}/` prefix — the post-normalization check, so a path that
    // slipped the canonical rule could still never re-shape the pinned prefix.
    const encodedPath = encodePath(path);
    const blobUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${encodedPath}`;
    const expectedPathname = `/${owner}/${repo}/${commitSha}/${encodedPath}`;
    if (new URL(blobUrl).pathname !== expectedPathname) {
      throw new Error('URL canonicalization altered the pinned blob path — refusing to resolve');
    }
    const blobBytes = new Uint8Array(
      await this.fetchWithinDeadline(blobUrl, { ...headers, accept: 'application/octet-stream' }, (response) =>
        response.arrayBuffer(),
      ),
    );
    if (blobBytes.byteLength > MAX_BLOB_BYTES) {
      throw new Error(`published blob at ${path} exceeds the accepted size bound (${blobBytes.byteLength} bytes)`);
    }

    return { blobBytes, committerTimestamp: parsed.data.commit.committer.date };
  }
}
