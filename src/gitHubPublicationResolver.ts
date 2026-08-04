import { z } from 'zod';
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
 * Fail-closed throughout: a non-OK response, a shape violation, a missing committer
 * timestamp, or a timeout THROWS — and `verifyPublication` converts any resolver rejection
 * into a publication refusal. An unresolvable precommitment must never run.
 *
 * The repositories this resolves against are PUBLIC by definition (that is the point of
 * the precommitment), so no token is sent. The unauthenticated GitHub API rate limit
 * (60/hour per address) comfortably covers a scheduled tick cadence; a limit response is a
 * non-OK status and therefore a refusal, never a silent pass.
 *
 * `fetchImpl` is injectable so every failure mode is unit-testable without a network; the
 * default is the platform `fetch`.
 */

const RESOLVE_TIMEOUT_MS = 30_000;

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
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

/** Encode a repo-relative path segment-by-segment, so a path may contain `/` but each
 *  segment is percent-encoded (spaces, `#`, `?` cannot re-shape the URL). */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function fetchOk(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
): Promise<Awaited<ReturnType<FetchLike>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`GET ${url} failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export class GitHubPublicationResolver implements PublicationResolver {
  constructor(private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  async resolve(publication: ManifestPublicationV1): Promise<ResolvedPublication> {
    const { repositoryOwner, repositoryName, path, commitSha } = publication;
    const owner = encodeURIComponent(repositoryOwner);
    const repo = encodeURIComponent(repositoryName);

    // (1) The commit's committer timestamp, strictly shape-checked. The response echoes the
    // resolved sha; require it to EQUAL the requested one, so a host that resolved a short
    // or moved ref can never substitute a different commit's timestamp.
    const commitUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}`;
    const commitResponse = await fetchOk(this.fetchImpl, commitUrl, {
      accept: 'application/vnd.github+json',
      'user-agent': 'ospex-benchmark-publication-resolver',
    });
    const parsed = commitResponseSchema.safeParse(await commitResponse.json());
    if (!parsed.success) {
      throw new Error(`commit response for ${commitSha} is not the expected shape: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    }
    if (parsed.data.sha !== commitSha) {
      throw new Error(`commit endpoint resolved ${parsed.data.sha}, not the requested ${commitSha}`);
    }

    // (2) The exact blob bytes at (commitSha, path) — raw bytes, never a decoded string.
    const blobUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${encodePath(path)}`;
    const blobResponse = await fetchOk(this.fetchImpl, blobUrl, {
      accept: 'application/octet-stream',
      'user-agent': 'ospex-benchmark-publication-resolver',
    });
    const blobBytes = new Uint8Array(await blobResponse.arrayBuffer());

    return { blobBytes, committerTimestamp: parsed.data.commit.committer.date };
  }
}
