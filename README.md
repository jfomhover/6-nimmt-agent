# 6-nimmt-agent

> A TypeScript engine and autonomous player for the card game [6 Nimmt!](https://en.wikipedia.org/wiki/6_nimmt!) — built to play live on [Board Game Arena](https://boardgamearena.com/gamepanel?game=sechsnimmt) and benchmark AI strategies against real humans.

---

## What is this?

6 Nimmt! is a deceptively simple card game: 104 cards, 4 rows on the table, everyone plays simultaneously. Your card goes to the nearest row tail lower than it — but if you land in the 6th slot, you take the whole row as penalty points. The lowest score wins.

The rules are fully deterministic. The interesting problem is **predicting where opponents will play** and avoiding the chaos.

This repo is a research project exploring that problem:

- 🎮 **Play autonomously** on BGA using Monte Carlo simulation with prior-based heuristics
- 📊 **Benchmark strategies** — random, Bayesian, MCS, MCS-Prior — against each other
- 📁 **Collect game data** in streaming JSONL for post-game analysis
- 🔬 **Iterate fast** — simulate 1000 games in seconds without touching a browser

---

## Quick start

```bash
npm install

# Simulate 1000 games: MCS-Prior vs 4 random players
npx tsx src/cli/index.ts simulate --strategies mcs-prior,random,random,random,random --games 1000

# Play live on BGA — log in and join a table in Chrome/Edge first, then:
npm run play -- --strategy mcs-prior --verbose
```

---

## Architecture

```
src/
├── engine/       Pure TypeScript game engine — rules, state, strategies
├── cli/          Simulate and benchmark strategies offline
├── sim/          Game runner for batch simulations
├── player/       Headless Playwright player for live BGA games
└── mcp/          MCP server for Copilot agent integration
```

The game loop is 100% deterministic — no LLM in the play path. The engine calls a strategy directly in-process. The Playwright player polls BGA's DOM every 500ms, reads card values from CSS sprites, and clicks via `el.click()` (Playwright's visibility checks don't work on BGA's animated elements).

---

## Strategies

| Strategy | Description |
|---|---|
| `random` | Uniform random — the baseline |
| `dummy-min` | Always plays the lowest card in hand |
| `dummy-max` | Always plays the highest card in hand |
| `bayesian-simple` | Expected-penalty minimisation over unseen card distribution |
| `mcs` | Monte Carlo Simulation — simulates random game completions |
| `mcs-prior` | MCS + prior-based heuristic + opponent modeling |

```bash
# Tune MCS-Prior options
npm run play -- --strategy mcs-prior:mcPerCard=200,timingWeight=0.3,trappedDiscount=0.3
```

---

## Strategy Leaderboard

Latest results from a 1,000-game competition tournament (3–6 players per game, random draws from pool). ELO: standard chess (initial=1500, K=32, D=400, normalized by N−1).

| Rank | Strategy | ELO | Win Rate | Avg Score |
|------|----------|-----|----------|-----------|
| 🥇 | `mcs:mcPerCard=100` | **1704** | 41.5% | 32.1 |
| 🥈 | `mcs-prior:mcPerCard=100` | 1704 | 35.7% | 38.6 |
| 🥉 | `mcs:mcPerCard=50` | 1658 | 35.4% | 36.2 |
| 4 | `bayesian-simple` | 1519 | 26.7% | 40.7 |
| 5 | `dummy-max` | 1366 | 12.4% | 49.4 |
| 6 | `random` | 1238 | 4.6% | 61.9 |
| 7 | `dummy-min` | 1159 | 2.7% | 65.2 |

> [Full report →](docs/results/competition-post-round10-1000-report.md)

---

## Documentation

| Doc | Description |
|---|---|
| [Getting Started](docs/getting-started.md) | Install, CLI, first live game |
| [Strategies](docs/strategies.md) | All strategies, options, benchmarking |
| [Headless Player](docs/headless-player.md) | Live BGA player in depth |
| [Simulator](docs/simulator.md) | Batch simulation and benchmarking |
| [Data Capture](docs/data-capture.md) | JSONL game log format |
| [Game Rules](spec/rules/6-nimmt.md) | 6 Nimmt! rules reference |
| [Contributing](CONTRIBUTING.md) | Setup, adding strategies, code style |

---

## Development

```bash
npm test          # Vitest test suite
npm run lint      # ESLint
npm run build     # tsc
```

---

## License

MIT
