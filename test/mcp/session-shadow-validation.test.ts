import { describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/mcp/session.js';

function sessionWithRound() {
  const manager = new SessionManager();
  const started = manager.startSession({ strategy: 'random', playerCount: 2, playerId: 'p0', seed: 'shadow-test' }) as { sessionId: string; sessionVersion: number };
  const round = manager.roundStarted({
    sessionId: started.sessionId,
    expectedVersion: started.sessionVersion,
    round: 1,
    board: [[5], [20], [40], [60]],
    hand: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  }) as { sessionVersion: number; sessionId?: string };
  return { manager, sessionId: started.sessionId, version: round.sessionVersion };
}

describe('MCP shadow-board resolution validation', () => {
  it('computes boardAfter when omitted', () => {
    const { manager, sessionId, version } = sessionWithRound();
    const result = manager.turnResolved({
      sessionId,
      expectedVersion: version,
      round: 1,
      turn: 1,
      plays: [{ playerId: 'p0', card: 10 }, { playerId: 'p1', card: 11 }],
      resolutions: [
        { playerId: 'p0', card: 10, rowIndex: 0, causedOverflow: false },
        { playerId: 'p1', card: 11, rowIndex: 0, causedOverflow: false },
      ],
    });
    expect(result).toMatchObject({ accepted: true, sessionVersion: version + 1 });
    expect(manager.sessionStatus({ sessionId })).toMatchObject({ turn: 1 });
  });

  it('rejects wrong player attribution and illegal row placement', () => {
    const first = sessionWithRound();
    const wrongPlayer = first.manager.turnResolved({
      sessionId: first.sessionId,
      expectedVersion: first.version,
      round: 1,
      turn: 1,
      plays: [{ playerId: 'p0', card: 10 }, { playerId: 'p1', card: 11 }],
      resolutions: [
        { playerId: 'p1', card: 10, rowIndex: 0, causedOverflow: false },
        { playerId: 'p1', card: 11, rowIndex: 0, causedOverflow: false },
      ],
    });
    expect(wrongPlayer).toMatchObject({ ok: false, code: 'INVALID_RESOLUTIONS' });

    const second = sessionWithRound();
    const wrongRow = second.manager.turnResolved({
      sessionId: second.sessionId,
      expectedVersion: second.version,
      round: 1,
      turn: 1,
      plays: [{ playerId: 'p0', card: 10 }, { playerId: 'p1', card: 11 }],
      resolutions: [
        { playerId: 'p0', card: 10, rowIndex: 1, causedOverflow: false },
        { playerId: 'p1', card: 11, rowIndex: 0, causedOverflow: false },
      ],
    });
    expect(wrongRow).toMatchObject({ ok: false, code: 'INVALID_RESOLUTIONS' });
  });

  it('accepts Rule 4 with explicit row-pick data and no overflow flag', () => {
    const { manager, sessionId, version } = sessionWithRound();
    const result = manager.turnResolved({
      sessionId,
      expectedVersion: version,
      round: 1,
      turn: 1,
      plays: [{ playerId: 'p0', card: 2 }, { playerId: 'p1', card: 11 }],
      resolutions: [
        { playerId: 'p0', card: 2, rowIndex: 0, causedOverflow: false, collectedCards: [5] },
        { playerId: 'p1', card: 11, rowIndex: 0, causedOverflow: false },
      ],
      rowPicks: [{ playerId: 'p0', rowIndex: 0, collectedCards: [5] }],
    });
    expect(result).toMatchObject({ accepted: true });
  });
});
