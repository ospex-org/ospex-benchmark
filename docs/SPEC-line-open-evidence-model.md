# SPEC — line-open runner: the Tier-0 evidence & measurement model

Status: **PR 0 (spec-only), Tier 0.** Target repo: `ospex-benchmark`. Companion to
`SPEC-line-open-speculation-runner.md` (base spec, committed alongside).

## 0. What Tier 0 is (and what it is not)

**The question Tier 0 answers:**

> Among markets we captured cleanly at their independently-derived opening line, which
> model produced the best closing-line value (CLV)?

Tier 0 is a **statistical instrument with transparent coverage**, not an adversarial
consensus/publication protocol. It fires per-market at the open, records each model's
forecast, captures the close, and reports CLV **with** its coverage, sample size, and
uncertainty. Imperfection is **measured and reported**, not structurally forbidden.

**Retained protections (mandatory).**
1. Each `(gameId, market)` is an independent firing unit.
2. A ready market never waits for a sibling market.
3. Entry timing and the opening quote are checked against `source=jsonodds`
   `odds_history`.
4. Every fire is bound to its own opening quote and scoped market set.
5. A speculation fires **at most once**; duplicate billing and duplicate scoring are
   structural errors.
6. The model/prompt/tool/sampling configuration is frozen for the cohort.
7. Every expected model arm has **exactly one** visible outcome for every fire; failed
   arms cannot be deleted from the denominator.
8. Fired artifacts cannot be silently deleted without reducing independently-derived
   coverage.
9. Coverage, response completion, close availability, sample size, uncertainty, and
   caveats are published **beside** CLV.
10. Paid live execution is staged, explicitly confirmed, and budget-bounded.

**Deliberately deferred to a later adversarial tier** (do not build in Tier 0): the
frozen `games` census and MVCC census builder; per-fire negative-space denominators,
`denominatorSha256`, and `fire_coverage_snapshot`; the `schedule_changed` opening gate;
whole-cohort `canonical-unranked`/salvage poisoning for operational misses; on-chain
Polygon anchoring (post-cohort roots, finality, reorg, sender rules); append-only
schedule history; scheduled-game census completeness; and any binary public-quality
gate.

**Coverage is reported, not poisoning.** Missing two markets operationally does not
discard 40 clean, independently-verified fires. Reserve structural failure for
malformed / duplicated / internally-inconsistent **fired** artifacts, never for an
honestly-reported market that simply never fired.

**Upgrade triggers** (revisit the deferred adversarial controls only when one holds):
the benchmark is marketed as an adversarial public leaderboard; outside agents submit
competing results; money/rewards/protocol-admission/reputation depend on the result; or
a third-party audit requires independently-timestamped publication. Even then, global
coverage stays derived from `odds_history` — a later tier must **not** reintroduce a
per-fire self-reported coverage denominator.

## 1. Ground truth: `odds_history`

`odds_history` is the independent source for both the measurable universe and the
opening/as-of quotes. It is append-only; PK is a surrogate `id`; the writer appends a
row only on a real price/line change (**change-based**), and only when a market is
**two-sided-valid** (one-sided tuples are dropped before the write). Each row carries
`line, away_odds_american, away_odds_decimal, home_odds_american, home_odds_decimal`,
`source ∈ {jsonodds, sportspage_open}`, and a `captured_at` the writer stamps via
`toISOString()` (**millisecond** precision). **All detection/opener/as-of derivations
filter `source = jsonodds`** (the live feed the runner detects from).

Two derivations, both with an explicit `id` tiebreak (equal-ms rows otherwise resolve
server-arbitrarily):
- **First two-sided appearance** of a pair, under a frozen scoring watermark:
  `earliest source=jsonodds row ordered by (captured_at ASC, id ASC)`.
- **As-of quote** at instant `t`:
  `greatest captured_at ≤ t ordered by (captured_at DESC, id DESC), limit 1` — the exact
  live two-sided price at `t` (change-based ⇒ exact).

Comparisons are inclusive and at **millisecond** precision (the writer stamps ms; the
column is µs-capable but never exercised sub-ms). The committed cross-host allowance is
`maxClockSkewMs`; a boundary genuinely ambiguous under it is UNKNOWN, never silently
reclassified.

`odds_history` has **neither a `sport`/`league` nor a `network` column** — it cannot,
alone, decide which sport a pair belongs to. **Sport classification comes from a `games`
identity join at finalization** (`games.sport`, §6), never from a scheduled-game census.
(`games.league` is a nullable column the writer persists as `null`; it is **not** a Tier-0
policy dimension — `games.sport` is the stable `NOT NULL` slug, e.g. `"mlb"`.)

## 2. The precommitted manifest (no census)

The manifest contains **no game census**. It precommits only the parameters that can
change the statistical sample, provider completion probability, or scoring output. It is
one strict schema: **unknown fields fail parsing**, and **no credential or secret may
appear in it**.

### `CohortManifestV1`

```
CohortManifestV1 {
  artifactSchemaVersion,

  // Source / statistical scope
  network,                         // e.g. "polygon"; needed for the games/closing_lines joins
  sportAllowList,                  // e.g. ["mlb"]; matches games.sport slugs (NOT games.league)
  windowStart, windowEnd,          // the precommitted opener-observation window [start, end)
  source: "jsonodds",
  sourceQueryVersion,              // versions validTwoSidedHistoryRowV1 (§6) + the as-of query
  marketPolicyVersion, marketPolicyDigest,   // enabled (sport, market) allow-list

  // Model-facing configuration
  promptScaffoldSha256,
  expectedArmRoster: [
    { participantId, provider, requestedModelId, approvedReportedModelIds }
  ],
  toolInferenceConfigSha256,       // tool permissions + sampling/inference config
  baselinePolicyVersion,
  repairPolicyVersion,
  scoringPolicyVersion,
  uncertaintyPolicyVersion,
  modelPriceTableVersion, modelPriceTableDigest,
  spendReservationPolicyVersion,   // fixed-attempt spend-reservation policy (no digest — the scalar is in constants)
  runnerCommitSha,

  constants: {
    pollIntervalMs:            30_000,   // must be < cleanEntryWindowMs
    cleanEntryWindowMs:        120_000,  // = W
    gameDiscoveryWindowHours:  168,      // GET /v1/games discovery horizon; does NOT define U
    maxClockSkewMs:            5_000,
    freshFireMs:               30_000,
    maxDispatchLagMs:          10_000,
    historyReadTimeoutMs:      30_000,
    providerCallTimeoutMs:     300_000,
    maxOutputTokens:           16_000,
    maxRepairAttemptsPerArm:   1,
    providerAttemptReservationUsdMicros: 100_000_000,  // fixed per-provider-HTTP-attempt spend reservation ($100)
    ingestionGraceMs:          900_000,
    scheduleChangeToleranceMs: 60_000,
    maxConcurrentProviderRequests,       // required positive integer; must be >= expectedArmRoster.length (§3)
    maxDispatchesPerTick                 // required positive integer
  },

  cohortCallCap,                  // required non-negative integer; provider-HTTP-attempt cap (§4)
  cohortSpendCapUsdMicros         // required non-negative integer; conservative spend cap (§4)
}
```

**If a value can change sample eligibility, provider completion probability, or scoring
output, it belongs in this schema — not in a CLI flag or a code default.**

### Hashing

```
canonicalManifestBytes = UTF8(canonicalize(strictlyParsedManifestObject))
cohortId               = sha256Hex(canonicalManifestBytes)
```

`canonicalize` is the repo serializer (`src/canonical.ts`). `cohortId` is **derived** and
is **not** a field inside the object it hashes — the bytes are the canonical serialization
of the strictly-parsed manifest object (do not write `canonicalize(manifest bytes)`).

**Known-version + recomputed-digest rule.** The runner and scorer load the policy
implementation named by `marketPolicyVersion`, **recompute** `marketPolicyDigest`, and
reject an unknown version or a digest mismatch. The same known-version / recomputed-digest
rule applies to the prompt (`promptScaffoldSha256`), tool/inference config
(`toolInferenceConfigSha256`), baseline (`baselinePolicyVersion`), repair
(`repairPolicyVersion`), scoring (`scoringPolicyVersion`), and uncertainty
(`uncertaintyPolicyVersion`) policies, and to the model price table
(`modelPriceTableVersion`/`modelPriceTableDigest`). Unknown pricing **fails boot** (§4). The
spend-reservation policy (`spendReservationPolicyVersion`) is known-version-checked, and its
manifest `providerAttemptReservationUsdMicros` must equal the code-owned amount for that
version — there is **no** digest, because the single material scalar is directly in the hashed
manifest and `runnerCommitSha` pins the algorithm.

### Public-Git precommitment (Tier 0, not on-chain)

The canonical invocation supplies a publication descriptor **outside** the hashed manifest:

```
ManifestPublicationV1 {
  repositoryOwner,
  repositoryName,
  path,
  commitSha                       // full immutable commit SHA — never a branch or tag
}
```

Before any provider request the runner must:

1. Resolve that exact public commit and path.
2. Read the exact blob bytes at `(commitSha, path)`.
3. Require the blob bytes to **equal** the local manifest file bytes.
4. Parse **both** through the strict `CohortManifestV1` schema and recompute `cohortId`;
   they must match.
5. Read the Git commit object's **committer timestamp** and require it **strictly before**
   `windowStart`.
6. Persist the publication descriptor and the observed committer timestamp in **every**
   fire and cohort artifact.

**State the limitation precisely.** The Git committer timestamp is operator-selectable and
does **not** prove first public visibility. This check prevents an accidental late or
mismatched manifest; it is **not** an adversarial timestamp. "Committed and pushed to
public Git before `windowStart`" remains an **operator covenant** in Tier 0 — a practical
precommitment, not an independently-irreversible timestamp. No Polygon transactions,
finality checks, reorg handling, or post-cohort on-chain roots in Tier 0.

### Canonical-mode config lock

Every eligibility-changing value comes only from the manifest. `windowStart`/`windowEnd`
(not `--window-hours`) define the cohort; poll cadence, the discovery horizon, caps,
timeouts, and output limits come only from `CohortManifestV1.constants`. `--poll-seconds`,
`--timeout-seconds`, `--max-output-tokens`, `--window-hours`, `--late-minutes`,
`--max-fires-per-tick` may remain for **dry-run/rehearsal only** (output labeled
non-cohort); supplying any in canonical mode is a **boot failure** unless byte-equal to the
manifest value.

## 3. Candidate discovery, detection, and firing

### Candidate discovery (runtime)

Candidates are discovered from the core API's games endpoint. In canonical mode the runner
queries `GET /v1/games` **once per `sportAllowList` member** with:

```
windowHours  = gameDiscoveryWindowHours     // from the manifest; core-api default 168, range 1..720
availableOnly = false
```

and **paginates every page** (deterministic pagination, no silent truncation). A different
discovery horizon — or `availableOnly=true` — is an eligibility-changing override and
**fails canonical boot**. This horizon is an operational reach only; it does **not** define
`U`. A qualifying history opener whose game falls outside the discovery horizon still
appears as a disclosed miss in `M` (§6), never a silent exclusion.

### Effective eligibility (runtime and finalization, identical)

```
effectiveEnabled(sport, market)
  = sport ∈ sportAllowList
    AND marketPolicy(sport, market) = enabled
```

`sport` is `games.sport` (the stable `NOT NULL` slug). This one predicate governs both
runtime dispatch and finalization membership — they must never diverge.

### Detection and firing

Detection is per-market and no-wait: an `effectiveEnabled` market fires on its own the
moment it is cleanly detected, never waiting on a sibling market. Fire-at-detection is
preserved verbatim — the prepared snapshot is built from the **same** `current_odds`
snapshot detection reads; there is **no** capture/dispatch split. Per tick, for each
currently-valid, two-sided, `effectiveEnabled` candidate:

1. Derive/fetch its independent `firstTwoSided` from `source=jsonodds` `odds_history` (§1).
2. Produce a fresh immutable **prepared snapshot** and stamp `detectedAt` (ordering below),
   binding each candidate market to its actual opening/as-of quote and its `odds_history`
   row identity.
3. Evaluate the **canonical window gates** (below). If any fails, do **not** claim or
   dispatch.
4. Under the durable atomic lock, deterministically select the retained scope and acquire
   the **at-most-once claim + full-roster budget/concurrency reservation** (§4).
5. Launch **all** expected model arms as one concurrent roster batch, without waiting on
   unrelated markets.
6. Persist **one** terminal arm outcome for **every** expected arm.

### Canonical window gates

No canonical provider request may begin unless **all** hold (times in ms):

```
windowStart ≤ firstTwoSided.captured_at < windowEnd
windowStart ≤ detectedAt                < windowEnd
initialRequestStartedAt                 < windowEnd                     // window boundary: INITIAL request only
0 ≤ detectedAt − firstTwoSided.captured_at ≤ cleanEntryWindowMs        // = W
0 ≤ initialRequestStartedAt − detectedAt   ≤ maxDispatchLagMs           // V-lag: INITIAL request only, two-sided
requestStartedAt < scheduledAtAtFire                                    // hard first-pitch gate — EVERY request (incl repair)
```

**V-lag applies to each arm's INITIAL request only** — it proves prompt dispatch after
detection, and is two-sided (a backdated `initialRequestStartedAt`, before `detectedAt`,
must **not** pass). A repair is causally downstream of the initial response and is **not**
compared to `detectedAt` under V-lag (§5, repair timeline). The observation-window boundary
`initialRequestStartedAt < windowEnd` likewise binds admission and the initial request: a
fire admitted before `windowEnd` may receive its initial response and perform one
fingerprint-preserving repair **after** `windowEnd`, provided the repair starts and is
accepted **before** `scheduledAtAtFire` and within all timeout/cap/fingerprint rules —
otherwise a fire admitted 1 ms before `windowEnd` would have systematically lower completion
probability. The first-pitch gate `requestStartedAt < scheduledAtAtFire` binds **every**
request, initial and repair. Full per-attempt timestamp ordering is required in §5.

The bare age gate `detectedAt − firstTwoSided ≤ W` alone is **insufficient**: it admits a
paid request for a market that can never be in the universe `U` (§6) — an opener just
**before** `windowStart` but within `W`, or an opener just **after** `windowEnd` detected
immediately. Both are guaranteed `X = F − U` extra fires. **The window gates above forbid
those calls before any provider spend.** `first_pitch_passed` is a hard no-dispatch
condition (see the cutoff race in §5): no provider request may start at/after
`scheduledAtAtFire` (the scheduled start carried by that fire's bundle).

**The clean window is never widened by clock skew.** If `firstTwoSided.captured_at >
detectedAt`:
- within `maxClockSkewMs`: do **not** claim; defer and re-evaluate on a later tick with a
  fresh `detectedAt`;
- beyond `maxClockSkewMs`: treat as a source/clock failure — do **not** claim or dispatch.

The scorer requires a **non-negative** age; no negative-age fire is clean. All scorer-side
`firstTwoSided` and as-of queries bound on `id ≤ oddsHistoryWatermark` (§6), so repeated
scoring cannot change as later rows arrive.

### Deterministic candidate ordering

Input / API / DB iteration order must **not** change the admitted set. Before
grouping/admission, sort clean candidate keys by:

```
(firstTwoSided.captured_at ASC, firstTwoSided.id ASC, gameId ASC, marketOrdinal ASC)
marketOrdinal: moneyline = 0, spread = 1, total = 2
```

For co-arrival grouping, sort the scoped market keys by `marketOrdinal`; order dispatch
groups by the minimum member key above, then `gameId`. This exact order governs
`maxDispatchesPerTick`, concurrency admission, and the final call/spend slots — so which
opportunities and which arms are sent is never decided by nondeterministic iteration order.

### Preparation / claim / request ordering

One coherent sequence (resolves the `detectedAt` vs partial-claim contradiction — the
final bundle is **projected synchronously after claim**, so `detectedAt` anchors the
prepared snapshot, not the final bundle):

1. Complete all asynchronous reads/refreshes and produce one immutable **prepared
   snapshot** containing candidate market blocks and their history evidence; record
   `preparedSnapshotTs = fetchCompletedAt`.
2. If the snapshot is stale or the quote/as-of checks fail, repeat the preparation loop —
   **no stale fallback** snapshot may be used after a failed refresh.
3. Stamp `detectedAt` once the prepared snapshot is clean and all asynchronous eligibility
   work is finished, **before** atomic scope selection/claim. Require
   `0 ≤ detectedAt − preparedSnapshotTs ≤ freshFireMs` (V1b).
4. Under the durable atomic lock:
   - recheck which candidate keys are still unclaimed;
   - deterministically select the retained scope (candidate ordering above);
   - **synchronously project** the final bundle/request bytes from the prepared snapshot
     for exactly that scope;
   - derive the provider-attempt count and the fixed monetary spend reservation from the
     manifest-pinned spend-reservation policy, plus the worst-case **concurrency** reservation;
   - atomically persist claims and reservations.
5. If no key remains, create **no** claim/reservation/artifact and send **no** request.
6. Persist `bundleBuiltAt` separately; it may be **after** `detectedAt`, but bundle
   construction is synchronous, and every **initial** request still satisfies V-lag /
   freshness / `windowEnd`, and **every** request (initial or repair) the first-pitch cutoff.
7. Start the full-roster initial request batch.

### Co-arrival partial-claim

A dispatched bundle contains **only** the keys this dispatch successfully claimed. If two
markets co-arrive and one is already claimed by another worker, step 4's deterministic
scope selection retains only the newly-claimed key(s); the synchronous projection builds
the bundle for that scope, recomputes the bundle/request hashes and scoped decision
cardinality, and dispatches only if ≥ 1 key remains. The already-claimed key receives **no**
second provider forecast. No "rebuild after claim" outside this synchronous projection.

### Full-roster fairness

Manifest arm order must **not** decide which model gets a request before V-lag/cutoff:

1. Require `maxConcurrentProviderRequests ≥ expectedArmRoster.length`; otherwise canonical
   boot **fails**.
2. Admit/claim a dispatch **only** when the scheduler can reserve initial-request capacity
   for the **entire** expected arm roster.
3. Launch all initial arm requests as **one concurrent roster batch**. No arm may become
   `dispatch_lag_exceeded` merely because another arm occupied the only internal scheduler
   slot first.
4. A repair uses the same bounded scheduler but is **not** subject to initial V-lag (it is
   causally downstream of the initial response); it remains bounded by
   `maxRepairAttemptsPerArm`, a freshly-acquired concurrency lease (§4), the remaining
   `providerCallTimeoutMs` / attempt-timeout contract, the first-pitch cutoff
   `scheduledAtAtFire`, the call/spend caps, and decision-fingerprint preservation (§5).
5. Cross-process concurrency reservations are expiring, releasable **leases** (§4), held in
   the **same** durable atomic store as the claim and call/spend reservations.

If full-roster capacity cannot be obtained while the market is still clean, **defer before
claim**; an eventual miss is disclosed in `M` (§6).

**Capacity is bounded, not poisoning.** Deterministic caps apply, all from the manifest:
`maxDispatchesPerTick` bounds new dispatches admitted per tick; `maxConcurrentProviderRequests`
bounds simultaneously in-flight provider HTTP requests across all arms and markets; and
`cohortCallCap`/`cohortSpendCapUsdMicros` bound the cohort total (§4). A store admission that
is not authorized is **classified**, not uniformly deferred: a **capacity refusal**
(`call_cap`/`spend_cap`/`concurrency`) **defers** while the candidate remains clean; **`all_claimed`**
is **terminal** for this candidate because another fire already owns the key; and a
state/config/input/scope fault surfaces **loudly**. Coverage is not a local verdict — whether a
market that never cleanly fires ultimately counts as a miss is the globally derived `M = U − F`
result (§6), never a cohort-poisoning event. The runner reads
`games`/current inputs to build the prompt, identify teams, classify `sport`, and enforce
`first_pitch_passed` — these are **fire inputs**, not cohort-membership evidence.

## 4. The fire artifact and atomic reservation

### Fire artifact (no embedded denominator)

Each completed fire artifact retains:
- `cohortId`, the manifest hash, and the public-manifest publication descriptor + observed
  committer timestamp (§2);
- `fireId`, `runId`, `gameId`, `games.sport`, the **scoped market set**;
- `preparedSnapshotTs`, `detectedAt`, `bundleBuiltAt`, and per arm `initialRequestStartedAt`
  plus each attempt's `requestStartedAt` / `requestReceivedAt` / `acceptedAt` (§5);
- `scheduledAtAtFire` (the scheduled start used for the first-pitch gate);
- the `source=jsonodds` `odds_history` opener/as-of **row identity** and the exact opening
  quote **for each scoped market**;
- the scoped bundle bytes/hash (**byte-identical in shape to today's bundle**; every
  hard-coded `3` gone — cardinality derives from the scoped market set);
- the exact expected-arm roster/config identity;
- **exactly one** terminal outcome per expected arm (§5), with the ordered per-attempt
  provenance and the recomputable `armDigest` (§5);
- accepted-response bytes/digest and **one decision per scoped market** for a valid arm;
- deterministic baseline decisions derived from the **same** scoped bundle; and
- claim/completion linkage sufficient to reject duplicates and incomplete standalone
  artifacts.

There is **no** embedded universe/`Disposition[]` denominator and **no** negative-space
snapshot — coverage is derived globally (§6).

### Claim/fire ledger (operational only)

A small append-only ledger records claim → completion for **at-most-once billing and
crash recovery only**. It is operational state, **not** the source of the coverage
denominator. Persistence order: (1) atomic claim + budget reservation + concurrency-lease
acquisition (below); (2) start the initial provider requests within V-lag; (3) persist arm
outcomes + run artifact; (4) mark
the claim completed. A crash between steps leaves an interrupted claim — at-most-once holds
(no re-fire), and the pair surfaces as a miss/incomplete fire in §6, never as a clean entry.

### Atomic at-most-once + budget/concurrency reservation

Per-key `O_EXCL` claims alone do **not** enforce a global call/spend/concurrency cap across
concurrent workers. Under **one durable cross-process lock/transaction**:

1. Recheck which candidate keys are still unclaimed.
2. Determine the final proposed dispatch scope (the keys to fire in this bundle).
3. Compute the worst-case provider-attempt reservation for that dispatch **and** the
   full-roster initial-request concurrency reservation.
4. Check the cohort call cap, the conservative spend cap, and the concurrency budget.
5. If sufficient: persist pending claims for **every** retained key and reserve the
   budget + concurrency, **all atomically**.
6. If insufficient: create **no** claim and send **no** request; the candidate may retry
   while still clean, and an eventual miss is disclosed in `M` (§6).

**`cohortCallCap` counts provider HTTP attempts**, not market claims — initial attempts
plus allowed repairs. Each dispatch reserves:

```
expectedArmRoster.length × (1 + maxRepairAttemptsPerArm)
```

A co-arrival multi-market bundle is **one dispatch** and does **not** multiply arm HTTP
attempts by market count.

**`cohortSpendCapUsdMicros` is enforced with a conservative administrative reservation**
(`spendReservationPolicyVersion`/`providerAttemptReservationUsdMicros`; `fixed-attempt-v1`).
Each possible provider HTTP attempt reserves the manifest-pinned
`providerAttemptReservationUsdMicros`; a fire reserves
`expectedArmRoster.length × (1 + maxRepairAttemptsPerArm)` attempts. The **same** reservation
magnitude applies to every retained market subset, because market count does not change the
provider-attempt count. This is intentionally coarse: it protects the brokered spend boundary
and makes **no** claim of tokenizer or provider-template equivalence. Provider-reported tokens
and estimated/API cost are **descriptive** evidence — never admission authority or a normalized
cross-provider fairness metric. The model price table
(`modelPriceTableVersion`/`modelPriceTableDigest`) still pins per-model rates for a
clearly-labeled completion estimate, and unknown model pricing still **fails boot**; the hard
guarantees remain the call count, the `maxOutputTokens`/repair bounds, and this conservative
reservation — **not** exact external billing.

**Two distinct state classes.** *Consumed cohort accounting* — the claim, the call
reservation, and the spend reservation — stays consumed per the conservative rules above; a
crash **after** reservation leaves it consumed (no duplicate retry, no fire retry), and a
completed dispatch may settle actual attempt counts only through the same atomic store,
never reducing below calls already made. *Transient concurrency capacity* is **not** a
permanently-consumed cohort budget: it is held as expiring, releasable attempt leases.

### Concurrency leases (releasable, crash-expiring)

`maxConcurrentProviderRequests` is enforced through **leases**, not consumed budget —
otherwise the first full-roster dispatch (e.g. `maxConcurrentProviderRequests = 4`,
`expectedArmRoster.length = 4`) could hold every slot forever, even after all four HTTP
attempts complete. Each lease is at least:

```
ConcurrencyLeaseV1 {
  leaseId,
  cohortId,
  fireId,
  ownerId,
  attemptKind,        // initial | repair
  slotCount,
  acquiredAt,
  expiresAt
}
```

Canonical behavior:
1. Initial admission atomically acquires `expectedArmRoster.length` slots **together with**
   the claim / call / spend reservation.
2. The initial lease's `expiresAt` is **no earlier than**
   `acquiredAt + maxDispatchLagMs + providerCallTimeoutMs + maxClockSkewMs`.
3. Launch the roster batch; **release each slot in a `finally` path** the moment that HTTP
   attempt reaches response, timeout, abort, or transport failure.
4. A repair acquires **one** fresh slot lease immediately before its repair HTTP attempt,
   from the same atomic global capacity counter; its `expiresAt` is no earlier than
   `acquiredAt + providerCallTimeoutMs + maxClockSkewMs`.
5. A stale lease may be reclaimed **only at/after `expiresAt`**, never earlier.
6. Reclaiming concurrency changes **only** current in-flight capacity — it does **not**
   refund a claim / call / spend reservation and **never** permits a fire retry.
7. A cleanly completed fire has **no** active leases; a crash may leave a lease until
   `expiresAt`, after which later unrelated fires may use the capacity while the crashed
   fire stays claimed/incomplete.
8. At every instant, the sum of active, unexpired lease slots across all workers is
   `≤ maxConcurrentProviderRequests`.

### Settle-once completion (post-install)

The claim is settled **after** the fire artifact is durably installed, never before — the
persistence order above (claim/reserve → dispatch → persist artifact → settle) is load-bearing:

- **Artifact persistence returns before completion begins.** A fire settles its claim exactly
  once, and only after the reconciled artifact's durable install has returned. An install
  failure or rejection performs **zero** completion — a fire whose evidence did not persist is
  never settled, so its reservation is never released against a missing record.
- **A `completed` settle means settled.** Completion omits both actuals: omitted `actualCalls`
  settles calls to the store-known attempts-started floor (releasing the unused call
  reservation), and omitted `actualSpendUsdMicros` deliberately retains the full conservative
  fixed-attempt spend reservation — the store cannot resolve the administrative reservation to
  exact provider spend, so the spend reservation stays a hard ceiling, not an estimate of exact
  billing. Settlement therefore relieves the **call** reservation; the spend reservation stays
  fully consumed by design.
- **A settle failure preserves the artifact and returns `unsettled`.** A completion refusal, a
  `complete()` throw, or an unrecognizable result never deletes, rewrites, or relabels the
  installed artifact; it yields a typed `unsettled` status. The completion status reports
  completion **confirmation**, not omniscient canonical store state, and its confidence depends on
  the reason:
  - a known refusal (`version_mismatch` / `invariant_breach` / `invalid_input`) is **atomic and
    wrote nothing**, so the claim is **confirmed `pending`** with its reservations unchanged;
  - a failed or mismatched completion (`store_complete_failed` / `store_result_mismatch`) is
    **unconfirmed** — the store transaction may have committed before its acknowledgement was
    lost — so the canonical fire may be `pending` (reservations retained) **or** already
    `completed` (calls settled to the `made_calls` floor; the spend reservation stays fully
    consumed either way, since the request omits `actualSpendUsdMicros`).

  In **every** `unsettled` case the artifact stays installed, no provider is re-dispatched, and the
  reservation is only ever conservatively held (never over-admitting). An activation consumer
  escalates `unsettled`, and a later recovery slice reconciles an aged fire through the store's
  **idempotent, artifact-backed** completion — never a blind re-settle.
- **No current automatic recovery.** Nothing re-settles an `unsettled` fire today: lease expiry
  recovers only concurrency, and a re-detected fire replays without re-settling (a pending
  replay carries release-only authority, never dispatch or completion authority). A later
  recovery slice may re-settle an aged `pending` fire only against **durable exact-artifact
  proof** (the settle carries no owner, so a genuinely crashed-before-install fire must never be
  settled). Canonical activation must branch on the completion status and escalate `unsettled`.
- **Canonical storage must survive the production host lifecycle.** The local filesystem sink is
  no-clobber crash-consistent only on a **persistent POSIX filesystem**; it does not provide
  cross-restart or cross-dyno persistence on an ephemeral dyno filesystem. Canonical activation
  requires a separately reviewed durable external/mounted sink — dyno-local files are **not** the
  canonical evidence root. The install boundary is awaitable so such a sink drops in without
  reopening the completion ordering.

## 5. Per-fire entry verification and arm provenance

### Entry verification

For each fire key `(gameId, market)`:
- **exactly one** completed artifact exists;
- fire timing is inside `W` of the independent `firstTwoSided` (**V2**, within skew);
- the fire's opening quote **equals** the correct `source=jsonodds` as-of quote for its
  `detectedAt` — `(captured_at DESC, id DESC) limit 1`, `id ≤ oddsHistoryWatermark` — on
  `line` + both American odds (home-side spread convention) (**V1**); the freshness gap
  `0 ≤ detectedAt − preparedSnapshotTs ≤ freshFireMs` holds (**V1b**);
- the **initial** dispatch lag `0 ≤ initialRequestStartedAt − detectedAt ≤ maxDispatchLagMs`
  holds (**V-lag**, two-sided, **initial request only** — a repair is not tested against it;
  measured at the provider HTTP boundary; both operands benchmark-host, no skew);
- the scoped bundle carries the same quote + market identity;
- no hard-coded three-market assumption; and
- **all** expected arms and their outcomes are present.

A fire that fails entry verification **remains** in the published fire/coverage accounting
but is **excluded from the clean-entry CLV sample** with a typed reason. It **cannot be
silently deleted**.

### Arm-outcome enum (exhaustive)

Every expected-roster arm has **exactly one** outcome; a *missing* record is an integrity
violation (there is no free absence marker):

| outcome | request sent? | role |
|---|---|---|
| `valid` | sent, validated | the only scoreable decision — one decision per scoped-bundle market |
| `invalid_schema` | sent | valid negative — a body that refuses or lacks the required schema, retained in the denominator |
| `timeout` | sent | valid negative |
| `rate_limited` | sent (429) | valid negative — a throttle must never read as a model failure |
| `provider_error` | sent | valid negative — provider/transport refusal with **no body** |
| `cutoff_missed` | an arm in an already-claimed fire where the **initial** request is unsent at/after `windowEnd` or `scheduledAtAtFire`, **or** a **repair** request/response crosses `scheduledAtAtFire` (first pitch), or any response is accepted at/after first pitch → no request sent / no decision accepted. Crossing `windowEnd` **after** a timely initial request is **not** by itself `cutoff_missed`. | valid negative; **no** decision records |
| `dispatch_lag_exceeded` | **not sent** — the **initial** request would start `> maxDispatchLagMs` after `detectedAt` (**V-lag**, initial-only, measured at the provider HTTP boundary; both operands benchmark-host, no skew) | valid negative |
| `credential_missing` | not sent (should be blocked at boot) | structural — a required arm makes the fire fail integrity |

"Failures never leave the denominator" — a *partial* fire still scores its sent arms;
deleting a bad forecast or a failed arm is a **structural integrity failure**.

### Per-attempt provenance and the arm digest

For every expected arm, persist **exactly one** terminal outcome and **all attempts** used
to substantiate it. Each attempt records:
- `participantId`, provider, requested model ID;
- the provider-reported model ID when a response identifies one;
- initial vs repair attempt number (**unique and strictly increasing**);
- the fire's `initialRequestStartedAt` (the arm's initial-request start — the **sole**
  operand of V-lag) recorded **distinctly** from each attempt's own `requestStartedAt`, so
  the scorer can never apply initial V-lag to a repair;
- per attempt, provider HTTP `requestStartedAt`, `requestReceivedAt`, and (when accepted)
  `acceptedAt`, in **full causal order** —
  `requestStartedAt ≤ requestReceivedAt ≤ acceptedAt` (the `acceptedAt` bound when present) —
  and across attempts `repair.requestStartedAt ≥ initial.requestReceivedAt`;
- `requestSha256`, the exact persisted response body, `responseSha256`;
- transport status, usage/token metadata, and repair linkage.

**Persisted response bytes (one exact rule).**

```
persistedResponseBytes = UTF8(the exact post-redaction retained response body)
responseSha256         = sha256Hex(persistedResponseBytes)
```

The scorer recomputes `responseSha256` from those **exact persisted bytes**. Any
unpersisted raw-provider digest kept for diagnostics is **not** an integrity proof.

**Arm digest (domain-bound to its enclosing identity).**

```
armDigest = sha256Hex(canonicalize({
  cohortId, fireId, runId, participantId, requestSha256,
  expectedArmIdentity,
  orderedAttempts,                  // attempt numbers unique & strictly increasing; timestamps fully causally ordered
  terminalOutcome,
  acceptedResponseDigestOrNull,     // = responseSha256 of the accepted attempt, or null
  acceptedDecisionFingerprintOrNull
}))
```

The scorer **recomputes** `armDigest`. Mutating the persisted response bytes, the enclosing
fire/run identity, an attempt's order, or an attempt timestamp must **fail** integrity. The
scorer also recomputes the per-attempt ordering `requestStartedAt ≤ requestReceivedAt ≤
acceptedAt`, the cross-attempt ordering `repair.requestStartedAt ≥ initial.requestReceivedAt`,
and unique strictly-increasing attempt numbers; any violation fails arm/fire integrity.

### Retained benchmark protections

- a successful response requires an **approved reported model ID**
  (`approvedReportedModelIds`);
- same-family substitution, model drift, and arm-family collision **fail integrity**;
- **at most one** repair attempt (`maxRepairAttemptsPerArm = 1`);
- a repair may fix **schema/format only** and must **preserve the initial decision
  fingerprint**;
- one valid response has **exactly one decision per scoped market**;
- deterministic baselines are re-derived from the **same** scoped bundle.

### Refusal taxonomy (no undocumented outcome)

- a provider/transport refusal with **no body** is `provider_error`;
- a **body** that refuses or lacks the required schema is `invalid_schema`;

— unless a separately versioned explicit enum value is deliberately added. Do not invent
an undocumented outcome.

### Cutoff race

First pitch (`scheduledAtAtFire`) is the hard cutoff for **every** request; `windowEnd`
bounds only admission and the **initial** request:
- if first pitch is already passed **before claim**, create **no** claim and **no** fire
  artifact — it becomes a coverage **miss** (`M`, §6), not a `cutoff_missed` outcome;
- an **initial** request unsent at/after `windowEnd` **or** `scheduledAtAtFire` (in an
  already-claimed fire) → `cutoff_missed` for that arm;
- a **repair** request or response that crosses `scheduledAtAtFire` (first pitch) →
  `cutoff_missed`;
- **crossing `windowEnd` after a timely initial request is NOT by itself `cutoff_missed`** —
  a fire admitted before `windowEnd` may complete one fingerprint-preserving repair after
  `windowEnd`, so long as that repair starts and is accepted before first pitch and within
  all timeout/cap/fingerprint rules (§3);
- no response may be **accepted** at/after `scheduledAtAtFire`;
- `dispatch_lag_exceeded` means the **initial** request is **not sent**.

**No request ever starts late.** Persist enough timestamps for the scorer to recompute each
classification.

## 6. Finalization: the universe + global coverage reconciliation

History — not a scheduled-game census — is the source of opportunity membership. `games`
is used **only** as an identity-classification join (to obtain `games.sport` and stable
prompt-identity fields), **never** as a scheduled-game census: a `games` row cannot create
membership without a qualifying first history appearance, and mutable schedule fields never
decide membership.

### The valid-history predicate

`odds_history` alone cannot decide sport (it has no `sport`/`network` column). The finalizer
parses each source row **fail-closed** against `validTwoSidedHistoryRowV1` (versioned by
`sourceQueryVersion`), which requires at least:
- `source === "jsonodds"`;
- a known market enum;
- a parseable `captured_at` and a safe, strictly-ordered identity (`id`);
- both American odds present, finite integers, and non-zero;
- both decimal odds finite and `> 1`;
- a finite `line` for spread/total and `line === null` for moneyline; and
- the **same** quote/line normalization used by bundle verification (V1).

Do not rely on the writer's intended behavior — the finalizer re-parses source rows.

### Complete, restart-stable finalization

At the **first** finalization attempt after `windowEnd + ingestionGraceMs`:

1. Atomically create `finalization-meta.json` with `cohortId`, the manifest hash, and
   `oddsHistoryWatermark = MAX(odds_history.id)`.
2. **Every retry reuses that persisted watermark** — it must never advance silently.
3. Enumerate qualifying source rows with immutable **`id ASC` keyset pagination**,
   `id ≤ watermark`, and **empty-page termination** — a short page is **not** end-of-data.
4. The normative algorithm is an exact **two-pass** scan:
   - **pass 1** — enumerate valid `source=jsonodds` rows under the watermark with
     `captured_at ∈ [windowStart, windowEnd)` to collect candidate `(jsonodds_id, market)`
     pairs;
   - **pass 2** — for every candidate pair, query its **earliest** valid row under the
     same watermark by `(captured_at ASC, id ASC)` with **no lower time bound**; keep the
     pair as an in-window opener only when that true first row is in `[windowStart,
     windowEnd)`. **Policy is applied only after step 5 produces the policy key** — do not
     filter on policy before the `games.sport` join exists.
5. **Identity-classification join.** Join each candidate `jsonodds_id` to **exactly one**
   `games` row for the manifest `network` to obtain `games.sport` (and stable
   prompt-identity fields). Then apply `effectiveEnabled(sport, market)` (§3, identical to
   runtime). A **missing, duplicate, null/blank, or unknown `sport`** join is
   `universe_metadata_unresolved`: finalization **exits nonzero** and publishes **no**
   denominator or CLV report — it never silently excludes such a pair.
6. Persist each included first row, its `games.sport`/metadata join, the query version, the
   watermark, the row count, and a SHA-256 in `universe.ndjson` plus metadata.
7. Any source-read, pagination, metadata-join, parse, or required-output-write failure
   **exits nonzero** and publishes no scorecard. Retrying with the **same** watermark is
   allowed.
8. If `|U| = 0`, publish counts with coverage percentages `null`/`N/A`; **never** emit
   `0/0`, `100%`, or a ranking.

```
U = distinct (gameId, market)
    where windowStart ≤ firstTwoSided.captured_at < windowEnd
      and effectiveEnabled(games.sport, market)          // sport from the games join
```

A reprice inside the window does **not** make a market whose true first appearance
predates the window a new opener; a first appearance after `windowEnd` (even before the
grace ends) is **excluded** from `U`. A scheduled game that never gets a valid two-sided
market has no CLV observation and is **not** a coverage hole.

### Reconciliation

The scorer **recomputes** `F`, duplicates, coverage, and the artifact inventory **every
time it scores** — it never trusts a stale coverage report after files change.

```
F = unique (gameId, market) keys from completed fire artifacts
C = F entries whose entry verification (§5) passes
M = U − F                      # missed opportunities
X = F − U                      # unexpected / extraneous fires
D = duplicate fire keys        # structural error
```

A co-arrival artifact with two markets contributes **two** independent keys to `F`, each
with its own entry quote and one-to-one artifact linkage.

**Published coverage:**

```
fireCoverage       = |F ∩ U| / |U|
cleanEntryCoverage = |C ∩ U| / |U|
missed              = M      (with advisory reason breakdown)
extraFires          = X
duplicateFires      = D
```

Runner-supplied miss reasons are **advisory operational diagnostics** only — they never
define membership and are never substituted for the independent `U − F` calculation. A
market in `M` with no trustworthy reason is `unexplained_miss`. A fired key absent from
`U` (`X`) is reported as an extra/invalid fire, **never** silently scored as a cohort
entry.

## 7. Close capture, CLV, and reporting

### Close capture

Use the production `closing_lines` source on the manifest `network`, keyed uniquely by
`(network, jsonodds_id, market)`:

```
closing_lines.source === "jsonodds"
```

(the single literal Tier-0 v1 close source — there is no committed alternative; a future
close source needs a new manifest field + version bump before it is honored). Also:
- retain the existing `confidence = fresh` and raw-price / no-vig consistency gates;
- persist `lock_time`, `value_captured_at`, `last_polled_at`, `confidence`, the raw
  quotes, the no-vig values, and `source`;
- use `lock_time` as `scheduledAtAtCloseCapture` / the close cutoff represented by the
  captured row;
- set `schedule_changed = abs(lock_time − scheduledAtAtFire) ≥ scheduleChangeToleranceMs`;
- a missing / stale / inconsistent / canceled / ambiguous close remains **entry-covered
  but CLV-unavailable** with a typed reason (`close_unavailable` / `schedule_ambiguous`).

Do **not** invent an ad-hoc latest-`odds_history` close while `closing_lines` is the
production close contract. Persist `scheduledAtAtFire` in the fire artifact and
`scheduledAtAtCloseCapture` at close capture, plus whether they materially differ.

### Schedule changes are a scoring-side concern

A later reschedule does not alter what line the model saw at the original open — the
opening artifact stays valid and is **never rewritten**. If a reliable close + cutoff
exist, compute CLV but tag the row `schedule_changed=true`, **exclude it from the primary
same-schedule estimate**, and show it only in a separate reschedule-sensitivity stratum.
`first_pitch_passed` stays a hard no-dispatch condition at fire time (§3).

### Uncertainty (byte-reproducible bootstrap)

Pin one reproducible policy in `uncertaintyPolicyVersion`. Tier-0 v1:

```
canonicalResultKey = canonicalize({ market, metric, participantA, participantBOrNull })
seedBytes          = SHA256(UTF8(cohortId + "\0" + scoringPolicyVersion + "\0" + canonicalResultKey))
PRNG               = xoshiro256** seeded with the four big-endian uint64 words of seedBytes
replicates         = 10_000
```

- **Cluster unit is `gameId`.** Sort the unique `gameId` cluster keys **lexicographically**
  before sampling.
- Draw unbiased indices with **rejection sampling**, never modulo bias.
- For each replicate, draw exactly `N` game clusters **with replacement** and include **all
  rows** for every sampled cluster occurrence.
- Sort the replicate statistics ascending.
- Use **nearest-rank** percentile indexes `ceil(p × B) − 1` for `p = 0.025` and `0.975`
  (`B = replicates`).
- Numeric **rounding/serialization is defined once** in `uncertaintyPolicyVersion`.
- `N < 2` game clusters → `interval: null, reason: insufficient_n` (never a fabricated
  zero-width interval).

Apply it to each single-model market mean **and** each pairwise model difference on the
**common scoreable** fires, using the exact `canonicalResultKey` vocabulary (a single-model
market mean sets `participantBOrNull = null`; a paired common-fire difference sets both).
**Never pool markets** for the primary comparison.

### Published reporting

**Published counts (side by side):** expected universe; fired; clean entry; valid model
decision by arm; close available; CLV scoreable; schedule-changed sensitivity rows.

**Primary model reporting must include:**
- N and mean economic CLV **by market**;
- the existing margin-adjusted / sensitivity metrics with their policy labels;
- game-clustered bootstrap intervals (above);
- response / valid-decision rate per arm;
- fire coverage, clean-entry coverage, and close coverage;
- **paired** model differences on the **common scoreable** fires;
- same-schedule primary results and schedule-changed sensitivity results **separately**;
  and
- an explicit statement that estimates are **conditional on captured clean fires** and
  that reported coverage **does not prove missing-at-random** sampling.

**Do not** pool different markets into one primary ranking; **do not** hide models with
zero valid decisions.

## 8. Trust boundary (stated plainly)

Tier-0 integrity rests on: (a) **internal consistency** — recomputable digests
(`requestSha256`, `responseSha256`, bundle/artifact hashes, and the domain-bound arm digest
of §5); (b) **practical precommitment** — the manifest published to public Git before
`windowStart`, verified byte-equal at runtime (§2); and (c) **independent honesty** —
`odds_history` derives the universe, first appearance, and as-of quotes, so coverage and
entry timing are not self-reported. There is **no** independently-irreversible external
timestamp in Tier 0; that is the acknowledged limit, and it is sufficient for the
non-adversarial question Tier 0 answers. Do not overstate it.

## 9. Sequencing

| PR | Content | `--live` |
|---|---|---|
| **0 — spec** | This Tier-0 governing spec + the base spec. Merge after review. | n/a |
| **1 — runner/artifact** | Per-market no-wait firing, independent claims, fire artifacts, one terminal arm outcome per expected arm, at-most-once + crash linkage; **rehearsal mode (dry-run, writes no live ledger)**; unit + adversarial-fixture tests. | **hard-disabled** |
| **2 — coverage + scoring** | Global `U`/`F`/`C` reconciliation, close capture + CLV + scorecard; **rehearsal exercised end-to-end against the coverage stack**; restart/failure tests. | **hard-disabled** |
| **3 — live canary** | Explicit, budget-bounded live canary after PRs 1–2 pass complete-stack review — explicit confirmation, pinned spend/call caps, clean credentials, at-most-once claims. | **enabled here only** |

Each PR branches from the then-current `main` after its predecessor merges. "Simpler
evidence" does **not** mean casual paid dispatch.

## 10. Test matrix (Tier-0 acceptance cases)

1. Moneyline opens while total/spread reads hang → moneyline fires without waiting.
2. Three markets open at three times → three independent claims/fires/artifact keys.
3. Co-arriving markets share transport but retain per-market entry quote/linkage.
4. First appearance outside `W` → no fire; a global coverage miss iff its first
   appearance is in the cohort window.
5. Fire artifact deleted → `U` unchanged, coverage decreases.
6. One arm record deleted → fire integrity fails; **not** converted into a lower-N clean
   result.
7. All arms fail → fire remains present; response coverage zero for those arms; no
   survivor deletion.
8. Duplicate claim workers overlap → only one paid dispatch.
9. Crash after claim before completion → no duplicate retry; global report shows
   interrupted/incomplete fire or miss.
10. Pre-window opener reprices during the window → excluded from `U` (first appearance
    predates the window).
11. First appearance inside window with later reprices → **one** universe key, not
    multiple opportunities.
12. Market first appears after `windowEnd` but before scoring grace ends → excluded from
    `U`.
13. Fired key absent from `U` → reported as an extra/invalid fire, never silently scored
    as a cohort entry.
14. One-, two-, three-market scoped bundles → exact dynamic decision cardinality.
15. Schedule changes after fire → opening artifact stays valid; the row goes to the
    reschedule-sensitivity stratum if the close is available.
16. Canceled/ambiguous close → fire stays in entry coverage; CLV unavailable with a typed
    reason.
17. Public manifest commit committer-timestamp is **not strictly before** `windowStart`,
    or the resolved blob bytes differ from the local manifest bytes, or the recomputed
    `cohortId` mismatches → the canonical run refuses **before** any provider call.
18. Canonical poll/config override differs from the manifest → refuses **before** provider
    calls.
19. Coverage report shows expected/fired/clean/missed/extra/duplicate/close and per-arm
    completion counts.
20. Scorecard states that coverage disclosure does **not** prove missing-at-random
    sampling.
21. Pre-window opener detected just after `windowStart` while still inside `W` → **zero**
    provider requests; excluded from `U`.
22. Post-window opener detected immediately → **zero** provider requests; excluded from
    `U`.
23. Slow history read ages the input snapshot → refresh/rebuild/restamp **before** claim;
    no stale fallback.
24. Co-arrival with one already-claimed key → only the unclaimed key is in the final bundle
    and its decisions.
25. Two workers race the final cohort budget slot → **at most one** reservation/dispatch.
26. Initial response or repair crosses first pitch → `cutoff_missed`, no decisions; no
    request starts late.
27. Provider attempt deleted / repair deleted / reported model changed → `armDigest` or
    model checks fail.
28. Finalizer retries after crash → same persisted history watermark and byte-identical
    `U`.
29. Server page cap below the requested page size, plus a post-watermark insertion →
    complete, stable `U`.
30. Same-window MLB and non-MLB history rows → only `effectiveEnabled(sport, market)` pairs
    enter `U`; unresolved metadata fails loudly (`universe_metadata_unresolved`).
31. Empty `U` → counts plus `N/A` coverage; no ranking.
32. Closing-row schedule drift at, below, and above `scheduleChangeToleranceMs` →
    deterministic primary / sensitivity classification.
33. Bootstrap rerun with the same inputs → byte-identical intervals; `N < 2` → `null`
    interval with `insufficient_n`.
34. A current writer-style `games` row with `sport="mlb", league=null` classifies
    successfully by `sport`; a blank/unknown `sport` fails loudly
    (`universe_metadata_unresolved`).
35. `sportAllowList=["mlb"]` plus a policy version that also knows NFL still admits only
    MLB; runtime and finalizer produce the **same** effective set.
36. A non-default game-discovery horizon or `availableOnly=true` in canonical mode fails
    boot; shuffled/paginated game input yields the same candidates.
37. Reversed candidate input under a one-dispatch cap yields the **same** admitted dispatch
    and misses.
38. `maxConcurrentProviderRequests < expectedArmRoster.length` fails boot; a saturated
    scheduler never privileges an earlier arm.
39. Partial co-arrival claim produces a final projected bundle **without** violating the
    prepared-snapshot / `detectedAt` / claim ordering.
40. `requestStartedAt < detectedAt` fails V-lag; all V1/V2 scoring queries remain stable
    under a post-watermark row.
41. Cutoff before claim produces **no** claim; cutoff after claim but before an arm request
    produces an unsent `cutoff_missed` for that arm.
42. Mutating persisted response bytes, enclosing fire identity, attempt order, or attempt
    timestamps → digest/integrity verification fails.
43. Independent bootstrap implementations using the pinned seed/PRNG/quantile rules produce
    **byte-identical** intervals.
44. A non-`jsonodds` `closing_lines.source` is CLV-unavailable under Tier-0 v1.
45. One full-roster dispatch completes and **releases** all concurrency leases; a second
    dispatch acquires those slots, and active unexpired slots never exceed
    `maxConcurrentProviderRequests`.
46. A worker crashes after claim/lease acquisition → the lease cannot be reclaimed **before**
    `expiresAt`, can be reclaimed **after**, and claim/call/spend stay consumed with **no**
    redispatch of the crashed fire.
47. An initial request starts before `windowEnd`, returns **after** `windowEnd`, and needs a
    fingerprint-preserving repair before first pitch → the repair is allowed and is **not**
    tested against initial V-lag; the same repair at/after first pitch → `cutoff_missed`.
48. `acceptedAt < requestReceivedAt`, a repair starting before the initial response
    (`repair.requestStartedAt < initial.requestReceivedAt`), or non-increasing/duplicate
    attempt numbers → fails arm/fire integrity.
