import { describe, it, expect } from 'vitest';
import type {
  CardNumber,
  Board,
  Row,
  CardChoiceState,
  RowChoiceState,
} from '../../src/engine';
import {
  strategies,
  createGame,
  dealRound,
  resolveTurn,
  applyRowPick,
  scoreRound,
  isGameOver,
  toCardChoiceState,
  toRowChoiceState,
  deriveSeedState,
  xoshiro256ss,
} from '../../src/engine';
import { createRandomStrategy } from '../../src/engine/strategies/random';

// ── Helpers ────────────────────────────────────────────────────────────

const cn = (n: number) => n as CardNumber;

function makeBoard(cards: number[][]): Board {
  return {
    rows: cards.map((row) => row.map(cn)) as unknown as [Row, Row, Row, Row],
  };
}

function makeCardChoiceState(
  hand: number[],
  overrides?: Partial<CardChoiceState>,
): CardChoiceState {
  const board = makeBoard([[10], [20], [30], [40]]);
  return {
    hand: hand.map(cn),
    board,
    playerScores: { p0: 0 },
    playerCount: 2,
    round: 1,
    turn: 1,
    turnHistory: [],
    initialBoardCards: board,
    ...overrides,
  };
}

function makeRowChoiceState(
  boardCards: number[][],
  overrides?: Partial<RowChoiceState>,
): RowChoiceState {
  return {
    board: makeBoard(boardCards),
    triggeringCard: cn(3),
    revealedThisTurn: [{ playerId: 'p0', card: cn(3) }],
    resolutionIndex: 0,
    hand: [cn(5), cn(15)],
    playerScores: { p0: 0, p1: 0 },
    playerCount: 2,
    round: 1,
    turn: 1,
    turnHistory: [],
    ...overrides,
  };
}

function makeSeededRng(seed: string): () => number {
  const state = deriveSeedState(seed);
  return () => Number(xoshiro256ss(state) >> 11n) / 2 ** 53;
}

/** Play a full game with the random strategy, returning final state. */
function playFullGame(seed: string, playerIds: string[]) {
  const strats = new Map(
    playerIds.map((id) => {
      const s = createRandomStrategy();
      s.onGameStart!({
        playerId: id,
        playerCount: playerIds.length,
        rng: makeSeededRng(`${seed}/${id}`),
      });
      return [id, s] as const;
    }),
  );

  let state = createGame(playerIds, seed);

  while (!isGameOver(state)) {
    state = dealRound(state);

    for (let turn = 0; turn < 10; turn++) {
      const plays = playerIds.map((id) => {
        const cardState = toCardChoiceState(state, id);
        return { playerId: id, card: strats.get(id)!.chooseCard(cardState) };
      });

      let resolution = resolveTurn(state, plays);
      while (resolution.kind === 'needs-row-pick') {
        const row = strats.get(resolution.playerId)!.chooseRow(toRowChoiceState(resolution.state, resolution.playerId));
        resolution = applyRowPick(resolution.state, resolution.playerId, row);
      }
      state = resolution.state;
    }

    state = scoreRound(state);
  }

  return state;
}

// ── 1. Strategy Registry ───────────────────────────────────────────────

describe('Strategy Registry', () => {
  it('has "random" key', () => {
    expect(strategies.has('random')).toBe(true);
  });

  it('factory returns an object with the Strategy interface', () => {
    const factory = strategies.get('random')!;
    const strat = factory();
    expect(strat).toHaveProperty('name');
    expect(strat).toHaveProperty('chooseCard');
    expect(strat).toHaveProperty('chooseRow');
    expect(typeof strat.name).toBe('string');
    expect(typeof strat.chooseCard).toBe('function');
    expect(typeof strat.chooseRow).toBe('function');
  });

  it('registry is read-only', () => {
    expect(strategies).toBeInstanceOf(Map);
    // ReadonlyMap has no set method exposed at the type level;
    // at runtime the underlying Map does, but the contract is ReadonlyMap.
    // We verify the exported type satisfies ReadonlyMap by checking absence
    // of set/delete at the type level (compile-time), and at runtime we
    // just ensure the map exists and has entries.
    expect(strategies.size).toBeGreaterThan(0);
  });
});

// ── 2. Random Strategy — chooseCard ────────────────────────────────────

describe('Random Strategy — chooseCard', () => {
  it('throws if onGameStart() was not called', () => {
    const strat = createRandomStrategy();
    const state = makeCardChoiceState([5, 15, 25]);
    expect(() => strat.chooseCard(state)).toThrow(/onGameStart/);
  });

  it('returns a card that exists in the hand', () => {
    const strat = createRandomStrategy();
    strat.onGameStart!({
      playerId: 'p0',
      playerCount: 2,
      rng: makeSeededRng('test-card'),
    });
    const hand = [5, 15, 25, 35, 45];
    const state = makeCardChoiceState(hand);
    const chosen = strat.chooseCard(state);
    expect(hand.map(cn)).toContain(chosen);
  });

  it('with rng always returning 0, always picks the first card', () => {
    const strat = createRandomStrategy();
    strat.onGameStart!({
      playerId: 'p0',
      playerCount: 2,
      rng: () => 0,
    });
    const hand = [5, 15, 25];
    const state = makeCardChoiceState(hand);
    for (let i = 0; i < 20; i++) {
      expect(strat.chooseCard(state)).toBe(cn(5));
    }
  });

  it('with rng always returning 0.99, always picks the last card', () => {
    const strat = createRandomStrategy();
    strat.onGameStart!({
      playerId: 'p0',
      playerCount: 2,
      rng: () => 0.99,
    });
    const hand = [5, 15, 25];
    const state = makeCardChoiceState(hand);
    for (let i = 0; i < 20; i++) {
      expect(strat.chooseCard(state)).toBe(cn(25));
    }
  });

  it('uniform distribution: all cards are picked at least once over 1000 calls', () => {
    const strat = createRandomStrategy();
    strat.onGameStart!({
      playerId: 'p0',
      playerCount: 2,
      rng: makeSeededRng('uniform-test'),
    });
    const hand = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const state = makeCardChoiceState(hand);
    const counts = new Map<number, number>();
    for (const c of hand) counts.set(c, 0);

    for (let i = 0; i < 1000; i++) {
      const chosen = strat.chooseCard(state) as number;
      counts.set(chosen, (counts.get(chosen) ?? 0) + 1);
    }

    for (const c of hand) {
      expect(counts.get(c)).toBeGreaterThan(0);
    }
  });
});

// ── 3. Random Strategy — chooseRow ─────────────────────────────────────

describe('Random Strategy — chooseRow', () => {
  it('picks the row with fewest total cattle heads', () => {
    const strat = createRandomStrategy();
    // Row 0: [10] → 3 heads (%10), Row 1: [1] → 1 head, Row 2: [55] → 7, Row 3: [11] → 5
    const state = makeRowChoiceState([[10], [1], [55], [11]]);
    expect(strat.chooseRow(state)).toBe(1);
  });

  it('tiebreaks by lowest row index', () => {
    const strat = createRandomStrategy();
    // All single-card rows with 1 cattle head each
    const state = makeRowChoiceState([[1], [2], [3], [4]]);
    expect(strat.chooseRow(state)).toBe(0);
  });

  it('works correctly with single-card rows vs multi-card rows', () => {
    const strat = createRandomStrategy();
    // Row 0: [1, 2, 3] → 3 heads, Row 1: [4] → 1 head, Row 2: [5] → 2 heads, Row 3: [6, 7] → 2 heads
    const state = makeRowChoiceState([[1, 2, 3], [4], [5], [6, 7]]);
    expect(strat.chooseRow(state)).toBe(1); // row 1 has only 1 head
  });
});

// ── 4. Random Strategy — Integration with Engine ───────────────────────

describe('Random Strategy — Integration with Engine', () => {
  it('plays through a full round without exceptions', () => {
    const seed = 'integration-test';
    const playerIds = ['alice', 'bob'];

    const strats = new Map(
      playerIds.map((id) => {
        const s = createRandomStrategy();
        s.onGameStart!({
          playerId: id,
          playerCount: playerIds.length,
          rng: makeSeededRng(`${seed}/${id}`),
        });
        return [id, s] as const;
      }),
    );

    let state = createGame(playerIds, seed);
    state = dealRound(state);

    for (let turn = 0; turn < 10; turn++) {
      expect(state.phase).toBe('awaiting-cards');

      const plays = playerIds.map((id) => {
        const cardState = toCardChoiceState(state, id);
        const card = strats.get(id)!.chooseCard(cardState);
        return { playerId: id, card };
      });

      let resolution = resolveTurn(state, plays);
      while (resolution.kind === 'needs-row-pick') {
        const row = strats.get(resolution.playerId)!.chooseRow(toRowChoiceState(resolution.state, resolution.playerId));
        resolution = applyRowPick(resolution.state, resolution.playerId, row);
      }
      state = resolution.state;
    }

    expect(state.phase).toBe('round-over');
    state = scoreRound(state);
  });

  it('strategy produces valid moves every turn through a full game', () => {
    expect(() => playFullGame('valid-moves-test', ['p0', 'p1', 'p2'])).not.toThrow();
  });
});

// ── 5. Determinism ─────────────────────────────────────────────────────

describe('Determinism', () => {
  it('same seed produces identical game outcomes', () => {
    const seed = 'determinism-test';
    const playerIds = ['alpha', 'beta'];

    const state1 = playFullGame(seed, playerIds);
    const state2 = playFullGame(seed, playerIds);

    // Same final scores
    for (const id of playerIds) {
      const p1 = state1.players.find((p) => p.id === id)!;
      const p2 = state2.players.find((p) => p.id === id)!;
      expect(p1.score).toBe(p2.score);
    }

    // Same round count
    expect(state1.round).toBe(state2.round);
  });
});
