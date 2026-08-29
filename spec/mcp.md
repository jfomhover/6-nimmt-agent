# 6 Nimmt! — MCP Server Specification

> Part of the [Technical Specification](spec.md). See also: [Engine](engine.md) · [Strategies](strategies.md) · [CLI](cli.md) · [Simulator](simulator.md)

---

## 1. Overview

The MCP (Model Context Protocol) server exposes the game engine as a set of structured tools for AI agent consumption. It is the **preferred interface for live play** — the agent communicates with the engine via native MCP tool calls instead of constructing CLI arguments and parsing stdout.

The MCP server runs as a subcommand of the CLI:

```
6nimmt serve
```

This starts an MCP server on **stdio** (stdin/stdout). The agent spawns the process and communicates over the standard MCP protocol.

### Design Goals

- **Same engine, different transport.** The MCP server uses the same engine, strategy registry, and validation logic as the CLI. No separate code paths.
- **Stateful sessions for live play.** The server maintains strategy instances per game session, enabling full lifecycle hook support (`onGameStart`, `onTurnResolved`, `onRoundEnd`) without reconstruction hacks.
- **Drift-resilient.** The agent provides visible snapshots with every recommendation request; the server validates against accumulated state and reports mismatches.
- **Idempotent and ordered.** Every mutating tool carries round/turn identifiers and a session version to prevent duplicate or out-of-order events.

---

## 2. Transport

- **stdio only.** The agent spawns `6nimmt serve` and communicates over stdin/stdout using the MCP protocol.
- No HTTP/SSE transport in MVP.
- The server is a long-running process for the duration of a game session.

---

## 3. Tools

### 3.1 `server_info` — Server capabilities and version

Returns server metadata for compatibility checking.

**Parameters:** None.

**Result:**
```json
{
  "name": "6nimmt",
  "version": "1.0.0",
  "tools": ["server_info", "list_strategies", "validate_state", "recommend_once",
            "start_session", "round_started", "turn_resolved", "round_ended",
            "session_recommend", "resync_session", "session_status", "end_session"],
  "sessionSupport": true,
  "maxConcurrentSessions": 4
}
```

---

### 3.2 `list_strategies` — Available strategies

Returns registered strategies with descriptions.

**Parameters:** None.

**Result:**
```json
{
  "strategies": [
    { "name": "random", "description": "Picks a card uniformly at random. Baseline strategy." },
    { "name": "bayesian", "description": "Maintains probability distributions over opponent hands." }
  ],
  "playerCountRange": { "min": 2, "max": 10 }
}
```

---

### 3.3 `validate_state` — Validate a game state

Validates a `CardChoiceState` or `RowChoiceState` JSON object.

**Parameters:**

| Parameter  | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `state`   | object | yes      | CardChoiceState or RowChoiceState JSON |
| `decision`| string | no       | `"card"` or `"row"`. Auto-detected from state shape if omitted. |

**Result:**
```json
{
  "valid": true,
  "decision": "card",
  "warnings": [],
  "errors": []
}
```

**Error result (domain):**
```json
{
  "valid": false,
  "decision": "card",
  "warnings": ["Hand size 8 unusual for turn 3 (expected 8, got 8)"],
  "errors": ["Card 105 is out of range (1-104)", "Board has 3 rows (expected 4)"]
}
```

Uses the same `validateCardChoiceState()` / `validateRowChoiceState()` functions as the CLI `recommend` command (see [Engine §4](engine.md#4-state-validation)).

---

### 3.4 `recommend_once` — Stateless single-turn recommendation

Stateless, one-shot recommendation. No session required. Equivalent to `6nimmt recommend` CLI command — useful for one-off queries, testing, or when session mode is unavailable.

**Parameters:**

| Parameter   | Type   | Required | Description |
|------------|--------|----------|-------------|
| `state`    | object | yes      | CardChoiceState or RowChoiceState JSON |
| `strategy` | string | yes      | Strategy name from registry |
| `decision` | string | no       | `"card"` or `"row"`. Auto-detected if omitted. |
| `timeout`  | number | no       | Max computation time in ms. Default: 10000. |

**Result:**
```json
{
  "decision": "card",
  "strategy": "bayesian",
  "recommendation": {
    "card": 42,
    "confidence": 0.85,
    "alternatives": [
      { "card": 38, "confidence": 0.10 },
      { "card": 91, "confidence": 0.05 }
    ]
  },
  "timedOut": false,
  "strategyFallback": false,
  "warnings": [],
  "stateValid": true,
  "stateWarnings": []
}
```

When `timedOut` is `true`, the recommendation is the best computed so far — still valid to play. When `strategyFallback` is `true`, the chosen strategy threw an error and a fallback heuristic (lowest card / fewest-heads row) was used; `warnings` explains what happened. Both are successful responses (`ok` is not present — success is implied).

Internally, follows the same reconstruction contract as CLI `recommend` (see [Strategies §7](strategies.md)).

---

### 3.5 `start_session` — Begin a live game session

Creates a stateful game session. One session = one live game. The server instantiates the chosen strategy and calls `onGameStart()`.

**Parameters:**

| Parameter     | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `strategy`   | string | yes      | Strategy name from registry |
| `playerCount`| number | yes      | Number of players (2–10) |
| `playerId`   | string | yes      | This player's identifier. Must be the BGA display username visible in the game DOM. All subsequent tool calls (plays, scores, rowPicks) must use the same identifier format for all players. |
| `seatIndex`  | number | no       | 0-based table position. Informational; `playerId` is the primary identity. |
| `seed`       | string | no       | Optional seed for strategy RNG derivation. If omitted, a random seed is generated. Providing a seed enables reproducible recommendations for the same game state. |

**Result:**
```json
{
  "sessionId": "s-a1b2c3d4",
  "seed": "auto-7f3a2b",
  "sessionVersion": 0,
  "phase": "awaiting-round",
  "strategy": "bayesian",
  "playerCount": 5,
  "playerId": "player-1"
}
```

**Errors:**
- `INVALID_STRATEGY` — Strategy name not found in registry.
- `INVALID_PLAYER_COUNT` — Player count outside 2–10 range.
- `MAX_SESSIONS_REACHED` — All session slots are in use. End an existing session or wait for one to expire.

**Session state machine:**
```
awaiting-round → in-round → [awaiting-row-pick →] in-round → awaiting-round / game-over → ... → ended
```

- `awaiting-round`: Waiting for `round_started`.
- `in-round`: Accepting `turn_resolved`, `session_recommend`. Waiting for `round_ended`.
- `awaiting-row-pick`: Mid-turn phase when the agent's card triggers Rule 4 (card lower than all row tails). The agent calls `session_recommend(decision:"row")` to enter this phase and receive a row recommendation, then calls `turn_resolved` with the full resolution to return to `in-round`.
- `game-over`: Game has ended (any player ≥ 66 cattle heads). Only `end_session` is valid.
- `ended`: Session terminated via `end_session`. No further tools accepted.

---

### 3.6 `round_started` — New round began

Tells the server that a new round started on BGA. Provides the initial board state and the agent's dealt hand.

**Parameters:**

| Parameter         | Type     | Required | Description |
|------------------|----------|----------|-------------|
| `sessionId`      | string   | yes      | Session identifier |
| `expectedVersion`| number   | yes      | Expected session version (optimistic concurrency) |
| `round`          | number   | yes      | Round number (1-based) |
| `board`          | number[][]| yes     | Initial board state — 4 rows, each an array of card numbers |
| `hand`           | number[] | yes      | Cards dealt to this player |

**Result:**
```json
{
  "sessionVersion": 1,
  "phase": "in-round",
  "round": 1,
  "accepted": true
}
```

**Errors:**
- `VERSION_MISMATCH` — `expectedVersion` doesn't match server state. Indicates missed events.
- `INVALID_PHASE` — Session not in `awaiting-round` phase.
- `INVALID_ROUND` — Round number not sequential.
- `INVALID_BOARD` — Board doesn't have exactly 4 rows, or cards out of range.
- `INVALID_HAND` — Hand size wrong or cards out of range/duplicated.

---

### 3.7 `turn_resolved` — Turn results observed

Tells the server how a turn resolved. The server calls `strategy.onTurnResolved()` with the provided data. The shape aligns with `TurnHistoryEntry` from the engine (see [Engine §1.5](engine.md#15-game-state-full--simulator-internal)) and `TurnResolution` from [Strategies §1](strategies.md#1-interface).

**Parameters:**

| Parameter         | Type     | Required | Description |
|------------------|----------|----------|-------------|
| `sessionId`      | string   | yes      | Session identifier |
| `expectedVersion`| number   | yes      | Expected session version |
| `round`          | number   | yes      | Current round number |
| `turn`           | number   | yes      | Turn number (1–10) |
| `plays`          | `{ playerId: string, card: number }[]` | yes | All players' revealed cards for this turn |
| `resolutions`    | `{ playerId: string, card: number, rowIndex: number, causedOverflow: boolean, collectedCards?: number[] }[]` | yes | Per-card resolution results, ordered lowest card first |
| `rowPicks`       | `{ playerId: string, rowIndex: number, collectedCards: number[] }[]` | no | Rule 4 forced row picks. Only present when a player's card was lower than all row tails and they had to pick a row. |
| `boardAfter`     | `number[][]` | no | Board state after all resolutions (4 rows). If omitted, server computes expected board from resolutions + previous state. If provided, used for drift validation. |

**Result:**
```json
{
  "sessionVersion": 2,
  "phase": "in-round",
  "round": 1,
  "turn": 1,
  "accepted": true
}
```

**Errors:**
- `VERSION_MISMATCH` — Out of sync.
- `INVALID_PHASE` — Session not in `in-round` or `awaiting-row-pick` phase.
- `INVALID_TURN` — Turn number not sequential within round.
- `INVALID_RESOLUTIONS` — Resolutions array is invalid (wrong order, missing fields, card mismatch with `plays`).
- `DUPLICATE_EVENT` — Exact same round/turn and payload already processed. Safe to ignore.
- `EVENT_CONFLICT` — Same round/turn already recorded with different data. Use `resync_session`.

> **Rule 4 resolution semantics:** When a player's card triggers Rule 4 (lower than all row tails), their entry in `resolutions` has `rowIndex` set to the row they **picked** (which is also where their card is placed as the new sole card). `causedOverflow` is `false` because Rule 4 is distinct from a sixth-card overflow, and `collectedCards` contains the cards from the picked row. The same information appears in `rowPicks` with attribution context. Both fields are consistent — `resolutions[].rowIndex` == `rowPicks[].rowIndex` for the same player.

> **Note:** The server normalizes `resolutions` to ascending card order upon receipt. The agent may provide them in any order.

---

### 3.8 `round_ended` — Round finished with scores

Tells the server a round ended. The server calls `strategy.onRoundEnd()`.

**Parameters:**

| Parameter         | Type     | Required | Description |
|------------------|----------|----------|-------------|
| `sessionId`      | string   | yes      | Session identifier |
| `expectedVersion`| number   | yes      | Expected session version |
| `round`          | number   | yes      | Round that just ended |
| `scores`         | `{ playerId: string, score: number }[]` | yes | Cumulative scores across all rounds (not per-round deltas). Used for game-over detection (any player ≥ 66). |

**Result:**
```json
{
  "sessionVersion": 3,
  "phase": "awaiting-round",
  "round": 1,
  "accepted": true,
  "gameOver": false,
  "finalScores": null
}
```

**Game-over result (when any player reaches ≥ 66 cattle heads):**
```json
{
  "sessionVersion": 3,
  "phase": "game-over",
  "round": 5,
  "accepted": true,
  "gameOver": true,
  "finalScores": [
    { "playerId": "player-1", "score": 42, "rank": 1 },
    { "playerId": "player-2", "score": 70, "rank": 2 }
  ]
}
```

When `gameOver` is `true`:
- `phase` becomes `"game-over"`.
- `finalScores` is populated with all players ranked by ascending score (lower is better).
- Further `round_started` calls return `INVALID_PHASE`.
- Only `end_session` is valid after game-over.

> A session cannot be reused for a new game. After game-over, the agent must call `end_session` and then `start_session` to begin a new game session.

**Errors:**
- `VERSION_MISMATCH`, `INVALID_PHASE`, `INVALID_ROUND`.

---

### 3.9`session_recommend` — Session-aware recommendation

Gets a recommendation using the strategy's full accumulated state from the session. The agent provides its current visible snapshot for drift validation.

**Parameters:**

| Parameter   | Type      | Required | Description |
|------------|-----------|----------|-------------|
| `sessionId`| string    | yes      | Session identifier |
| `hand`     | number[]  | yes      | Agent's current hand (from BGA DOM) |
| `board`    | number[][]| yes      | Current board state (from BGA DOM) |
| `decision` | string    | no       | `"card"` or `"row"`. Auto-detected if omitted. |
| `timeout`  | number    | no       | Max computation time in ms. Default: 10000. |
| `triggeringCard` | number | no   | Required when `decision` is `"row"`. The card that triggered the row pick. |
| `revealedThisTurn` | array | no | Required when `decision` is `"row"`. Cards revealed so far this turn: `[{ playerId, card }]`. |
| `resolutionIndex` | number | no | Required when `decision` is `"row"`. 0-based index into the turn's resolution order indicating how many cards have resolved before this row pick. |

> **Note on `resolutionIndex`:** Rule 4 can only trigger once per turn — only the lowest-valued card in a turn can be lower than all row tails. After that card picks a row and becomes a new tail, all remaining higher-valued cards will always find an eligible row. Therefore, `resolutionIndex` is always `0` for Rule 4 picks.

**Result (card decision):**
```json
{
  "sessionId": "s-a1b2c3d4",
  "sessionVersion": 2,
  "decision": "card",
  "strategy": "bayesian",
  "recommendation": {
    "card": 42,
    "confidence": 0.85,
    "alternatives": [
      { "card": 38, "confidence": 0.10 },
      { "card": 91, "confidence": 0.05 }
    ]
  },
  "timedOut": false,
  "strategyFallback": false,
  "stateConsistent": true,
  "stateWarnings": []
}
```

**Result (row decision):**
```json
{
  "sessionId": "s-a1b2c3d4",
  "sessionVersion": 2,
  "decision": "row",
  "strategy": "bayesian",
  "recommendation": {
    "rowIndex": 2,
    "confidence": 0.92,
    "alternatives": [
      { "rowIndex": 0, "confidence": 0.05 },
      { "rowIndex": 1, "confidence": 0.02 },
      { "rowIndex": 3, "confidence": 0.01 }
    ]
  },
  "timedOut": false,
  "strategyFallback": false,
  "stateConsistent": true,
  "stateWarnings": []
}
```

`strategyFallback` — `true` if the chosen strategy threw an error and a fallback heuristic (lowest card / fewest-heads row) was used. When `true`, `stateWarnings` describes what happened.

> **Row recommendation is optional:**Calling `session_recommend(decision:"row")` before `turn_resolved` during Rule 4 is **recommended but not required** for the state machine. If the agent skips the recommendation (e.g., the row choice is obvious) and calls `turn_resolved` directly with `rowPicks` data, the server accepts it without entering the `awaiting-row-pick` phase. The `awaiting-row-pick` phase is triggered **only** by a `session_recommend(decision:"row")` call, not by the presence of `rowPicks` in `turn_resolved`.

> **Read-only semantics:** `session_recommend` does not increment `sessionVersion`. The `sessionVersion` in the response reflects the current (unchanged) version. The agent may call `session_recommend` multiple times without affecting version tracking.

**Drift detection:** The server compares the agent-provided `hand` and `board` against its accumulated session state:
- **Consistent** (`stateConsistent: true`): Agent snapshot matches server state. Recommendation uses full session history.
- **Minor drift** (`stateConsistent: false`, `stateWarnings` populated): Agent snapshot differs slightly (e.g., board state diverged after a missed event). Recommendation still produced using agent-provided snapshot as override, but server logs the discrepancy.
- **Major drift** → returns `STATE_MISMATCH` error recommending `resync_session`.

**Drift classification thresholds:**

- **Consistent** (`stateConsistent: true`): Agent hand and board match server shadow state exactly (same cards, same row assignment, same order within rows).
- **Minor drift** (`stateConsistent: false`, recommendation still produced): Hand size matches but ≤ 2 individual cards differ, OR board rows have the same cards but ≤ 2 cards are in different positions. The server produces a recommendation using the agent-provided snapshot as override and populates `stateWarnings`.
- **Major drift** (`STATE_MISMATCH` error): Hand size differs by > 1, OR board row count ≠ 4, OR > 2 cards in board differ from server state, OR agent-provided state contains cards that violate game rules (e.g., duplicates, out-of-range values). The server cannot produce a reliable recommendation and returns an error.

**Shadow state computation:** The server maintains an internal shadow board by applying each `turn_resolved` resolution to its state (starting from the `round_started` board). When `boardAfter` is provided in `turn_resolved`, it is validated against the server's computed board. The drift comparison in `session_recommend` compares the agent-provided snapshot against this server-computed shadow state — not against previously agent-provided state.

**Errors:**
- `UNKNOWN_SESSION` — Session ID not found or already ended.
- `INVALID_PHASE` — Called during `awaiting-round` or `game-over` phase when no recommendation is possible.
- `STATE_MISMATCH` — Agent snapshot vs server state diverged significantly. Use `resync_session`.

> **Validation field semantics:** `stateConsistent` (in `session_recommend`) indicates whether the agent-provided snapshot matches the server's accumulated session state. This differs from `stateValid` (in `recommend_once`) which indicates whether the provided state passes structural validation (well-formed, correct ranges). Both tools populate `stateWarnings` with details when issues are detected.

---

### 3.10 `resync_session` — Recover from state drift

Resets the session's accumulated state to match the agent's current view of the game. Used when drift is detected or after the agent reconnects to BGA.

**Parameters:**

| Parameter     | Type      | Required | Description |
|--------------|-----------|----------|-------------|
| `sessionId`  | string    | yes      | Session identifier |
| `round`      | number    | yes      | Current round number |
| `turn`       | number    | yes      | Current turn number |
| `board`      | number[][]| yes      | Current board state from BGA |
| `hand`       | number[]  | yes      | Current hand from BGA |
| `scores`     | `{ playerId: string, score: number }[]` | yes | Current scores from BGA |
| `turnHistory` | `{ turn: number, plays: { playerId: string, card: number }[], resolutions: { playerId: string, card: number, rowIndex: number, causedOverflow: boolean, collectedCards?: number[] }[], rowPicks: { playerId: string, rowIndex: number, collectedCards: number[] }[], boardAfter: number[][] }[]` | no | Known turn resolution history this round. Includes per-card `resolutions` for full `TurnResolution` reconstruction. Enables complete strategy replay. |

**Result:**
```json
{
  "sessionVersion": 10,
  "phase": "in-round",
  "round": 2,
  "turn": 4,
  "resynced": true,
  "strategyStateReset": true,
  "message": "Session resynced. Strategy state rebuilt from provided snapshot."
}
```

**Behaviour:**
1. Resets session round/turn/phase to provided values.
2. Calls `onGameStart()` on the strategy instance (fresh start).
3. If `turnHistory` is provided, replays each entry as a synthetic `onTurnResolved()` call (same reconstruction contract as CLI `recommend_once` — see [Strategies §7](strategies.md)). The `resolutions` field in each entry provides per-card placement details (`rowIndex`, `causedOverflow`, `collectedCards`), enabling full `TurnResolution` reconstruction for stateful strategies.
4. Cross-round strategy memory is lost. This is an acceptable trade-off for recovery.
5. Unconditionally resets the session phase (including `awaiting-row-pick`) to match the provided round/turn state. After resync, phase is set based on the provided `turn` value: if `turn` ≥ 1, phase becomes `in-round`; if `turn` is `0`, phase becomes `awaiting-round` (indicating a round boundary). The agent should provide `turn: 0` when resyncing between rounds (after a round ended but before the next round started).

> **Version semantics:** `resync_session` increments `sessionVersion` by exactly 1, regardless of how many `turnHistory` entries are replayed internally. Internal replays are reconstruction steps, not discrete events. The result includes the new `sessionVersion` for all subsequent calls.

> **Degradation note:** BGA DOM may not retain full turn history for all rounds. `turnHistory` quality depends on what the agent can scrape from the current page. Strategy reconstruction quality degrades proportionally to missing entries — strategies that rely heavily on opponent modeling (e.g., bayesian) will produce lower-quality recommendations with incomplete history.

---

### 3.11 `session_status` — Query session state (read-only)

Returns the current session state without mutation. Useful after network hiccups or to verify session state before acting.

**Parameters:**

| Parameter    | Type   | Required | Description |
|-------------|--------|----------|-------------|
| `sessionId` | string | yes      | Session identifier |

**Result:**
```json
{
  "sessionId": "s-a1b2c3d4",
  "sessionVersion": 8,
  "phase": "in-round",
  "round": 2,
  "turn": 3,
  "strategy": "bayesian",
  "board": [[5, 22, 44], [10, 33], [67], [99, 101]],
  "hand": [12, 28, 45, 61, 73, 88, 94],
  "scores": [
    { "playerId": "copilot-ai", "score": 12 },
    { "playerId": "alice", "score": 8 }
  ],
  "lastEvent": "turn_resolved(round:2, turn:2)"
}
```

**Errors:**
- `UNKNOWN_SESSION` — Session ID not found or already ended.

This tool is read-only — it does not require `expectedVersion` and does not increment `sessionVersion`.

---

### 3.12 `end_session` — Terminate a game session

Cleans up the session and releases resources.

**Parameters:**

| Parameter    | Type   | Required | Description |
|-------------|--------|----------|-------------|
| `sessionId` | string | yes      | Session identifier |

**Result:**
```json
{
  "sessionId": "s-a1b2c3d4",
  "ended": true,
  "totalRounds": 3,
  "finalPhase": "ended"
}
```

After `end_session`, the `sessionId` is invalid. Any further tool calls with this session return `UNKNOWN_SESSION`.

---

## 4. Error Model

### 4.1 MCP Protocol Errors

Used for protocol-level failures. These use MCP's built-in error mechanism.

| Error | When |
|-------|------|
| `InvalidParams` | Malformed tool arguments, missing required fields, wrong types |
| `MethodNotFound` | Unknown tool name |
| `InternalError` | Unexpected server crash |

### 4.2 Structured Domain Errors

Used for recoverable game/domain failures. Returned as **tool results** (not MCP errors) so the agent can inspect and recover.

```typescript
interface DomainError {
  ok: false;
  code: string;
  recoverable: boolean;
  suggestedAction: "retry_with_version" | "resync_session" | "start_fresh" | "none";
  message: string;
  details?: Record<string, unknown>;
}
```

| Code | Recoverable | suggestedAction | Description |
|------|-------------|-----------------|-------------|
| `UNKNOWN_SESSION` | no | `start_fresh` | Session ID not found or already ended |
| `INVALID_PHASE` | yes | `none` | Tool called in wrong session phase (e.g., `turn_resolved` before `round_started`) |
| `VERSION_MISMATCH` | yes | `retry_with_version` | `expectedVersion` doesn't match. Response includes `currentVersion`. |
| `DUPLICATE_EVENT` | yes | `none` | Exact same round/turn AND same payload already processed. Safe to ignore — no state change. Response includes `currentVersion` for convenience. `sessionVersion` does not increment for `DUPLICATE_EVENT` responses — the event was already applied. |
| `INVALID_ROUND` | yes | `none` | Round number not sequential |
| `INVALID_TURN` | yes | `none` | Turn number not sequential within round |
| `INVALID_BOARD` | yes | `none` | Board structure invalid (wrong row count, cards out of range) |
| `INVALID_HAND` | yes | `none` | Hand invalid (wrong size, cards out of range, duplicates) |
| `INVALID_RESOLUTIONS` | yes | `none` | Resolutions array invalid (wrong order, missing fields, card mismatch with plays) |
| `INVALID_STRATEGY` | no | `none` | Strategy name not found in registry |
| `INVALID_PLAYER_COUNT` | no | `none` | Player count outside 2–10 |
| `STATE_MISMATCH` | yes | `resync_session` | Agent snapshot vs server state diverged significantly. Use `resync_session`. |
| `EVENT_CONFLICT` | no | `resync_session` | Same round/turn already recorded with different data. Session state may be corrupted. Use `resync_session`. |
| `SESSION_EXPIRED` | yes | `start_fresh` | Session expired due to inactivity. Start a new session. |
| `MAX_SESSIONS_REACHED` | no | `none` | All session slots are in use. End an existing session or wait for one to expire. |

> **`recoverable` semantics:** `true` means the session is still usable — the agent can retry the call, fix the parameters, or use a recovery mechanism (resync). `false` means the session is unusable for this call — the agent must start a new session or abandon the operation. Note: even `recoverable: false` errors (like `EVENT_CONFLICT`) may allow session recovery via `resync_session`; the flag indicates whether a *simple retry* of the same operation can succeed.

> **Session-wide errors:** `UNKNOWN_SESSION` and `SESSION_EXPIRED` can be returned by any tool that accepts a `sessionId` parameter. They are not listed individually in each tool's Errors section to avoid repetition.

**Design principle:** Errors include enough context for an AI agent to self-correct. `VERSION_MISMATCH` includes `currentVersion`. `INVALID_STRATEGY` includes `validStrategies`. `STATE_MISMATCH` includes a summary of the drift.

---

## 5. Session Lifecycle

### 5.1 State Machine

```
                    start_session
                         │
                         ▼
              ┌─── awaiting-round ◄──┐
              │          │           │
              │    round_started     │
              │          │           │
              │          ▼           │
              │      in-round ───────┘
              │     ┌────┴────┐     round_ended
              │     │         │       │
              │  turn_resolved  session_recommend
              │     │         │       │
              │     │    awaiting-row-pick (Rule 4)
              │     │         │
              │     │    turn_resolved
              │     │         │
              │     └────┬────┘
              │          │
              │    (repeat 1-10 turns)
              │          │
              │    round_ended ──► game-over ─┐
              │                               │
              │    end_session (from any phase)│
              │          │                    │
              │          ▼                    │
              └──────► ended ◄────────────────┘
```

**Relationship to engine phases:** The MCP session phases are a coarser-grained abstraction over the engine's internal `GamePhase`:

| MCP Session Phase | Engine Phase(s) | Notes |
|-------------------|-----------------|-------|
| `awaiting-round` | `round-over` | Between rounds; waiting for `dealRound()` |
| `in-round` | `awaiting-cards` + `resolving` | Cards being played and resolved |
| `awaiting-row-pick` | `awaiting-row-pick` | 1:1 mapping |
| `game-over` | `game-over` | 1:1 mapping |
| `ended` | *(no equivalent)* | MCP-only; session terminated |

#### Allowed tools per phase

| Phase | Allowed tools | Rejected (returns `INVALID_PHASE`) |
|-------|---------------|------------------------------------|
| `awaiting-round` | `round_started`, `session_status`, `resync_session`, `end_session` | `turn_resolved`, `round_ended`, `session_recommend` |
| `in-round` | `session_recommend(decision:"card")`, `turn_resolved`, `round_ended`, `session_recommend(decision:"row")`, `session_status`, `resync_session`, `end_session` | `round_started` |
| `awaiting-row-pick` | `session_recommend(decision:"row")` (re-query), `turn_resolved` (exit phase), `session_status` (read-only), `resync_session` (recovery), `end_session` (abort) | `session_recommend(decision:"card")`, `round_started`, `round_ended` |
| `game-over` | `end_session`, `session_status` | `round_started`, `turn_resolved`, `round_ended`, `session_recommend` |

> **Note:** In the `awaiting-row-pick` phase, the agent may re-query `session_recommend(decision:"row")` if it needs to re-evaluate (e.g., after a timeout). Calling `turn_resolved` exits the phase back to `in-round`. All other mutating tools are rejected with `INVALID_PHASE`.

### 5.2 Session Versioning

Every session has a monotonically increasing `sessionVersion` (starting at 0). It increments on every mutating tool call (`round_started`, `turn_resolved`, `round_ended`, `resync_session`).

Every mutating tool requires `expectedVersion` — if it doesn't match, the server returns `VERSION_MISMATCH` with `currentVersion`. This prevents:
- Duplicate events from retries
- Out-of-order event delivery
- Race conditions in concurrent tool calls

Non-versioned tools (`session_recommend`, `session_status`, `end_session`) do not require `expectedVersion` and do not increment `sessionVersion`. Note: `end_session` is destructive (terminates the session) but is exempt from versioning because it cannot conflict with other operations.

> **Implementation note:** For `turn_resolved`, the server SHOULD check for duplicate events (same round/turn + same payload) before checking `expectedVersion`. This allows retries of already-applied events to return `DUPLICATE_EVENT` directly, avoiding an unnecessary VERSION_MISMATCH → retry → DUPLICATE_EVENT round-trip.

> **Note:** `resync_session` is **exempt**from version checking despite being a mutating tool. Rationale: resync is a recovery mechanism invoked when the agent has lost track of the current version (e.g., after a `STATE_MISMATCH` error). Requiring `expectedVersion` would create a catch-22. The resync result provides the new `sessionVersion` for all subsequent calls.

### 5.3 Restart and Recovery

Sessions are **ephemeral** — they exist only in the server process's memory. If the MCP server process dies:
- All sessions are lost.
- The agent must call `start_session` again and use `resync_session` to rebuild state from the current BGA DOM.

This is acceptable because:
- The MCP server is spawned by the agent and runs for the duration of the game.
- If the process crashes, the agent detects it (stdin/stdout closes) and restarts.
- `resync_session` with `turnHistory` can rebuild most strategy state.

Session persistence is a **post-MVP enhancement**.

### 5.4 Concurrent Sessions

The server supports up to 4 concurrent sessions per server process instance (`maxConcurrentSessions`). Each session is independent — different strategies, different games, different players. Each session receives its own independent strategy instance and RNG state, even when multiple sessions use the same strategy name.

This enables:
- Testing multiple strategies against the same live game state.
- Running one active session and one "shadow" session for comparison.

> **Serialization guarantee:** Tool calls targeting the same session are processed in FIFO (arrival) order. The server never reorders concurrent calls within a single session. If the agent sends `session_recommend` and `turn_resolved` simultaneously, the server processes them in arrival order, which may mean the recommendation uses pre-turn state.

### 5.5 Recovery Ladder

When errors occur, the agent should escalate through these steps in order:

1. **`VERSION_MISMATCH`** → Retry the same tool call with `currentVersion` from the error response.
2. **`STATE_MISMATCH`** → Call `resync_session` with the current BGA DOM state.
3. **`resync_session` failure** (e.g. `UNKNOWN_SESSION`) → Call `end_session` + `start_session` + `resync_session` to rebuild from scratch.
4. **`UNKNOWN_SESSION` on any call** → Session lost; start fresh with `start_session`.
5. **MCP process died** (stdin/stdout closed) → Restart `6nimmt serve`, create a new session.

> **Circuit-breaker rule:** If the same error recurs 3 consecutive times at one recovery level, escalate to the next level immediately. If all levels are exhausted (process restart fails), the agent should abort the game gracefully and report the failure. This prevents infinite retry loops.

### 5.6 Session Expiry

Sessions expire after **30 minutes** of inactivity (no tool calls for that session). Expired sessions return `SESSION_EXPIRED`. The agent should start a new session when this occurs.

Any tool call that includes a valid `sessionId` resets the inactivity timer for that session, regardless of whether the call succeeds or returns an error. Tool calls to other sessions do not affect this session's timer.

The `maxConcurrentSessions` limit applies only to active (non-expired) sessions. Expired sessions are automatically cleaned up and do not count against the limit.

---

## 6. Module Structure

```
src/mcp/
  server.ts          — MCP server setup, tool registration, stdio transport
  session.ts         — Session state machine, versioning, lifecycle
  tools/
    stateless.ts     — list_strategies, validate_state, recommend_once
    session-mgmt.ts  — start_session, end_session, resync_session, session_status
    events.ts        — round_started, turn_resolved, round_ended
    recommend.ts     — session_recommend
  drift.ts           — State comparison / drift detection logic
  errors.ts          — Domain error constructors
  index.ts           — Barrel export
```

---

## 7. CLI Integration

The `serve` command is registered alongside existing CLI commands:

```
6nimmt serve [options]
```

| Argument              | Alias | Type   | Default | Description |
|----------------------|-------|--------|---------|-------------|
| `--log-level`        | `-l`  | string | `warn`  | Log verbosity: `debug`, `info`, `warn`, `error` |
| `--max-sessions`     |       | number | `4`     | Maximum concurrent sessions |

**No output format flag** — MCP defines its own serialization. Logs go to stderr (not stdout, which is reserved for MCP protocol).

The `serve` command shares the same engine and strategy registry as `simulate`, `recommend`, `play`, and `strategies`. No separate code path.

---

## 8. Relationship to CLI `recommend`

Both the MCP `recommend_once` tool and the CLI `recommend` command coexist:

| Aspect | CLI `recommend` | MCP `recommend_once` / `session_recommend` |
|--------|----------------|--------------------------------------|
| Transport | Shell exec + JSON stdout | MCP stdio |
| State | Stateless (reconstruction) | Stateless (`recommend_once`) or stateful (`session_recommend`) |
| Use case | Scripting, testing, fallback | Live agent play (preferred) |
| Drift detection | None | Built-in (`stateConsistent` + `resync_session`) |
| Strategy memory | Current round only (via reconstruction) | Full game (via session lifecycle) |

**The MCP server is the preferred path for live play.** CLI `recommend` remains valuable for testing, scripting, and as a fallback when MCP is unavailable.

The spec §7 "Live Play Mode" in [Strategies](strategies.md) describes the reconstruction contract used by both CLI `recommend` and MCP `recommend_once` (stateless). MCP `session_recommend` bypasses reconstruction entirely because the strategy instance persists.

---

## 9. Typical Live Play Flow

```
Agent                              MCP Server (6nimmt serve)
  │                                         │
  ├── server_info ─────────────────────────►│
  │◄── {version, tools, ...} ──────────────┤
  │                                         │
  ├── list_strategies ─────────────────────►│
  │◄── {strategies: [...]} ────────────────┤
  │                                         │
  ├── start_session ───────────────────────►│  strategy:"bayesian", playerCount:5, playerId:"copilot-ai"
  │◄── {sessionId:"s-abc", version:0} ─────┤
  │                                         │
  │  [BGA: new round, cards dealt]          │
  │                                         │
  ├── round_started ───────────────────────►│  board, hand, round:1, expectedVersion:0
  │◄── {version:1, phase:"in-round"} ──────┤
  │                                         │
  ├── session_recommend ───────────────────►│  hand, board
  │◄── {card:42, confidence:0.85} ─────────┤
  │                                         │
  │  [Agent plays card 42 on BGA]           │
  │  [BGA: turn resolves]                   │
  │                                         │
  ├── turn_resolved ───────────────────────►│  plays, resolutions, rowPicks,
  │                                         │  boardAfter, round:1, turn:1,
  │                                         │  expectedVersion:1
  │◄── {version:2, phase:"in-round"} ──────┤
  │                                         │
  │  ... repeat turns 2-10 ...              │
  │                                         │
  ├── round_ended ─────────────────────────►│  scores, round:1, expectedVersion:11
  │◄── {version:12, phase:"awaiting-round"}┤
  │                                         │
  │  ... repeat rounds ...                  │
  │                                         │
  ├── end_session ─────────────────────────►│
  │◄── {ended:true} ───────────────────────┤
```

### Row-Pick Flow (Rule 4 — agent's card triggers row pick)

```
  │  [BGA: turn cards revealed, agent's card is lowest of all row tails]
  │                                         │
  ├── session_recommend ───────────────────►│  decision:"row", triggeringCard:3,
  │                                         │  revealedThisTurn:[{playerId,card},...],
  │                                         │  resolutionIndex:0, hand, board
  │◄── {rowIndex:2, confidence:0.92} ──────┤  server enters awaiting-row-pick phase
  │                                         │
  │  [Agent picks row 2 on BGA]             │
  │  [BGA: turn fully resolves]             │
  │                                         │
  ├── turn_resolved ───────────────────────►│  plays, resolutions (incl. agent's row pick),
  │                                         │  rowPicks, boardAfter, round, turn,
  │                                         │  expectedVersion
  │◄── {version:N, phase:"in-round"} ──────┤  server returns to in-round phase
```

### Game-Over Flow

```
  ├── round_ended ─────────────────────────►│  scores, round:5, expectedVersion:N
  │◄── {version:N+1, phase:"game-over",    ┤
  │     gameOver:true, finalScores:[...]}   │
  │                                         │
  │  [Only end_session is valid now]        │
  │                                         │
  ├── end_session ─────────────────────────►│
  │◄── {ended:true} ───────────────────────┤
```

### Recovery Flow (after drift detected)

```
  ├── session_recommend ───────────────────►│
  │◄── {ok:false, code:"STATE_MISMATCH"} ──┤
  │                                         │
  │  [Agent reads full state from BGA DOM]  │
  │                                         │
  ├── resync_session ──────────────────────►│  round, turn, board, hand, scores,
  │                                         │  turnHistory
  │◄── {resynced:true, version:15} ────────┤
  │                                         │
  ├── session_recommend ───────────────────►│  hand, board
  │◄── {card:38, confidence:0.72} ─────────┤
```

### 9.1 Edge Cases

The following normative examples clarify common edge cases:

1. **Turn 1, Round 1:** The agent calls `round_started` then immediately `session_recommend`. No prior `turn_resolved` is needed — there is nothing to resolve yet. This is the normal start-of-round flow.

2. **Another player triggers Rule 4 (row pick):** This appears in `turn_resolved` as part of the `resolutions` array (the resolution entry will have `causedOverflow: true` and include `collectedCards`). The agent does NOT need to call any special tool — just reports the full turn resolution including the other player's forced pick.

3. **Agent's own card triggers Rule 4:** The agent calls `session_recommend(decision: "row", ...)` BEFORE calling `turn_resolved`. The recommendation helps the agent decide which row to pick on BGA. After picking and observing the full turn resolution on BGA, the agent calls `turn_resolved` with the complete data (all plays, all placements including the agent's row pick).

   > The agent should capture `revealedThisTurn` immediately upon card reveal (when BGA shows all played cards face-up), before BGA begins resolution animations. This ensures the list is complete and unaffected by subsequent DOM changes during resolution.
