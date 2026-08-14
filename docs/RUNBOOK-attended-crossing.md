# Runbook — the attended crossing

**Classification (fixed): `fixture-backed paid provider/store canary — not canonical benchmark evidence`.**

This document is the reviewed operating procedure for the FIRST paid invocation of
the line-open cohort runner: one attended, store-backed fire in which the four real
provider adapters (OpenAI, Anthropic, Google, xAI) are dispatched with real API
keys against the synthetic fixture candidate. It is executed by a human operator
at an interactive terminal, exactly once per attempt, with no automatic retry.

What it proves: real dispatch through the gated billable capability; real cohort
admission and the $800 reservation against a durable store; real artifact
production + durable install; the runtime spend guard pricing REAL provider
`usageRaw`; and the attended `[Y/n]` authorization chain end to end.

What it does NOT prove or authorize: canonical live-game discovery, public
manifest precommitment, real opening-line evidence, the non-serial cohort launch,
or any scale-up. Those each have their own separate gates. A successful crossing
authorizes nothing beyond itself.

---

## 0. The spend-evidence mechanism (a prerequisite, now in-tree)

The frozen evidence contract requires a redacted token-only `usageRaw` sidecar,
keyed to the fire/artifact id with its SHA-256 recorded, **for the first crossing
even when the spend guard passes cleanly** — the artifact deliberately carries
only NORMALIZED usage (three token counts per attempt), while the
provider-specific raw buckets (Google `thoughtsTokenCount`, OpenAI
`reasoning_tokens`, Anthropic cache fields, xAI additive reasoning) exist only in
the sidecar. Two §10 checks depend on those buckets: recomputing each attempt's
conservative derived cost, and the ≥1 real reasoning-field observation.

The mechanism satisfying this is in the tree:

- **Every BILLABLE fire durably installs the spend sidecar** (`*-spend.json`
  beside the artifact) — clean pass or escalation — keyed off the capability's
  `billingClass` in `runOneFire`, installed BEFORE settlement, with the sidecar
  path + sha256 carried on the fire's outcome and printed in the operator
  report. Known-zero (mock/fake) fires install none, so every default path is
  unchanged.
- **The deterministic offline PAIR verifier** the §10 spend recomputation uses:
  `yarn verify:sidecar <fire-artifact.json> <fire-spend.json>` — it verifies the
  durable artifact–sidecar PAIR, never the sidecar alone: the artifact is
  strict-parsed and digest-replay-verified with its existing owners and then
  serves as the relational witness (`artifact-binding` and
  `attempt-completeness` checks: exact identity, the frozen roster, exactly one
  matching row per sent attempt — no missing, duplicate, fabricated, or foreign
  rows), and every cost and the whole-fire verdict are recomputed with the exact
  runtime arithmetic at the code-pinned table (price-identity, reservation,
  aggregate-cap, record-consistency, reason, and reasoning-observation checks).
  Exit 0 IFF every named check passes.

- [ ] Confirm at the crossing commit: `yarn test` fully green and both mechanisms
      present (the billable-sidecar install and `yarn verify:sidecar`).

---

## 1. Roles and hard rules

- **Operator**: the repository owner, at the keyboard, in an INTERACTIVE
  terminal. **Never pipe or redirect the confirmation input.** The `[Y/n]`
  stdin semantics are exact: only a stream that closes WITHOUT producing a line
  is EOF (refused); a piped EMPTY LINE (`\n`) is an Enter, and Enter accepts
  the capital-Y default — **a piped newline AUTHORIZES the spend**. The
  interactive-terminal requirement is therefore an operating rule, not a
  convenience.
- **One invocation per attempt. No automatic retry of any kind.** A failed or
  escalated attempt is investigated and recorded before any human decision to
  attempt again (§9).
- The crossing spends real money. Everything before the `[Y/n]` prompt is free
  and repeatable; everything after typing `y`/Enter is a paid dispatch.
- Do not run any other process that can reach the provider keys during the
  crossing (see §5, legacy tools).

## 2. Machine and repository state

- [ ] `git status` clean; `main` checked out at the exact reviewed crossing
      commit. Record the commit SHA in the execution log (§11).
- [ ] `yarn install` from the committed lockfile; `yarn typecheck` clean;
      `yarn test` fully green at that commit.
- [ ] Confirm the crossing profile in code is the pinned one-fire shape
      (`CROSSING_PROFILE` in `src/crossingProfile.ts`): roster 4, one repair per
      arm, 8 max attempts, $100/attempt reservation, $800 spend cap = the
      one-fire reservation = the canary ceiling, call cap 8, concurrency 4, one
      dispatch per tick, `maxOutputTokens` 16000, provider timeout 300s,
      conservative guard price table (`prices-v4`) + digest.

## 3. Durable destinations (store + artifacts), with read-back

Dyno-local or otherwise ephemeral storage is NOT acceptable evidence storage.
Both destinations must survive the process and be readable afterwards.

- [ ] **Postgres**: create a dedicated durable database for the crossing (for
      example `ospex_crossing` on a local or managed Postgres — NOT the scratch
      conformance default). Set `STORE_DATABASE_URL` to it explicitly. The runner
      applies the store schema idempotently on boot (no destructive drop). This
      database is retained after the crossing as part of the evidence. A managed
      target is connected to over TLS automatically, and one that would end up
      unencrypted is refused — see `STORE_DATABASE_URL` in `.env.example` for the
      rules and the opt-out.
- [ ] **Artifacts**: choose an explicit durable directory OUTSIDE the repository
      scratch default and pass it via `--out` (or `FIRE_ARTIFACTS_DIR`). Verify
      you can create and read back a file in it before the crossing.
- [ ] **Dress rehearsal (zero spend)**: run the mock store-backed demo against
      the SAME store and artifact destinations first:

      yarn runner:fire --out <artifact-dir>

      This admits and settles one fire with mock adapters (no provider call, no
      spend), proving store connectivity, schema apply, budget init, artifact
      install, and read-back on the exact plumbing the crossing will use. Read
      the installed demo artifact back and confirm it parses. (The demo cohort
      has a different cohortId than the crossing cohort; its rows and artifact
      are inert leftovers and may stay.)

## 4. Credentials

- [ ] All four provider keys present in the environment or the local `.env`:
      `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (or its supported
      alias `GOOGLE_API_KEY`), `XAI_API_KEY`. The resolver and the gated
      producer independently probe each adapter's own credential check; any
      missing key refuses before the prompt.
- [ ] Each key belongs to an account the operator controls, with billing enabled
      and a spending limit the operator has reviewed. The expected invoice is
      well under $1, and the committed conservative worst-case TOKEN bound for
      the whole fire is ≈$219 (§8; search fees sit on top, and on Google/xAI
      they have no pre-dispatch cap) — set provider-side limits with that in
      mind; they are an independent backstop, not part of this protocol.
- [ ] No key material is ever committed, pasted into the execution log, or
      included in any artifact (the artifact and sidecar carry token counts and
      digests, never credentials — spot-check after the run, §7).

## 5. No competing live-capable processes

The legacy tools (`watch` — live by default, `smoke`, `preflight`) construct real
adapters outside the cohort gate and share the same keys.

- [ ] No `watch`/`smoke`/`preflight` or other repo process is running (check the
      process list for stray `node`/`tsx` processes and stop them).
- [ ] No scheduled task or terminal is positioned to start one during the run.

## 6. Pricing reconciliation (same day as the crossing)

The runtime guard prices at the conservative table `prices-v4`
(`src/modelPriceTable.ts`; reconciled 2026-08-10, including current OpenAI Fast
long-context rates and the per-search fees). Its job is to only ever
OVER-estimate. Reconcile it against the providers' CURRENT published pricing
pages immediately before the crossing:

| model | pinned conservative token rates (prices-v4; input/output per 1M tokens) | source page |
|---|---|---|
| `gpt-5.6-sol` | $25 / $90 | OpenAI API pricing (Fast long-context cache-write/input ceiling + output) |
| `claude-fable-5` | $10 / $50 | Anthropic API pricing |
| `gemini-3.1-pro-preview` | $4 / $18 | Google AI pricing (long-context tier) |
| `grok-4.5` | $4 / $12 | x.ai API pricing (long-context tier) |

- [ ] For each model, confirm the highest conservatively-reachable published
      tier is still ≤ the pinned rate. Record each page's rates + the check date
      in the execution log.
- [ ] **If any published rate now exceeds the pinned rate: STOP.** The table
      needs a conscious `prices-vN` edit and manifest re-pin (a reviewed code
      change) before any crossing.

## 7. Execution

Run from the repository root, in an interactive terminal:

    yarn runner:fire --live --out <artifact-dir>

(equivalently: `npx tsx src/cohortRunnerMain.ts --store=postgres --fixture
--live --out <artifact-dir>`, with `STORE_DATABASE_URL` set per §3).

Expected sequence — read each stage as it happens:

1. Banner: `STORE-BACKED LIVE CROSSING (postgres + fixture + --live)`.
2. The tri-state resolution validates the crossing pins and probes all four
   credentials. Any violation prints and the run exits `2` — nothing was
   spent, and re-running after a fix is free.
3. The exact terms print: the cohortId, the `$800.00` full-fire reservation
   ceiling, the 8-call cap, the one-fire limit. **Verify each against §2 before
   answering.** There is no time pressure at the prompt — the fixture's
   freshness clock anchors after the confirmation.
4. `proceed with the attended live crossing? [Y/n]` — Enter or `y`/`yes`
   proceeds; `n`, any other answer, or EOF (a stream closing without a line)
   refuses (exit `2`, nothing spent). **Answering affirmatively is the spend
   decision — and a piped empty line counts as Enter (§1), which is why this
   prompt is only ever answered interactively.**
5. The gated producer re-validates and mints the billable capability; the store
   opens; the cohort budget pins; the one fire dispatches — four concurrent
   initial requests, at most one repair per arm on an invalid response. Worst
   case wall time is bounded by two 300s waves (~10 minutes); typical is well
   under a minute.
6. The tick report prints: per-fire outcome, installed artifact path(s), and the
   exit code per §9. **Do not interrupt the process after answering `y`** —
   money may already be spent, and the install-then-settle ordering is what
   guarantees durable evidence; let it reach its own exit.

## 8. Expected cost

- **Expected invoice (an estimate, never a guarantee)**: each attempt sends
  ~1.5–2.5k input tokens and typically receives a few hundred output tokens →
  roughly $0.02–$0.05 per attempt at the pinned rates, ≈ **$0.25–$0.50 for the
  whole fire**.
- **The committed conservative worst-case bound** is the one in
  `docs/SPEND-BOUND-PROOF.md`, at the pinned `prices-v4` rates — note that
  Google `thoughtsTokenCount` and xAI reasoning tokens are ADDITIVE and are NOT
  bounded by `maxOutputTokens` (their bound is the model's own output
  envelope), so the visible-output cap alone does not bound the bill. Per
  attempt: OpenAI $37.77, Anthropic $56.40, Google $24.248320, xAI $8.00 —
  each under the $100 per-attempt reservation — giving a conservative
  full-fire TOKEN bound (two attempts per model) of **$252.836640**, well
  under the $800 reservation ceiling. Search fees are priced on top of these
  figures and are provider-capped only on OpenAI and Anthropic (see
  SPEND-BOUND-PROOF.md, "Web-search fees").
- **What the $100 guard is and is not**: it is a POST-DISPATCH control. It
  prices the RETURNED usage and, on any attempt over $100 or any attempt it
  cannot price, refuses settlement — escalating with durable evidence and
  stopping later admissions. It cannot stop an already-dispatched request from
  billing whatever the provider bills. The pre-dispatch protections are the
  committed per-attempt proof and the pinned cost-driver profile; $800 is the
  store's reservation ceiling, not the expected invoice; and provider-side
  account spending limits (§4) remain an independent backstop.

## 9. Outcome playbook

| Console outcome / exit | Meaning | Action |
|---|---|---|
| exit `2` before the prompt | Refused (pins/credentials/mode). Nothing spent. | Fix the named violations; re-run freely. |
| exit `2` at the prompt (declined/EOF) | Operator refused. Nothing spent. | Re-run freely when ready. |
| `Installed/settled`, exit `0` | **Runtime-clean CANDIDATE** — artifact durably installed, claim settled. Not yet an accepted crossing: the runtime exit cannot establish the sidecar hash, the per-attempt spend recomputation, the reasoning observation, or the store state. | Continue to §10; the crossing is ACCEPTED only when every §10 check passes. |
| `InstalledEscalated/spend_evidence_unknown` (or `.../spend_attempt_over_reservation`), exit `1` | Money was spent; at least one attempt could not be priced with confidence (typical cause: a provider timeout/429 returned no usage) or priced over the reservation. The artifact AND the redacted sidecar are durably installed (paths + sha256 printed); the claim + $800 reservation stay retained in the store. | **The crossing attempt FAILED — an UNKNOWN never passes.** Do not retry. Read the sidecar, identify the offending attempt(s), record everything in the log. A later fresh attempt is a new decision after review (each invocation boots a new cohort, so the store does not block it — the discipline is procedural, not mechanical). |
| `Installed/unsettled(...)`, exit `1` | Artifact durable; settlement unconfirmed against the store. | Do not re-run. Inspect the store's claim row for this fire first; reconcile deliberately. |
| `SpendGuardInternalError` thrown | A non-money bug escaped the guard AFTER dispatch; the artifact was installed first (its path is in the error). | Treat as a failed crossing AND a code defect: file it, fix it, re-review before any new attempt. |
| Artifact INSTALL failure after `y` (the process exits nonzero with an install error) | Requests may already be billed, but NO durable canonical artifact exists; the claim + $800 reservation stay retained in the store. Evidence state is incomplete. | **Failed crossing.** Inspect the durable store's claim row AND the artifact directory (including any temp files) FIRST; record everything in the log; no retry without review. |
| Spend-SIDECAR install failure (clean pass or escalation: artifact installed, sidecar write failed, nonzero exit; on a clean pass this refuses settlement — the claim stays retained) | The canonical artifact is durable but the raw token evidence is missing. | **Failed crossing.** Inspect the store + artifact directory first; record; no retry without review. |
| Any OTHER post-`y` exception or nonzero result not listed above | Spend and evidence state unknown. | **Failed crossing.** Same discipline: inspect the durable store + artifact destination first, record the attempt, and never retry blind. |
| Process interrupted/killed after `y` | Spend state unknown; evidence possibly incomplete. | Do not re-run. The store's claim state is the source of truth; inspect it and the artifact directory before anything else. |

## 10. Post-run verification (the acceptance — EVERY item is mandatory)

Runtime exit `0` is only a candidate pass. The crossing is ACCEPTED only when
every check below passes; any failed or UNPROVABLE item means the crossing
FAILED — it authorizes nothing, and any new attempt is a fresh reviewed
decision, never a retry.

- [ ] Runtime candidate: exit code `0`; exactly one fire outcome,
      `Installed/settled`; exactly one installed artifact path.
- [ ] **Artifact read-back**: open the installed `fire-*.json` from the durable
      directory. It parses; its `cohortId`/`fireId` equal the console report;
      every arm in the roster is present with a terminal outcome; every attempt carries
      normalized usage; no credential material appears anywhere in it.
- [ ] **Sidecar**: the `*-spend.json` exists beside the artifact (every billable
      fire installs one — §0); recompute its SHA-256 and confirm it equals the
      hash printed in the run's operator report; it contains token counts only.
- [ ] **Per-attempt spend + pair binding**: run
      `yarn verify:sidecar <fire-artifact.json> <fire-spend.json>` (§0) — the
      exact integer ceiling arithmetic against the artifact–sidecar pair, not a
      hand estimate. It must print `VERDICT: PASS` (artifact integrity + binding
      + attempt completeness against the artifact's own record of what was sent,
      every attempt priceable and within the $100 reservation, aggregate within
      the $800 cap, record consistent, whole-fire reason recomputed, reasoning
      observed). Record the per-attempt figures it prints in the log.
- [ ] **Reasoning observation**: at least one attempt shows a real nonzero
      reasoning/thinking token field in its raw buckets (e.g. Google
      `thoughtsTokenCount` or OpenAI `reasoning_tokens`).
- [ ] **Store**: the claim row for this fire is completed/settled; the cohort
      budget rows reflect exactly one fire's reservation consumed.
- [ ] File the completed execution log (§11) with the artifact + sidecar hashes.
      Label everything with the fixed classification at the top of this document.

## 11. Execution log (fill a copy per attempt; never include key material)

    date/time (UTC):
    operator:
    commit SHA (clean tree):
    typecheck/test at commit:            pass / fail
    prerequisite slice merged:           yes / no
    STORE_DATABASE_URL identity:         (host/db name only — no credentials)
    artifact directory:
    dress rehearsal (mock) run:          pass / fail, artifact read back: yes / no
    pricing recheck date + per-model published rates vs pinned:
    legacy processes checked:            none running
    terms printed — cohortId:
    answer given:
    outcome (kind + exit code):
    artifact path + sha256:
    sidecar path + sha256:
    per-attempt tokens + derived cost (from sidecar):
    reasoning-field observation (which arm/field/value):
    store claim state after:
    notes / anomalies:

## 12. After the crossing

A successful crossing closes exactly one question: the machinery spends real
money correctly, under the caps, with durable evidence. The next steps each have
their own separate reviews and are NOT unlocked by this run: the non-serial
cohort launch; the canonical live-data / public-manifest-precommitment gate
before any scale; and retiring the legacy watcher last.
