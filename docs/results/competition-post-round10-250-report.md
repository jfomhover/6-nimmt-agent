# Competition Report: Post-Round-10 Regression Check

> **Date:** 2026-08-29  
> **Code state:** PR #22, commit `61062f9` plus the subsequent passing test/doc fixes  
> **Games:** 250 complete games  
> **Duration:** 18.0 minutes  
> **Seed:** `competition-post-round10-250-2026-08-29`  
> **ELO:** Standard chess-style ELO, initial 1500, K=32, D=400, normalized by N−1  
> **Player range:** 3–6 per game, random and deterministic from the seed

This is a post-fix regression check against [the previous 1,000-game report](competition-1000-report.md). The pool, strategy options, player range, and ELO settings are identical. The sample is smaller, so the absolute ELO values and rank deltas should not be treated as a statistically equivalent replacement for the 1,000-game baseline.

---

## Strategy Pool

| # | Strategy | Configuration |
|---|---|---|
| 1 | `mcs-prior:mcPerCard=100` | Prior-informed MCS, 100 rollouts/card |
| 2 | `mcs:mcPerCard=100` | Plain MCS, 100 rollouts/card |
| 3 | `mcs:mcPerCard=50` | Plain MCS, 50 rollouts/card |
| 4 | `bayesian-simple` | Uniform unknown-pool Monte Carlo |
| 5 | `dummy-max` | Always plays highest card |
| 6 | `dummy-min` | Always plays lowest card |
| 7 | `random` | Uniform random card selection |

---

## ELO Leaderboard

| Rank | Strategy | ELO | Recent-rating StdDev | Player-games |
|---:|---|---:|---:|---:|
| 1 | **`mcs:mcPerCard=100`** | **1695** | ±32 | 132 |
| 2 | `mcs-prior:mcPerCard=100` | 1623 | ±28 | 128 |
| 3 | `mcs:mcPerCard=50` | 1599 | ±20 | 125 |
| 4 | `bayesian-simple` | 1533 | ±30 | 111 |
| 5 | `dummy-max` | 1453 | ±31 | 123 |
| 6 | `random` | 1266 | ±15 | 129 |
| 7 | `dummy-min` | 1198 | ±64 | 110 |

---

## Performance Statistics

| Strategy | Win Rate | Avg Score | Median | Min | Max | StdDev | Avg Winning Score |
|---|---:|---:|---:|---:|---:|---:|---:|
| **`mcs:mcPerCard=100`** | **44.1%** | **31.5** | 29 | 0 | 83 | 18.4 | 19.8 |
| `mcs-prior:mcPerCard=100` | 36.5% | 37.5 | 35 | 0 | 86 | 19.0 | 24.4 |
| `mcs:mcPerCard=50` | 35.7% | 37.9 | 33 | 8 | 83 | 19.6 | 24.2 |
| `bayesian-simple` | 22.4% | 44.2 | 41.5 | 0 | 90 | 21.5 | 22.2 |
| `dummy-max` | 14.0% | 50.1 | 51.5 | 3 | 103 | 22.2 | 26.7 |
| `random` | 3.8% | 62.7 | 67 | 11 | 96 | 18.0 | 32.2 |
| `dummy-min` | 0.7% | 65.6 | 69 | 18 | 108 | 19.6 | 18.0 |

---

## Comparison With Previous Report

| Strategy | Previous ELO (1000 games) | Post-fix ELO (250 games) | Previous rank | Post-fix rank | Previous avg score | Post-fix avg score |
|---|---:|---:|---:|---:|---:|---:|
| `mcs:mcPerCard=100` | 1597 | **1695** | 1 | 1 | 33.3 | **31.5** |
| `mcs-prior:mcPerCard=100` | 1500 | **1623** | 3 | 2 | 37.5 | **37.5** |
| `mcs:mcPerCard=50` | 1558 | 1599 | 2 | 3 | 36.6 | 37.9 |
| `bayesian-simple` | 1431 | 1533 | 4 | 4 | 43.1 | 44.2 |
| `dummy-max` | 1367 | 1453 | 5 | 5 | 48.2 | 50.1 |
| `random` | 1198 | 1266 | 6 | 6 | 61.8 | 62.7 |
| `dummy-min` | 1083 | 1198 | 7 | 7 | 66.0 | 65.6 |

### Interpretation

1. **No clear strength regression:** Plain MCS-100 remains the winner and improved its observed average score from 33.3 to 31.5. Its ELO also increased, although the different seed and smaller sample prevent treating +98 ELO as a measured code improvement.
2. **MCS-Prior remains competitive:** It moved ahead of MCS-50 in this sample and matched its previous average score. That is consistent with the corrected round-local strategy state and lifecycle behavior, but the rank difference is not conclusive at 250 games.
3. **Bayesian-simple remains stable:** It retained fourth place with nearly the same average score as before. The round-memory reset did not produce an obvious regression.
4. **Baseline ordering is unchanged:** `dummy-max > random > dummy-min` remains intact.
5. **The result is a regression signal, not a benchmark replacement:** The previous report used 1,000 games; this run used 250 because the corrected MCS lifecycle is substantially more expensive. A future 1,000-game run should be used for final rating estimates if exact statistical comparability is required.

---

## Execution Notes

- The exact 1,000-game post-fix command was attempted with the same pool and settings.
- It reached 750/1,000 games after approximately one hour but timed out before producing a complete aggregate result, so it is intentionally excluded from the tables above.
- The reported 250-game run completed all games and produced the JSON metrics used in this document.
- All strategies used the corrected engine lifecycle, including staged row picks and end-of-round scoring.

## Verdict

The post-fix competition shows **no evidence of a strategy-strength regression**. The relative ordering is stable, MCS-100 remains dominant, and the corrected lifecycle completes all games without invariant failures. The smaller sample and high MCS runtime mean this should be read as a sanity check rather than a statistically definitive re-rating.
