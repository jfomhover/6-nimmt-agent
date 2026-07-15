# Round 10 - Algorithmic Audit

**Date:** 2026-07-15  
**Scope:** Full repository audit, with primary focus on `src/engine/` and secondary review of CLI, simulator, MCP, and headless-player integrations  
**Method:** Spec-to-code audit against `spec/engine.md`, `spec/rules/6-nimmt.md`, `spec/cli.md`, `spec/simulator.md`, `spec/mcp.md`, `spec/strategies.md`, and relevant code docstrings. Verification commands run: `npm test`, `npm run build`, `npm run lint`.

---

## Executive Summary

The low-level 6 Nimmt placement logic is mostly sound: cattle-head scoring rules, row placement, overflow handling, per-round seed derivation, xoshiro256** usage, and Fisher-Yates shuffling all appear algorithmically correct.

The larger problem is contract conformance. The engine and several consumers do not implement the state machine and visible-state contracts described in the spec/docstrings. The biggest gaps are:

- round scoring happens at the wrong time
- the spec'd paused row-pick resolution API is not implemented
- visible-state shapes differ materially from the documented contract
- stateless validation/reconstruction is weaker than the spec requires
- MCP session state does not compute or validate shadow-board transitions as described

This repo does not look sloppy or random. It does, however, have several places where the implementation and the specification have drifted apart in ways that are material to correctness, especially for stateful strategies and external integrations.

## Verification Snapshot

- `npm test`: pass, 35 files / 471 tests
- `npm run build`: pass
- `npm run lint`: pass with 89 warnings, mostly `no-console` in scripts and CLI entry points, plus one missing return-type warning in `src/mcp/server.ts`

Important caveat: the passing test suite does not prove spec conformance here. Several tests encode current implementation behavior rather than the stricter API/lifecycle described in the spec.

---

## Findings

## F1 - Critical - Round scoring lifecycle does not match the spec

**Spec:**

- `PlayerState.score` is cumulative across rounds while `collected` holds this round's penalty cards until scoring time: `spec/engine.md:79-86`
- `dealRound()` resets `collected`, turns 1-10 are played, then `scoreRound()` adds `sum(cattleHeads(collected))` to cumulative `score`: `spec/engine.md:231-236`
- `isGameOver()` must be checked only after round scoring, never mid-round: `spec/engine.md:235`, `spec/engine.md:358-362`

**Code:**

- `resolveTurn()` computes penalty from collected cards and adds it directly into `score`: `src/engine/game.ts:190-191`, `src/engine/game.ts:207-209`, `src/engine/game.ts:236-241`
- `scoreRound()` does not score; it only increments `round` and resets `turn`: `src/engine/game.ts:265-281`
- `isGameOver()` checks scores directly, which now means game-over can become true mid-round: `src/engine/game.ts:286-287`

**Why this matters:**

- mid-round scores are observably different from the documented behavior
- the spec's `penaltyThisRound` concept cannot be represented cleanly
- terminal detection can happen before the round boundary, which the spec explicitly forbids

**Disposition:** spec/code mismatch with behavioral impact

## F2 - Critical - The engine does not implement the documented row-pick state machine

**Spec:**

- `resolveTurn()` must return either `{ kind: "completed" }` or `{ kind: "needs-row-pick" }`: `spec/engine.md:335-347`
- the engine must pause in `"awaiting-row-pick"` and resume via `applyRowPick()`: `spec/engine.md:240-249`, `spec/engine.md:349-356`
- `GameState` includes `pendingResolution` specifically for in-flight resolution: `spec/engine.md:101-106`, `spec/engine.md:134-142`

**Code:**

- `resolveTurn()` takes a synchronous `rowPickFn` and resolves rule 4 inline instead of pausing: `src/engine/game.ts:119-123`, `src/engine/game.ts:175-201`
- there is no `applyRowPick()` implementation exported at all: `src/engine/index.ts:36-45`
- the type model only includes `pendingRowPick`, not the spec's `PendingTurnResolution`, and that field is never actually used by `resolveTurn()`: `src/engine/types.ts:38-57`

**Why this matters:**

- the public engine API is not the API described in the spec/docstrings
- `toRowChoiceState()` exists, but the engine lifecycle never naturally produces the state it claims to project
- simulator/spec alignment is broken at the architectural level, not just by naming

**Disposition:** core API/lifecycle divergence

## F3 - High - The engine cannot represent the spec's `game-over` phase

**Spec:**

- `GamePhase` includes `"game-over"`: `spec/engine.md:111-116`
- after `scoreRound()`, any player at `>= 66` moves the state into `"game-over"`: `spec/engine.md:235`, `spec/engine.md:248-249`

**Code:**

- `GamePhase` omits `"game-over"`: `src/engine/types.ts:30-35`
- `scoreRound()` never sets a terminal phase: `src/engine/game.ts:265-281`

**Why this matters:**

- the engine state machine cannot express the terminal lifecycle that other layers are documented to consume
- this compounds F1, because terminal detection is detached from phase transition semantics

**Disposition:** missing lifecycle state

## F4 - High - Visible-state projections do not match the documented strategy contract

**Spec:**

- `CardChoiceState.playerScores` and `RowChoiceState.playerScores` are arrays of `{ id, score, penaltyThisRound }`: `spec/engine.md:154-170`, `spec/engine.md:178-200`
- `initialBoardCards` is the 4 cards that started the round: `spec/engine.md:168-169`, `spec/engine.md:192-193`
- `RowChoiceState.hand` excludes the triggering card, and row state also includes `initialBoardCards`, `triggeringCard`, `revealedThisTurn`, and `resolutionIndex`: `spec/engine.md:178-200`

**Code:**

- `playerScores` is a `Record<string, number>` with no `penaltyThisRound`: `src/engine/types.ts:111-134`, `src/engine/visible-state.ts:30-44`, `src/engine/visible-state.ts:76-92`
- `initialBoardCards` is stored as a full `Board`, not 4 card numbers: `src/engine/types.ts:55`, `src/engine/types.ts:119`, `src/engine/game.ts:62`, `src/engine/game.ts:113`
- `toRowChoiceState()` hardcodes `resolutionIndex: 0`, exposes the full current hand, and omits `initialBoardCards`: `src/engine/visible-state.ts:81-92`

**Why this matters:**

- strategies are not receiving the interface they were documented against
- stateful or reconstruction-heavy strategies can reason incorrectly from malformed row-pick context

**Disposition:** structural contract drift with algorithmic consequences for strategy behavior

## F5 - High - Engine validation utilities from the spec are missing, and CLI/MCP substitute weaker checks

**Spec:**

- the engine is supposed to expose `validateCardChoiceState()` and `validateRowChoiceState()`: `spec/engine.md:407-423`
- validation must enforce row count, row length, increasing rows, duplicate-card rules, player-count range, turn range, and decision-specific field rules: `spec/engine.md:425-447`
- CLI `recommend` is documented as reporting validation results based on those checks: `spec/cli.md:127-131`, `spec/cli.md:278-280`
- MCP stateless validation is documented to use the same engine validation functions: `spec/mcp.md:109`, `spec/mcp.md:414`

**Code:**

- there are no engine validation functions implemented; only the spec mentions them
- `src/cli/commands/recommend.ts` checks only field presence plus a few ad hoc warnings: `src/cli/commands/recommend.ts:10-45`, `src/cli/commands/recommend.ts:112-166`
- `src/mcp/tools/stateless.ts` performs partial structural checks but still does not implement the full engine-spec validation contract: `src/mcp/tools/stateless.ts:54-147`, `src/mcp/tools/stateless.ts:173-239`

**Why this matters:**

- malformed or inconsistent states can be labeled usable when the spec says they should fail validation
- CLI and MCP are no longer guaranteed to interpret state validity the same way as the engine

**Disposition:** missing spec-required API plus downstream behavior drift

## F6 - High - MCP `turn_resolved` does not compute or validate the shadow board as specified

**Spec:**

- `turn_resolved` accepts `boardAfter` optionally; if omitted, the server computes expected board state from prior state plus `resolutions`: `spec/mcp.md:243-247`
- invalid resolution ordering/card mismatch should return `INVALID_RESOLUTIONS`: `spec/mcp.md:259-269`, `spec/mcp.md:557`
- the server's shadow board must be maintained by applying `turn_resolved` resolution data: `spec/mcp.md:396-408`

**Code:**

- `turnResolved()` accepts the arrays as-is, with no normalization or legality validation: `src/mcp/session.ts:297-357`
- if `boardAfter` is omitted, the code stores `session.board` as `resolution.boardAfter` instead of computing the new board: `src/mcp/session.ts:350-357`
- the session board is updated only when `boardAfter` is explicitly supplied: `src/mcp/session.ts:366-369`

**Why this matters:**

- the session can drift silently even when the client follows the spec and omits `boardAfter`
- later `session_recommend` calls may use stale server state while claiming to be session-aware

**Disposition:** broken MCP state-accumulation contract

## F7 - High - `session_recommend` reconstructs visible state incorrectly

**Spec:**

- recommendations should use the session's accumulated lifecycle state and compare agent snapshot against server shadow state: `spec/mcp.md:328-408`
- row decisions require `triggeringCard`, `revealedThisTurn`, and `resolutionIndex`: `spec/mcp.md:337-343`
- row/board drift comparison is supposed to care about row assignment and card order, not only set membership: `spec/mcp.md:401-405`

**Code:**

- card recommendation synthesizes `initialBoardCards` from current row heads rather than preserving true round-start cards: `src/mcp/session.ts:521-531`
- row recommendations silently default missing row context and pass `turn: session.turn` while card recommendation uses `session.turn + 1`: `src/mcp/session.ts:544-555`
- drift detection uses symmetric difference over flattened card sets, ignoring row assignment and order: `src/mcp/session.ts:504-517`

**Why this matters:**

- strategies can be given impossible or incomplete visible state while the server reports only minor drift
- this is especially damaging for stateful strategies that depend on initial board context and turn-resolution reconstruction

**Disposition:** session-aware recommendation path is materially weaker than specified

## F8 - High - Simulator and CLI `play` misuse the engine's row-choice contract

**Spec:**

- simulator flow is documented as using engine resolution state and row-pick continuation semantics: `spec/simulator.md:80-93`
- `RowChoiceState.hand` must exclude the played card and include `initialBoardCards`: `spec/engine.md:178-200`

**Code:**

- both `src/sim/runner.ts` and `src/cli/commands/play.ts` manually build row-choice state from the pre-resolution `GameState` rather than using a spec-aligned engine pause/resume flow: `src/sim/runner.ts:67-95`, `src/cli/commands/play.ts:66-89`
- both pass the player's full current hand, which still includes the already-played triggering card: `src/sim/runner.ts:80-94`, `src/cli/commands/play.ts:77-88`
- both omit `initialBoardCards`: same sections above

**Why this matters:**

- strategies see an impossible state during rule-4 decisions
- simulator and CLI can appear internally consistent with the current engine while still violating the documented engine contract

**Disposition:** downstream misuse of row-pick semantics

## F9 - High - The headless player breaks strategy lifecycle semantics for stateful strategies

**Spec:**

- strategies requiring randomness must use seeded `rng` passed via `onGameStart()`, not `Math.random()`: `spec/strategies.md:25-31`, `spec/strategies.md:124-130`
- `onTurnResolved()` replay is supposed to provide full public turn resolution detail: `spec/strategies.md:33-40`, `spec/strategies.md:140-153`
- row-choice input should include the true triggering card and reveal context: `spec/engine.md:178-200`

**Code:**

- `playGame()` seeds strategies with `Math.random`: `src/player/loop.ts:130-137`
- row-pick state uses `lastPlayedCard ?? 1`, empty `revealedThisTurn`, empty `turnHistory`, and still omits initial-board context: `src/player/loop.ts:549-570`
- inferred `onTurnResolved()` data is partial and synthetic, with `playerId: 'unknown'`, empty `resolutions`, and empty `rowPicks`: `src/player/loop.ts:488-521`

**Why this matters:**

- stateful strategies running in the headless player are not receiving the contract they were written for
- deterministic replay expectations are broken for RNG-using strategies

**Disposition:** live-play integration is functional for simpler strategies, but not semantically faithful for the full strategy interface

## F10 - Medium - CLI/MCP edge cases diverge from documented contracts

**Spec:**

- exactly one of `--state` and `--state-file` must be supplied to `recommend`: `spec/cli.md:309-321`
- stateless recommend/reconstruction should use deterministic RNG: `spec/strategies.md:142-145`
- structured domain failures in MCP must be returned as tool results, not tool errors: `spec/mcp.md:532-545`
- `simulate --games` is an invalid-arguments surface and should reject malformed values: `spec/cli.md:29-36`, `spec/cli.md:251-280`

**Code:**

- CLI `recommend` silently prefers `--state` when both inputs are present: `src/cli/commands/recommend.ts:70-88`
- CLI `recommend` seeds RNG with `Date.now()`, which makes identical input states non-reproducible: `src/cli/commands/recommend.ts:123-131`
- MCP server marks domain errors with `isError: true`: `src/mcp/server.ts:196-205`, `src/mcp/server.ts:253-265`
- `simulate` parses `--games` but does not validate positivity/integer semantics before calling `runBatch()`: `src/cli/commands/simulate.ts:136-157`, `src/sim/batch.ts:17-27`

**Why this matters:**

- these are not core engine bugs, but they weaken reproducibility, caller self-correction, and spec compliance at system boundaries

**Disposition:** medium-severity interface/contract drift

---

## Correctness Strengths

The audit also found several areas that are implemented correctly and should be preserved:

- `cattleHeads()` matches the documented priority rules: `spec/engine.md:17-24`, `src/engine/card.ts:9-15`
- board placement picks the highest eligible lower tail, correctly distinguishes rule 4 from overflow, and overflows on the 6th card: `spec/rules/6-nimmt.md:36-43`, `spec/engine.md:375-389`, `src/engine/board.ts:17-45`, `src/engine/board.ts:53-76`
- per-turn card resolution is performed in ascending card order: `spec/rules/6-nimmt.md:43`, `src/engine/game.ts:159-160`, `src/engine/game.ts:175-228`
- PRNG/seed derivation/shuffle are aligned with the spec: `spec/engine.md:252-263`, `src/engine/prng.ts:19-24`, `src/engine/prng.ts:29-40`, `src/engine/prng.ts:68-75`, `src/engine/card.ts:31-33`

---

## Overall Verdict

The core card-placement algorithm is trustworthy. The repo's main weakness is not the low-level rules engine; it is the mismatch between the implemented state/lifecycle contracts and the documented ones.

If the standard for this round is "does the code work exactly as described in the spec and docstrings," the answer is no.

The highest-priority fixes are:

1. realign round scoring and game-over timing with `spec/engine.md`
2. either implement the documented paused row-pick engine API (`resolveTurn`/`applyRowPick`) or revise the spec to match the synchronous design
3. make `CardChoiceState` and `RowChoiceState` structurally match the documented contract everywhere
4. implement the spec'd validation utilities and route CLI/MCP through them
5. fix MCP shadow-state computation so session-aware recommendations are actually state-aware

Until those are addressed, the repo is usable, testable, and in some areas well-implemented, but it is not yet spec-exact.
