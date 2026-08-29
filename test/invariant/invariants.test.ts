/**
 * Invariant tests: run 500 random games (100 each at 2,3,5,7,10 players)
 * and verify all game invariants hold after every state transition.
 */
import { describe, it, expect } from 'vitest';
import {
  createGame,
  dealRound,
  resolveTurn,
  applyRowPick,
  scoreRound,
  isGameOver,
  createPrng,
  type GameState,
  type CardNumber,
  type PlayCardMove,
} from '../../src/engine';

// ── Seeded random helpers ──────────────────────────────────────────────

function makeRandomStrategy(seed: string) {
  const prng = createPrng(seed);
  return {
    pickCard(hand: readonly CardNumber[]): CardNumber {
      const idx = Math.floor(prng.nextFloat() * hand.length);
      return hand[idx];
    },
    pickRow(): number {
      return Math.floor(prng.nextFloat() * 4);
    },
  };
}

// ── Invariant checkers ─────────────────────────────────────────────────

function getAllCards(state: GameState): CardNumber[] {
  const cards: CardNumber[] = [];
  // Deck
  cards.push(...state.deck);
  // Board
  for (const row of state.board.rows) cards.push(...row);
  // Player hands + collected
  for (const p of state.players) {
    cards.push(...p.hand);
    cards.push(...p.collected);
  }
  return cards;
}

function checkTotalCards104(state: GameState) {
  const all = getAllCards(state);
  expect(all.length).toBe(104);
}

function checkAllCardsUnique(state: GameState) {
  const all = getAllCards(state);
  const set = new Set(all);
  expect(set.size).toBe(all.length);
}

function checkExactly4Rows(state: GameState) {
  expect(state.board.rows.length).toBe(4);
}

function checkRowLengths(state: GameState) {
  for (const row of state.board.rows) {
    expect(row.length).toBeGreaterThanOrEqual(1);
    expect(row.length).toBeLessThanOrEqual(5);
  }
}

function checkPlayerCount(state: GameState) {
  expect(state.players.length).toBeGreaterThanOrEqual(2);
  expect(state.players.length).toBeLessThanOrEqual(10);
}

function checkHandSize(state: GameState) {
  if (state.phase === 'awaiting-cards') {
    const expected = 10 - (state.turn - 1);
    for (const p of state.players) {
      expect(p.hand.length).toBe(expected);
    }
  }
}

function checkDeckSize(state: GameState) {
  if (state.phase === 'awaiting-cards' && state.turn === 1) {
    const expected = 104 - 10 * state.players.length - 4;
    expect(state.deck.length).toBe(expected);
  }
}

function checkNonNegativeScores(state: GameState) {
  for (const p of state.players) {
    expect(p.score).toBeGreaterThanOrEqual(0);
  }
}

function checkUniquePlayerIds(state: GameState) {
  const ids = state.players.map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length);
}

function checkAllInvariants(state: GameState) {
  checkTotalCards104(state);
  checkAllCardsUnique(state);
  checkExactly4Rows(state);
  if (state.phase !== 'round-over' || state.turn > 0) {
    checkRowLengths(state);
  }
  checkPlayerCount(state);
  checkHandSize(state);
  checkDeckSize(state);
  checkNonNegativeScores(state);
  checkUniquePlayerIds(state);
}

// ── Score monotonicity tracker ─────────────────────────────────────────

function checkScoresMonotonicallyNonDecreasing(
  prevScores: Map<string, number>,
  state: GameState,
) {
  for (const p of state.players) {
    const prev = prevScores.get(p.id) ?? 0;
    expect(p.score).toBeGreaterThanOrEqual(prev);
  }
}

// ── Play a full game with invariant checks ─────────────────────────────

function playGameWithInvariantChecks(
  playerCount: number,
  gameSeed: string,
) {
  const playerIds = Array.from({ length: playerCount }, (_, i) => `p${i}`);
  const strategy = makeRandomStrategy(`${gameSeed}/strategy`);

  let state = createGame(playerIds, gameSeed);
  checkAllInvariants(state);

  const prevScores = new Map<string, number>();
  for (const p of state.players) prevScores.set(p.id, 0);

  let rounds = 0;
  const MAX_ROUNDS = 50;

  while (!isGameOver(state) && rounds < MAX_ROUNDS) {
    state = dealRound(state);
    checkAllInvariants(state);

    // Play 10 turns
    for (let t = 0; t < 10; t++) {
      const plays: PlayCardMove[] = state.players.map((p) => ({
        playerId: p.id,
        card: strategy.pickCard(p.hand),
      }));

      let resolution = resolveTurn(state, plays);
      while (resolution.kind === 'needs-row-pick') {
        resolution = applyRowPick(resolution.state, resolution.playerId, strategy.pickRow());
      }
      state = resolution.state;

      checkAllInvariants(state);
      checkScoresMonotonicallyNonDecreasing(prevScores, state);
      for (const p of state.players) prevScores.set(p.id, p.score);
    }

    state = scoreRound(state);
    checkAllInvariants(state);
    rounds++;
  }

  expect(rounds).toBeLessThan(MAX_ROUNDS);
}

// ── Same-seed replay check ─────────────────────────────────────────────

function playGameToCompletion(playerCount: number, gameSeed: string): GameState {
  const playerIds = Array.from({ length: playerCount }, (_, i) => `p${i}`);
  const strategy = makeRandomStrategy(`${gameSeed}/strategy`);

  let state = createGame(playerIds, gameSeed);

  let rounds = 0;
  while (!isGameOver(state) && rounds < 50) {
    state = dealRound(state);

    for (let t = 0; t < 10; t++) {
      const plays: PlayCardMove[] = state.players.map((p) => ({
        playerId: p.id,
        card: strategy.pickCard(p.hand),
      }));

      let resolution = resolveTurn(state, plays);
      while (resolution.kind === 'needs-row-pick') {
        resolution = applyRowPick(resolution.state, resolution.playerId, strategy.pickRow());
      }
      state = resolution.state;
    }

    state = scoreRound(state);
    rounds++;
  }

  return state;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('Invariant tests — 500 random games', () => {
  const playerCounts = [2, 3, 5, 7, 10];
  const GAMES_PER_COUNT = 100;

  for (const pc of playerCounts) {
    it(`passes all invariants for ${GAMES_PER_COUNT} games with ${pc} players`, () => {
      for (let i = 0; i < GAMES_PER_COUNT; i++) {
        playGameWithInvariantChecks(pc, `inv-seed-${pc}-${i}`);
      }
    });
  }
});

describe('Same-seed replay is byte-identical', () => {
  const playerCounts = [2, 5, 10];

  for (const pc of playerCounts) {
    it(`same seed produces identical game for ${pc} players`, () => {
      const seed = `replay-seed-${pc}`;
      const result1 = playGameToCompletion(pc, seed);
      const result2 = playGameToCompletion(pc, seed);
      expect(result1).toStrictEqual(result2);
    });
  }
});
