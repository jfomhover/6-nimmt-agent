/**
 * GameRunner: single-game simulator for 6 Nimmt!
 */
import { randomUUID } from 'node:crypto';
import type { CardNumber, GameState, RowChoiceState } from '../engine/types';
import type { Strategy, TurnResolution } from '../engine/strategies/types';
import {
  createGame,
  dealRound,
  resolveTurn,
  applyRowPick,
  scoreRound,
  isGameOver,
  toCardChoiceState,
  strategies,
  cattleHeads,
  deriveSeedState,
  xoshiro256ss,
  parseStrategySpec,
} from '../engine';
import type { SimConfig, GameResult, PlayerResult } from './types';

// ── Helpers ────────────────────────────────────────────────────────────

function createPlayerRng(seed: string, playerId: string): () => number {
  const state = deriveSeedState(seed + '/' + playerId);
  return () => Number(xoshiro256ss(state) >> 11n) / 2 ** 53;
}

/** Pick the row with fewest total cattle heads (tiebreak: lowest index). */
function fewestHeadsRow(gameState: GameState): 0 | 1 | 2 | 3 {
  let bestIndex = 0;
  let bestPenalty = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = gameState.board.rows[i].reduce(
      (sum, c) => sum + cattleHeads(c),
      0,
    );
    if (p < bestPenalty) {
      bestPenalty = p;
      bestIndex = i;
    }
  }
  return bestIndex as 0 | 1 | 2 | 3;
}

function isValidRowIndex(v: unknown): v is 0 | 1 | 2 | 3 {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

// ── Build TurnResolution from history ──────────────────────────────────

function buildTurnResolution(state: GameState): TurnResolution {
  const entry = state.turnHistory[state.turnHistory.length - 1];
  return {
    turn: entry.turn,
    plays: entry.plays,
    resolutions: entry.resolutions,
    rowPicks: entry.rowPicks.map((rp) => ({
      playerId: rp.playerId,
      rowIndex: rp.rowIndex,
      collectedCards: [...rp.collectedCards],
    })),
    boardAfter: entry.boardAfter.map((row) => [...row]),
  };
}

// ── Build RowChoiceState manually ──────────────────────────────────────

function buildRowChoiceState(
  playerId: string,
  triggeringCard: CardNumber,
  sortedPlays: readonly { playerId: string; card: CardNumber }[],
  gameState: GameState,
): RowChoiceState {
  const player = gameState.players.find((p) => p.id === playerId)!;
  const playerScores = gameState.players.map((p) => ({ id: p.id, score: p.score, penaltyThisRound: p.collected.reduce((s, c) => s + cattleHeads(c), 0) }));
  return {
    board: gameState.board,
    triggeringCard,
    revealedThisTurn: sortedPlays.map((p) => ({
      playerId: p.playerId,
      card: p.card,
    })),
    resolutionIndex: gameState.pendingResolution?.nextIndex ?? 0,
    hand: player.hand.filter((card) => card !== triggeringCard),
    playerScores,
    playerCount: gameState.players.length,
    round: gameState.round,
    turn: gameState.turn,
    turnHistory: gameState.turnHistory,
    initialBoardCards: gameState.initialBoardCards,
  };
}

// ── Main runner ────────────────────────────────────────────────────────

export function runGame(config: SimConfig): GameResult {
  const { players } = config;

  // 1. Validate
  if (players.length < 2 || players.length > 10) {
    throw new Error(
      `Invalid player count: ${players.length}. Must be 2–10.`,
    );
  }
  for (const p of players) {
    const baseName = parseStrategySpec(p.strategy).name;
    if (!strategies.has(baseName)) {
      throw new Error(`Unknown strategy "${p.strategy}".`);
    }
  }

  // 2. Seed
  const seed = config.seed ?? randomUUID();

  // 3. Create game
  const playerIds = players.map((p) => p.id);
  let state = createGame(playerIds, seed);

  // 4. Instantiate strategies (merge inline options from qualified key with explicit strategyOptions)
  const strategyMap = new Map<string, Strategy>();
  for (const p of players) {
    const { name: baseName, options: parsedOptions } = parseStrategySpec(p.strategy);
    const factory = strategies.get(baseName)!;
    const mergedOptions = parsedOptions
      ? { ...parsedOptions, ...p.strategyOptions }
      : p.strategyOptions;
    strategyMap.set(p.id, factory(mergedOptions));
  }

  // 5. onGameStart
  for (const p of players) {
    const strat = strategyMap.get(p.id)!;
    strat.onGameStart?.({
      playerId: p.id,
      playerCount: players.length,
      rng: createPlayerRng(seed, p.id),
    });
  }

  // 6. Game loop
  let roundCount = 0;

  while (true) {
    // 6a. Deal round
    state = dealRound(state);
    roundCount++;

    // 6a.1 onRoundStart — notify strategies of new round
    for (const p of players) {
      const strat = strategyMap.get(p.id)!;
      const player = state.players.find((ps) => ps.id === p.id)!;
      try {
        strat.onRoundStart?.({ round: roundCount, hand: player.hand, board: state.board });
      } catch { /* lifecycle errors are non-fatal */ }
    }

    // 6b. 10 turns
    for (let t = 0; t < 10; t++) {
      // Collect card choices
      const plays: { playerId: string; card: CardNumber }[] = [];
      for (const p of players) {
        const strat = strategyMap.get(p.id)!;
        const player = state.players.find((ps) => ps.id === p.id)!;
        let card: CardNumber;

        try {
          const choiceState = toCardChoiceState(state, p.id);
          const chosen = strat.chooseCard(choiceState);
          if (player.hand.includes(chosen)) {
            card = chosen;
          } else {
            console.warn(
              `Strategy "${p.strategy}" (${p.id}) returned card ${chosen} not in hand; using lowest.`,
            );
            card = player.hand[0]; // hand is sorted ascending
          }
        } catch (err) {
          console.warn(
            `Strategy "${p.strategy}" (${p.id}) threw in chooseCard: ${err}; using lowest card.`,
          );
          card = player.hand[0];
        }

        plays.push({ playerId: p.id, card });
      }

      // Sort plays for building revealedThisTurn
      const sortedPlays = [...plays].sort((a, b) => a.card - b.card);

      let result = resolveTurn(state, plays);
      while (result.kind === 'needs-row-pick') {
        const picker = result.playerId;
        const strat = strategyMap.get(picker)!;
        let row = 0 as 0 | 1 | 2 | 3;
        try {
          const chosen = strat.chooseRow(buildRowChoiceState(picker, result.card, sortedPlays, result.state));
          row = isValidRowIndex(chosen) ? chosen : fewestHeadsRow(result.state);
        } catch { row = fewestHeadsRow(result.state); }
        result = applyRowPick(result.state, picker, row);
      }
      state = result.state;

      // onTurnResolved
      const resolution = buildTurnResolution(state);
      for (const p of players) {
        const strat = strategyMap.get(p.id)!;
        try {
          strat.onTurnResolved?.(resolution);
        } catch {
          // lifecycle errors are non-fatal
        }
      }
    }

    // 6c. Score round
    state = scoreRound(state);

    // 6d. onRoundEnd
    const scores = state.players.map((p) => ({ id: p.id, score: p.score }));
    for (const p of players) {
      const strat = strategyMap.get(p.id)!;
      try {
        strat.onRoundEnd?.(scores);
      } catch {
        // lifecycle errors are non-fatal
      }
    }

    // 6e. Check game over
    if (isGameOver(state)) break;
  }

  // 6f. onGameEnd — notify strategies of final outcome
  const finalScores = state.players.map((p) => ({ id: p.id, score: p.score }));
  for (const p of players) {
    const strat = strategyMap.get(p.id)!;
    const myScore = state.players.find((ps) => ps.id === p.id)!.score;
    const won = finalScores.every(s => s.id === p.id || s.score >= myScore);
    try {
      strat.onGameEnd?.({ scores: finalScores, rounds: roundCount, won });
    } catch { /* lifecycle errors are non-fatal */ }
  }

  // 7. Build result with rankings
  const strategyById = new Map(players.map((p) => [p.id, p.strategy]));

  const sortedByScore = state.players
    .map((p) => ({ id: p.id, score: p.score }))
    .sort((a, b) => a.score - b.score);

  // Assign ranks: lowest score = rank 1, ties share same rank
  const playerResults: PlayerResult[] = [];
  let currentRank = 1;
  for (let i = 0; i < sortedByScore.length; i++) {
    if (i > 0 && sortedByScore[i].score > sortedByScore[i - 1].score) {
      currentRank = i + 1;
    }
    playerResults.push({
      id: sortedByScore[i].id,
      strategy: strategyById.get(sortedByScore[i].id)!,
      finalScore: sortedByScore[i].score,
      rank: currentRank,
    });
  }

  return {
    seed,
    rounds: roundCount,
    playerResults,
  };
}
