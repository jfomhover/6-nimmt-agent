import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../src/mcp/session.js';

// ── Helpers ─────────────────────────────────────────────────────────

interface SessionResult {
  sessionId: string;
  sessionVersion: number;
  phase: string;
  [key: string]: unknown;
}

interface DomainError {
  ok: false;
  code: string;
  message: string;
  [key: string]: unknown;
}

function isDomainError(v: unknown): v is DomainError {
  return typeof v === 'object' && v !== null && 'ok' in v && (v as DomainError).ok === false;
}

function createTestSession(mgr: SessionManager) {
  const result = mgr.startSession({
    strategy: 'random',
    playerCount: 2,
    playerId: 'p0',
    seed: 'test-seed',
  });
  expect(isDomainError(result)).toBe(false);
  return result as SessionResult;
}

function makeBoard(): number[][] {
  return [[5], [15], [25], [35]];
}

function makeHand(): number[] {
  return [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
}

function startRound(mgr: SessionManager, sessionId: string, version: number, round = 1) {
  const result = mgr.roundStarted({
    sessionId,
    expectedVersion: version,
    round,
    board: makeBoard(),
    hand: makeHand(),
  });
  expect(isDomainError(result)).toBe(false);
  return result as SessionResult;
}

function resolveTurn(
  mgr: SessionManager,
  sessionId: string,
  version: number,
  round: number,
  turn: number,
  playedCard: number,
  boardAfter?: number[][],
) {
  const result = mgr.turnResolved({
    sessionId,
    expectedVersion: version,
    round,
    turn,
    plays: [
      { playerId: 'p0', card: playedCard },
      { playerId: 'p1', card: playedCard + 1 },
    ],
    resolutions: [
      { playerId: 'p0', card: playedCard, rowIndex: 0, causedOverflow: false },
      { playerId: 'p1', card: playedCard + 1, rowIndex: 0, causedOverflow: false },
    ],
    boardAfter: boardAfter ?? [[5, playedCard, playedCard + 1], [15], [25], [35]],
  });
  expect(isDomainError(result)).toBe(false);
  return result as SessionResult;
}

// ── start_session ───────────────────────────────────────────────────

describe('startSession', () => {
  let mgr: SessionManager;
  beforeEach(() => { mgr = new SessionManager(); });

  it('creates session successfully', () => {
    const result = createTestSession(mgr);
    expect(result.sessionId).toBeTruthy();
    expect(typeof result.sessionId).toBe('string');
  });

  it('returns version 0 and phase awaiting-round', () => {
    const result = createTestSession(mgr);
    expect(result.sessionVersion).toBe(0);
    expect(result.phase).toBe('awaiting-round');
  });

  it('invalid strategy → INVALID_STRATEGY', () => {
    const result = mgr.startSession({
      strategy: 'nonexistent',
      playerCount: 2,
      playerId: 'p0',
    });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('INVALID_STRATEGY');
  });

  it('playerCount 1 → INVALID_PLAYER_COUNT', () => {
    const result = mgr.startSession({
      strategy: 'random',
      playerCount: 1,
      playerId: 'p0',
    });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('INVALID_PLAYER_COUNT');
  });

  it('playerCount 11 → INVALID_PLAYER_COUNT', () => {
    const result = mgr.startSession({
      strategy: 'random',
      playerCount: 11,
      playerId: 'p0',
    });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('INVALID_PLAYER_COUNT');
  });

  it('exceeds maxSessions → MAX_SESSIONS_REACHED', () => {
    const smallMgr = new SessionManager(2);
    createTestSession(smallMgr);
    createTestSession(smallMgr);
    const result = smallMgr.startSession({
      strategy: 'random',
      playerCount: 2,
      playerId: 'p0',
    });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('MAX_SESSIONS_REACHED');
  });
});

// ── round_started ───────────────────────────────────────────────────

describe('roundStarted', () => {
  let mgr: SessionManager;
  beforeEach(() => { mgr = new SessionManager(); });

  it('accepts valid round_started', () => {
    const session = createTestSession(mgr);
    const result = startRound(mgr, session.sessionId, 0);
    expect(result.sessionVersion).toBe(1);
    expect(result.phase).toBe('in-round');
  });

  it('wrong version → VERSION_MISMATCH', () => {
    const session = createTestSession(mgr);
    const result = mgr.roundStarted({
      sessionId: session.sessionId,
      expectedVersion: 99,
      round: 1,
      board: makeBoard(),
      hand: makeHand(),
    });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('VERSION_MISMATCH');
  });

  it('wrong phase (call round_started twice) → INVALID_PHASE', () => {
    const session = createTestSession(mgr);
    startRound(mgr, session.sessionId, 0);
    const result = mgr.roundStarted({
      sessionId: session.sessionId,
      expectedVersion: 1,
      round: 2,
      board: makeBoard(),
      hand: makeHand(),
    });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('INVALID_PHASE');
  });

  it('invalid board (3 rows) → INVALID_BOARD', () => {
    const session = createTestSession(mgr);
    const result = mgr.roundStarted({
      sessionId: session.sessionId,
      expectedVersion: 0,
      round: 1,
      board: [[1], [2], [3]],
      hand: makeHand(),
    });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('INVALID_BOARD');
  });

  it('invalid hand (card > 104) → INVALID_HAND', () => {
    const session = createTestSession(mgr);
    const result = mgr.roundStarted({
      sessionId: session.sessionId,
      expectedVersion: 0,
      round: 1,
      board: makeBoard(),
      hand: [105],
    });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('INVALID_HAND');
  });
});

// ── turn_resolved ───────────────────────────────────────────────────

describe('turnResolved', () => {
  let mgr: SessionManager;
  beforeEach(() => { mgr = new SessionManager(); });

  it('accepts valid turn, increments version', () => {
    const session = createTestSession(mgr);
    startRound(mgr, session.sessionId, 0);
    const result = resolveTurn(mgr, session.sessionId, 1, 1, 1, 10);
    expect(result.sessionVersion).toBe(2);
    expect(result.phase).toBe('in-round');
  });

  it('updates hand (removes played card)', () => {
    const session = createTestSession(mgr);
    startRound(mgr, session.sessionId, 0);
    resolveTurn(mgr, session.sessionId, 1, 1, 1, 10);
    const status = mgr.sessionStatus({ sessionId: session.sessionId }) as { handSize: number };
    expect(status.handSize).toBe(9); // started with 10, played 1
  });

  it('duplicate same payload → DUPLICATE_EVENT', () => {
    const session = createTestSession(mgr);
    startRound(mgr, session.sessionId, 0);
    resolveTurn(mgr, session.sessionId, 1, 1, 1, 10);
    // Replay same turn with same data but current version
    const result = mgr.turnResolved({
      sessionId: session.sessionId,
      expectedVersion: 2,
      round: 1,
      turn: 1,
      plays: [
        { playerId: 'p0', card: 10 },
        { playerId: 'p1', card: 11 },
      ],
      resolutions: [
        { playerId: 'p0', card: 10, rowIndex: 0, causedOverflow: false },
         { playerId: 'p1', card: 11, rowIndex: 0, causedOverflow: false },
      ],
      boardAfter: [[5, 10, 11], [15], [25], [35]],
    });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('DUPLICATE_EVENT');
  });

  it('same turn different data → EVENT_CONFLICT', () => {
    const session = createTestSession(mgr);
    startRound(mgr, session.sessionId, 0);
    resolveTurn(mgr, session.sessionId, 1, 1, 1, 10);
    // Same turn but different plays
    const result = mgr.turnResolved({
      sessionId: session.sessionId,
      expectedVersion: 2,
      round: 1,
      turn: 1,
      plays: [
        { playerId: 'p0', card: 99 },
        { playerId: 'p1', card: 98 },
      ],
      resolutions: [
        { playerId: 'p0', card: 99, rowIndex: 0, causedOverflow: false },
        { playerId: 'p1', card: 98, rowIndex: 1, causedOverflow: false },
      ],
      boardAfter: [[5, 99], [15, 98], [25], [35]],
    });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('EVENT_CONFLICT');
  });

  it('wrong turn number → INVALID_TURN', () => {
    const session = createTestSession(mgr);
    startRound(mgr, session.sessionId, 0);
    const result = mgr.turnResolved({
      sessionId: session.sessionId,
      expectedVersion: 1,
      round: 1,
      turn: 5, // expected 1
      plays: [{ playerId: 'p0', card: 10 }, { playerId: 'p1', card: 11 }],
      resolutions: [
        { playerId: 'p0', card: 10, rowIndex: 0, causedOverflow: false },
        { playerId: 'p1', card: 11, rowIndex: 1, causedOverflow: false },
      ],
    });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('INVALID_TURN');
  });
});

// ── round_ended ─────────────────────────────────────────────────────

describe('roundEnded', () => {
  let mgr: SessionManager;
  beforeEach(() => { mgr = new SessionManager(); });

  it('transitions to awaiting-round when no game-over', () => {
    const session = createTestSession(mgr);
    startRound(mgr, session.sessionId, 0);
    resolveTurn(mgr, session.sessionId, 1, 1, 1, 10);

    const result = mgr.roundEnded({
      sessionId: session.sessionId,
      expectedVersion: 2,
      round: 1,
      scores: [{ playerId: 'p0', score: 5 }, { playerId: 'p1', score: 3 }],
    }) as SessionResult;

    expect(isDomainError(result)).toBe(false);
    expect(result.phase).toBe('awaiting-round');
    expect((result as Record<string, unknown>).gameOver).toBe(false);
  });

  it('transitions to game-over when score ≥ 66', () => {
    const session = createTestSession(mgr);
    startRound(mgr, session.sessionId, 0);
    resolveTurn(mgr, session.sessionId, 1, 1, 1, 10);

    const result = mgr.roundEnded({
      sessionId: session.sessionId,
      expectedVersion: 2,
      round: 1,
      scores: [{ playerId: 'p0', score: 66 }, { playerId: 'p1', score: 10 }],
    }) as Record<string, unknown>;

    expect(isDomainError(result)).toBe(false);
    expect(result.phase).toBe('game-over');
    expect(result.gameOver).toBe(true);
  });

  it('returns finalScores ranked when game over', () => {
    const session = createTestSession(mgr);
    startRound(mgr, session.sessionId, 0);
    resolveTurn(mgr, session.sessionId, 1, 1, 1, 10);

    const result = mgr.roundEnded({
      sessionId: session.sessionId,
      expectedVersion: 2,
      round: 1,
      scores: [{ playerId: 'p0', score: 70 }, { playerId: 'p1', score: 10 }],
    }) as { finalScores: { playerId: string; score: number }[] };

    expect(result.finalScores).toBeDefined();
    // Sorted ascending by score
    expect(result.finalScores[0].score).toBeLessThanOrEqual(result.finalScores[1].score);
  });
});

// ── session_recommend ───────────────────────────────────────────────

describe('sessionRecommend', () => {
  let mgr: SessionManager;
  beforeEach(() => { mgr = new SessionManager(); });

  it('card recommendation in in-round phase', () => {
    const session = createTestSession(mgr);
    startRound(mgr, session.sessionId, 0);

    const result = mgr.sessionRecommend({
      sessionId: session.sessionId,
      hand: makeHand(),
      board: makeBoard(),
    }) as Record<string, unknown>;

    expect(isDomainError(result)).toBe(false);
    expect(result.decision).toBe('card');
  });

  it('returns recommendation with card from hand', () => {
    const session = createTestSession(mgr);
    startRound(mgr, session.sessionId, 0);
    const hand = makeHand();

    const result = mgr.sessionRecommend({
      sessionId: session.sessionId,
      hand,
      board: makeBoard(),
    }) as { recommendation: { card: number } };

    expect(hand).toContain(result.recommendation.card);
  });

  it('drift detection: minor mismatch → stateConsistent:false with warnings', () => {
    const session = createTestSession(mgr);
    startRound(mgr, session.sessionId, 0);

    // Pass slightly different hand (1 card different, drift ≤ 4)
    const driftHand = [10, 20, 30, 40, 50, 60, 70, 80, 90, 101];
    const result = mgr.sessionRecommend({
      sessionId: session.sessionId,
      hand: driftHand,
      board: makeBoard(),
    }) as { warnings: string[] };

    expect(isDomainError(result)).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.toLowerCase().includes('drift'))).toBe(true);
  });

  it('wrong phase → INVALID_PHASE', () => {
    const session = createTestSession(mgr);
    // Still in awaiting-round phase
    const result = mgr.sessionRecommend({
      sessionId: session.sessionId,
      hand: makeHand(),
      board: makeBoard(),
    });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('INVALID_PHASE');
  });
});

// ── resync_session ──────────────────────────────────────────────────

describe('resyncSession', () => {
  let mgr: SessionManager;
  beforeEach(() => { mgr = new SessionManager(); });

  it('resets session state', () => {
    const session = createTestSession(mgr);
    startRound(mgr, session.sessionId, 0);

    const result = mgr.resyncSession({
      sessionId: session.sessionId,
      round: 2,
      turn: 3,
      board: [[1], [2], [3], [4]],
      hand: [50, 60],
      scores: [{ playerId: 'p0', score: 10 }, { playerId: 'p1', score: 5 }],
    }) as Record<string, unknown>;

    expect(isDomainError(result)).toBe(false);
    expect(result.resynced).toBe(true);
    expect(result.round).toBe(2);
    expect(result.turn).toBe(3);
  });

  it('replays turnHistory', () => {
    const session = createTestSession(mgr);
    startRound(mgr, session.sessionId, 0);

    const history = [
      {
        turn: 1,
        plays: [{ playerId: 'p0', card: 10 }, { playerId: 'p1', card: 11 }],
        resolutions: [
          { playerId: 'p0', card: 10, rowIndex: 0, causedOverflow: false },
          { playerId: 'p1', card: 11, rowIndex: 1, causedOverflow: false },
        ],
        rowPicks: [],
        boardAfter: [[5, 10], [15, 11], [25], [35]],
      },
    ];

    const result = mgr.resyncSession({
      sessionId: session.sessionId,
      round: 1,
      turn: 1,
      board: [[5, 10], [15, 11], [25], [35]],
      hand: [20, 30, 40, 50, 60, 70, 80, 90, 100],
      scores: [{ playerId: 'p0', score: 0 }, { playerId: 'p1', score: 0 }],
      turnHistory: history as never[],
    }) as Record<string, unknown>;

    expect(result.resynced).toBe(true);
    expect(result.strategyStateReset).toBe(true);
    expect((result.message as string)).toContain('1 turn(s) replayed');
  });

  it('returns resynced:true', () => {
    const session = createTestSession(mgr);
    const result = mgr.resyncSession({
      sessionId: session.sessionId,
      round: 1,
      turn: 0,
      board: makeBoard(),
      hand: makeHand(),
      scores: [],
    }) as Record<string, unknown>;

    expect(result.resynced).toBe(true);
  });
});

// ── session_status ──────────────────────────────────────────────────

describe('sessionStatus', () => {
  let mgr: SessionManager;
  beforeEach(() => { mgr = new SessionManager(); });

  it('returns current state', () => {
    const session = createTestSession(mgr);
    const status = mgr.sessionStatus({ sessionId: session.sessionId }) as Record<string, unknown>;

    expect(isDomainError(status)).toBe(false);
    expect(status.sessionId).toBe(session.sessionId);
    expect(status.phase).toBe('awaiting-round');
    expect(status.sessionVersion).toBe(0);
    expect(status.strategy).toBe('random');
  });

  it('unknown session → UNKNOWN_SESSION', () => {
    const result = mgr.sessionStatus({ sessionId: 'no-such-session' });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('UNKNOWN_SESSION');
  });
});

// ── end_session ─────────────────────────────────────────────────────

describe('endSession', () => {
  let mgr: SessionManager;
  beforeEach(() => { mgr = new SessionManager(); });

  it('ends session, returns ended:true', () => {
    const session = createTestSession(mgr);
    const result = mgr.endSession({ sessionId: session.sessionId }) as Record<string, unknown>;

    expect(isDomainError(result)).toBe(false);
    expect(result.ended).toBe(true);
    expect(result.finalPhase).toBe('ended');
  });

  it('subsequent calls → UNKNOWN_SESSION', () => {
    const session = createTestSession(mgr);
    mgr.endSession({ sessionId: session.sessionId });
    const result = mgr.endSession({ sessionId: session.sessionId });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('UNKNOWN_SESSION');
  });
});

// ── Full lifecycle integration ──────────────────────────────────────

describe('full lifecycle', () => {
  it('start → round → turns → roundEnd → repeat → gameOver → end', () => {
    const mgr = new SessionManager();
    const session = createTestSession(mgr);
    let version = 0;

    // Round 1
    const r1 = mgr.roundStarted({
      sessionId: session.sessionId,
      expectedVersion: version,
      round: 1,
      board: [[1], [2], [3], [4]],
      hand: makeHand(),
    }) as SessionResult;
    version = r1.sessionVersion;

    // Play 10 turns (use all 10 cards from hand)
    const hand = makeHand();
    let lifecycleBoard = [[1], [2], [3], [4]];
    for (let t = 1; t <= 10; t++) {
      const card = hand[t - 1];
      const opponentCard = card === 104 ? 103 : card + 1;
      const causedOverflow = lifecycleBoard[3].length === 5;
      const collectedCards = causedOverflow ? [...lifecycleBoard[3]] : undefined;
      lifecycleBoard[3] = causedOverflow ? [card] : [...lifecycleBoard[3], card];
      const opponentOverflow = lifecycleBoard[3].length === 5;
      const opponentCollectedCards = opponentOverflow ? [...lifecycleBoard[3]] : undefined;
      lifecycleBoard[3] = opponentOverflow ? [opponentCard] : [...lifecycleBoard[3], opponentCard];
      const turnResult = mgr.turnResolved({
        sessionId: session.sessionId,
        expectedVersion: version,
        round: 1,
        turn: t,
        plays: [
          { playerId: 'p0', card },
          { playerId: 'p1', card: opponentCard },
        ],
        resolutions: [
          { playerId: 'p0', card, rowIndex: 3, causedOverflow, ...(collectedCards ? { collectedCards } : {}) },
          { playerId: 'p1', card: opponentCard, rowIndex: 3, causedOverflow: opponentOverflow, ...(opponentCollectedCards ? { collectedCards: opponentCollectedCards } : {}) },
        ],
        boardAfter: lifecycleBoard,
      }) as SessionResult;
      expect(isDomainError(turnResult)).toBe(false);
      version = turnResult.sessionVersion;
    }

    // End round 1 with low scores → continue
    const endR1 = mgr.roundEnded({
      sessionId: session.sessionId,
      expectedVersion: version,
      round: 1,
      scores: [{ playerId: 'p0', score: 10 }, { playerId: 'p1', score: 8 }],
    }) as Record<string, unknown>;
    expect(isDomainError(endR1)).toBe(false);
    expect(endR1.phase).toBe('awaiting-round');
    expect(endR1.gameOver).toBe(false);
    version = endR1.sessionVersion as number;

    // Round 2 → immediate game over
    const r2 = startRound(mgr, session.sessionId, version, 2);
    version = r2.sessionVersion;

    const t1r2 = resolveTurn(mgr, session.sessionId, version, 2, 1, 10);
    version = t1r2.sessionVersion;

    const endR2 = mgr.roundEnded({
      sessionId: session.sessionId,
      expectedVersion: version,
      round: 2,
      scores: [{ playerId: 'p0', score: 70 }, { playerId: 'p1', score: 20 }],
    }) as Record<string, unknown>;
    expect(isDomainError(endR2)).toBe(false);
    expect(endR2.phase).toBe('game-over');
    expect(endR2.gameOver).toBe(true);
    version = endR2.sessionVersion as number;

    // End session
    const ended = mgr.endSession({ sessionId: session.sessionId }) as Record<string, unknown>;
    expect(ended.ended).toBe(true);

    // Confirm session is gone
    const afterEnd = mgr.sessionStatus({ sessionId: session.sessionId });
    expect(isDomainError(afterEnd)).toBe(true);
  });
});
