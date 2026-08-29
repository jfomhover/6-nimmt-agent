/**
 * MCS-Prior strategy — Monte Carlo Search enhanced with prior-based heuristic evaluation.
 *
 * ARCHITECTURE:
 * For each candidate card, run N simulations:
 *   1. Simulate 1 turn (our card + prior-weighted opponent cards) → immediate penalty
 *   2. Evaluate remaining hand danger with heuristic → long-term risk
 *   3. Total score = immediate penalty + heuristic danger (relative to opponents)
 *   Pick the card with lowest average total score.
 *
 * THREE KEY HEURISTICS (see evaluateHand for implementation):
 *
 * A) TRAPPED CARD MANAGEMENT (cards below all row tops)
 *    - These cards ALWAYS trigger a row pick, the question is "when."
 *    - Turns 1-3: suppress urgency. Early game should focus on shedding high-penalty
 *      overflow cards (e.g., 55=7 heads). Low cards cost 1-2 heads and can wait.
 *    - Turns 4+: activate trapped penalty, ramping with urgency. If a cheap row exists
 *      (≤2 cards), the scale is high (1.5) to encourage immediate play. If rows are
 *      expensive (4-5 cards), scale is low (0.7) to discourage costly row picks.
 *    - The `trappedDiscount` parameter controls how fast urgency ramps:
 *      cardDanger *= (1 + remainingTurns × trappedDiscount × urgency)
 *
 * B) OVERFLOW RISK (cards above all row tops, but may overflow primed rows)
 *    - Scaled by how many rows are primed (5 cards) relative to baseline for this turn.
 *    - Danger = overflowRate × avgOverflowPenalty × (primedCount / baselinePrimed)
 *
 * C) TIMING PRESSURE (holding cards past their natural play window)
 *    - Each card has an avgTurn from the prior (when it's typically played).
 *    - If held past that turn: cardDanger *= (1 + (turn - avgTurn) × timingWeight)
 *    - This ensures cards eventually get played — even if individually risky, waiting
 *      is worse because future board states will be more dangerous.
 *
 * OPPONENT MODEL (see priorWeightedSelect):
 *    - Opponents play cards weighted by INVERSE danger (safe cards first).
 *    - Cards past their avgTurn get a timing boost (opponents dump overdue cards).
 *    - This produces more realistic simulations than uniform random play.
 *
 * BENCHMARKING FINDINGS (from docs/results/mcs-prior.md):
 *    - simDepth=1 beats simDepth=2 at equal budget (more samples > deeper lookahead)
 *    - timingWeight sweet spot is 0.3-0.5 (0 is clearly worst, 0.7 regresses)
 *    - trappedDiscount > 0 beats disabled in head-to-head play
 *    - Overall: mcs-prior beats plain mcs ~29% vs 24.3% win rate at equal mcPerCard
 */
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
import { CARD_PRIOR, TURN_BASELINE } from './prior-table';

export interface McsPriorOptions {
  /** Simulations per candidate card (default: 100) */
  mcPerCard?: number;
  /** Maximum total simulations (default: 10 × mcPerCard) */
  mcMax?: number;
  /** Scoring mode (default: 'relative') */
  scoring?: 'self' | 'relative';
  /** Turns to simulate forward before applying heuristic (default: 1) */
  simDepth?: number;
  /** Opponent model: 'uniform' = random, 'prior' = weighted by inverse danger (default: 'prior') */
  opponentModel?: 'uniform' | 'prior';
  /** Weight of timing pressure in heuristic (default: 0.3) */
  timingWeight?: number;
  /** Trapped card discount factor — multiplies row-pick danger by remainingTurns × this value.
   *  0 = disabled (original behavior), 0.3 = moderate, 0.5 = aggressive early dump. (default: 0.3) */
  trappedDiscount?: number;
}

const DEFAULT_MC_PER_CARD = 100;
const DEFAULT_SIM_DEPTH = 1;
const DEFAULT_TIMING_WEIGHT = 0.3;
const DEFAULT_TRAPPED_DISCOUNT = 0.3;

/**
 * Evaluate how dangerous a remaining hand is after simulation.
 *
 * This is the "terminal evaluation" — called after simulating 1 turn forward.
 * It estimates the total future penalty of holding these cards for the rest of
 * the round. Higher score = worse hand to be stuck with.
 *
 * The function implements heuristics A, B, and C from the module doc above.
 */
function evaluateHand(
  hand: readonly CardNumber[],
  board: CardNumber[][],
  turn: number,
  timingWeight: number,
  trappedDiscount: number,
): number {
  if (hand.length === 0) return 0;

  // Board state analysis
  const rowTops = board.map(r => r[r.length - 1]);
  const minRowTop = Math.min(...rowTops);
  const rowLens = board.map(r => r.length);
  const primedCount = rowLens.filter(l => l >= 5).length;

  // Per-turn baselines from the prior (what a "typical" board looks like at this turn)
  const baseline = TURN_BASELINE[Math.min(turn - 1, 9)] ?? TURN_BASELINE[9];
  const basePrimed = baseline.avgPrimedRows ?? 1.0;

  const remainingTurns = Math.max(0, 10 - turn);

  let totalDanger = 0;
  for (const card of hand) {
    const prior = CARD_PRIOR[card - 1];
    if (!prior) continue;

    let cardDanger: number;
    if (card < minRowTop) {
      // ── HEURISTIC A: TRAPPED CARD MANAGEMENT ──
      // This card is below every row top → guaranteed row pick whenever played.
      // The decision isn't IF we pay, it's WHEN (and how much the row costs).
      const minRowLen = Math.min(...rowLens);
      const cheapRowAvailable = minRowLen <= 2;

      if (turn <= 4) {
        // EARLY GAME (turns 1-3, heuristicTurn ≤ 4):
        // Low cards are a known, bounded cost (typically 1-3 heads). Don't panic.
        // We deliberately suppress danger here so the strategy focuses on shedding
        // HIGH-penalty cards (overflow risks like 55=7heads) in the early game,
        // rather than "wasting" early turns on cheap row picks.
        cardDanger = prior.rowPickRate * prior.avgRowPickPenalty * 0.3;
      } else {
        // MID/LATE GAME (turns 4+):
        // Now trapped cards become urgent. Row lengths are growing, row pick costs
        // escalate, and we're running out of turns to dump these.
        // Scale depends on whether a cheap row exists right now:
        //   - cheapRowAvailable (≤2 cards): scale 1.5 → "dump it NOW, this is a window"
        //   - no cheap row (3+ cards):      scale 0.7 → "wait for a better opportunity"
        const scale = cheapRowAvailable ? 1.5 : 0.7;
        cardDanger = prior.rowPickRate * prior.avgRowPickPenalty * scale;

        // Trapped discount: ramps urgency as turns run out.
        // urgency goes from 0.17 (turn 5) to 1.0 (turn 10), clamped to [0,1].
        // Effect: cardDanger × (1 + remainingTurns × 0.3 × urgency)
        // At turn 7 with 3 turns left: ×(1 + 3 × 0.3 × 0.5) = ×1.45
        if (trappedDiscount > 0 && remainingTurns > 0) {
          const urgency = Math.min(1, (turn - 4) / 6);
          cardDanger *= (1 + remainingTurns * trappedDiscount * urgency);
        }
      }
    } else {
      // ── HEURISTIC B: OVERFLOW RISK ──
      // Card is above minRowTop, so it can be placed. But if many rows are primed
      // (5 cards = about to overflow), this card might trigger a 6th-card overflow.
      // Scale relative to what's "normal" for this turn (basePrimed from prior).
      const scale = basePrimed > 0 ? Math.max(0.5, primedCount / basePrimed) : 1;
      cardDanger = prior.overflowRate * prior.avgOverflowPenalty * scale;
    }

    // ── HEURISTIC C: TIMING PRESSURE ──
    // Each card has a "natural" turn when it's typically played (from prior).
    // Holding a card past that turn means we're in increasingly unusual/dangerous
    // territory. This multiplier grows linearly after avgTurn:
    //   turn 6, avgTurn 4, timingWeight 0.3 → multiplier = 1 + 2×0.3 = 1.6
    const timingPressure = Math.max(0, turn - prior.avgTurn) * timingWeight;
    cardDanger *= (1 + timingPressure);

    totalDanger += cardDanger;
  }

  return totalDanger;
}

/**
 * OPPONENT MODEL: Prior-weighted card selection.
 *
 * Models how a "reasonable" opponent picks which card to play.
 * The key insight: real players (and MCS bots) play safe cards first and hold
 * dangerous cards as long as possible — then dump them when forced.
 *
 * Weight formula: (1 / (danger + 0.1)) × (1 + timingBoost)
 *   - Safe cards (low expectedPenalty) → high weight → played early
 *   - Dangerous cards (high expectedPenalty) → low weight → held back
 *   - Overdue cards (past avgTurn) → timingBoost increases → eventually forced out
 *
 * This produces a distribution that matches observed behavior from 1300+ training games.
 */
function priorWeightedSelect(hand: CardNumber[], turn: number, rng: () => number): CardNumber {
  if (hand.length === 0) throw new Error('Empty hand');
  if (hand.length === 1) return hand[0];

  // Weight = inverse of expected penalty, adjusted by timing
  const weights: number[] = hand.map(card => {
    const prior = CARD_PRIOR[card - 1];
    if (!prior) return 1;
    // Cards that are "due" (past their avg turn) get higher weight (opponents dump them)
    const timingBoost = Math.max(0, turn - prior.avgTurn) * 0.2;
    // Inverse danger: safer cards are played more freely, dangerous cards are held
    // But timing pressure makes overdue dangerous cards more likely to be played
    const danger = prior.expectedPenalty || 0.5;
    return (1 / (danger + 0.1)) * (1 + timingBoost);
  });

  // Normalize and sample
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) {
    return hand[Math.floor(rng() * hand.length)];
  }

  let r = rng() * total;
  for (let i = 0; i < hand.length; i++) {
    r -= weights[i];
    if (r <= 0) return hand[i];
  }
  return hand[hand.length - 1];
}

/**
 * Simulate a single turn with prior-weighted opponent play.
 * Returns penalty array indexed by player position.
 */
function simulateTurnWithOpponentModel(
  hands: CardNumber[][],
  board: CardNumber[][],
  myCard: CardNumber,
  turn: number,
  opponentModel: 'uniform' | 'prior',
  rng: () => number,
): number[] {
  const taggedPlays: { playerIdx: number; card: CardNumber }[] = [
    { playerIdx: 0, card: myCard },
  ];

  // Remove our card from our hand
  const myIdx = hands[0].indexOf(myCard);
  if (myIdx !== -1) hands[0].splice(myIdx, 1);

  for (let i = 1; i < hands.length; i++) {
    if (hands[i].length === 0) continue;
    let card: CardNumber;
    if (opponentModel === 'prior') {
      card = priorWeightedSelect(hands[i], turn, rng);
    } else {
      const idx = Math.floor(rng() * hands[i].length);
      card = hands[i][idx];
    }
    const cardIdx = hands[i].indexOf(card);
    hands[i].splice(cardIdx, 1);
    taggedPlays.push({ playerIdx: i, card });
  }

  const penalties = new Array(hands.length).fill(0) as number[];
  accumulateTurn(taggedPlays, board, penalties);
  return penalties;
}

/**
 * Simulate remaining turns (after the evaluated first turn) with random/prior play.
 */
function simulateRemainingTurns(
  hands: CardNumber[][],
  board: CardNumber[][],
  penalties: number[],
  startTurn: number,
  turnsRemaining: number,
  opponentModel: 'uniform' | 'prior',
  rng: () => number,
): void {
  for (let t = 0; t < turnsRemaining; t++) {
    const turn = startTurn + t;
    const taggedPlays: { playerIdx: number; card: CardNumber }[] = [];
    for (let i = 0; i < hands.length; i++) {
      if (hands[i].length === 0) continue;
      let card: CardNumber;
      if (opponentModel === 'prior' && i > 0) {
        card = priorWeightedSelect(hands[i], turn, rng);
      } else {
        const idx = Math.floor(rng() * hands[i].length);
        card = hands[i][idx];
      }
      const cardIdx = hands[i].indexOf(card);
      hands[i].splice(cardIdx, 1);
      taggedPlays.push({ playerIdx: i, card });
    }
    if (taggedPlays.length > 0) {
      accumulateTurn(taggedPlays, board, penalties);
    }
  }
}

export function createMcsPriorStrategy(options: McsPriorOptions = {}): Strategy {
  const VALID_OPTIONS = new Set(['mcPerCard', 'mcMax', 'scoring', 'simDepth', 'opponentModel', 'timingWeight', 'trappedDiscount']);
  for (const key of Object.keys(options)) {
    if (!VALID_OPTIONS.has(key)) {
      throw new Error(`Unknown mcs-prior option "${key}". Valid: ${[...VALID_OPTIONS].join(', ')}`);
    }
  }

  const mcPerCard = Math.max(1, Math.floor(Number(options.mcPerCard) || DEFAULT_MC_PER_CARD));
  const mcMax = Math.max(1, Math.floor(Number(options.mcMax) || mcPerCard * 10));
  const scoring: 'self' | 'relative' = options.scoring === 'self' ? 'self' : 'relative';
  const simDepth = Math.max(1, Math.floor(Number(options.simDepth ?? DEFAULT_SIM_DEPTH)));
  const opponentModel: 'uniform' | 'prior' = options.opponentModel === 'uniform' ? 'uniform' : 'prior';
  const timingWeight = Number(options.timingWeight ?? DEFAULT_TIMING_WEIGHT);
  const parsedTrapped = Number(options.trappedDiscount ?? DEFAULT_TRAPPED_DISCOUNT);
  const trappedDiscount = Math.max(0, Number.isNaN(parsedTrapped) ? DEFAULT_TRAPPED_DISCOUNT : parsedTrapped);

  let rng: (() => number) | null = null;
  let playerCount = 2;
  let seenCards = new Set<number>();

  function score(penalties: number[]): number {
    const myPenalty = penalties[0];
    if (scoring === 'self') return myPenalty;
    const oppTotal = penalties.slice(1).reduce((s, p) => s + p, 0);
    const oppAvg = penalties.length > 1 ? oppTotal / (penalties.length - 1) : 0;
    return myPenalty - oppAvg;
  }

  return {
    name: 'mcs-prior',

    getOptions() {
      return { mcPerCard, mcMax, scoring, simDepth, opponentModel, timingWeight, trappedDiscount };
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
      if (!rng) throw new Error('McsPriorStrategy: onGameStart() must be called before chooseCard()');
      const { hand, board, turn } = state;
      const opponentCount = playerCount - 1;
      const cardsPerPlayer = 10 - turn + 1;

      if (hand.length === 1) return hand[0];

      const unknownPool = buildUnknownPool(hand, board, seenCards, state.turnHistory, state.initialBoardCards);
      const nSims = Math.min(mcMax, mcPerCard * hand.length);

      let bestCard = hand[0];
      let bestScore = Infinity;

      for (const myCard of hand) {
        let totalScore = 0;
        const simsPerCard = Math.max(1, Math.floor(nSims / hand.length));

        for (let sample = 0; sample < simsPerCard; sample++) {
          // Sample opponent hands
          const oppHands = sampleOpponentHands(unknownPool, opponentCount, cardsPerPlayer, rng);
          const myHand = [...hand].filter(c => c !== myCard) as CardNumber[];
          const hands: CardNumber[][] = [myHand, ...oppHands];

          const boardCopy = cloneBoard(board);
          const penalties = new Array(hands.length).fill(0) as number[];

          // Simulate first turn (our card + opponent cards)
          const firstTurnPenalties = simulateTurnWithOpponentModel(
            hands, boardCopy, myCard, turn, opponentModel, rng,
          );
          for (let i = 0; i < penalties.length; i++) penalties[i] += firstTurnPenalties[i];

          // Simulate additional turns up to simDepth
          const extraTurns = Math.min(simDepth - 1, hands[0].length);
          if (extraTurns > 0) {
            simulateRemainingTurns(hands, boardCopy, penalties, turn + 1, extraTurns, opponentModel, rng);
          }

          // Heuristic evaluation of remaining hand + board state
          // Use actual turns simulated (1 initial + extraTurns), not requested simDepth,
          // since extraTurns is capped by hand size.
          const heuristicTurn = turn + 1 + extraTurns;
          const handDanger = evaluateHand(hands[0], boardCopy, heuristicTurn, timingWeight, trappedDiscount);
          penalties[0] += handDanger;

          totalScore += score(penalties);
        }

        const avgScore = totalScore / simsPerCard;
        if (avgScore < bestScore) {
          bestScore = avgScore;
          bestCard = myCard;
        }
      }

      return bestCard;
    },

    chooseRow(state) {
      if (!rng) throw new Error('McsPriorStrategy: onGameStart() must be called before chooseRow()');
      const { board } = state;
      const opponentCount = playerCount - 1;
      const hand = state.hand.filter(c => c !== state.triggeringCard);
      const cardsPerPlayer = hand.length;

      const unknownPool = buildUnknownPoolForRowChoice(
        hand, board, seenCards, state.turnHistory, state.revealedThisTurn, state.triggeringCard,
      );

      if (cardsPerPlayer === 0) {
        return fewestHeadsRowIndex(board.rows);
      }

      const simsPerRow = mcPerCard;
      let bestRow: 0 | 1 | 2 | 3 = 0;
      let bestScore = Infinity;

      for (let rowIdx = 0; rowIdx < 4; rowIdx++) {
        let totalScore = 0;

        for (let sample = 0; sample < simsPerRow; sample++) {
          const boardCopy = cloneBoard(board);
          const rowPenalty = boardCopy[rowIdx].reduce((s, c) => s + cattleHeads(c), 0);
          boardCopy[rowIdx] = [state.triggeringCard];

          const oppHands = sampleOpponentHands(unknownPool, opponentCount, cardsPerPlayer, rng);
          const hands: CardNumber[][] = [[...hand] as CardNumber[], ...oppHands];
          const penalties = new Array(hands.length).fill(0) as number[];
          penalties[0] = rowPenalty;

          // Simulate forward
          const turnsToSim = Math.min(simDepth, hands[0].length);
          simulateRemainingTurns(hands, boardCopy, penalties, state.turn + 1, turnsToSim, opponentModel, rng);

          // Heuristic on remaining hand
          const heuristicTurn = state.turn + 1 + turnsToSim;
          penalties[0] += evaluateHand(hands[0], boardCopy, heuristicTurn, timingWeight, trappedDiscount);

          totalScore += score(penalties);
        }

        const avgScore = totalScore / simsPerRow;
        if (avgScore < bestScore) {
          bestScore = avgScore;
          bestRow = rowIdx as 0 | 1 | 2 | 3;
        }
      }

      return bestRow;
    },
  };
}
