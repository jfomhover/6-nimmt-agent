import { describe, it, expect } from 'vitest';
import {
  createGame,
  dealRound,
  resolveTurn,
  applyRowPick,
  scoreRound,
  isGameOver,
  getWinners,
} from '../../../src/engine/game';
import type { CardNumber, GameState, PlayCardMove } from '../../../src/engine/types';

function resolveWithDefault(state: GameState, plays: PlayCardMove[]): GameState {
  let result = resolveTurn(state, plays);
  while (result.kind === 'needs-row-pick') result = applyRowPick(result.state, result.playerId, 0);
  return result.state;
}

// ── createGame ─────────────────────────────────────────────────────────

describe('createGame', () => {
  it('produces correct initial state for 2 players', () => {
    const state = createGame(['p0', 'p1'], 'test-seed');
    expect(state.round).toBe(1);
    expect(state.turn).toBe(0);
    expect(state.phase).toBe('round-over');
    expect(state.seed).toBe('test-seed');
    expect(state.players).toHaveLength(2);
    expect(state.players[0].id).toBe('p0');
    expect(state.players[0].hand).toEqual([]);
    expect(state.players[0].score).toBe(0);
    expect(state.board.rows).toHaveLength(4);
  });

  it('rejects 0 players', () => {
    expect(() => createGame([], 'seed')).toThrow();
  });

  it('rejects 1 player', () => {
    expect(() => createGame(['p0'], 'seed')).toThrow();
  });

  it('rejects 11 players', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `p${i}`);
    expect(() => createGame(ids, 'seed')).toThrow();
  });

  it('rejects duplicate player IDs', () => {
    expect(() => createGame(['p0', 'p0'], 'seed')).toThrow();
  });

  it('rejects empty seed', () => {
    expect(() => createGame(['p0', 'p1'], '')).toThrow();
  });
});

// ── dealRound ──────────────────────────────────────────────────────────

describe('dealRound', () => {
  it('deals correct hand sizes for 2 players', () => {
    const state = createGame(['p0', 'p1'], 'test-seed');
    const dealt = dealRound(state);
    expect(dealt.players[0].hand).toHaveLength(10);
    expect(dealt.players[1].hand).toHaveLength(10);
  });

  it('deals correct hand sizes for 5 players', () => {
    const ids = Array.from({ length: 5 }, (_, i) => `p${i}`);
    const state = createGame(ids, 'test-seed');
    const dealt = dealRound(state);
    for (const p of dealt.players) {
      expect(p.hand).toHaveLength(10);
    }
  });

  it('deals correct hand sizes for 10 players', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const state = createGame(ids, 'test-seed');
    const dealt = dealRound(state);
    for (const p of dealt.players) {
      expect(p.hand).toHaveLength(10);
    }
  });

  it('board has 4 rows with 1 card each', () => {
    const state = createGame(['p0', 'p1'], 'test-seed');
    const dealt = dealRound(state);
    for (const row of dealt.board.rows) {
      expect(row).toHaveLength(1);
    }
  });

  it('deck remainder correct (104 - 10×N - 4)', () => {
    for (const n of [2, 5, 10]) {
      const ids = Array.from({ length: n }, (_, i) => `p${i}`);
      const state = createGame(ids, 'test-seed');
      const dealt = dealRound(state);
      expect(dealt.deck).toHaveLength(104 - 10 * n - 4);
    }
  });

  it('sets turn=1 and phase=awaiting-cards', () => {
    const state = createGame(['p0', 'p1'], 'test-seed');
    const dealt = dealRound(state);
    expect(dealt.turn).toBe(1);
    expect(dealt.phase).toBe('awaiting-cards');
  });

  it('hands are sorted ascending', () => {
    const state = createGame(['p0', 'p1'], 'test-seed');
    const dealt = dealRound(state);
    for (const p of dealt.players) {
      for (let i = 1; i < p.hand.length; i++) {
        expect(p.hand[i]).toBeGreaterThan(p.hand[i - 1]);
      }
    }
  });

  it('throws if not in round-over phase', () => {
    const state = createGame(['p0', 'p1'], 'test-seed');
    const dealt = dealRound(state);
    expect(() => dealRound(dealt)).toThrow();
  });

  it('all dealt cards are unique', () => {
    const state = createGame(['p0', 'p1'], 'test-seed');
    const dealt = dealRound(state);
    const allCards = [
      ...dealt.players.flatMap((p) => p.hand),
      ...dealt.board.rows.flat(),
      ...dealt.deck,
    ];
    expect(new Set(allCards).size).toBe(104);
  });
});

// ── resolveTurn ────────────────────────────────────────────────────────

describe('resolveTurn', () => {
  function setupDealtState(seed = 'test-resolve'): GameState {
    const state = createGame(['p0', 'p1'], seed);
    return dealRound(state);
  }

  it('simple 2-player turn (no overflow, no rule-4)', () => {
    // Use a specific seed where normal placement occurs
    const dealt = setupDealtState('simple-turn-seed');
    const p0Card = dealt.players[0].hand[dealt.players[0].hand.length - 1]; // highest card
    const p1Card = dealt.players[1].hand[dealt.players[1].hand.length - 1];

    const plays: PlayCardMove[] = [
      { playerId: 'p0', card: p0Card },
      { playerId: 'p1', card: p1Card },
    ];

    // This may or may not overflow depending on seed, so just verify it doesn't throw
    const result = resolveWithDefault(dealt, plays);
    expect(result.turn).toBe(2);
    expect(result.phase).toBe('awaiting-cards');
    expect(result.players[0].hand).toHaveLength(9);
    expect(result.players[1].hand).toHaveLength(9);
  });

  it('validates cards are in hands', () => {
    const dealt = setupDealtState();
    const plays: PlayCardMove[] = [
      { playerId: 'p0', card: 999 as CardNumber },
      { playerId: 'p1', card: dealt.players[1].hand[0] },
    ];
    expect(() => resolveTurn(dealt, plays)).toThrow();
  });

  it('validates exact player count', () => {
    const dealt = setupDealtState();
    const plays: PlayCardMove[] = [
      { playerId: 'p0', card: dealt.players[0].hand[0] },
    ];
    expect(() => resolveTurn(dealt, plays)).toThrow();
  });

  it('throws if not in awaiting-cards phase', () => {
    const state = createGame(['p0', 'p1'], 'test-seed');
    expect(() => resolveTurn(state, [])).toThrow();
  });

  it('10-player turn resolves correctly', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const state = createGame(ids, 'ten-player-seed');
    const dealt = dealRound(state);

    const plays: PlayCardMove[] = dealt.players.map((p) => ({
      playerId: p.id,
      card: p.hand[0], // lowest card from each hand
    }));

    const result = resolveWithDefault(dealt, plays);
    expect(result.turn).toBe(2);
    for (const p of result.players) {
      expect(p.hand).toHaveLength(9);
    }
  });
});

// ── Phase transitions ──────────────────────────────────────────────────

describe('phase transitions', () => {
  it('round-over → awaiting-cards → (turns) → round-over', () => {
    const state = createGame(['p0', 'p1'], 'phase-test-seed');
    expect(state.phase).toBe('round-over');

    const dealt = dealRound(state);
    expect(dealt.phase).toBe('awaiting-cards');

    let current = dealt;
    for (let t = 1; t <= 10; t++) {
      const plays: PlayCardMove[] = current.players.map((p) => ({
        playerId: p.id,
        card: p.hand[0],
      }));

      current = resolveWithDefault(current, plays);

      if (t < 10) {
        expect(current.phase).toBe('awaiting-cards');
      } else {
        expect(current.phase).toBe('round-over');
      }
    }

    expect(current.turn).toBe(10);
  });
});

// ── scoreRound ─────────────────────────────────────────────────────────

describe('scoreRound', () => {
  it('increments round and resets turn', () => {
    const state = createGame(['p0', 'p1'], 'score-test');
    let current = dealRound(state);

    for (let t = 1; t <= 10; t++) {
      const plays: PlayCardMove[] = current.players.map((p) => ({
        playerId: p.id,
        card: p.hand[0],
      }));
      current = resolveWithDefault(current, plays);
    }

    expect(current.phase).toBe('round-over');
    expect(current.turn).toBe(10);

    const scored = scoreRound(current);
    expect(scored.round).toBe(2);
    expect(scored.turn).toBe(0);
  });

  it('throws if phase is not round-over', () => {
    const state = createGame(['p0', 'p1'], 'score-test');
    const dealt = dealRound(state);
    expect(() => scoreRound(dealt)).toThrow();
  });

  it('throws if turn is not 10', () => {
    const state = createGame(['p0', 'p1'], 'score-test');
    expect(() => scoreRound(state)).toThrow();
  });
});

// ── isGameOver / getWinners ────────────────────────────────────────────

describe('isGameOver', () => {
  it('returns false when all scores below 66', () => {
    const state = createGame(['p0', 'p1'], 'seed');
    expect(isGameOver(state)).toBe(false);
  });

  it('returns true when a player score >= 66', () => {
    const state = createGame(['p0', 'p1'], 'seed');
    const modified: GameState = {
      ...state,
      players: [
        { ...state.players[0], score: 66 },
        state.players[1],
      ],
    };
    expect(isGameOver(modified)).toBe(true);
  });
});

describe('getWinners', () => {
  it('returns player(s) with lowest score', () => {
    const state = createGame(['p0', 'p1'], 'seed');
    const modified: GameState = {
      ...state,
      players: [
        { ...state.players[0], score: 80 },
        { ...state.players[1], score: 45 },
      ],
    };
    expect(getWinners(modified)).toEqual(['p1']);
  });

  it('returns multiple winners on tie', () => {
    const state = createGame(['p0', 'p1', 'p2'], 'seed');
    const modified: GameState = {
      ...state,
      players: [
        { ...state.players[0], score: 10 },
        { ...state.players[1], score: 70 },
        { ...state.players[2], score: 10 },
      ],
    };
    expect(getWinners(modified)).toEqual(['p0', 'p2']);
  });
});

// ── Score accumulation ─────────────────────────────────────────────────

describe('score accumulation', () => {
  it('scores increase when overflow occurs', () => {
    // Play a full round and check that scores are non-negative and accumulate
    const state = createGame(['p0', 'p1'], 'overflow-score-seed');
    let current = dealRound(state);

    let prevTotalScore = 0;
    for (let t = 1; t <= 10; t++) {
      const plays: PlayCardMove[] = current.players.map((p) => ({
        playerId: p.id,
        card: p.hand[0],
      }));
      current = resolveWithDefault(current, plays);
      const totalScore = current.players.reduce((s, p) => s + p.score, 0);
      expect(totalScore).toBeGreaterThanOrEqual(prevTotalScore);
      prevTotalScore = totalScore;
    }
  });

  it('scores are cumulative across rounds', () => {
    const state = createGame(['p0', 'p1'], 'cumulative-seed');
    let current = dealRound(state);

    for (let t = 1; t <= 10; t++) {
      const plays: PlayCardMove[] = current.players.map((p) => ({
        playerId: p.id,
        card: p.hand[0],
      }));
      current = resolveWithDefault(current, plays);
    }

    const round1Scores = current.players.map((p) => p.score);

    current = scoreRound(current);
    current = dealRound(current);

    for (let t = 1; t <= 10; t++) {
      const plays: PlayCardMove[] = current.players.map((p) => ({
        playerId: p.id,
        card: p.hand[0],
      }));
      current = resolveWithDefault(current, plays);
    }

    // Scores should be >= round 1 scores (cumulative)
    for (let i = 0; i < current.players.length; i++) {
      expect(current.players[i].score).toBeGreaterThanOrEqual(round1Scores[i]);
    }
  });
});
