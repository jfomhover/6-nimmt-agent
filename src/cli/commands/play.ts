import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import type { CardNumber, GameState } from '../../engine/types.js';
import type { Strategy, TurnResolution } from '../../engine/strategies/types.js';
import {
  createGame,
  dealRound,
  resolveTurn,
  applyRowPick,
  scoreRound,
  isGameOver,
  toCardChoiceState,
  strategies,
  parseStrategySpec,
  cattleHeads,
  deriveSeedState,
  xoshiro256ss,
} from '../../engine/index.js';
import { format } from '../formatters/index.js';
import type {
  PlayResult,
  PlayRound,
  PlayTurn,
  PlayScore,
  PlayFinalResult,
  OutputFormat,
} from '../formatters/types.js';
import { didYouMean, outputError, createMeta, parseStrategies } from '../helpers.js';

function createPlayerRng(seed: string, playerId: string): () => number {
  const state = deriveSeedState(seed + '/' + playerId);
  return () => Number(xoshiro256ss(state) >> 11n) / 2 ** 53;
}

function fewestHeadsRow(gameState: GameState): 0 | 1 | 2 | 3 {
  let bestIndex = 0;
  let bestPenalty = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = gameState.board.rows[i].reduce((sum, c) => sum + cattleHeads(c), 0);
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

function buildRowChoiceState(
  playerId: string,
  triggeringCard: CardNumber,
  sortedPlays: readonly { playerId: string; card: CardNumber }[],
  gameState: GameState,
): import('../../engine/types.js').RowChoiceState {
  const player = gameState.players.find((p) => p.id === playerId)!;
  const playerScores = gameState.players.map((p) => ({ id: p.id, score: p.score, penaltyThisRound: p.collected.reduce((s, c) => s + cattleHeads(c), 0) }));
  return {
    board: gameState.board,
    triggeringCard,
    revealedThisTurn: sortedPlays.map((p) => ({ playerId: p.playerId, card: p.card })),
    resolutionIndex: gameState.pendingResolution?.nextIndex ?? 0,
    hand: player.hand,
    playerScores,
    playerCount: gameState.players.length,
    round: gameState.round,
    turn: gameState.turn,
    turnHistory: gameState.turnHistory,
    initialBoardCards: gameState.initialBoardCards,
  };
}

export const playCommand = new Command('play')
  .description('Play a single game with full round-by-round output')
  .requiredOption('-s, --strategies <strategies>', 'Comma-separated list of strategy names')
  .option('-S, --seed <seed>', 'Random seed for reproducibility')
  .option('-f, --format <format>', 'Output format (table, json)', 'table')
  .action((opts) => {
    const fmt = opts.format as OutputFormat;
    const startTime = Date.now();

    // Parse strategies
    let strategySpecs: { name: string; options?: Record<string, unknown> }[];
    try {
      const names = parseStrategies(opts.strategies as string);
      strategySpecs = names.map(parseStrategySpec);
    } catch {
      outputError(fmt, 'INVALID_STRATEGY', `Failed to parse strategies: ${opts.strategies}`);
      process.exit(1);
    }

    // Validate strategies exist
    for (const spec of strategySpecs) {
      if (!strategies.has(spec.name)) {
        const valid = [...strategies.keys()];
        const suggestion = didYouMean(spec.name, valid);
        outputError(fmt, 'INVALID_STRATEGY',
          `Unknown strategy '${spec.name}'.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`, valid);
        process.exit(1);
      }
    }

    if (strategySpecs.length < 2 || strategySpecs.length > 10) {
      outputError(fmt, 'INVALID_PLAYER_COUNT', `Need 2–10 strategies, got ${strategySpecs.length}.`);
      process.exit(1);
    }

    const seed = opts.seed ?? randomUUID();
    const players = strategySpecs.map((s, i) => ({ id: `player-${i}`, strategy: s.name, options: s.options }));
    const playerIds = players.map((p) => p.id);

    try {
      let state = createGame(playerIds, seed);

      // Instantiate strategies
      const strategyMap = new Map<string, Strategy>();
      for (const p of players) {
        strategyMap.set(p.id, strategies.get(p.strategy)!(p.options));
      }
      for (const p of players) {
        strategyMap.get(p.id)!.onGameStart?.({
          playerId: p.id,
          playerCount: players.length,
          rng: createPlayerRng(seed, p.id),
        });
      }

      const rounds: PlayRound[] = [];
      const scoresBefore = new Map<string, number>();

      while (true) {
        state = dealRound(state);
        const initialBoard = state.board.rows.map((row) => [...row] as number[]);
        const turns: PlayTurn[] = [];

        // onRoundStart — notify strategies of new round
        for (const p of players) {
          const strat = strategyMap.get(p.id)!;
          const player = state.players.find((ps) => ps.id === p.id)!;
          try {
            strat.onRoundStart?.({ round: state.round, hand: player.hand, board: state.board });
          } catch { /* lifecycle errors are non-fatal */ }
        }

        // Track scores at round start
        for (const p of state.players) scoresBefore.set(p.id, p.score);

        for (let t = 0; t < 10; t++) {
          const plays: { playerId: string; card: CardNumber }[] = [];
          for (const p of players) {
            const strat = strategyMap.get(p.id)!;
            const player = state.players.find((ps) => ps.id === p.id)!;
            let card: CardNumber;
            try {
              const choiceState = toCardChoiceState(state, p.id);
              const chosen = strat.chooseCard(choiceState);
              card = player.hand.includes(chosen) ? chosen : player.hand[0];
            } catch {
              card = player.hand[0];
            }
            plays.push({ playerId: p.id, card });
          }

          const sortedPlays = [...plays].sort((a, b) => a.card - b.card);
          const turnPlays = plays.map((play, i) => ({
            seatIndex: i,
            playerId: play.playerId,
            strategy: players[i].strategy,
            card: play.card as number,
          }));

          let result = resolveTurn(state, plays);
          while (result.kind === 'needs-row-pick') {
            const strat = strategyMap.get(result.playerId)!;
            let row = 0 as 0 | 1 | 2 | 3;
            try {
              const chosen = strat.chooseRow(buildRowChoiceState(result.playerId, result.card, sortedPlays, result.state));
              row = isValidRowIndex(chosen) ? chosen : fewestHeadsRow(result.state);
            } catch { row = fewestHeadsRow(result.state); }
            result = applyRowPick(result.state, result.playerId, row);
          }
          state = result.state;

          // Build placements and rowPicks from turn history
          const lastEntry = state.turnHistory[state.turnHistory.length - 1];
          const placements = lastEntry.resolutions.map((r) => ({
            card: r.card as number,
            rowIndex: r.rowIndex,
            overflow: r.causedOverflow,
            ...(r.collectedCards ? { collectedCards: [...r.collectedCards] as number[] } : {}),
          }));
          const rowPicks = lastEntry.rowPicks.map((rp) => ({
            playerId: rp.playerId,
            rowIndex: rp.rowIndex,
            collectedCards: [...rp.collectedCards] as number[],
          }));

          turns.push({
            turn: lastEntry.turn,
            plays: turnPlays,
            placements,
            rowPicks,
          });

          // Notify strategies
          const resolution = buildTurnResolution(state);
          for (const p of players) {
            try { strategyMap.get(p.id)!.onTurnResolved?.(resolution); } catch { /* non-fatal */ }
          }
        }

        state = scoreRound(state);

        // Round scores
        const scores: PlayScore[] = players.map((p, i) => ({
          seatIndex: i,
          playerId: p.id,
          strategy: p.strategy,
          roundPenalty: state.players.find((ps) => ps.id === p.id)!.score - scoresBefore.get(p.id)!,
          totalScore: state.players.find((ps) => ps.id === p.id)!.score,
        }));

        // Notify strategies
        const roundScores = state.players.map((p) => ({ id: p.id, score: p.score }));
        for (const p of players) {
          try { strategyMap.get(p.id)!.onRoundEnd?.(roundScores); } catch { /* non-fatal */ }
        }

        rounds.push({ round: state.round - 1, initialBoard, turns, scores });

        if (isGameOver(state)) break;
      }

      // onGameEnd — notify strategies of final outcome
      const endScores = state.players.map((p) => ({ id: p.id, score: p.score }));
      for (const p of players) {
        const strat = strategyMap.get(p.id)!;
        const myScore = state.players.find((ps) => ps.id === p.id)!.score;
        const won = endScores.every(s => s.id === p.id || s.score >= myScore);
        try {
          strat.onGameEnd?.({ scores: endScores, rounds: rounds.length, won });
        } catch { /* lifecycle errors are non-fatal */ }
      }

      // Final results with rankings
      const sorted = state.players
        .map((p) => ({ id: p.id, score: p.score }))
        .sort((a, b) => a.score - b.score);
      const finalResults: PlayFinalResult[] = [];
      let currentRank = 1;
      for (let i = 0; i < sorted.length; i++) {
        if (i > 0 && sorted[i].score > sorted[i - 1].score) currentRank = i + 1;
        const seatIndex = players.findIndex((p) => p.id === sorted[i].id);
        finalResults.push({
          seatIndex,
          playerId: sorted[i].id,
          strategy: players[seatIndex].strategy,
          finalScore: sorted[i].score,
          rank: currentRank,
        });
      }

      const output: PlayResult = {
        meta: createMeta('play', startTime),
        seed,
        strategies: strategySpecs.map(s => s.name),
        rounds,
        finalResults,
      };

      console.log(format(output, fmt));
    } catch (err) {
      outputError(fmt, 'ENGINE_ERROR', `Engine error: ${(err as Error).message}`);
      process.exit(2);
    }
  });
