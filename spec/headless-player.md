# Headless Player Spec

## Problem

The LLM-agent approach to playing 6 Nimmt on BGA is fundamentally flawed:
- **Slow**: 20-30s per turn (multiple tool calls × network latency)
- **Fragile**: Loses state across context windows, timeouts break the loop
- **Expensive**: LLM tokens for purely deterministic orchestration
- **Unreliable**: Long loops get interrupted, can't run unattended

The game loop is 100% deterministic — no reasoning required. The LLM adds no value inside the play loop.

## Solution

A standalone TypeScript Playwright script that:
1. Logs into BGA and navigates to a table
2. Reads game state directly from the DOM
3. Calls the strategy engine **in-process** (no MCP, no network)
4. Clicks the recommended card/row
5. Loops until game ends

**Performance target:** <2 seconds per turn (DOM read + strategy + click).

## Usage

```bash
# Play a game on an existing table
npx tsx src/player/play.ts --table <table-id> --strategy mcs

# With strategy options (colon-separated key=val pairs)
npx tsx src/player/play.ts \
  --table 843761580 \
  --strategy mcs:mcMax=1000,mcPerCard=100 \
  --delay 2000          # ms delay before each play (appear human)
  --verbose             # log every action
```

## Architecture

```
src/player/
├── play.ts            # Entry point — parse args, orchestrate
├── bga-auth.ts        # BGA login (credentials from env vars)
├── state-reader.ts    # Read hand/board/scores from live DOM
├── actor.ts           # Execute moves (play card, pick row)
├── loop.ts            # Main game loop (poll → read → decide → act)
├── collector.ts       # Streaming JSONL data collection
├── browser-launcher.ts # Find & launch Chrome/Edge with CDP
└── logger.ts          # Structured JSON logging
```

### Dependencies

- `playwright` — browser automation (already in devDeps)
- Strategy engine — imported directly from `src/engine/strategies/`
- No MCP server needed at runtime

### Authentication

BGA credentials via environment variables:
```
BGA_USERNAME=...
BGA_PASSWORD=...
```

Or: reuse an existing browser session (persistent context / cookies file).

## Game Loop (`loop.ts`)

### Live Resolution Fidelity

The live BGA DOM does not reliably expose every opponent card and per-card placement
before a forced row-pick decision. The headless player must never fabricate that
information. During row choice it provides the triggering card and the public reveals
known at that point; `turnHistory` and opponent resolutions may therefore be partial.
Stateful strategies used in this mode must tolerate that degraded context. Once the
post-resolution board is available, the player records the board-diff reconstruction
for subsequent card-counting decisions.

```typescript
export async function playGame(page: Page, strategy: Strategy, opts: PlayOpts) {
  while (true) {
    // 1. Check game end
    const ended = await checkGameEnd(page);
    if (ended) return ended.scores;

    // 2. Wait for our turn (poll title text)
    const state = await waitForAction(page, { timeout: 180_000 });

    // 3. Decide and act
    if (state.action === 'playCard') {
      const hand = await readHand(page);
      const board = await readBoard(page);
      const scores = await readScores(page);
      const gameState = buildGameState(hand, board, scores, opts.playerCount);
      const recommendation = strategy.recommend(gameState);
      await playCard(page, hand, recommendation.card);
    } else if (state.action === 'pickRow') {
      const board = await readBoard(page);
      const row = pickCheapestRow(board); // or strategy.recommendRow()
      await pickRow(page, row);
    }

    // 4. Optional human-like delay
    if (opts.delay) await page.waitForTimeout(opts.delay);
  }
}
```

### State Detection

Poll page title every 500ms:
| Title contains | Action |
|---|---|
| "You must choose a card" | `playCard` |
| "You must take a row" | `pickRow` |
| "Everyone must choose" | Keep polling (opponent's turn) |
| Game end detected | Return scores |

### Game End Detection

```typescript
async function checkGameEnd(page: Page): Promise<GameResult | null> {
  return page.evaluate(() => {
    if (gameui.gamedatas.gamestate.name === 'gameEnd') {
      return { scores: /* extract final scores */ };
    }
    return null;
  });
}
```

## State Reading (from SKILL.md — verified working)

All DOM reading code is already proven from live testing:
- **Hand**: `gameui.playerHand.getAllItems()` → decode sprite positions
- **Board**: `#row_card_zone_1` through `#row_card_zone_4` → parse card elements
- **Scores**: `gameui.gamedatas.players` → score field

Card value formula: `value = (|Y%| / 100) * 10 + (|X%| / 100) + 1`

## Strategy Integration

Import engine directly — no MCP overhead:

```typescript
import { createStrategy } from '../engine/strategies/index.js';

const strategy = createStrategy('mcs', { mcMax: 500 });
// strategy.recommend(gameState) → { card, confidence }
```

## Error Handling

| Error | Recovery |
|---|---|
| Title poll timeout (180s) | Log warning, take screenshot, retry once |
| Card click fails | Retry with fresh DOM read |
| BGA disconnection | Wait for auto-reconnect (30s), refresh if stuck |
| Strategy throws | Fall back to random, log error |
| Page navigation away | Re-navigate to table URL |

## Logging

Structured JSON logs to stdout:
```json
{"turn": 3, "round": 1, "action": "playCard", "card": 42, "strategy": "mcs", "confidence": 0.82, "elapsed_ms": 450}
{"turn": 3, "round": 1, "action": "waitingForOpponents", "elapsed_ms": 12300}
{"turn": 4, "round": 1, "action": "pickRow", "row": 2, "cattleCollected": 5}
```

## Testing

- **Unit tests**: Mock `page.evaluate()` responses, verify strategy calls
- **Integration test**: Playwright against a local HTML fixture of BGA DOM
- **Live smoke test**: Join a solo training table, play one full game

## Non-Goals (for now)

- Multi-table support (play multiple games simultaneously)
- Auto-join matchmaking (user provides table URL)
- Result reporting to external systems
- ELO tracking

## Comparison: Agent vs Headless Player

| Aspect | LLM Agent | Headless Player |
|---|---|---|
| Speed per turn | 20-30s | <2s |
| Cost per game | ~$0.50-1.00 tokens | $0 |
| Reliability | Fragile (timeouts, context loss) | Robust (deterministic) |
| Unattended | No (needs babysitting) | Yes |
| Flexibility | Can adapt to UI changes | Needs code updates |
| Setup | Agent config + MCP server | Just `npx tsx` |

## Source

- DOM selectors and state reading: verified in live play (see `skills/bga-6nimmt/SKILL.md`)
- Strategy engine: `src/engine/strategies/` (MCS, Bayesian, Random all working)
- BGA game URL format: `https://boardgamearena.com/table?table=<id>`
