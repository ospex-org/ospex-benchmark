# Totals dispersion — `TOTALS_V1_PROVISIONAL`

*Last updated: 2026-07-14T16:10:16Z*

The published negative-binomial dispersion parameter for MLB game totals: the
single fitted scalar the totals ladder (`TOTALS_V1`) will consume to price
win/push probabilities at any line from a closing quote. This document is the
methodology record for how it was fit, what it was fit on, the checks it must
pass before it is published, and the approximations knowingly accepted in the
provisional version.

**Parameter artifact:** [`data/totals-dispersion-TOTALS_V1_PROVISIONAL.json`](../data/totals-dispersion-TOTALS_V1_PROVISIONAL.json)
— the machine-readable source of truth (full-precision values; this page
quotes rounded figures). The artifact is regenerated, never hand-edited: a
unit test recomputes every published number from the committed input datasets
and requires exact equality.

## Model

The final combined run total `T` of an MLB game is modeled as negative
binomial with mean `mu` and dispersion `k`:

```
Var(T | mu) = mu + mu^2 / k        (k -> infinity recovers Poisson)
```

The ladder solves `mu` per game from the closing quote (line + de-vigged
prices, push-conditioned at integer lines); `k` is the fitted scalar below.
A count model with more-than-Poisson variance is the standard choice for run
totals: runs arrive in correlated bunches (innings, home runs with runners
on), so `Var(T | mu) > mu` everywhere.

## Data

Two committed datasets, both regenerable by the scripts named below:

1. **Historical finals — Retrosheet game logs, MLB regular seasons
   2023–2025** ([`data/retrosheet-mlb-totals-2023-2025.ndjson`](../data/retrosheet-mlb-totals-2023-2025.ndjson),
   from `yarn ingest:retrosheet`). 7,289 games; the meta record pins the
   SHA-256 of each source archive. The window is the current rules era (2023
   introduced the pitch clock, shift limits, and larger bases) and all three
   seasons play extra innings under the placed-runner rule — the same regime
   2026 games settle under.

   > The information used here was obtained free of charge from and is
   > copyrighted by Retrosheet. Interested parties may contact Retrosheet at
   > "www.retrosheet.org".

2. **Our own captured closing totals**
   ([`data/inhouse-totals-2026-07-14.ndjson`](../data/inhouse-totals-2026-07-14.ndjson),
   from `yarn extract:totals`). Every MLB totals row of the production
   closing-line capture (927 lines, lock times 2026-05-05 through
   2026-07-12), read over the same public anon PostgREST path the scorer
   uses — any outside reproducer can fetch the identical rows. Records whose
   game has a latched final also carry it: these are the accruing
   `(closing total, prices, final)` pairs the non-provisional refit will use
   (45 pairs at snapshot time).

**Deliberately not used:** statsapi.mlb.com is prohibited for bulk pulls
(its terms allow only individual, non-commercial, non-bulk use), and the
odds feed retains results for only a few days, so a season-scale backfill of
paired lines+finals does not exist upstream. Retrosheet is the permitted
historical-finals path, and it carries innings information (`outs`), which
our own `games` rows do not.

## Fit method (provisional): moment decomposition

The ladder needs the *conditional* dispersion of `T` around the market's
per-game mean — not the marginal spread of totals across games, which mixes
in how much the means themselves vary. The provisional fit separates the two
with the law of total variance:

```
Var(T) = Var(mu) + E[Var(T | mu)]
```

- `Var(T)` and `mean(T)` come from the Retrosheet finals (marginal moments).
- `Var(mu)` is estimated by the sample variance of our captured closing
  total lines — the market's own per-game mean estimates.
- Under the model, `E[Var(T | mu)] = E[mu] + E[mu^2] / k`, and
  `E[mu^2] = mean^2 + Var(mu)` (the Jensen term is retained, not dropped).

Solving for the dispersion:

```
k = (mean^2 + Var(lines)) / (Var(T) - Var(lines) - mean)
```

**Selection (settlement basis).** Forfeits (0 in the window) and
rain-shortened games (under 51 outs; 12 games) are excluded — sportsbooks
void unresolved totals on shortened games. Extra innings are **included**:
totals bets settle on the actual final, and the placed-runner era is
consistent across fit window and deployment. A regulation-only variant
(51–54 outs) is published as a sensitivity row; it moves `k` by ~1.5%,
showing the fit is robust to that choice.

**Fail-closed gates.** The fit refuses to publish (throws) rather than emit
a suspect parameter when: fewer than 5,000 finals or 500 closing lines are
supplied; the decomposition leaves no overdispersion
(`Var(T) - Var(lines) <= mean`, which a negative binomial cannot represent);
or any push anchor (below) falls outside the gross-error band.

## Results (2026-07-14 fit)

| Quantity | Value |
| --- | --- |
| **`k` (primary, settlement basis)** | **8.101** |
| Retrosheet finals used | 7,277 (of 7,289; 12 shortened excluded, 0 forfeits) |
| Marginal mean / variance of totals | 8.975 / 20.270 |
| Closing-line mean / variance (n=927) | 8.549 / 1.204 |
| Conditional variance `E[Var(T\|mu)]` | 19.066 |
| `k` (regulation-only sensitivity, n=6,651) | 7.982 |
| Extra-innings games included | 626 |

**Push-rate anchor** — the fitted model's `P(T = L)` with the mean at the
line, for the integer lines MLB totals concentrate on. Market lore says
"roughly 8–10%"; the acceptance band is deliberately wider (6–12%) because
it exists to catch a grossly wrong dispersion, not to localize inside lore:

| Line | Model push probability |
| --- | --- |
| 7 | 10.86% |
| 8 | 9.85% |
| 9 | 9.02% |
| 10 | 8.32% |

Observational (not a fit input): of the 45 in-house pairs so far, 21 closed
on integer lines and 1 pushed.

**Marginal pmf check** (published evidence, not a gate): the fitted NB mixed
over our closing-line distribution — recentered so the mixture mean matches
the finals mean, isolating shape from the era gap — against the empirical
distribution of the 7,277 finals:

| T | Empirical | Model |
| --- | --- | --- |
| 4 | 4.70% | 6.47% |
| 5 | 9.91% | 8.08% |
| 6 | 7.24% | 9.14% |
| 7 | 11.19% | 9.56% |
| 8 | 7.26% | 9.40% |
| 9 | 10.00% | 8.77% |
| 10 | 6.64% | 7.85% |
| 11 | 7.39% | 6.78% |
| 12 | 5.08% | 5.68% |
| 13 | 5.83% | 4.64% |
| 14 | 3.39% | 3.70% |

The visible disagreement pattern is the **parity oscillation**: MLB games
cannot end tied, so even totals (which permit a tie through nine innings)
are systematically depleted into mostly-odd resolutions — empirically, odd
totals 7 and 9 are enriched and even totals 8 and 10 depleted by 1.5–2
percentage points relative to any smooth count model. A smooth NB cannot
reproduce this, and it matters exactly at the ladder's most sensitive
output: push probabilities at integer lines will run **high at even lines
and low at odd lines** by roughly that much. This is published rather than
smoothed over; whether TOTALS_V1 adds a parity adjustment is a refit-time
decision, to be judged against the accrued in-house pairs and the
alternate-line ladder validation planned for the ladder PR.

## Known approximations (accepted for the provisional fit)

1. **Closing line ≈ market mean.** The line is used as the per-game mean
   estimate; the skew implied by unequal over/under prices is ignored.
2. **Window mismatch.** Close spread comes from May–July 2026; marginal
   moments from full seasons 2023–2025. Seasonal coverage (no April in the
   close sample) and era drift (2026 runs ~0.4 below the window mean) both
   land in the subtraction.
3. **Over-subtraction of `Var(mu)`.** The closing-line variance includes
   market noise and 0.5-run line quantization on top of true mean variance,
   biasing the conditional variance slightly low (and `k` slightly high).
4. **Parity smoothness** — see the pmf check above.
5. **Constant `k`.** One dispersion scalar across all means; the MLE refit
   can test this.
6. **Walk-off truncation.** Home-team wins end mid-inning; the effect is in
   the marginal data but not modeled.

These are provisional-fit compromises, disclosed here and in the artifact's
`knownApproximations` field, and are exactly what the refit removes.

## Refit plan — `TOTALS_V1`

Once the accruing in-house pairs reach a workable sample (~300, expected
mid-August 2026): maximum-likelihood fit of `k` on
`(closing total, prices, final)` pairs conditional on the close-implied mean
— same reference feed as scoring, no window mismatch, no decomposition
approximations. The ladder stamps its parameter version on every scored row
(`TOTALS_V1_PROVISIONAL` vs `TOTALS_V1`), so history recomputes cleanly and
nothing is invalidated retroactively.

## Reproduction

```bash
# 1. Historical finals (downloads three ~460KB archives from retrosheet.org,
#    or point --from-dir at pre-downloaded copies):
yarn ingest:retrosheet --download

# 2. In-house closing totals + finals (public anon read; needs SUPABASE_URL
#    and SUPABASE_ANON_KEY in .env):
yarn extract:totals

# 3. The fit:
yarn fit:totals --inhouse data/inhouse-totals-<date>.ndjson
```

The fit is deterministic given the two input datasets — re-running changes
only `generatedAt`. `yarn test` includes an integrity test that recomputes
the committed artifact from the committed datasets and requires exact
equality, plus golden tests of the NB pmf against independently computed
reference values.
