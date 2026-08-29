import { describe, it, expect } from 'vitest';
import { determinePlacement, placeCard, collectRow } from '../../../src/engine/board';
import type { Board, CardNumber } from '../../../src/engine/types';

function cn(n: number): CardNumber {
  return n as CardNumber;
}

function mkBoard(rows: number[][]): Board {
  return { rows: rows.map((r) => r.map(cn)) } as unknown as Board;
}

describe('determinePlacement', () => {
  it('card goes to closest lower tail', () => {
    const board = mkBoard([[10], [20], [30], [40]]);
    const result = determinePlacement(board, cn(35));
    expect(result).toEqual({ kind: 'place', rowIndex: 2, causedOverflow: false });
  });

  it('returns must-pick-row when card < all tails', () => {
    const board = mkBoard([[10], [20], [30], [40]]);
    const result = determinePlacement(board, cn(5));
    expect(result).toEqual({ kind: 'must-pick-row' });
  });

  it('detects overflow when target row has 5 cards', () => {
    const board = mkBoard([[3, 5, 10, 22, 33], [50], [70], [90]]);
    const result = determinePlacement(board, cn(40));
    expect(result).toEqual({
      kind: 'place',
      rowIndex: 0,
      causedOverflow: true,
      collectedCards: [3, 5, 10, 22, 33].map(cn),
    });
  });
});

describe('placeCard', () => {
  it('appends card to row correctly', () => {
    const board = mkBoard([[10], [20], [30], [40]]);
    const newBoard = placeCard(board, cn(15), 0);
    expect(newBoard.rows[0]).toEqual([10, 15].map(cn));
    expect(newBoard.rows[1]).toEqual([20].map(cn));
  });

  it('overflow replaces row with single card', () => {
    const board = mkBoard([[3, 5, 10, 22, 33], [50], [70], [90]]);
    const newBoard = placeCard(board, cn(40), 0);
    expect(newBoard.rows[0]).toEqual([cn(40)]);
    expect(newBoard.rows[1]).toEqual([cn(50)]);
  });
});

describe('collectRow', () => {
  it('returns collected cards and new board', () => {
    const board = mkBoard([[10, 15], [20], [30], [40]]);
    const { newBoard, collected } = collectRow(board, 0, cn(5));
    expect(collected).toEqual([10, 15].map(cn));
    expect(newBoard.rows[0]).toEqual([cn(5)]);
    expect(newBoard.rows[1]).toEqual([cn(20)]);
  });
});
