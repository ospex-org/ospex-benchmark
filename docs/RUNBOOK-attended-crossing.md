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

## 0. Prerequisite code slice (must merge BEFORE this runbook is executable)

The frozen evidence contract requires a redacted token-only `usageRaw` sidecar,
keyed to the fire/artifact id with its SHA-256 recorded, **for the first crossing
even when the spend guard passes cleanly**. As merged, `runOneFire` installs the
sidecar only on a spend-guard ESCALATION; a clean pass installs the artifact
alone, and the artifact deliberately carries only NORMALIZED usage (three token
counts per attempt) — the provider-specific raw buckets (Google
`thoughtsTokenCount`, OpenAI `reasoning_tokens`, Anthropic cache fields, xAI
additive reasoning) exist only in the sidecar. Two crossing checks depend on
those raw buckets: recomputing each attempt's conservative derived cost, and the
≥1 real reasoning-field observation (§7.5).

**Proposed slice (small, to be reviewed on its own):** a BILLABLE fire always
builds and installs the spend sidecar — clean pass or escalation — keyed off the
capability's `billingClass` in `runOneFire`, with the sidecar path + sha256 added
to the clean `Installed` outcome's operator report. Known-zero fires remain
sidecar-free, so every default/mock/test path is byte-identical. Do not execute
this runbook until that slice (or an equivalent agreed mechanism) is merged.

- [ ] Prerequisite slice merged; `yarn test` green at the crossing commit.

---

## 1. Roles and hard rules

- **Operator**: the repository owner, at the keyboard, in an interactive terminal
  (the confirmation reads stdin; a piped/headless stdin sees EOF and refuses).
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
      conservative guard price table (`prices-v2`) + digest.

## 3. Durable destinations (store + artifacts), with read-back

Dyno-local or otherwise ephemeral storage is NOT acceptable evidence storage.
Both destinations must survive the process and be readable afterwards.

- [ ] **Postgres**: create a dedicated durable database for the crossing (for
      example `ospex_crossing` on a local or managed Postgres — NOT the scratch
      conformance default). Set `STORE_DATABASE_URL` to it explicitly. The runner
      applies the store schema idempotently on boot (no destructive drop). This
      database is retained after the crossing as part of the evidence.
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
      and a spending limit the operator has reviewed. Expected spend is well
      under $5 (§8); provider-side limits are an independent backstop, not part
      of this protocol.
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

The runtime guard prices at the conservative table `prices-v2`
(`src/modelPriceTable.ts`), snapshotted 2026-07-23. Its job is to only ever
OVER-estimate. Reconcile it against the providers' CURRENT published pricing
pages immediately before the crossing:

| model | pinned prices-v2 (input/output per 1M tokens) | source page |
|---|---|---|
| `gpt-5.6-sol` | $12.50 / $60 | openai.com API pricing |
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
   proceeds; `n`, any other answer, or EOF refuses (exit `2`, nothing spent).
   **Answering affirmatively is the spend decision.**
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

- Realistic: each attempt sends ~1.5–2.5k input tokens and receives a few
  hundred output tokens → roughly $0.02–$0.05 per attempt at the pinned rates,
  ≈ **$0.25–$0.50 for the whole fire**.
- Bounded: even if all 8 attempts exhausted the 16000-token output cap, the
  total at pinned rates is under ~$5. The runtime guard independently
  hard-stops any single attempt that prices over $100, and the store reserves
  exactly $800 for the fire — the ceiling, not the bill.

## 9. Outcome playbook

| Console outcome / exit | Meaning | Action |
|---|---|---|
| exit `2` before the prompt | Refused (pins/credentials/mode). Nothing spent. | Fix the named violations; re-run freely. |
| exit `2` at the prompt (declined/EOF) | Operator refused. Nothing spent. | Re-run freely when ready. |
| `Installed/settled`, exit `0` | **The clean crossing.** Artifact durably installed, claim settled. | Proceed to §10 verification. |
| `InstalledEscalated/spend_evidence_unknown` (or `.../spend_attempt_over_reservation`), exit `1` | Money was spent; at least one attempt could not be priced with confidence (typical cause: a provider timeout/429 returned no usage) or priced over the reservation. The artifact AND the redacted sidecar are durably installed (paths + sha256 printed); the claim + $800 reservation stay retained in the store. | **The crossing attempt FAILED — an UNKNOWN never passes.** Do not retry. Read the sidecar, identify the offending attempt(s), record everything in the log. A later fresh attempt is a new decision after review (each invocation boots a new cohort, so the store does not block it — the discipline is procedural, not mechanical). |
| `Installed/unsettled(...)`, exit `1` | Artifact durable; settlement unconfirmed against the store. | Do not re-run. Inspect the store's claim row for this fire first; reconcile deliberately. |
| `SpendGuardInternalError` thrown | A non-money bug escaped the guard AFTER dispatch; the artifact was installed first (its path is in the error). | Treat as a failed crossing AND a code defect: file it, fix it, re-review before any new attempt. |
| Process interrupted/killed after `y` | Spend state unknown; evidence possibly incomplete. | Do not re-run. The store's claim state is the source of truth; inspect it and the artifact directory before anything else. |

## 10. Post-run verification (the acceptance, checked in order)

- [ ] Exit code `0`; exactly one fire outcome, `Installed/settled`; exactly one
      installed artifact path.
- [ ] **Artifact read-back**: open the installed `fire-*.json` from the durable
      directory. It parses; its `cohortId`/`fireId` equal the console report;
      all four arms are present with terminal outcomes; every attempt carries
      normalized usage; no credential material appears anywhere in it.
- [ ] **Sidecar** (via the §0 slice): the `*-spend.json` exists beside the
      artifact; recompute its SHA-256 and confirm it equals the recorded hash;
      it contains token counts only.
- [ ] **Per-attempt spend**: from the sidecar's raw token buckets and the pinned
      `prices-v2` rates, recompute each billable attempt's conservative cost.
      Every attempt strictly under $100; the aggregate under $800. Record the
      per-attempt figures in the log.
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
