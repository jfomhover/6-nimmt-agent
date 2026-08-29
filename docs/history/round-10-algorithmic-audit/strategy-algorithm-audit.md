# Round 10 - Strategy Algorithm Audit

**Date:** 2026-07-15  
**Scope:** `src/engine/strategies/` implementations audited against `spec/strategies.md`, `spec/strategies/dummies.md`, `spec/strategies/bayesian.md`, `spec/strategies/mcs.md`, `spec/strategies/mcs-prior.md`, `spec/strategies/card-priors.md`, and relevant in-file docstrings.

---

## Executive Summary

The strategy layer is in better shape than the engine lifecycle layer.

Most implementations are directionally correct and, in several cases, quite faithful to their documented algorithms. The strongest confirmed issue is in `bayesian-simple`: it carries `seenCards` across rounds, which is wrong for a game where the full deck is regenerated every round. There is also a reproducibility contract problem: several stochastic strategies silently fall back to `Math.random()` instead of requiring the seeded RNG promised by the strategy spec.

Outside those points, the biggest gaps are not "this algorithm is wrong" but "this implementation is a simpler variant than the richer spec wording suggests." That matters for documentation accuracy, but it is a different class of problem from a broken strategy.

---

## Findings

## S1 - High - `bayesian-simple` carries round-local card memory across rounds

**Spec:**

- the Bayesian strategy's unknown pool is derived from current visible information for the round: `spec/strategies/bayesian.md:25-33`
- round-start prior depends on remaining hand slots in the current round: `spec/strategies/bayesian.md:49-54`
- tracked state is framed as current-round inference state: `spec/strategies/bayesian.md:173-177`
- `mcs-prior` explicitly notes that `seenCards` resets each round because cards can reappear across rounds: `spec/strategies/mcs-prior.md:180-184`

**Code:**

- `bayesian-simple` stores persistent `seenCards`: `src/engine/strategies/bayesian.ts:94-97`
- `seenCards` is reset only in `onGameStart()`, not in `onRoundStart()`: `src/engine/strategies/bayesian.ts:102-106`
- `onTurnResolved()` continually adds observed cards: `src/engine/strategies/bayesian.ts:108-125`
- `chooseCard()` removes all `seenCards` from the unknown pool: `src/engine/strategies/bayesian.ts:132-149`

**Why this matters:**

- in 6 Nimmt, cards absolutely can reappear in later rounds because the deck is fully regenerated
- after one or more rounds, this strategy will treat many legal cards as impossible for opponents to hold
- that corrupts opponent-hand sampling and therefore the strategy's expected-penalty estimates

**Judgment:** definite algorithmic bug in the code

---

## S2 - Medium - Stochastic strategies do not fully enforce the seeded-RNG contract

**Spec:**

- strategies requiring randomness must use the `rng` from `onGameStart()`, not `Math.random()`: `spec/strategies.md:83-90`, `spec/strategies.md:124-130`
- stateless reconstruction is documented to call `onGameStart()` with deterministic RNG before use: `spec/strategies.md:142-145`

**Code:**

- `bayesian-simple` initializes `rng` to `Math.random`: `src/engine/strategies/bayesian.ts:93-95`
- `mcs` initializes `rng` to `Math.random`: `src/engine/strategies/mcs.ts:99-104`
- `mcs-prior` initializes `rng` to `Math.random`: `src/engine/strategies/mcs-prior.ts:303-309`
- by contrast, `random` explicitly throws if `onGameStart()` was not called: `src/engine/strategies/random.ts:15-20`

**Why this matters:**

- when lifecycle wiring is correct, this bug is latent
- when lifecycle wiring is imperfect, these strategies become nondeterministic instead of failing fast
- that violates the stated reproducibility contract and makes debugging harder

**Judgment:** real spec/code mismatch, though lower impact than S1 because it depends on caller behavior

---

## S3 - Low - `bayesian-simple` is a lighter-weight Monte Carlo estimator than the richer Bayesian spec suggests

**Spec:**

- the full document describes per-card, per-opponent location beliefs and Bayesian updates: `spec/strategies/bayesian.md:39-73`
- later, the same spec recommends starting with simple uniform tracking: `spec/strategies/bayesian.md:73`, `spec/strategies/bayesian.md:140-145`, `spec/strategies/bayesian.md:173-177`

**Code:**

- the implementation tracks only `seenCards`, not explicit card-location distributions or per-opponent belief state: `src/engine/strategies/bayesian.ts:96-97`
- opponent hands are sampled uniformly from a shared unknown pool: `src/engine/strategies/bayesian.ts:157-177`
- the file docstring openly says this is Monte Carlo sampling rather than full Bayesian inference: `src/engine/strategies/bayesian.ts:4-11`

**Why this matters:**

- the implementation is simpler than the early sections of the spec might lead a reader to expect
- however, it does align with the spec's explicit `bayesian-simple` variant and "start with simple uniform tracking" recommendation

**Judgment:** documentation/spec nuance issue, not a strong code defect

---

## S4 - Low - `mcs-prior` relative scoring is only partially relative at the heuristic leaf

**Spec:**

- MCS-Prior is described as choosing the card with lowest average score relative to opponents: `spec/strategies/mcs-prior.md:14-22`
- default scoring mode is `relative`: `spec/strategies/mcs-prior.md:82-104`

**Code:**

- relative scoring subtracts average opponent penalty from our own penalty total: `src/engine/strategies/mcs-prior.ts:311-317`
- heuristic leaf evaluation is added only to `penalties[0]`, not to simulated opponent evaluations: `src/engine/strategies/mcs-prior.ts:378-385`, `src/engine/strategies/mcs-prior.ts:433-437`

**Why this matters:**

- the final score is "relative" in a limited sense
- the heuristic future estimate is asymmetric, because only our remaining hand is evaluated heuristically
- that is probably intentional, but it is not a fully symmetric relative leaf evaluation

**Judgment:** acceptable approximation unless the spec intends strict symmetry

---

## S5 - Low - Plain `mcs` implements the simplified random-playout variant, not the broader MCS family described earlier in the spec

**Spec:**

- the spec discusses MCS, PolicyMCS, and PUCT/Alpha0.5 variants: `spec/strategies/mcs.md:71-95`
- but it also explicitly carves out a simplified initial implementation using random playouts: `spec/strategies/mcs.md:106-154`

**Code:**

- `mcs` options include `mcPerCard`, `mcMax`, and `scoring`, but not PUCT/neural-policy machinery: `src/engine/strategies/mcs.ts:16-23`
- simulation uses sampled opponent hands and random card choice throughout playouts: `src/engine/strategies/mcs.ts:32-70`, `src/engine/strategies/mcs.ts:139-178`, `src/engine/strategies/mcs.ts:180-242`

**Why this matters:**

- someone reading only the early sections of the spec could expect a more advanced search variant
- the implementation is still consistent with the spec's explicit simplified-MCS section

**Judgment:** intentional simplification, not a defect

---

## S6 - Low - Prior-table provenance comment is weaker than the strategy spec

**Spec:**

- prior data is documented as derived from 1310 MCS-vs-MCS training games: `spec/strategies/mcs-prior.md:105-107`
- card-prior generation is described as coming from strong MCS self-play: `spec/strategies/card-priors.md:9-12`

**Code:**

- `prior-table.ts` says only "1310 games (5 players, strategy: mcs)": `src/engine/strategies/prior-table.ts:1-3`

**Why this matters:**

- this is doc precision, not algorithm correctness
- the table schema and usage appear consistent with the strategy docs

**Judgment:** documentation drift only

---

## Areas That Appear Faithful

## A1 - `random` is faithful to the spec

**Spec:** `spec/strategies.md:83-90`  
**Code:** `src/engine/strategies/random.ts:5-43`

Why it looks right:

- card choice uses the seeded `rng` supplied via `onGameStart()`
- row choice is greedy fewest-cattle-heads
- tie-breaking is deterministic by first-minimum row index due to iteration order

## A2 - `dummy-min` and `dummy-max` are faithful to the dummies spec

**Spec:** `spec/strategies/dummies.md:7-29`  
**Code:** `src/engine/strategies/dummy.ts:13-55`

Why they look right:

- `dummy-min` always plays the minimum card
- `dummy-max` always plays the maximum card
- both choose the fewest-heads row
- both are deterministic and stateless

## A3 - Shared MCS base logic is broadly faithful

**Spec:**

- available/unknown card tracking: `spec/strategies/mcs.md:29-44`
- hand sampling: `spec/strategies/mcs.md:45-57`
- playout resolution: `spec/strategies/mcs.md:58-69`

**Code:**

- board cloning and Fisher-Yates sampling helpers: `src/engine/strategies/mcs-base.ts:23-37`
- turn simulation and penalty accumulation: `src/engine/strategies/mcs-base.ts:39-90`
- unknown-pool construction and seen-card updates: `src/engine/strategies/mcs-base.ts:92-174`
- opponent hand sampling: `src/engine/strategies/mcs-base.ts:176-199`

Notes:

- one minor difference is that sampled opponent hands are not explicitly sorted after sampling, even though the spec example sorts them
- current playout policies are order-insensitive, so this does not look behaviorally significant

## A4 - `mcs` is faithful to the simplified full-round-planning design

**Spec:** `spec/strategies/mcs.md:17-25`, `spec/strategies/mcs.md:116-153`, `spec/strategies/mcs.md:187-202`  
**Code:** `src/engine/strategies/mcs.ts:32-70`, `src/engine/strategies/mcs.ts:139-242`

Why it looks right:

- candidate cards are evaluated by repeated determinization and playout
- the remainder of the round is simulated, not just the immediate turn
- row choice simulates row-take consequences rather than using only greedy immediate penalty, except for the last-turn fast path

## A5 - `mcs-prior` is largely faithful to its documented architecture

**Spec:**

- one-turn-plus-heuristic architecture: `spec/strategies/mcs-prior.md:14-22`
- `evaluateHand` heuristic structure: `spec/strategies/mcs-prior.md:24-68`
- opponent model: `spec/strategies/mcs-prior.md:70-80`
- options and defaults: `spec/strategies/mcs-prior.md:82-103`
- prior schema: `spec/strategies/mcs-prior.md:105-132`

**Code:**

- module docstring matches the intended architecture: `src/engine/strategies/mcs-prior.ts:1-43`
- `evaluateHand()` implements trapped-card logic, overflow-risk logic, and timing pressure: `src/engine/strategies/mcs-prior.ts:90-170`
- `priorWeightedSelect()` uses inverse-danger weighting plus timing boost: `src/engine/strategies/mcs-prior.ts:173-215`
- card choice and row choice use the prior-weighted model plus heuristic leaf evaluation: `src/engine/strategies/mcs-prior.ts:340-447`
- prior-table schema aligns with documented fields: `src/engine/strategies/prior-table.ts:6-23`, `src/engine/strategies/prior-table.ts:25-148`

---

## Overall Verdict

The strategy implementations are mostly credible.

My bottom line by category:

- **Definite strategy bug:** `bayesian-simple` failing to reset round-local seen-card state
- **Real contract bug:** stochastic strategies tolerating missing seeded RNG by falling back to `Math.random()`
- **Intentional simplifications that should be documented clearly:**
  - `bayesian-simple` is a lightweight Monte Carlo strategy, not a full belief-tracking Bayesian engine
  - `mcs` is the simplified random-playout variant, not a PUCT/neural variant
  - `mcs-prior` uses an asymmetric but practical relative leaf-evaluation shortcut

If the bar is "are these strategy files mostly sane and grounded in the described algorithms," the answer is yes.

If the bar is "are they exactly identical to the richest possible reading of every strategy spec document," the answer is no, mainly because some of those specs mix an idealized future design with the simpler variants that were actually implemented.

The strongest action item from this strategy audit is straightforward:

1. add `onRoundStart()` reset behavior to `bayesian-simple`
2. decide whether stochastic strategies should fail fast when `onGameStart()` was skipped, matching `random`
3. tighten the strategy docs so each one distinguishes clearly between current implementation and future richer variants
