/**
 * Bayesian-Simple strategy — expected-penalty minimisation.
 *
 * For each candidate card, estimates its expected penalty by sampling K random
 * opponent hands from the unknown card pool and simulating a single turn.
 * Unlike MCS (which simulates entire rounds), this evaluates only the immediate
 * next turn — making it fast but short-sighted.
 *
 * The "Bayesian" label comes from treating opponent hands as drawn from a
 * uniform distribution over unseen cards (the posterior given our observations).
 * In practice this is Monte Carlo sampling, not full Bayesian inference.
 *
 * Strengths: Fast (~200 samples), good at avoiding immediate danger.
 * Weaknesses: No long-term planning, no opponent modeling beyond uniform random.
 */
import type { Strategy, TurnResolution } from './types';
import type { CardNumber, Board } from '../types';
import { cattleHeads } from '../card';

/** Monte Carlo samples per decision — higher = more accurate but slower. */
const K = 200;

function fewestHeadsRowIndex(rows: readonly (readonly CardNumber[])[]): 0 | 1 | 2 | 3 {
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

/** Simulate placing all plays onto the board, return penalty for targetCard's owner. */
function simulateTurn(
  plays: { card: CardNumber; isMe: boolean }[],
  board: CardNumber[][],
): number {
  const sorted = [...plays].sort((a, b) => a.card - b.card);
  let penalty = 0;

  for (const play of sorted) {
    // Find best row: tail < card and largest such tail
    let bestRow = -1;
    let bestTail = -1;
    for (let i = 0; i < board.length; i++) {
      const tail = board[i][board[i].length - 1];
      if (tail < play.card && tail > bestTail) {
        bestTail = tail;
        bestRow = i;
      }
    }

    if (bestRow === -1) {
      // Card lower than all tails — forced row pick (fewest heads)
      const rowIdx = fewestHeadsRowIndex(board);
      if (play.isMe) {
        penalty += board[rowIdx].reduce((s, c) => s + cattleHeads(c), 0);
      }
      board[rowIdx] = [play.card];
    } else if (board[bestRow].length >= 5) {
      // Overflow: 6th card
      if (play.isMe) {
        penalty += board[bestRow].reduce((s, c) => s + cattleHeads(c), 0);
      }
      board[bestRow] = [play.card];
    } else {
      board[bestRow].push(play.card);
    }
  }

  return penalty;
}

/** Deep-copy board rows into mutable arrays. */
function cloneBoard(board: Board): CardNumber[][] {
  return board.rows.map((row) => [...row]);
}

/** Fisher-Yates shuffle (in-place) using provided rng. */
function fisherYates<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

export function createBayesianSimpleStrategy(): Strategy {
  let rng: (() => number) | null = null;
  let playerCount = 2;
  // Persistent set of all cards ever observed — fed by onTurnResolved().
  let seenCards = new Set<number>();

  return {
    name: 'bayesian-simple',

    onGameStart(config) {
      rng = config.rng;
      playerCount = config.playerCount;
      seenCards = new Set();
    },

    onRoundStart() {
      seenCards = new Set();
    },

    onTurnResolved(resolution: TurnResolution) {
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
    },

    chooseCard(state) {
      if (!rng) throw new Error('BayesianSimpleStrategy: onGameStart() must be called before chooseCard()');
      const { hand, board, turn } = state;
      const opponentCount = playerCount - 1;
      const cardsPerPlayer = 10 - turn + 1; // cards remaining in each hand

      // Build unknown pool
      const known = new Set<number>();
      for (const c of hand) known.add(c);
      for (const row of board.rows) {
        for (const c of row) known.add(c);
      }
      for (const c of seenCards) known.add(c);
      for (const entry of state.turnHistory) {
        for (const play of entry.plays) known.add(play.card);
      }
      for (const c of state.initialBoardCards) known.add(c);

      const unknownPool: CardNumber[] = [];
      for (let i = 1; i <= 104; i++) {
        if (!known.has(i)) unknownPool.push(i as CardNumber);
      }

      let bestCard = hand[0];
      let bestPenalty = Infinity;

      for (const myCard of hand) {
        let totalPenalty = 0;

        for (let sample = 0; sample < K; sample++) {
          // Shuffle unknown pool and deal to opponents
          fisherYates(unknownPool, rng);

          const plays: { card: CardNumber; isMe: boolean }[] = [
            { card: myCard, isMe: true },
          ];

          let offset = 0;
          for (let opp = 0; opp < opponentCount; opp++) {
            const handSize = Math.min(cardsPerPlayer, unknownPool.length - offset);
            if (handSize > 0) {
              // Pick a random card from this opponent's dealt hand
              const oppCardIdx = offset + Math.floor(rng() * handSize);
              plays.push({ card: unknownPool[oppCardIdx], isMe: false });
              offset += handSize;
            }
          }

          const boardCopy = cloneBoard(board);
          totalPenalty += simulateTurn(plays, boardCopy);
        }

        const avgPenalty = totalPenalty / K;
        if (avgPenalty < bestPenalty) {
          bestPenalty = avgPenalty;
          bestCard = myCard;
        }
      }

      return bestCard;
    },

    chooseRow(state) {
      return fewestHeadsRowIndex(state.board.rows);
    },
  };
}
