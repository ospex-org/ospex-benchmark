import { z } from 'zod';
import { deepFreeze } from './freeze.js';
import { cohortId, parseManifest } from './manifest.js';

/**
 * Public-Git precommitment verification (SPEC-line-open-evidence-model.md §2,
 * "Public-Git precommitment"; case 17). The canonical invocation supplies a
 * publication descriptor OUTSIDE the hashed manifest naming the exact public
 * commit the manifest was published at; before any provider request the runner
 * resolves that commit and refuses to run unless:
 *
 *   - the resolved blob bytes EQUAL the local manifest file bytes (raw bytes,
 *     not just the same canonical form);
 *   - the manifest parsed from the blob recomputes the SAME `cohortId` as the
 *     local manifest; and
 *   - the commit's committer timestamp is STRICTLY BEFORE `windowStart`.
 *
 * The limitation is stated precisely: a Git committer timestamp is
 * operator-selectable and does NOT prove first public visibility. This guards
 * against an accidental late or mismatched manifest; "committed and pushed to
 * public Git before windowStart" stays an operator covenant in Tier 0, not an
 * adversarial timestamp. No on-chain anchoring in Tier 0.
 *
 * The resolve step (network / Git host) is INJECTED as a `PublicationResolver`,
 * so the verification here is pure and fixture-testable; the concrete resolver
 * that reaches a public Git host is wired by the CLI/runtime slice.
 */

// A full immutable commit SHA — never a branch or tag — as lowercase 40-hex.
const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

// An ISO-8601 instant with an explicit offset (`Z` or `+/-hh:mm`). Used to guard
// the committer timestamp before comparing it to windowStart: an offset-less
// string would be read by Date.parse in the runner's LOCAL zone and compared
// against a UTC windowStart, making the verdict host-timezone-dependent. This
// mirrors the rigor manifest.ts applies to windowStart itself.
const offsetDateTime = z.string().datetime({ offset: true });

export const manifestPublicationV1Schema = z
  .object({
    repositoryOwner: z.string().min(1),
    repositoryName: z.string().min(1),
    path: z.string().min(1),
    commitSha: commitShaSchema,
  })
  .strict();

export type ManifestPublicationV1 = z.infer<typeof manifestPublicationV1Schema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 20)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Strictly parse a raw publication descriptor, throwing on any structural
 *  violation (unknown field, missing field, or a non-40-hex commitSha). */
export function parseManifestPublication(raw: unknown): ManifestPublicationV1 {
  const result = manifestPublicationV1Schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`invalid manifest publication descriptor: ${formatIssues(result.error)}`);
  }
  return result.data;
}

/**
 * What the injected resolver returns: the exact blob bytes at `(commitSha, path)`
 * and the resolved commit's committer timestamp. The timestamp MUST be an ISO-8601
 * instant with an explicit offset (`Z` or `+/-hh:mm`) — an offset-less value is
 * rejected, because it would otherwise be read in the runner's local zone. Git
 * commit timestamps are second-granularity.
 */
export interface ResolvedPublication {
  blobBytes: string;
  committerTimestamp: string;
}

/**
 * Resolves the exact `(commitSha, path)` blob bytes and the commit's committer
 * timestamp from a PUBLIC Git host. Implemented by the CLI/runtime slice (network
 * I/O); injected here so verification stays pure. `resolve` MUST reject if the
 * commit or path cannot be resolved — an unresolvable precommitment fails the run.
 */
export interface PublicationResolver {
  resolve(publication: ManifestPublicationV1): Promise<ResolvedPublication>;
}

/**
 * The verified precommitment record persisted in every fire and cohort artifact
 * (§2 step 6): the descriptor plus the observed committer timestamp. Deep-frozen
 * so the persisted evidence cannot drift after verification.
 */
export interface PublicationVerified {
  readonly publication: ManifestPublicationV1;
  readonly committerTimestamp: string;
}

/** A precommitment refusal carrying the exact reasons, mirroring
 *  `CohortBootError` / the `validateManifestAgainstCode` violations shape. */
export class PublicationError extends Error {
  readonly violations: readonly string[];
  constructor(message: string, violations: readonly string[]) {
    super(message);
    this.name = 'PublicationError';
    this.violations = violations;
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CheckPublicationInput {
  /** The exact bytes of the local manifest file the cohort is running from. */
  localManifestBytes: string;
  publication: ManifestPublicationV1;
  /** The already-resolved public blob + committer timestamp (from the resolver). */
  resolved: ResolvedPublication;
}

/**
 * The pure verification core (§2 steps 3-6). Self-contained: it re-derives the
 * local `windowStart` and `cohortId` from `localManifestBytes`, so it does not
 * depend on a possibly-inconsistent pre-booted object — passing the SAME bytes
 * that booted the cohort binds this check to the running cohortId. Accumulates
 * every violation into one `PublicationError`; returns the frozen verified record
 * on success.
 */
export function checkPublication(input: CheckPublicationInput): PublicationVerified {
  const { localManifestBytes, resolved } = input;
  const violations: string[] = [];

  // Re-validate the descriptor defensively (mirroring cohortId's re-parse and the
  // local/blob re-parse below): a caller that reached here through an `as` cast
  // must not be able to persist a non-canonical descriptor — e.g. a branch-name
  // commitSha — into the step-6 evidence.
  const descriptor = manifestPublicationV1Schema.safeParse(input.publication);
  if (!descriptor.success) {
    violations.push(`publication descriptor is invalid: ${formatIssues(descriptor.error)}`);
  }

  // Re-derive the local manifest's windowStart + cohortId (defensive: this module
  // is self-contained even though the cohort normally booted from the same bytes).
  let localWindowStart: string | undefined;
  let localCohortId: string | undefined;
  try {
    const local = parseManifest(JSON.parse(localManifestBytes));
    localWindowStart = local.windowStart;
    localCohortId = cohortId(local);
  } catch (error) {
    violations.push(`local manifest is not a valid manifest: ${reasonOf(error)}`);
  }

  // (3) Raw byte equality — stricter than cohortId: the committed file must be
  //     byte-identical to the file being run, not merely canonically equivalent.
  //     Both sides are the file's UTF-8 text; the resolver must decode the blob
  //     with the same encoding used to read the local file.
  if (resolved.blobBytes !== localManifestBytes) {
    violations.push('published blob bytes differ from the local manifest bytes');
  }

  // (4) Recomputed cohortId match — parse the blob independently; a blob that is
  //     a valid manifest but a DIFFERENT cohort is caught here even if step 3
  //     were ever relaxed.
  let blobCohortId: string | undefined;
  try {
    blobCohortId = cohortId(parseManifest(JSON.parse(resolved.blobBytes)));
  } catch (error) {
    violations.push(`published blob is not a valid manifest: ${reasonOf(error)}`);
  }
  if (localCohortId !== undefined && blobCohortId !== undefined && blobCohortId !== localCohortId) {
    violations.push(`published cohortId ${blobCohortId} != local cohortId ${localCohortId}`);
  }

  // (5) Committer timestamp strictly before windowStart. The timestamp must carry
  //     an explicit offset (Z or +/-hh:mm) — an offset-less string would be read by
  //     Date.parse in the runner's LOCAL zone and compared against a UTC
  //     windowStart, making the verdict host-timezone-dependent; reject it (fail
  //     closed) with the same rigor the manifest applies to windowStart. Equal is
  //     NOT before — refuse. Git timestamps are whole seconds and Date.parse floors
  //     windowStart to ms (the fail-closed direction), so ms precision is lossless.
  if (!offsetDateTime.safeParse(resolved.committerTimestamp).success) {
    violations.push(
      `committer timestamp "${resolved.committerTimestamp}" must be an ISO-8601 instant with an explicit offset (Z or +/-hh:mm)`,
    );
  } else if (
    localWindowStart !== undefined &&
    !(Date.parse(resolved.committerTimestamp) < Date.parse(localWindowStart))
  ) {
    violations.push(
      `committer timestamp ${resolved.committerTimestamp} is not strictly before windowStart ${localWindowStart}`,
    );
  }

  if (violations.length > 0) {
    throw new PublicationError(`public-Git precommitment failed: ${violations.join('; ')}`, violations);
  }

  // (6) The record persisted in every fire and cohort artifact. `descriptor.success`
  //     is necessarily true here (any failure pushed a violation and threw above).
  return deepFreeze({
    publication: descriptor.success ? descriptor.data : input.publication,
    committerTimestamp: resolved.committerTimestamp,
  });
}

export interface VerifyPublicationInput {
  localManifestBytes: string;
  publication: ManifestPublicationV1;
  resolver: PublicationResolver;
}

/**
 * Resolve the public commit (§2 steps 1-2) via the injected resolver, then run
 * the pure `checkPublication` (steps 3-6). A resolver rejection is itself a
 * refusal — an unresolvable precommitment must never run.
 */
export async function verifyPublication(input: VerifyPublicationInput): Promise<PublicationVerified> {
  const { localManifestBytes, publication, resolver } = input;
  let resolved: ResolvedPublication;
  try {
    resolved = await resolver.resolve(publication);
  } catch (error) {
    const reason = reasonOf(error);
    throw new PublicationError(
      `could not resolve public commit ${publication.commitSha} ` +
        `(${publication.repositoryOwner}/${publication.repositoryName}:${publication.path}): ${reason}`,
      [`resolve failed: ${reason}`],
    );
  }
  return checkPublication({ localManifestBytes, publication, resolved });
}
