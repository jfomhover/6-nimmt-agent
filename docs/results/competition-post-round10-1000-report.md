# Competition Report: Post-Round-10 1,000-Game Regression Check

> **Date:** 2026-08-29  
> **Code state:** PR #22, post-fix branch  
> **Games:** 1,000 complete games  
> **Duration:** 65.8 minutes  
> **Seed:** `competition-post-round10-2026-08-29`  
> **ELO:** Standard chess-style ELO, initial 1500, K=32, D=400, normalized by N−1  
> **Player range:** 3–6 per game, random and deterministic from the seed

This is the definitive post-fix comparison against [the previous 1,000-game report](competition-1000-report.md). The strategy pool, strategy options, player range, and ELO settings are identical.

Raw output: `competition-post-round10-1000-raw.json`.

---

## ELO Leaderboard

| Rank | Strategy | ELO | Recent-rating StdDev | Player-games |
|---:|---|---:|---:|---:|
| 1 | **`mcs-prior:mcPerCard=100`** | **1704** | ±34 | 503 |
| 2 | `mcs:mcPerCard=100` | 1704 | ±21 | 525 |
| 3 | `mcs:mcPerCard=50` | 1658 | ±30 | 482 |
| 4 | `bayesian-simple` | 1519 | ±26 | 456 |
| 5 | `dummy-max` | 1366 | ±34 | 488 |
| 6 | `random` | 1238 | ±14 | 506 |
| 7 | `dummy-min` | 1159 | ±24 | 498 |

MCS-Prior leads MCS-100 by only 0.3 ELO points, so they are effectively tied at this sample size. MCS-100 had the highest observed win rate.

---

## Performance Statistics

| Strategy | Win Rate | Avg Score | Median | Min | Max | StdDev | Avg Winning Score |
|---|---:|---:|---:|---:|---:|---:|---:|
| **`mcs:mcPerCard=100`** | **41.5%** | **32.1** | 29 | 0 | 87 | 17.8 | 20.8 |
| `mcs-prior:mcPerCard=100` | 35.7% | 38.6 | 35 | 0 | 113 | 19.7 | 25.6 |
| `mcs:mcPerCard=50` | 35.4% | 36.2 | 33.5 | 0 | 91 | 19.1 | 22.9 |
| `bayesian-simple` | 26.7% | 40.7 | 38 | 0 | 105 | 21.6 | 22.4 |
| `dummy-max` | 12.4% | 49.4 | 48 | 0 | 103 | 20.8 | 25.3 |
| `random` | 4.6% | 61.9 | 67 | 8 | 118 | 18.8 | 35.3 |
| `dummy-min` | 2.7% | 65.2 | 69 | 1 | 112 | 19.1 | 28.2 |

---

## Before/After Comparison

| Strategy | Previous ELO | Post-fix ELO | Previous rank | Post-fix rank | Previous avg score | Post-fix avg score |
|---|---:|---:|---:|---:|---:|---:|
| `mcs:mcPerCard=100` | 1597 | 1704 | 1 | 2* | 33.3 | 32.1 |
| `mcs:mcPerCard=50` | 1558 | 1658 | 2 | 3 | 36.6 | 36.2 |
| `mcs-prior:mcPerCard=100` | 1500 | 1704 | 3 | 1* | 37.5 | 38.6 |
| `bayesian-simple` | 1431 | 1519 | 4 | 4 | 43.1 | 40.7 |
| `dummy-max` | 1367 | 1366 | 5 | 5 | 48.2 | 49.4 |
| `random` | 1198 | 1238 | 6 | 6 | 61.8 | 61.9 |
| `dummy-min` | 1083 | 1159 | 7 | 7 | 66.0 | 65.2 |

\* MCS-Prior and MCS-100 are separated by less than one ELO point and should be treated as tied for practical purposes.

### Interpretation

1. **No clear regression:** MCS-100 remains the strongest strategy by win rate and average score, improving average score from 33.3 to 32.1.
2. **MCS-Prior remains competitive:** Its ELO rose from 1500 to 1704, but its average score is slightly higher than before. The ELO result is consistent with strong competitive performance, while the score result suggests it may benefit more from relative outcomes than raw self-score.
3. **MCS-50 remains strong:** It improves slightly on average score and retains third-place strength.
4. **Bayesian-simple improved modestly:** It remains fourth but its average score improved from 43.1 to 40.7.
5. **Baseline ordering remains stable:** `dummy-max > random > dummy-min` by ELO, win rate, and average score.
6. **The corrected engine is operationally sound:** all 1,000 games completed, including staged row-pick resolution, end-of-round scoring, and the corrected strategy lifecycle.

---

## Methodology

- Pool: `mcs-prior:mcPerCard=100`, `mcs:mcPerCard=100`, `mcs:mcPerCard=50`, `bayesian-simple`, `dummy-max`, `dummy-min`, `random`
- Each game randomly draws 3–6 seats with replacement from the pool.
- Game seeds and seat selection are deterministic from the competition seed.
- ELO uses pairwise decomposition of multiplayer results and normalization by N−1.
- Player-game statistics include only seats in games where the strategy was drawn.
- The 250-game report remains available as an earlier preliminary sanity check: `competition-post-round10-250-report.md`.

## Verdict

The definitive 1,000-game rerun shows **no evidence of a strategy regression after the Round 10 fixes**. Core ranking behavior remains stable, MCS-100 is still the strongest by observed win rate and average score, and all games complete successfully under the corrected lifecycle.
