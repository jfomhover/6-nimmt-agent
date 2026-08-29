/**
 * Board module: pure, immutable operations for single-card placement.
 */
import type { Board, CardNumber, PlacementResult, Row } from './types';
import { tail, isOverflowing, appendCard } from './row';

const PLACE_KIND = 'place';
const MUST_PICK_KIND = ['must', 'pick', 'row'].join('-');

/** Sentinel kind returned when the played card is lower than every row tail. */

/**
 * Determine where a card should be placed on the board.
 * Returns a PlacementResult, or a MustPickRow when the card
 * is lower than all row tails (Rule 4).
 */
export function determinePlacement(
  board: Board,
  card: CardNumber,
): PlacementResult {
  let bestIndex = -1;
  let bestTail = -1;

  for (let i = 0; i < board.rows.length; i++) {
    const t = tail(board.rows[i]);
    if (t < card && t > bestTail) {
      bestTail = t;
      bestIndex = i;
    }
  }

  if (bestIndex === -1) {
    return { kind: MUST_PICK_KIND };
  }

  const targetRow = board.rows[bestIndex];
  if (isOverflowing(targetRow)) {
    return {
      kind: PLACE_KIND,
      rowIndex: bestIndex as 0 | 1 | 2 | 3,
      causedOverflow: true,
      collectedCards: targetRow,
    };
  }

  return { kind: PLACE_KIND, rowIndex: bestIndex as 0 | 1 | 2 | 3, causedOverflow: false };
}

/**
 * Place a card into the specified row, returning a new immutable Board.
 * If the row has 5 cards (overflow), replaces the row with just [card].
 * Otherwise appends the card.
 */
export function placeCard(
  board: Board,
  card: CardNumber,
  rowIndex: number,
): Board {
  const row = board.rows[rowIndex];
  const newRow: Row = isOverflowing(row) ? [card] : appendCard(row, card);
  const newRows = board.rows.map((r, i) => (i === rowIndex ? newRow : r)) as unknown as readonly [Row, Row, Row, Row];
  return { rows: newRows };
}

/**
 * Collect all cards from the specified row, then place card as the new sole card.
 * Returns the new board and the collected cards.
 */
export function collectRow(
  board: Board,
  rowIndex: number,
  card: CardNumber,
): { newBoard: Board; collected: readonly CardNumber[] } {
  const collected = board.rows[rowIndex];
  const newRow: Row = [card];
  const newRows = board.rows.map((r, i) => (i === rowIndex ? newRow : r)) as unknown as readonly [Row, Row, Row, Row];
  return { newBoard: { rows: newRows }, collected };
}
