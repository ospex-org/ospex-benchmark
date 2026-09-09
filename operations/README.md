# Score-and-publish host adapter — authoring only

`score_and_publish_once.py` is the repository-owned source of the existing
one-cohort host adapter. This change supplies source and offline tests, **not an
installation or activation**. No systemd unit, timer, output directory, lock
owner, environment file, data, model, database or publication is changed by
checking in these files. The retired watch/decisions producer is not restored.

## Provenance

- Authoring base: `f4b753a31169b6df5368afa52fff7b03426bfbbb`.
- Exact installed adapter bytes were captured and byte-compared before authoring.
- Captured source SHA256:
  `3f61103ced719306cabccd4b4bb19624dd5a24d04de75ec91b6beebcfdfce490`.
- That imported adapter pinned benchmark commit
  `2fc37a870cb23c5fd33ac44517303f5e2991f363` and `scoring-v0.6.2`.

The public change is a sanitized derivative, not a verbatim import commit.
Original bytes and the installed-to-authored comparison are retained in private
operator evidence, not in newly merged public history. The hash above identifies
the captured bytes, not the modified adapter or a freshly inspected installation.

## One explicit NEW_BENCH binding

A future, separately reviewed installation must pass **all three** flags:

```text
--benchmark-checkout /absolute/canonical/NEW_BENCH
--expected-head <reviewed-full-40-character-lowercase-commit>
--expected-policy <reviewed-scoring-vMAJOR.MINOR.PATCH>
```

These are placeholders, not runnable activation instructions. Bind the exact
reviewed checkout shared by the coordinated rebuild. There is no old-checkout
fallback, environment-variable fallback, default policy or automatic adoption of
whatever HEAD happens to be present. A later merged commit needs its own explicit
reviewed HEAD binding; the authoring base is not a perpetual runtime pin.

The immutable binding is used for every child `cwd`: Git preflight, raw parent
projection, per-run score/publish, and whole-cohort coverage projection. Before
standings or raw-artifact reads, and again immediately before **each** publisher
child, the adapter checks:

1. Existing absolute canonical directory; no symlinked checkout/ancestor or `..`
   alias, and the directory must be the Git worktree root.
2. Exact full lowercase 40-hex HEAD; no abbreviations or branch-name resolution.
3. Clean tracked and untracked source. Normal ignored dependencies are permitted;
   this is not a dependency integrity verifier.
4. One literal `SCORING_POLICY_VERSION` declaration in `src/scoring.ts`, exactly
   matching the explicit policy. Unexpected declaration shape or identity stops
   rather than importing/executing TypeScript to infer it.

Keep this checkout immutable during a pass. Pre-child checks detect observed
source drift; they are not an atomic filesystem freeze or protection against a
concurrent privileged editor.

## Preserved installed behavior

- One oldest unpublished `watch-v0` cohort-day, on/after 2026-08-21 and strictly
  before today's **America/New_York** date; one-hour raw-file quiet period.
- The existing scheduler retains sole ownership. Nonblocking exclusive `flock`,
  mode 0600, and release on success/failure remain unchanged. `OSPEX_STATE_DIR`
  defaults to `~/.ospex`; output is its `decisions/out` subdirectory. An explicit
  state root overrides the home-directory default, so different host usernames
  do not redirect an explicitly configured installation.
- `OSPEX_SCORE_PUBLISH_LOCK_PATH` overrides the lock path; its generic default is
  `locks/score-publish.lock` beneath the state root. Both settings accept absolute
  paths or `~` expansion; empty/relative values fail before operational work.
  **Future cutover must explicitly bind and verify the existing output and shared
  lock paths.** Do not adopt a new default lock namespace or launch a second
  scheduler while an existing owner may run. No installed path is changed here.
- No-op still acquires the lock and reads standings/raw-directory state. It does
  not require installed dependencies or DB environment. `--dry-run` selects and
  validates without Yarn, but still acquires the lock and reads standings/data:
  **it is not the offline test command**.
- Actual publication still checks `node_modules/.bin/tsx`, `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, `BENCHMARK_DB_URL` and `PGSSLMODE=require`. The adapter does
  not load an environment file; the existing service owns environment supply.
- `/usr/bin/yarn project <all raw parents>` precedes projected-game-count readback;
  `score --run <raw> --publish` runs only for missing/stale scored metadata;
  `project:scores --scoring-run` publishes all scored files with the unchanged
  ranking arguments/reason. No invented extra CLI stage is inserted.
- Raw name/run/cohort/date checks, raw-set snapshot recheck, scored first-record
  identity/policy/integrity checks, nonzero-child STOP, and standings coverage
  readback remain intact. The adapter does not itself recompute scorecards.
- Already-published historical rows through 2026-08-31 keep operator-managed
  ranking state. Every newly published eligible cohort is ranking-open; later
  scored rows with incompatible ranking state fail closed. Standings must report
  the explicitly bound default policy, not merely accept a policy query string.
  The ranking threshold currently equals the minimum eligible cohort date: it
  is not an additional gate over selectable dates. This preserves the captured
  adapter's standing policy; this change does not approve a new ranking policy.
- `--self-test` alone needs no binding, checkout, environment, files, dependencies,
  network or lock, and prints `SELFTEST PASS ranking policy`.

## Policy and schema comparison

Comparing the old pinned benchmark commit above with authoring base `f4b753a…`:

- Both declare **`scoring-v0.6.2`**. There is no scoring-methodology version bump.
- `src/scoring.ts`, `src/scoreRun.ts`, `src/schema.ts`, `src/scoredProjection.ts`,
  `src/projectRunMain.ts`, `src/projectScoresMain.ts`, `src/servingStore.ts` and
  `src/benchmarkServingConfig.ts` are unchanged. For these scorer/projection
  contracts there are no added, removed, renamed, default-changed,
  constraint-changed or meaning-changed fields.
- Shared `src/fetchers.ts` now labels its own timeout abort as `ETIMEDOUT` with
  `syscall: read`; it also supports input-network guarding in live-input reads.
  `src/servingSchemaGate.ts` adds exemption/extension diagnostics without changing
  the gate's schema or acceptance policy. These are dependency differences to
  retain in cutover review, not a new scoring algorithm.

This is source comparison, not a claim about a live DB schema, installed
configuration, current API behavior or complete downstream runtime compatibility.

## Offline verification and held gates

The adapter and suite are Linux-only (`fcntl` is imported at module scope).
With Python 3.10+ and Git, from the repository root:

```sh
python3 -B operations/test_score_and_publish_once.py -v
env -i /usr/bin/python3 -B operations/score_and_publish_once.py --self-test
```

CI registers these as a separate stdlib-only job without a dependency install.
Tests create disposable Git/output/lock fixtures, scrub inherited environment
and Git configuration, forbid unmocked network/non-Git children, exercise a real
cross-process lock, and mock every Yarn publication. Metadata/standings fixtures
are explicitly synthetic; they prove adapter behavior, not real producer or
live publication conformance. No model, scoring algorithm or DB runs here.

Still required before any live cutover: external exact-head review on the
operator's machine; separately authorized source landing; reviewed merged HEAD
and policy shared by the rebuild; dependency/install, TypeScript typecheck/unit
and relevant schema/compatibility gates; exact installed-byte and service-argument
readback; and an explicitly authorized native first-run/publication acceptance
with real artifact/served-coverage parity. No push, PR, merge, install, runtime
repoint, service/timer operation or live test is authorized by this README.
