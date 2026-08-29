# Round 10 - Code vs Spec Adjudication

**Date:** 2026-07-15  
**Purpose:** Classify each Round 10 audit finding as primarily a code problem, a spec problem, or an architectural choice that needs an explicit decision.

---

## Overall Judgment

The repository's main issue is **implementation drift**, not that the game spec is fundamentally wrong.

My overall assessment is:

- the **game rules** and core **engine lifecycle concepts** in the spec are mostly sound
- most mismatches are caused by the code simplifying or reshaping the architecture without the spec being updated
- a few areas could be resolved either by changing code or by rewriting the spec, but those are design choices, not rule mistakes

In short: this repo is mostly suffering from **code not matching the intended contract**, not from a bad understanding of 6 Nimmt.

---

## Decision Table

| Finding | Primary issue | Recommended action | Confidence |
|---|---|---|---:|
| F1 - Round scoring lifecycle mismatch | Code | Change code | High |
| F2 - Missing paused row-pick API | Code, unless architecture intentionally changes | Change code | Medium-high |
| F3 - Missing `game-over` phase | Code | Change code | High |
| F4 - Visible-state contract drift | Mostly code | Change code | Medium |
| F5 - Missing engine validation utilities | Code | Change code | High |
| F6 - MCP shadow-board computation missing | Code | Change code | High |
| F7 - MCP session reconstruction drift | Code | Change code | High |
| F8 - Simulator / CLI row-choice misuse | Code | Change code | High |
| F9 - Headless-player lifecycle degradation | Code, with one possible spec clarification | Change code, optionally clarify spec | Medium |
| F10 - CLI/MCP edge-case contract drift | Code | Change code | High |

---

## Per-Finding Adjudication

## F1 - Round scoring lifecycle mismatch

**Call:** Code problem.

**Why:**

- The spec cleanly separates:
  - cards collected this round
  - cumulative score across rounds
  - game-over detection at round boundary
- That matches both the actual game structure and the rest of the documented API.
- The current implementation collapses these layers by adding penalty into `score` during `resolveTurn()`.

**Why I do not blame the spec:**

- `penaltyThisRound` in visible state only makes sense if round-local penalty remains distinct from cumulative score.
- the spec's `scoreRound()` semantics are coherent across engine, simulator, and CLI output expectations.

**Recommended action:** Change code to make `scoreRound()` perform scoring, preserve `collected` until next `dealRound()`, and gate `isGameOver()` at round end.

---

## F2 - Missing paused row-pick API

**Call:** Primarily a code problem, but this is the strongest candidate for an explicit architectural decision.

**Why:**

- The spec models rule 4 as a real mid-resolution pause point.
- That design is cleaner for:
  - immutable state transitions
  - visible-state projection
  - simulator orchestration
  - MCP/session workflows
- The current callback-based design is workable for a closed simulator, but it leaks complexity outward and is the root cause of several later mismatches.

**Why I do not call the spec wrong:**

- A forced row pick is genuinely a second decision point in the game.
- Modeling it explicitly is more faithful and composable than hiding it behind a callback.

**When the spec could be changed instead:**

- If you intentionally want a smaller engine API aimed only at in-process simulation, you could revise the spec to describe synchronous resolution with an injected row-pick callback.
- But that would require coordinated changes across `spec/engine.md`, `spec/simulator.md`, visible-state docs, and likely MCP assumptions.

**Recommended action:** Change code to match the spec unless you deliberately decide to simplify the public engine architecture.

---

## F3 - Missing `game-over` phase

**Call:** Code problem.

**Why:**

- The spec, MCP session model, and common game-lifecycle expectations all assume a terminal phase exists.
- The engine is the outlier here.

**Why I do not blame the spec:**

- terminal phase modeling is standard and useful
- it makes downstream consumers simpler and less error-prone

**Recommended action:** Add `game-over` to engine types and state transitions.

---

## F4 - Visible-state contract drift

**Call:** Mostly a code problem.

**Why:**

- The important semantic pieces in the spec are correct:
  - row-pick hand should exclude the already-played card
  - row-pick state should include the triggering card and turn reveal context
  - strategies benefit from round-start board context
- The code currently provides a different shape and weaker information.

**What is slightly debatable:**

- The exact representation of `initialBoardCards` could be either:
  - flat `CardNumber[]` of length 4
  - a board-like structure containing the 4 singleton rows
- That is a representation choice, not a game-rule issue.

**My judgment:**

- Even if you relaxed the `initialBoardCards` representation, the rest of the mismatch still points to code drift.

**Recommended action:** Change code to satisfy the current visible-state contract. If desired, separately decide whether `initialBoardCards` should remain a flat list or be generalized in the spec.

---

## F5 - Missing engine validation utilities

**Call:** Code problem.

**Why:**

- Shared validation functions in the engine are a good design requirement.
- They prevent CLI, MCP, and future consumers from drifting into incompatible validation behavior.
- The implementation simply never delivered the documented contract.

**Why I do not blame the spec:**

- the validation rules are reasonable and useful
- the spec clearly distinguishes hard errors from warnings

**Recommended action:** Implement validation in the engine and make CLI/MCP call it instead of partial ad hoc logic.

---

## F6 - MCP shadow-board computation missing

**Call:** Code problem.

**Why:**

- A session-aware recommendation system that accepts turn-resolution events must be able to advance its own shadow board from those events.
- That is exactly what the spec says.
- The current implementation only tracks the board when the client sends `boardAfter`, which weakens the whole session model.

**Why I do not blame the spec:**

- the spec here is not overreaching; it is defining the minimum needed for session integrity

**Recommended action:** Change code to validate/normalize `resolutions` and compute board transitions internally.

---

## F7 - MCP session reconstruction drift

**Call:** Code problem.

**Why:**

- The spec's requirements for state-aware recommendation are coherent:
  - preserve round-start context
  - respect row-pick input semantics
  - compare against the server's real shadow state
- The implementation uses shortcuts that make recommendations easier to produce but less trustworthy.

**Recommended action:** Change code. Do not weaken the spec unless you want to explicitly downgrade the promises made by session mode.

---

## F8 - Simulator / CLI row-choice misuse

**Call:** Code problem.

**Why:**

- These callers are manually compensating for the engine's current shape.
- In doing so, they construct row-choice states that violate the documented strategy contract.
- This is still a code bug even if it was caused upstream by engine architecture drift.

**Recommended action:** Change code after the engine row-pick lifecycle is settled.

---

## F9 - Headless-player lifecycle degradation

**Call:** Mostly a code problem, with one area where the spec may need clarification.

**Why it is code-side:**

- using `Math.random` instead of the provided deterministic RNG is plainly contrary to the documented strategy contract
- fabricating `triggeringCard` with a fallback sentinel is unsafe
- sending partial `onTurnResolved()` payloads without clearly describing them as degraded data is an implementation compromise

**Where the spec may be optimistic:**

- In real BGA play, it may not always be possible to reconstruct a fully faithful `TurnResolution` with exact attribution for every opponent card and resolution step.
- If that is a real operational limitation, the spec should explicitly define a degraded live-play mode rather than implicitly promising full parity.

**My judgment:**

- even if the spec gets a clarification, the current implementation still needs fixes

**Recommended action:**

- Change code now for deterministic RNG and better row-pick/state reconstruction.
- Optionally add a spec note later if full public-resolution reconstruction is impossible from BGA signals.

---

## F10 - CLI/MCP edge-case contract drift

**Call:** Code problem.

**Why:**

- mutual exclusivity of `--state` / `--state-file` is a normal CLI contract
- deterministic stateless reconstruction is a good requirement for reproducibility
- domain errors as normal tool results is a deliberate MCP design choice, not a mistake
- positive integer validation for `--games` is basic input hygiene

**Recommended action:** Change code.

---

## What I Believe the Spec Gets Right

These parts of the spec look substantively correct and should remain the source of truth:

- 6 Nimmt placement and overflow semantics
- end-of-round scoring and game-over-at-round-boundary semantics
- seeded deterministic shuffling and per-player seeded strategy RNG
- explicit visible-state separation between card choice and row choice
- shared engine-level validation utilities for all consumers
- MCP session shadow-state model

---

## What Could Reasonably Be Changed in the Spec

These are the only areas where I think a spec change is defensible if it reflects a deliberate architectural decision:

1. **Row-pick engine API**
   If you intentionally prefer callback-based synchronous resolution over paused immutable state transitions, the spec can be rewritten to match that design.

2. **`initialBoardCards` representation**
   If the codebase strongly prefers board-shaped data over a flat 4-card list, the spec could be loosened here.

3. **Headless live-play fidelity guarantees**
   If BGA does not expose enough information to reconstruct perfect turn-resolution history, the spec should say so explicitly and define the degraded contract.

None of those are game-rule corrections. They are interface-design decisions.

---

## Final Recommendation

Treat the Round 10 findings as **implementation drift first**.

Recommended stance:

1. keep the current spec as the baseline for engine lifecycle and visible-state semantics
2. fix code to match it for Findings F1, F3, F5, F6, F7, F8, and F10
3. for Findings F2, F4, and F9, make an explicit architecture decision rather than letting drift continue
4. if you choose to keep the current architecture in those areas, update all affected spec documents consistently instead of leaving mixed models in place

If forced to summarize in one sentence: **the repo's understanding of the game is mostly right, but the code has drifted away from the documented architecture more than the spec has drifted away from reality.**
