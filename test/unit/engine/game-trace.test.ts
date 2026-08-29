import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGame,
  dealRound,
  resolveTurn,
  applyRowPick,
  scoreRound,
  isGameOver,
  getWinners,
} from '../../../src/engine/game';
import type { CardNumber, GameState, PlayCardMove, Board } from '../../../src/engine/types';

// ── Load fixtures ──────────────────────────────────────────────────────

interface RowPick {
  playerId: string;
  card: number;
  pickedRowIndex: number;
  collectedCards: number[];
  cattleHeadsCollected: number;
}

interface TurnTrace {
  turn: number;
  plays: { playerId: string; card: number }[];
  resolutions: {
    playerId: string;
    card: number;
    rowIndex: number;
    causedOverflow: boolean;
  }[];
  rowPicks: RowPick[];
  boardAfter: number[][];
}

interface RoundScore {
  id: string;
  penalty: number;
  totalScore: number;
}

interface RoundTrace {
  round: number;
  deckOrder: number[];
  dealtHands: Record<string, number[]>;
  initialBoard: number[][];
  turns: TurnTrace[];
  roundScores: RoundScore[];
}

interface GameTrace {
  id: string;
  seed: string;
  playerCount: number;
  rounds: RoundTrace[];
  finalResults: { id: string; finalScore: number; rank: number }[];
  winners: string[];
}

const __dirname = join(fileURLToPath(import.meta.url), '..');
const fixturePath = join(__dirname, '../../../spec/fixtures/full-game-traces.json');
const traces: GameTrace[] = JSON.parse(readFileSync(fixturePath, 'utf-8'));

// ── Helper to compare boards ───────────────────────────────────────────

function boardToArrays(board: Board): number[][] {
  return board.rows.map((row) => [...row]);
}

// ── Full game trace replay ─────────────────────────────────────────────

describe('full game trace replay', () => {
  for (const trace of traces) {
    describe(trace.id, () => {
      const playerIds = Array.from(
        { length: trace.playerCount },
        (_, i) => `p${i}`,
      );

      it('replays entire game correctly', () => {
        let state = createGame(playerIds, trace.seed);

        for (const round of trace.rounds) {
          // Deal round
          state = dealRound(state);
          expect(state.round).toBe(round.round);
          expect(state.turn).toBe(1);
          expect(state.phase).toBe('awaiting-cards');

          // Verify dealt hands (sorted ascending in fixture)
          for (const player of state.players) {
            const expectedHand = round.dealtHands[player.id];
            expect([...player.hand]).toEqual(expectedHand);
          }

          // Verify initial board
          expect(boardToArrays(state.board)).toEqual(round.initialBoard);

          // Build row-pick lookup for this round
          const rowPickLookup = new Map<string, Map<number, number>>();
          for (const turn of round.turns) {
            for (const rp of turn.rowPicks) {
              if (!rowPickLookup.has(rp.playerId)) {
                rowPickLookup.set(rp.playerId, new Map());
              }
              rowPickLookup.get(rp.playerId)!.set(rp.card, rp.pickedRowIndex);
            }
          }

          // Resolve each turn
          for (const turnTrace of round.turns) {
            const plays: PlayCardMove[] = turnTrace.plays.map((p) => ({
              playerId: p.playerId,
              card: p.card as CardNumber,
            }));

            const rowPickFn = (playerId: string, _s: GameState): number => {
              const playerPicks = rowPickLookup.get(playerId);
              if (!playerPicks) {
                throw new Error(
                  `No row pick data for player ${playerId} in turn ${turnTrace.turn}`,
                );
              }
              // Find the pick for this player in this turn
              const turnRowPick = turnTrace.rowPicks.find(
                (rp) => rp.playerId === playerId,
              );
              if (!turnRowPick) {
                throw new Error(
                  `No row pick for player ${playerId} in turn ${turnTrace.turn}`,
                );
              }
              return turnRowPick.pickedRowIndex;
            };

            let resolution = resolveTurn(state, plays);
            while (resolution.kind === 'needs-row-pick') {
              const row = rowPickFn(resolution.playerId, resolution.state);
              resolution = applyRowPick(resolution.state, resolution.playerId, row as 0 | 1 | 2 | 3);
            }
            state = resolution.state;

            // Verify board after turn
            expect(boardToArrays(state.board)).toEqual(turnTrace.boardAfter);
          }

          // Scores are applied at the round boundary, not during turn resolution.
          state = scoreRound(state);

          // Verify round scores
          for (const rs of round.roundScores) {
            const player = state.players.find((p) => p.id === rs.id);
            expect(player).toBeDefined();
            expect(player!.score).toBe(rs.totalScore);
          }

          // Transition to next round is performed by dealRound().
        }

        // Verify final results
        for (const fr of trace.finalResults) {
          const player = state.players.find((p) => p.id === fr.id);
          expect(player).toBeDefined();
          expect(player!.score).toBe(fr.finalScore);
        }

        // Verify winners
        expect(getWinners(state).sort()).toEqual([...trace.winners].sort());

        // Verify game over (last round should have triggered it)
        expect(isGameOver(state)).toBe(true);
      });
    });
  }
});
