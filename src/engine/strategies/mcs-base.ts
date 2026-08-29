/**
 * Shared MCS utilities — simulation primitives, card counting, and hand sampling.
 * Used by both `mcs.ts` (plain MCS) and `mcs-prior.ts` (prior-informed MCS).
 */
import type { TurnResolution } from './types';
import type { CardNumber, Board, CardChoiceState, RowChoiceState } from '../types';
import { cattleHeads } from '../card';

/** Pick the row with fewest total cattle heads. */
export function fewestHeadsRowIndex(rows: readonly (readonly CardNumber[])[]): 0 | 1 | 2 | 3 {
  let best = 0;
  let bestP = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i].reduce((s, c) => s + cattleHeads(c), 0);
    if (p < bestP) {
      bestP = p;
      best = i;
    }
  }
  return best as 0 | 1 | 2 | 3;
}

/** Deep-copy board rows into mutable arrays. */
export function cloneBoard(board: Board): CardNumber[][] {
  return board.rows.map((row) => [...row]);
}

/** Fisher-Yates shuffle (in-place) using provided rng. */
export function fisherYates<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Simulate placing all plays onto the board, return penalties for each play (by position).
 * Modifies board in-place.
 */
export function simulateTurn(
  plays: CardNumber[],
  board: CardNumber[][],
): number[] {
  const indexed = plays.map((card, i) => ({ card, idx: i }));
  indexed.sort((a, b) => a.card - b.card);
  const penalties = new Array(plays.length).fill(0) as number[];

  for (const { card, idx } of indexed) {
    let bestRow = -1;
    let bestTail = -1;
    for (let i = 0; i < board.length; i++) {
      const tail = board[i][board[i].length - 1];
      if (tail < card && tail > bestTail) {
        bestTail = tail;
        bestRow = i;
      }
    }

    if (bestRow === -1) {
      const rowIdx = fewestHeadsRowIndex(board);
      penalties[idx] += board[rowIdx].reduce((s, c) => s + cattleHeads(c), 0);
      board[rowIdx] = [card];
    } else if (board[bestRow].length >= 5) {
      penalties[idx] += board[bestRow].reduce((s, c) => s + cattleHeads(c), 0);
      board[bestRow] = [card];
    } else {
      board[bestRow].push(card);
    }
  }

  return penalties;
}

/**
 * Simulate a turn with tagged plays and accumulate penalties into a player-indexed array.
 */
export function accumulateTurn(
  taggedPlays: { playerIdx: number; card: CardNumber }[],
  board: CardNumber[][],
  totalPenalties: number[],
): void {
  const cards = taggedPlays.map(p => p.card) as CardNumber[];
  const turnPenalties = simulateTurn(cards, board);
  for (let i = 0; i < taggedPlays.length; i++) {
    totalPenalties[taggedPlays[i].playerIdx] += turnPenalties[i];
  }
}

/**
 * Build the unknown card pool by excluding all known cards.
 */
export function buildUnknownPool(
  hand: readonly CardNumber[],
  board: Board,
  seenCards: Set<number>,
  turnHistory: CardChoiceState['turnHistory'],
  initialBoardCards: readonly CardNumber[],
): CardNumber[] {
  const known = new Set<number>();
  for (const c of hand) known.add(c);
  for (const row of board.rows) {
    for (const c of row) known.add(c);
  }
  for (const c of seenCards) known.add(c);
  for (const entry of turnHistory) {
    for (const play of entry.plays) known.add(play.card);
  }
  for (const c of initialBoardCards) known.add(c);

  const pool: CardNumber[] = [];
  for (let i = 1; i <= 104; i++) {
    if (!known.has(i)) pool.push(i as CardNumber);
  }
  return pool;
}

/**
 * Build unknown pool for row choice context (includes revealedThisTurn and triggeringCard).
 */
export function buildUnknownPoolForRowChoice(
  hand: readonly CardNumber[],
  board: Board,
  seenCards: Set<number>,
  turnHistory: RowChoiceState['turnHistory'],
  revealedThisTurn: RowChoiceState['revealedThisTurn'],
  triggeringCard: CardNumber,
): CardNumber[] {
  const known = new Set<number>();
  for (const c of hand) known.add(c);
  for (const row of board.rows) {
    for (const c of row) known.add(c);
  }
  for (const c of seenCards) known.add(c);
  for (const entry of turnHistory) {
    for (const play of entry.plays) known.add(play.card);
  }
  for (const play of revealedThisTurn) {
    known.add(play.card);
  }
  known.add(triggeringCard);

  const pool: CardNumber[] = [];
  for (let i = 1; i <= 104; i++) {
    if (!known.has(i)) pool.push(i as CardNumber);
  }
  return pool;
}

/**
 * Update the seen cards set from a turn resolution.
 */
export function updateSeenCards(seenCards: Set<number>, resolution: TurnResolution): void {
  for (const play of resolution.plays) {
    seenCards.add(play.card);
  }
  for (const res of resolution.resolutions) {
    if (res.collectedCards) {
      for (const c of res.collectedCards) seenCards.add(c);
    }
  }
  for (const pick of resolution.rowPicks) {
    for (const c of pick.collectedCards) seenCards.add(c);
  }
  if (resolution.boardAfter) {
    for (const row of resolution.boardAfter) {
      for (const card of row) seenCards.add(card);
    }
  }
}

/**
 * Sample opponent hands from the unknown pool.
 * Shuffles pool in-place and slices off hands.
 */
export function sampleOpponentHands(
  unknownPool: CardNumber[],
  opponentCount: number,
  cardsPerPlayer: number,
  rng: () => number,
): CardNumber[][] {
  fisherYates(unknownPool, rng);
  const hands: CardNumber[][] = [];
  let offset = 0;
  for (let opp = 0; opp < opponentCount; opp++) {
    const hs = Math.min(cardsPerPlayer, unknownPool.length - offset);
    if (hs > 0) {
      hands.push(unknownPool.slice(offset, offset + hs) as CardNumber[]);
      offset += hs;
    } else {
      hands.push([]);
    }
  }
  return hands;
}
