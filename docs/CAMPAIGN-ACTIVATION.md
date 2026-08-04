# Campaign activation — what exists, what is structurally absent, and what must land before a scheduled tick may spend

Status as of this document: **scheduled campaign activation is structurally disabled.**
`campaign:arm` and `campaign:stop` are real and durable; `campaign:tick` validates the full
authorization chain and then refuses to dispatch (exit 3). No code path in
`src/campaignMain.ts` constructs a provider adapter, admits a claim, or reaches a dispatch —
the refusal is not a flag, it is the absence of the paid path from the entrypoint.

## What exists today

- **Arming** (`campaign:arm`, attended, once per cohort): requires an explicit
  offset-qualified `--start` — the campaign's identity anchor, which keeps the identical
  public command byte-identical across retries. It builds a bounds-checked campaign
  manifest sized in provider calls, prints the exact terms and cost projections, takes the
  standard `[Y/n]` confirmation, then performs the durable writes in **authority order** —
  the manifest file first (riding the fire-artifact sink's durable loop: a same-directory
  fsynced exclusive temp, an atomic no-clobber hard-link publication, a parent-directory
  sync where the platform supports one, then a final read-back), the cohort budget next
  (durable but not authorizing), and the durable authorization record **last**, as the
  single authorizing transition. A failed arm therefore cannot leave standing authority,
  cleanup failures cannot falsify a decided outcome, and re-running the same arm reconciles
  every intermediate failure — including an authorizing write whose commit status was lost.
  A cohort is armed at most once, ever; another campaign is a new manifest and therefore a
  new cohortId.
- **Ticking** (`campaign:tick`, unattended): reads the durable record, validates liveness at
  the tick clock, exact binding to the booted manifest (identity, roster, price identity,
  every cap), and a fresh independent credential observation — then refuses to dispatch.
  Exit 3 = validly armed, activation refused; exit 2 = no live authorization; exit 1 = loud
  failure. A valid authorization deliberately does **not** exit 0, so a scheduler pointed at
  this build notices instead of no-op looping.
- **Stopping** (`campaign:stop`): stamps `disarmedAt` inside the record (first stop wins,
  row never deleted). The next tick resolves nothing.
- **The hard money bound** is unchanged and independent of all of the above: the store's
  cohort call/spend caps are enforced inside a row lock (`admit_dispatch`), so even a wrong
  authorization layer cannot spend past what arming fixed.

## Why the tick refuses — the two missing load-bearing pieces

### 1. Real publication evidence

The cohort runner requires a `PublicationVerified` record binding the manifest bytes to a
public-Git precommitment. The only resolver in the tree today is the **rehearsal
self-resolver**, which supplies an all-zeros commit SHA, a synthetic path, and a manufactured
committer timestamp. That is honest for a zero-spend rehearsal and for the single attended
crossing fire (where a human read the terms of that exact invocation), and it is **not
acceptable evidence for a recurring unattended paid path**: it would let every scheduled fire
carry publication-shaped evidence no public lookup ever produced.

Before activation, a scheduled tick must:

- require a strict external publication descriptor — real repository, path, full commit
  SHA — and resolve it against public Git;
- verify byte-equality of the published blob with the local manifest, cohortId equality, and
  the committer-timestamp-before-`windowStart` rule;
- **reject the zero/synthetic rehearsal descriptor with zero provider calls**, proven by
  negative tests at both the unit and public-CLI level.

**Status of this piece:** the machinery exists and is wired, verification-first. The
concrete resolver (`GitHubPublicationResolver` — commits endpoint for the committer
instant with a sha-echo substitution guard, raw host for the exact blob bytes, fail-closed
on every non-OK/shape/timeout path) feeds the pure `verifyPublication` core, and
`campaign:tick --publication <descriptor.json>` verifies the precommitment before its
authorization validation: any failure — including a network failure or the all-zeros
rehearsal commit, which is rejected structurally before any resolution — refuses the tick.
What remains for activation is exactly one tightening: the descriptor becomes **required**
(a tick without one refuses instead of reporting "not configured").

### 2. A durable escalation latch

A spend-guard escalation means the spend model is not holding; it must not be able to repeat
on the next scheduled invocation. A "disarm after the tick result" write is **best-effort** —
if that single write fails transiently, the authorization stays live and a cron-style
scheduler runs again regardless of the previous exit code. Activation therefore requires an
escalation latch that is:

- **durable at escalation time** (recorded transactionally with, or derivable from, the
  installed escalation evidence itself — not a separate afterthought write), and
- **checked before every dispatch**, so that installed escalation + a failed disarm + a
  process restart still cannot reach another provider call.

The acceptance test for this piece is exactly that sequence: force an installed escalation,
fail the disarm write, restart, tick again — and prove no provider call is reachable.

## What the scheduler itself must specify before activation

- Halt semantics: the scheduler stops scheduling on **any nonzero or unknown** tick outcome
  and requires human re-arming to resume.
- Ownership of notification (who is told, on what channel) and of the kill lever
  (`campaign:stop` from a different box than the runner).
- A status surface so monitoring reads state instead of inferring it from logs. The
  durable-state half exists: `campaign:status` (read-only) reports the authorization's
  classification, calls reserved vs cap and attempts actually started, reservations
  (labeled as reservations, never invoices), fires/claims/active leases, and the verdict
  the next tick would reach. The per-tick half — when the last tick ran and deferrals
  grouped by reason — requires the scheduler's durable tick journal and lands with it.

## How activation flips

One well-marked change in `tickCampaign`: replace the refusal with the real tick input
assembly (publication resolution, gated capability mint, store-backed claim port, artifact
sink), landed **together with** the two pieces above and their tests — never before. The
gated campaign capability producer (`gateRealCampaignAdapterCapability`) already exists and
is fully tested; it is deliberately not reachable from any entrypoint in this build.
