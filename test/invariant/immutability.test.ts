/**
 * Immutability tests: verify engine functions never mutate their input state.
 */
import { describe, it, expect } from 'vitest';
import {
  createGame,
  dealRound,
  resolveTurn,
  applyRowPick,
  scoreRound,
  createPrng,
  type GameState,
  type CardNumber,
  type PlayCardMove,
} from '../../src/engine';

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

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

function resolveWithRows(state: GameState, plays: PlayCardMove[], strategy: ReturnType<typeof makeRandomStrategy>): GameState {
  let resolution = resolveTurn(state, plays);
  while (resolution.kind === 'needs-row-pick') resolution = applyRowPick(resolution.state, resolution.playerId, strategy.pickRow() as 0 | 1 | 2 | 3);
  return resolution.state;
}

describe('Immutability — engine never mutates input state', () => {
  it('createGame does not mutate its arguments', () => {
    const ids = ['a', 'b', 'c'];
    const idsCopy = [...ids];
    createGame(ids, 'immut-1');
    expect(ids).toStrictEqual(idsCopy);
  });

  it('dealRound does not mutate input state', () => {
    const state = createGame(['a', 'b', 'c'], 'immut-2');
    const clone = deepClone(state);
    dealRound(state);
    expect(state).toStrictEqual(clone);
  });

  it('resolveTurn does not mutate input state', () => {
    const strategy = makeRandomStrategy('immut-3-strat');
    let state = createGame(['a', 'b', 'c'], 'immut-3');
    state = dealRound(state);

    const clone = deepClone(state);
    const plays: PlayCardMove[] = state.players.map((p) => ({
      playerId: p.id,
      card: strategy.pickCard(p.hand),
    }));

    resolveWithRows(state, plays, strategy);
    expect(state).toStrictEqual(clone);
  });

  it('scoreRound does not mutate input state', () => {
    const strategy = makeRandomStrategy('immut-4-strat');
    let state = createGame(['a', 'b', 'c'], 'immut-4');
    state = dealRound(state);

    for (let t = 0; t < 10; t++) {
      const plays: PlayCardMove[] = state.players.map((p) => ({
        playerId: p.id,
        card: strategy.pickCard(p.hand),
      }));
      state = resolveWithRows(state, plays, strategy);
    }

    const clone = deepClone(state);
    scoreRound(state);
    expect(state).toStrictEqual(clone);
  });

  it('resolveTurn does not mutate plays array', () => {
    const strategy = makeRandomStrategy('immut-5-strat');
    let state = createGame(['a', 'b', 'c'], 'immut-5');
    state = dealRound(state);

    const plays: PlayCardMove[] = state.players.map((p) => ({
      playerId: p.id,
      card: strategy.pickCard(p.hand),
    }));
    const playsCopy = deepClone(plays);

    resolveWithRows(state, plays, strategy);
    expect(plays).toStrictEqual(playsCopy);
  });

  it('multiple turns do not mutate earlier states', () => {
    const strategy = makeRandomStrategy('immut-6-strat');
    let state = createGame(['a', 'b', 'c', 'd'], 'immut-6');
    state = dealRound(state);

    const snapshots: GameState[] = [];

    for (let t = 0; t < 10; t++) {
      const clone = deepClone(state);
      snapshots.push(clone);

      const plays: PlayCardMove[] = state.players.map((p) => ({
        playerId: p.id,
        card: strategy.pickCard(p.hand),
      }));
      state = resolveWithRows(state, plays, strategy);
    }

    // Verify no snapshot was mutated
    const strategy2 = makeRandomStrategy('immut-6-strat');
    let state2 = createGame(['a', 'b', 'c', 'd'], 'immut-6');
    state2 = dealRound(state2);

    for (let t = 0; t < 10; t++) {
      expect(snapshots[t]).toStrictEqual(state2);
      const plays: PlayCardMove[] = state2.players.map((p) => ({
        playerId: p.id,
        card: strategy2.pickCard(p.hand),
      }));
      state2 = resolveWithRows(state2, plays, strategy2);
    }
  });
});
