import type { Strategy, TurnResolution } from './types';
import type { CardNumber } from '../types';
import { cattleHeads } from '../card';
import {
  fewestHeadsRowIndex,
  cloneBoard,
  accumulateTurn,
  buildUnknownPool,
  buildUnknownPoolForRowChoice,
  updateSeenCards,
  sampleOpponentHands,
} from './mcs-base';

const DEFAULT_MC_PER_CARD = 50;

export interface McsOptions {
  /** Maximum total simulations across all cards (default: 10 × mcPerCard) */
  mcMax?: number;
  /** Simulations per candidate card (default: 50, capped by mcMax) */
  mcPerCard?: number;
  /** Scoring mode: 'self' = minimize own penalty, 'relative' = minimize own minus avg opponent (default: 'self') */
  scoring?: 'self' | 'relative';
}

/**
 * Simulate the entire remaining round from a given state.
 * Returns array of penalties for each player (index 0 = us).
 *
 * hands[0] = our hand (with myCard already chosen for turn 1)
 * hands[1..N-1] = sampled opponent hands
 */
function simulateRound(
  board: CardNumber[][],
  hands: CardNumber[][],
  myFirstCard: CardNumber,
  rng: () => number,
): number[] {
  const playerCount = hands.length;
  const totalPenalties = new Array(playerCount).fill(0) as number[];

  // First turn: we play myFirstCard, opponents play random
  const firstPlays: { playerIdx: number; card: CardNumber }[] = [{ playerIdx: 0, card: myFirstCard }];
  for (let i = 1; i < playerCount; i++) {
    if (hands[i].length === 0) continue;
    const idx = Math.floor(rng() * hands[i].length);
    firstPlays.push({ playerIdx: i, card: hands[i][idx] });
    hands[i].splice(idx, 1);
  }
  // Remove our played card from hand
  const myHandIdx = hands[0].indexOf(myFirstCard);
  if (myHandIdx !== -1) hands[0].splice(myHandIdx, 1);

  accumulateTurn(firstPlays, board, totalPenalties);

  // Remaining turns: all players play random
  const remainingTurns = hands[0].length;
  for (let t = 0; t < remainingTurns; t++) {
    const plays: { playerIdx: number; card: CardNumber }[] = [];
    for (let i = 0; i < playerCount; i++) {
      if (hands[i].length === 0) continue;
      const idx = Math.floor(rng() * hands[i].length);
      plays.push({ playerIdx: i, card: hands[i][idx] });
      hands[i].splice(idx, 1);
    }
    if (plays.length > 0) {
      accumulateTurn(plays, board, totalPenalties);
    }
  }

  return totalPenalties;
}

/**
 * Monte-Carlo Search strategy.
 *
 * Simulates full remaining rounds with random opponent hands to evaluate
 * each possible card play. Picks the card with lowest average total penalty
 * across all simulations.
 *
 * Card counting is fed by the caller via onTurnResolved() — the strategy
 * tracks all cards it's been told about and excludes them from the unknown pool.
 *
 * Based on the MCS agent from:
 *   Johann Brehmer & Marcel Gutsche, "Beating 6 nimmt! with reinforcement learning"
 *   https://github.com/johannbrehmer/rl-6nimmt
 */
export function createMcsStrategy(options: McsOptions = {}): Strategy {
  // Validate options — reject unknown keys to catch typos
  const VALID_OPTIONS = new Set(['mcPerCard', 'mcMax', 'scoring']);
  for (const key of Object.keys(options)) {
    if (!VALID_OPTIONS.has(key)) {
      throw new Error(`Unknown MCS option "${key}". Valid options: ${[...VALID_OPTIONS].join(', ')}`);
    }
  }
  if (options.scoring !== undefined && options.scoring !== 'self' && options.scoring !== 'relative') {
    throw new Error(`Invalid scoring mode "${options.scoring}". Must be "self" or "relative".`);
  }

  const mcPerCard = Math.max(1, Math.floor(Number(options.mcPerCard) || DEFAULT_MC_PER_CARD));
  // Default mcMax = 10 × mcPerCard (max hand size is 10, so budget never clips by default)
  const mcMax = Math.max(1, Math.floor(Number(options.mcMax) || mcPerCard * 10));
  const scoring: 'self' | 'relative' = options.scoring === 'relative' ? 'relative' : 'self';
  let rng: (() => number) | null = null;
  let playerCount = 2;
  // Persistent set of all cards ever observed — fed by onTurnResolved().
  let seenCards = new Set<number>();

  /** Score a simulation result based on scoring mode. Lower = better. */
  function score(penalties: number[]): number {
    const myPenalty = penalties[0];
    if (scoring === 'self') return myPenalty;
    // 'relative': our penalty minus average opponent penalty (negative = we're winning)
    const oppTotal = penalties.slice(1).reduce((s, p) => s + p, 0);
    const oppAvg = penalties.length > 1 ? oppTotal / (penalties.length - 1) : 0;
    return myPenalty - oppAvg;
  }

  return {
    name: 'mcs',

    getOptions() {
      return { mcPerCard, mcMax, scoring };
    },

    onGameStart(config) {
      rng = config.rng;
      playerCount = config.playerCount;
      seenCards = new Set();
    },

    onRoundStart() {
      seenCards = new Set();
    },

    onTurnResolved(resolution: TurnResolution) {
      updateSeenCards(seenCards, resolution);
    },

    chooseCard(state) {
      if (!rng) throw new Error('McsStrategy: onGameStart() must be called before chooseCard()');
      const { hand, board, turn } = state;
      const opponentCount = playerCount - 1;
      const cardsPerPlayer = 10 - turn + 1;

      const unknownPool = buildUnknownPool(hand, board, seenCards, state.turnHistory, state.initialBoardCards);

      // Number of simulations
      const nSims = Math.min(mcMax, mcPerCard * hand.length);

      // If only one card, just play it
      if (hand.length === 1) return hand[0];

      let bestCard = hand[0];
      let bestPenalty = Infinity;

      for (const myCard of hand) {
        let totalPenalty = 0;
        const simsPerCard = Math.max(1, Math.floor(nSims / hand.length));

        for (let sample = 0; sample < simsPerCard; sample++) {
          const oppHands = sampleOpponentHands(unknownPool, opponentCount, cardsPerPlayer, rng);
          const hands: CardNumber[][] = [
            [...hand].filter((c) => c !== myCard) as CardNumber[],
            ...oppHands,
          ];

          const boardCopy = cloneBoard(board);
          totalPenalty += score(simulateRound(boardCopy, hands, myCard, rng));
        }

        const avgPenalty = totalPenalty / simsPerCard;
        if (avgPenalty < bestPenalty) {
          bestPenalty = avgPenalty;
          bestCard = myCard;
        }
      }

      return bestCard;
    },

    chooseRow(state) {
      if (!rng) throw new Error('McsStrategy: onGameStart() must be called before chooseRow()');
      // For row picks: simulate remaining round for each row choice
      const { board } = state;
      const opponentCount = playerCount - 1;
      // Remove triggeringCard from hand — it's already been played this turn
      const hand = state.hand.filter(c => c !== state.triggeringCard);
      const cardsPerPlayer = hand.length;

      const unknownPool = buildUnknownPoolForRowChoice(
        hand, board, seenCards, state.turnHistory, state.revealedThisTurn, state.triggeringCard,
      );

      // If cardsPerPlayer is 0 or this is the last turn, just pick fewest heads
      if (cardsPerPlayer === 0) {
        return fewestHeadsRowIndex(board.rows);
      }

      const simsPerRow = mcPerCard;
      let bestRow: 0 | 1 | 2 | 3 = 0;
      let bestPenalty = Infinity;

      for (let rowIdx = 0; rowIdx < 4; rowIdx++) {
        let totalPenalty = 0;

        for (let sample = 0; sample < simsPerRow; sample++) {
          // Simulate taking this row
          const boardCopy = cloneBoard(board);
          const rowPenalty = boardCopy[rowIdx].reduce((s, c) => s + cattleHeads(c), 0);
          boardCopy[rowIdx] = [state.triggeringCard];

          // Deal opponent hands for remaining turns
          const oppHands = sampleOpponentHands(unknownPool, opponentCount, cardsPerPlayer, rng);
          const hands: CardNumber[][] = [[...hand] as CardNumber[], ...oppHands];

          // Play out remaining turns randomly, accumulate all penalties
          const simPenalties = new Array(hands.length).fill(0) as number[];
          simPenalties[0] = rowPenalty; // we already took the row
          const remainingTurns = hands[0].length;
          for (let t = 0; t < remainingTurns; t++) {
            const taggedPlays: { playerIdx: number; card: CardNumber }[] = [];
            for (let i = 0; i < hands.length; i++) {
              if (hands[i].length === 0) continue;
              const idx = Math.floor(rng() * hands[i].length);
              taggedPlays.push({ playerIdx: i, card: hands[i][idx] });
              hands[i].splice(idx, 1);
            }
            if (taggedPlays.length > 0) {
              accumulateTurn(taggedPlays, boardCopy, simPenalties);
            }
          }

          totalPenalty += score(simPenalties);
        }

        const avgPenalty = totalPenalty / simsPerRow;
        if (avgPenalty < bestPenalty) {
          bestPenalty = avgPenalty;
          bestRow = rowIdx as 0 | 1 | 2 | 3;
        }
      }

      return bestRow;
    },
  };
}
