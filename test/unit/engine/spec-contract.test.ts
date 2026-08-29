import { describe, expect, it } from 'vitest';
import { applyRowPick, cattleHeads, createGame, resolveTurn, scoreRound, toRowChoiceState } from '../../../src/engine/index.js';
import type { Board, CardNumber, GameState, PlayCardMove } from '../../../src/engine/types.js';

const card = (n: number) => n as CardNumber;

describe('documented engine lifecycle', () => {
  it('pauses rule 4 and resumes through applyRowPick', () => {
    const base = createGame(['p0', 'p1'], 'contract-seed');
    const state: GameState = {
      ...base,
      phase: 'awaiting-cards',
      turn: 1,
      board: { rows: [[card(20)], [card(40)], [card(60)], [card(80)]] as Board['rows'] },
      players: [
        { id: 'p0', hand: [card(10)], collected: [], score: 0 },
        { id: 'p1', hand: [card(30)], collected: [], score: 0 },
      ],
      initialBoardCards: [card(20), card(40), card(60), card(80)],
    };
    const result = resolveTurn(state, [{ playerId: 'p0', card: card(10) }, { playerId: 'p1', card: card(30) }] satisfies PlayCardMove[]);
    expect(result.kind).toBe('needs-row-pick');
    expect(result.state.phase).toBe('awaiting-row-pick');
    expect(toRowChoiceState(result.state, 'p0').hand).toEqual([]);
    const completed = applyRowPick(result.state, 'p0', 0);
    expect(completed.kind).toBe('completed');
    expect(completed.state.phase).toBe('awaiting-cards');
    expect(completed.state.players[0].score).toBe(0);
    expect(completed.state.players[0].collected).toEqual([card(20)]);
  });

  it('scores collected cards only at scoreRound', () => {
    expect(cattleHeads(55)).toBe(7);
    const base = createGame(['p0', 'p1'], 'score-contract');
    const state: GameState = {
      ...base,
      phase: 'round-over',
      turn: 10,
      players: [
        { id: 'p0', hand: [], collected: [card(55)], score: 0 },
        { id: 'p1', hand: [], collected: [], score: 0 },
      ],
    };
    const scored = scoreRound(state);
    expect(scored.players[0].score).toBe(7);
    expect(scored.players[0].collected).toEqual([card(55)]);
  });
});
