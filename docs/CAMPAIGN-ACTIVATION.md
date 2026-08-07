# Campaign activation — the activated contract

Status as of this document: **scheduled campaign activation is LIVE.** `campaign:tick`,
given a live durable authorization, verified public-Git publication evidence, and a clear
escalation latch, assembles the real tick input and dispatches under the armed caps: real
discovery, store-arbitrated admission, billable provider adapters, durable fire artifacts.
Everything below states the contract that holds it.

## The command surface

- **Arming** (`campaign:arm`, attended, once per cohort): requires an explicit
  offset-qualified `--start` — the campaign's identity anchor, which keeps the identical
  public command byte-identical across retries — and an explicit `--artifacts <dir>` with
  **no default**: the campaign's durable evidence destination, a deliberate arming
  decision (choose storage that survives the host lifecycle). The arm resolves it to an
  absolute path, initializes it (the arm is the ONLY creator), durably installs an
  identity marker (`evidence-root.json`, a minted random id, through the same no-clobber
  loop as the manifest), and binds both the root and the marker id **immutably** into the
  authorization record. A root has one identity for its lifetime: a second campaign armed
  at the same root adopts the existing marker; a byte-different marker refuses the arm; a
  retry pointed at a different root refuses to reconcile, and so does a retry whose
  pathname no longer carries the armed identity — the attended command never reports a
  reconciliation the next tick would refuse. It builds a bounds-checked
  campaign manifest sized in provider calls, prints the exact terms and cost projections,
  takes the standard `[Y/n]` confirmation, then performs the durable writes in
  **authority order** — the evidence-root marker and the manifest file first (each riding
  the fire-artifact sink's durable loop: a same-directory fsynced exclusive temp, an
  atomic no-clobber hard-link publication, a parent-directory sync where the platform
  supports one, then a final read-back), the cohort budget next (durable but not
  authorizing), and the durable authorization record **last**, as the single authorizing
  transition. A failed arm therefore cannot leave standing authority, cleanup failures
  cannot falsify a decided outcome, and re-running the same arm reconciles every
  intermediate failure — including an authorizing write whose commit status was lost. A
  cohort is armed at most once, ever; another campaign is a new manifest and therefore a
  new cohortId.
- **Ticking** (`campaign:tick`, unattended): the paid path. Its gates, in order, are the
  subject of the next section. Exit 0 = a healthy dispatched tick (including one that
  found nothing eligible — the journal detail says so); exit 2 = a refusal (a halted
  schedule, missing or failed publication evidence, missing configuration — the store
  URL, the read-seam env, or an `--artifacts` flag a tick must not carry — no live
  authorization, an evidence root failing its identity verification, a tripped
  escalation latch, a dispatched fire that left unresolved spend evidence, or a
  fault-class admission outcome); exit 1 = loud failure.
- **Status** (`campaign:status`, read-only): reports the durable state and the verdict the
  next tick would reach, in the tick's own precedence. Detailed below.
- **Resuming** (`campaign:resume`, attended): clears a halted schedule after operator
  review, with the standard `[Y/n]` confirmation — an operator-acknowledgment journal
  entry, granting nothing else.
- **Stopping** (`campaign:stop`): stamps `disarmedAt` inside the record (first stop wins,
  row never deleted). The next tick resolves nothing. Runnable from any box that reaches
  the store and holds a copy of the campaign manifest — it does not need the runner.
- **The hard money bound** is independent of all of the above: the store's cohort
  call/spend caps are enforced inside a row lock (`admit_dispatch`), so even a wrong
  authorization layer cannot spend past what arming fixed.

## What one tick does, in order

1. **Pre-store configuration** — refused before anything opens, leaving no journal trace
   (such a tick can reach no dispatch either: every dispatch path needs the same store it
   never opened, and these refusals are pinned by test to open nothing and dispatch
   nothing): `--manifest` must boot; `--publication` is **required** and must parse as a
   strict descriptor (the all-zeros rehearsal commit is rejected structurally, before any
   resolution); a tick given `--artifacts` refuses — the evidence root is bound at arm
   time in the durable authorization record and cannot be changed per-tick; the discovery
   read seams need `SUPABASE_URL` + `SUPABASE_ANON_KEY`.
2. **The schedule halt rule** — evaluated before any journal write, authorization read, or
   latch read (see the scheduler contract below). A halted tick refuses (exit 2) writing
   no journal entry and touching no campaign state.
3. **The two-phase journal entry begins.** Everything from here to the finish is a durable
   tick outcome the halt rule sees.
4. **Publication evidence, verified**: byte-identical published blob, cohortId equality,
   committer strictly before `windowStart`, resolved against public Git by the concrete
   `GitHubPublicationResolver` (sha-echo substitution guard, URL-canonicalization defense
   on the commit pin, one deadline across headers and body, bounded response sizes). ANY
   failure — a network failure included — journals `publication_refused` and exits 2. The
   verified record is branded by the publication owner and threaded to the spine, which
   re-authenticates it per fire.
5. **The authorization resolution** (`resolveCampaignIntent`): the durable record's strict
   capture, liveness at the tick clock, exact binding to the booted manifest (identity,
   roster, price identity, every cap), and a fresh independent credential observation.
   Refusal journals `no_live_authorization`.
6. **The armed evidence root, verified by identity**: the record binds the absolute root
   and the id of the marker the arm installed; the tick reads the marker back and
   requires the exact id before reading any evidence. A missing root, a missing or
   unreadable marker, or a foreign id journals `evidence_root_refused` (exit 2, halting
   the schedule) — a lost mount or a recreated empty directory at the same pathname is
   NOT the armed root and can never read as a clear latch. The tick never creates the
   root; the attended arm is the only initializer. The same verification is also part of
   the latch operation itself (next step), so it re-runs at every admission — a root
   lost in the late window between this check and an admission trips the guard
   (`evidence_root_lost`) rather than scanning an empty pathname as clear.
7. **The composed escalation latch** (below). A trip journals `escalation_latched`.
8. **The gated billable mint** (`gateRealCampaignAdapterCapability`) — the second of two
   independent validation passes: the producer re-derives the cohort binding, the campaign
   bounds, and its own credential observation from the real adapters, refusing on any
   disagreement with the resolution's claim. A refusal journals `no_live_authorization`
   (exit 2), never a crash. Minting performs no network I/O.
9. **The real tick input is assembled and dispatched** (`runCohortTick`): real discovery +
   opener reads over core-api/PostgREST, the store-backed claim port wrapped in
   `latchGuardedClaimPort` (every admission consults the same composed latch), the minted
   billable capability, the durable `FireArtifactSink` under the artifact root, and the
   manifest-derived run options. At most the manifest's per-tick dispatch budget admits;
   the store's row-locked caps arbitrate every admission.
10. **Outcome classification**: a mid-tick latch trip (`EscalationLatchedError` from the
   guarded port) journals `escalation_latched` (exit 2); fires admitted earlier in that
   same tick are recorded durably in the store and under the artifact root —
   `campaign:status` shows them — while the journal entry records the latch causes. Any
   evaluated fire that left unresolved spend evidence — a spend-guard escalation
   (`InstalledEscalated`) or an installed fire whose settlement was refused or failed
   (`Installed`/unsettled) — journals `dispatch_unresolved` (exit 2): the schedule halts
   for review, and the same fires trip the store-derived latch on any later tick
   regardless. A fault-class admission outcome (`NotAdmitted`/`Fault` — store-contract
   skew, an uninitialized budget, a store error; or a `WouldAdmit`, which on this path
   can only mean a rehearsal claim port was wired in) journals `dispatch_faulted`
   (exit 2): a fault authorizes nothing and spends nothing, but an unattended campaign
   must not keep ticking over a store whose contract is not holding. Cap and concurrency
   refusals map to `Defer` and stay healthy — a completed campaign keeps ticking
   healthily until its authorization expires. Otherwise the tick journals `dispatched`
   (exit 0) with a machine-readable detail: candidate counts, per-reason deferral counts
   (grouped, so a slate-sized tick does not write a slate-sized row), evaluated-fire
   outcome counts, and the individually-named installed fires (bounded by the per-tick
   dispatch budget). Any other failure journals `loud_failure` best-effort and
   propagates (exit 1).

## The durable escalation latch

A spend-guard escalation means the spend model is not holding; it must not be able to
repeat on the next scheduled invocation. A "disarm after the tick result" write is
best-effort — if it fails transiently, the authorization stays live and a cron-style
scheduler runs again regardless. The latch is therefore **derived, never separately
written**, from two independent durable signals (`escalationLatch.ts`):

1. the **store's shadow of the escalation** — a cohort fire that is `pending` with no live
   lease, true from strictly before the moment escalation evidence can exist (the spine
   settles every lease before the spend guard runs, and deliberately never settles an
   escalated claim), and also holding crashed-unsettled and settle-failed fires — the
   conservative direction for an unattended path. Readable from any box that reaches the
   store, independent of any filesystem root; and
2. the **installed escalation evidence itself** — a spend sidecar with a non-null `reason`
   under the artifact root's cohort directory (`escalationEvidenceScan.ts`). A sidecar
   claiming a clean pass (`reason: null`) is never trusted on its own say-so: it reads
   clear only when it names the scanned cohort AND the offline pair verifier
   (`verifySpendEvidence`, reused wholesale — `reason-recomputed` authoritative) passes
   every named check against the paired installed artifact; a missing, unreadable,
   foreign, or contradicted pair latches as unverified evidence. After a reviewed
   recovery settles the store shadow, this source is the ONLY signal keeping the latch
   tripped — which is why the root it scans is not selectable: it is bound at arm time
   with a durable identity marker (`campaignEvidenceRoot.ts`), the tick verifies that
   identity before every read, and an unverifiable root refuses the tick outright
   (`evidence_root_refused`) rather than reading an empty or foreign directory as clear.

Both sources fail CLOSED (a source that cannot be read rejects, never reads as clear).
"Checked before every dispatch" is `latchGuardedClaimPort`: every dispatch begins with
`claimPort.admit`, and the guarded port consults the latch before every admission, aborting
the tick with a typed error on a trip — with no change to the store contract, the claim
port, or the spine. The tick consults the same composed latch at the tick level (the half a
scheduler and an operator see), and `campaign:status` reports the store-derived half. The
acceptance battery runs the documented sequence literally: a real installed escalation
(real sidecar bytes on disk), a disarm write that fails, a restart (all fresh objects over
the same durable substrate), and a fresh tick whose provider adapters are tripwires —
proving the admission is refused and no provider call is reachable.

## The scheduler contract

- **Halt semantics — enforced by the tick itself.** Cron cannot be trusted to stop itself,
  so every substantive tick writes a **two-phase journal entry**
  (`store.campaign_ticks`: begin, then finish exactly once with a semantic outcome), and
  before any journal write, authorization read, or latch read a tick evaluates the halt
  rule (`campaignSchedule.ts`) over the journal: ANY prior tick in the window that
  finished outside the healthy set — wherever it sits, so an overlapping slow tick's
  failure cannot be buried under a faster tick's healthy finish, and including any
  outcome this build does not recognize — or that started and never finished within the
  manifest-derived tick deadline (the crash shape, "unknown outcome") refuses this tick
  (exit 2) until an operator resumes. A halted tick writes no journal entry and touches
  no campaign state, so repeated cron firings cannot bury the entry that needs review; a
  journal FINISH failure leaves the unfinished entry that halts the schedule once it
  passes the tick deadline — failing toward review. **The healthy set is exactly the
  dispatched outcome** (`dispatched`). A journal written by the pre-activation build
  carries `validated_refused` rows, which this build does not recognize: a journal
  spanning the build change halts once for operator review — fail closed, deliberate;
  review and `campaign:resume`.
  Stated bounds: the halt evaluation's input is read in ONE snapshot, anchored at the
  durable latest-resume boundary — the boundary row itself, EVERY unfinished tick after
  it, and EVERY non-healthy finished tick after it, with deliberately no row limit: a
  newest-N sample of the raw journal cannot authoritatively decide that no unreviewed
  halt cause exists, so the bounded newest-first read serves display only (the escalation
  latch remains the independent money backstop). A tick that fails before its begin
  entry leaves no journal trace: for store-class failures such a tick can reach no
  dispatch either (every dispatch path needs the same store it could not reach), and the
  pre-store configuration refusals — a missing, unusable, or all-zeros publication
  descriptor, missing read-seam env, a tick-supplied `--artifacts` — are pinned by test to
  open nothing and dispatch nothing; repeated pre-journal failures surface only through
  the process exit code and its monitoring channel, never the journal.
- **Resuming is attended.** `campaign:resume` clears a halted schedule with the standard
  `[Y/n]` confirmation, appending an operator-acknowledgment entry that bounds the halt
  window. It refuses while an in-flight tick's outcome is still pending — a resume would
  bound that entry out of the halt window before it could ever be reviewed — and the
  append itself is CONDITIONAL: it commits only while the journal frontier still equals
  the exact frontier the review read (tick begin and resume serialize on one per-cohort
  lock), so a tick beginning during the attended prompt refuses the acknowledgment
  instead of being silently bounded out. It grants nothing else: the next tick still
  validates the authorization, the publication evidence, and the escalation latch in
  full. A schedule that is not halted has nothing to resume.
- **Notification and the kill lever.** Monitoring runs `campaign:status` (read-only; its
  exit code mirrors the next tick's verdict, and the journal + schedule lines carry the
  state) and alerts on nonzero through whatever channel operates the monitoring box. The
  kill lever is `campaign:stop`, runnable from any box that reaches the store and holds a
  copy of the campaign manifest (its bytes are the campaign's identity).
- **The status surface.** `campaign:status` reports the authorization's classification,
  calls reserved vs cap and attempts actually started, reservations (labeled as
  reservations, never invoices), fires/claims/active leases, the escalation-latch state
  (unresolved fires), the tick journal — when the last tick ran, how it finished, and its
  detail (where a dispatched tick's deferrals-by-reason and installed fires live) — the
  schedule state under the same halt rule the tick refuses on, and the verdict the next
  tick would reach in the tick's own precedence. What only the tick itself can check —
  the publication evidence and the artifact-root half of the latch — is stated as such in
  the verdict line rather than silently assumed.

## Provider preflight (web search)

Every arm runs the declared web-search tool, so three provider-side conditions can fail a
run for reasons unrelated to the harness. Clear them with one cheap call per arm before
arming, not on the night:

1. **Anthropic** — web search can be disabled organization-wide in the Console, in which
   case any request carrying the tool returns 400. Fable 5 additionally requires 30-day
   data retention and is unavailable under zero-data-retention, which fails every request
   regardless of body.
2. **Google** — the grounding tool and this model are paid-tier only; a free-tier key fails
   regardless of body.
3. **All four** — confirm the declared tool block is accepted as written. The wire shapes
   were verified against current provider documentation, but documentation is not a live
   response: `yarn smoke:dry` exercises the harness without provider calls, so the first
   real acceptance is the first paid call.

Two behaviours to expect and NOT treat as harness faults:

- An Anthropic `pause_turn` (its server-side tool loop hit its iteration limit) or a
  provider refusal records that arm as `provider_error` with its usage retained, not as a
  schema failure. Continuation is deliberately disabled; enabling it is a money decision
  (`maxServerToolContinuations`, and re-deriving the per-attempt bound), not a hot fix.
- A fire whose search accounting is incomplete — a provider proving a search ran without
  letting the count be derived — escalates as unknown spend and halts the campaign. That is
  the money guard working; resume after reviewing the artifact.

## Operating a campaign

1. `campaign:arm --calls <n> --days <n> --start <ISO> --artifacts <dir>` (attended). The
   manifest file it emits is the campaign's identity — every later command needs that
   exact file. `--artifacts` is the campaign's durable evidence destination, bound for
   its lifetime: choose storage that survives the host lifecycle (a persistent mount,
   not ephemeral local disk), because a tick refuses to run when the root or its
   identity marker is lost.
2. Publish the manifest bytes to the public repository BEFORE `windowStart`, and write the
   publication descriptor JSON (`repositoryOwner`, `repositoryName`, `path`, the full
   40-hex `commitSha` of the publishing commit).
3. Schedule `campaign:tick --manifest <path> --publication <descriptor>` from cron — the
   tick takes no artifact flag; its root comes from the record. Environment:
   `STORE_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` (optionally
   `OSPEX_API_URL`), and the roster's provider credentials.
4. Point monitoring at `campaign:status --manifest <path>` and alert on nonzero exits.
5. On a halt: review (`campaign:status`, the journal detail, the artifact root), then
   `campaign:resume` to continue or `campaign:stop` to end the campaign. A stopped
   campaign is over — a cohort arms at most once, ever.
