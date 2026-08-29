/**
 * Metamorphic / property-based tests for the 6 Nimmt! engine.
 */
import { describe, it, expect } from 'vitest';
import {
  createGame,
  dealRound,
  resolveTurn,
  applyRowPick,
  scoreRound,
  isGameOver,
  createDeck,
  createPrng,
  type CardNumber,
  type PlayCardMove,
} from '../../src/engine';

// ── Helpers ────────────────────────────────────────────────────────────

function makeRandomStrategy(seed: string) {
  const prng = createPrng(seed);
  return {
    pickCard(hand: readonly CardNumber[]): CardNumber {
      return hand[Math.floor(prng.nextFloat() * hand.length)];
    },
    pickRow(): number {
      return Math.floor(prng.nextFloat() * 4);
    },
  };
}

function playFullGame(playerIds: string[], gameSeed: string, strategySeed: string) {
  const strategy = makeRandomStrategy(strategySeed);
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
      while (resolution.kind === 'needs-row-pick') resolution = applyRowPick(resolution.state, resolution.playerId, strategy.pickRow() as 0 | 1 | 2 | 3);
      state = resolution.state;
    }
    state = scoreRound(state);
    rounds++;
  }

  return state;
}

// ── Player rename: same outcomes ───────────────────────────────────────

describe('Player rename metamorphic', () => {
  it('renaming players produces same scores and rankings', () => {
    const original = ['p0', 'p1', 'p2', 'p3'];
    const renamed = ['x0', 'x1', 'x2', 'x3'];
    const seed = 'rename-test-42';

    const result1 = playFullGame(original, seed, `${seed}/strategy`);
    const result2 = playFullGame(renamed, seed, `${seed}/strategy`);

    // Scores should match positionally
    for (let i = 0; i < original.length; i++) {
      expect(result1.players[i].score).toBe(result2.players[i].score);
    }

    // Rankings (by score) should be identical
    const ranking1 = result1.players.map((p) => p.score).sort((a, b) => a - b);
    const ranking2 = result2.players.map((p) => p.score).sort((a, b) => a - b);
    expect(ranking1).toStrictEqual(ranking2);
  });

  it('works for multiple seeds', () => {
    for (let i = 0; i < 20; i++) {
      const original = ['p0', 'p1', 'p2'];
      const renamed = ['x0', 'x1', 'x2'];
      const seed = `rename-multi-${i}`;

      const result1 = playFullGame(original, seed, `${seed}/strategy`);
      const result2 = playFullGame(renamed, seed, `${seed}/strategy`);

      for (let j = 0; j < original.length; j++) {
        expect(result1.players[j].score).toBe(result2.players[j].score);
      }
    }
  });
});

// ── Seed determinism ───────────────────────────────────────────────────

describe('Seed determinism', () => {
  it('same seed always produces same game result', () => {
    for (let i = 0; i < 10; i++) {
      const seed = `determinism-${i}`;
      const ids = ['a', 'b', 'c', 'd'];
      const r1 = playFullGame(ids, seed, `${seed}/strategy`);
      const r2 = playFullGame(ids, seed, `${seed}/strategy`);
      expect(r1).toStrictEqual(r2);
    }
  });
});

// ── Different seed → different deck ────────────────────────────────────

describe('Different seed → different game', () => {
  it('two different seeds produce different deck orders', () => {
    const deck1 = createDeck('seed-alpha', 1);
    const deck2 = createDeck('seed-beta', 1);
    // Extremely unlikely to be the same
    expect(deck1).not.toStrictEqual(deck2);
  });

  it('many different seeds produce different decks', () => {
    const decks = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const deck = createDeck(`unique-seed-${i}`, 1);
      decks.add(JSON.stringify(deck));
    }
    expect(decks.size).toBe(100);
  });
});

// ── Serialization round-trip ───────────────────────────────────────────

describe('Serialization round-trip', () => {
  it('JSON round-trip produces equivalent state after createGame', () => {
    const state = createGame(['a', 'b', 'c'], 'serial-test');
    const roundTripped = JSON.parse(JSON.stringify(state));
    expect(roundTripped).toStrictEqual(state);
  });

  it('JSON round-trip produces equivalent state after dealRound', () => {
    let state = createGame(['a', 'b', 'c'], 'serial-test-2');
    state = dealRound(state);
    const roundTripped = JSON.parse(JSON.stringify(state));
    expect(roundTripped).toStrictEqual(state);
  });

  it('JSON round-trip produces equivalent state mid-game', () => {
    const strategy = makeRandomStrategy('serial-mid');
    const ids = ['a', 'b', 'c'];
    let state = createGame(ids, 'serial-test-3');
    state = dealRound(state);

    for (let t = 0; t < 5; t++) {
      const plays: PlayCardMove[] = state.players.map((p) => ({
        playerId: p.id,
        card: strategy.pickCard(p.hand),
      }));
      let resolution = resolveTurn(state, plays);
      while (resolution.kind === 'needs-row-pick') resolution = applyRowPick(resolution.state, resolution.playerId, strategy.pickRow() as 0 | 1 | 2 | 3);
      state = resolution.state;
    }

    const roundTripped = JSON.parse(JSON.stringify(state));
    expect(roundTripped).toStrictEqual(state);
  });
});
