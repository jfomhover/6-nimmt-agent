/**
 * Session state manager for the 6 Nimmt! MCP server.
 * Tracks per-session game state and delegates to strategy instances.
 */

import { randomUUID } from 'node:crypto';
import type { CardNumber, CardChoiceState, RowChoiceState, Board } from '../engine/types.js';
import type { Strategy, TurnResolution } from '../engine/strategies/types.js';
import { strategies, cattleHeads, deriveSeedState, xoshiro256ss } from '../engine/index.js';
import * as errors from './errors.js';
import type { DomainError } from './errors.js';

/** Convert a 4-row number[][] (already validated) to a typed Board. */
function toBoard(rows: number[][]): Board {
  return { rows: [rows[0], rows[1], rows[2], rows[3]] as unknown as Board['rows'] };
}

// ── Types ───────────────────────────────────────────────────────────

type SessionPhase = 'awaiting-round' | 'in-round' | 'awaiting-row-pick' | 'game-over' | 'ended';

interface Session {
  id: string;
  strategy: Strategy;
  strategyName: string;
  strategyOptions?: Record<string, unknown>;
  playerId: string;
  playerCount: number;
  seed: string;
  version: number;
  phase: SessionPhase;
  round: number;
  turn: number;
  completedRounds: number;
  board: number[][];
  initialBoard: number[][];
  hand: number[];
  scores: { playerId: string; score: number }[];
  roundPenalties: Record<string, number>;
  turnHistory: TurnResolution[];
  lastEvent: string;
  /** Serialised last turn_resolved payload for duplicate detection */
  lastTurnKey?: string;
  lastTurnPayload?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function createPlayerRng(seed: string, playerId: string): () => number {
  const state = deriveSeedState(seed + '/' + playerId);
  return () => Number(xoshiro256ss(state) >> 11n) / 2 ** 53;
}

function fewestHeadsRow(board: number[][]): 0 | 1 | 2 | 3 {
  let best = 0;
  let bestP = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = board[i].reduce((s, c) => s + cattleHeads(c), 0);
    if (p < bestP) { bestP = p; best = i; }
  }
  return best as 0 | 1 | 2 | 3;
}

function computeBoardAfter(boardBefore: number[][], resolutions: { rowIndex: number; card: number; causedOverflow: boolean; collectedCards?: number[] }[], rowPicks: { rowIndex: number; collectedCards: number[] }[]): number[][] | undefined {
  const board = boardBefore.map((row) => [...row]);
  for (const resolution of [...resolutions].sort((a, b) => a.card - b.card)) {
    if (resolution.rowIndex < 0 || resolution.rowIndex > 3 || !Number.isInteger(resolution.rowIndex)) return undefined;
    const row = board[resolution.rowIndex];
    const pick = rowPicks.find((p) => p.rowIndex === resolution.rowIndex && p.collectedCards.join(',') === (resolution.collectedCards ?? []).join(','));
    if (pick && !resolution.causedOverflow) {
      if (JSON.stringify(pick.collectedCards) !== JSON.stringify(row)) return undefined;
      board[resolution.rowIndex] = [resolution.card];
    } else if (resolution.causedOverflow || row.length >= 5) {
      if (row.length !== 5 || JSON.stringify(resolution.collectedCards ?? []) !== JSON.stringify(row)) return undefined;
      board[resolution.rowIndex] = [resolution.card];
    } else {
      if (row.length >= 5 || resolution.card <= row[row.length - 1]) return undefined;
      board[resolution.rowIndex].push(resolution.card);
    }
  }
  return board;
}

function isValidCard(c: number): boolean {
  return Number.isInteger(c) && c >= 1 && c <= 104;
}

/**
 * Coerces various board representations into a flat number[][].
 * Accepts:
 *   - number[][] (passthrough)
 *   - { rows: number[][] }
 *   - { "0": number[], "1": number[], "2": number[], "3": number[] }
 * Returns undefined if the input cannot be coerced.
 */
function coerceBoard(input: unknown): number[][] | undefined {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    // { rows: [[...], ...] }
    if (Array.isArray(obj.rows)) return obj.rows;
    // { "0": [...], "1": [...], "2": [...], "3": [...] }
    if ('0' in obj && '1' in obj && '2' in obj && '3' in obj) {
      const rows = [obj['0'], obj['1'], obj['2'], obj['3']];
      if (rows.every(r => Array.isArray(r))) return rows as number[][];
    }
  }
  return undefined;
}

/**
 * Coerces various scores representations into { playerId, score }[].
 * Accepts:
 *   - { playerId: string, score: number }[] (passthrough)
 *   - { [playerId]: number } (object map)
 * Returns undefined if the input cannot be coerced.
 */
function coerceScores(input: unknown): { playerId: string; score: number }[] | undefined {
  if (Array.isArray(input)) {
    // Already an array — validate shape
    if (input.length === 0) return [];
    if (input[0] && typeof input[0] === 'object' && 'playerId' in input[0]) {
      return input as { playerId: string; score: number }[];
    }
    return undefined;
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    // Object map: { "player1": 7, "player2": 12 }
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 0) return [];
    const scores: { playerId: string; score: number }[] = [];
    for (const [key, val] of entries) {
      if (typeof val !== 'number') return undefined;
      scores.push({ playerId: key, score: val });
    }
    return scores;
  }
  return undefined;
}



// ── SessionManager ──────────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, Session>();
  private maxSessions: number;

  constructor(maxSessions: number = 4) {
    this.maxSessions = maxSessions;
  }

  // ── start_session ───────────────────────────────────────────────

  startSession(params: {
    strategy: string;
    playerCount: number;
    playerId: string;
    seatIndex?: number;
    seed?: string;
    strategyOptions?: Record<string, unknown>;
  }): object | DomainError {
    const { strategy: strategyName, playerCount, playerId, seed: providedSeed, strategyOptions } = params;

    // Validate strategy
    if (!strategies.has(strategyName)) {
      return errors.invalidStrategy(strategyName, [...strategies.keys()]);
    }

    // Validate player count
    if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 10) {
      return errors.invalidPlayerCount(playerCount);
    }

    // Check session limit
    if (this.sessions.size >= this.maxSessions) {
      return errors.maxSessionsReached(this.maxSessions);
    }

    const sessionId = `s-${randomUUID().slice(0, 8)}`;
    const seed = providedSeed ?? randomUUID();

    // Instantiate strategy
    const strat = strategies.get(strategyName)!(strategyOptions);
    const rng = createPlayerRng(seed, playerId);
    strat.onGameStart?.({ playerId, playerCount, rng });

    const session: Session = {
      id: sessionId,
      strategy: strat,
      strategyName,
      strategyOptions,
      playerId,
      playerCount,
      seed,
      version: 0,
      phase: 'awaiting-round',
      round: 0,
      turn: 0,
      completedRounds: 0,
      board: [],
      initialBoard: [],
      hand: [],
      scores: [],
      roundPenalties: {},
      turnHistory: [],
      lastEvent: 'start_session',
    };

    this.sessions.set(sessionId, session);

    return {
      sessionId,
      seed,
      sessionVersion: 0,
      phase: 'awaiting-round' as SessionPhase,
      strategy: strategyName,
      playerCount,
      playerId,
    };
  }

  // ── round_started ───────────────────────────────────────────────

  roundStarted(params: {
    sessionId: string;
    expectedVersion: number;
    round: number;
    board: unknown;
    hand: number[];
  }): object | DomainError {
    const { sessionId, expectedVersion, round, hand } = params;
    const board = coerceBoard(params.board);
    if (!board) {
      return errors.domainError('INVALID_BOARD', 'Board must be an array of 4 rows, an object with keys 0-3, or { rows: [...] }.', {
        recoverable: false, suggestedAction: 'none',
        details: { received: typeof params.board },
      });
    }

    const session = this.sessions.get(sessionId);
    if (!session) return errors.unknownSession(sessionId);
    if (session.version !== expectedVersion) return errors.versionMismatch(expectedVersion, session.version);
    if (session.phase !== 'awaiting-round') return errors.invalidPhase(session.phase, 'awaiting-round');

    // Check round is sequential
    if (round !== session.round + 1) {
      return errors.domainError('INVALID_ROUND', `Expected round ${session.round + 1}, got ${round}.`, {
        recoverable: true, suggestedAction: 'resync_session',
        details: { expected: session.round + 1, got: round },
      });
    }

    // Validate board: must be 4 rows with valid cards
    if (!Array.isArray(board) || board.length !== 4) {
      return errors.domainError('INVALID_BOARD', 'Board must have exactly 4 rows.', {
        recoverable: false, suggestedAction: 'none',
        details: { rowCount: Array.isArray(board) ? board.length : 0 },
      });
    }
    for (let i = 0; i < 4; i++) {
      if (!Array.isArray(board[i]) || board[i].length === 0) {
        return errors.domainError('INVALID_BOARD', `Board row ${i} must be a non-empty array.`, {
          recoverable: false, suggestedAction: 'none',
        });
      }
      for (const c of board[i]) {
        if (!isValidCard(c)) {
          return errors.domainError('INVALID_BOARD', `Board row ${i} has invalid card ${c}.`, {
            recoverable: false, suggestedAction: 'none',
          });
        }
      }
    }

    // Validate hand
    if (!Array.isArray(hand) || hand.length === 0) {
      return errors.domainError('INVALID_HAND', 'Hand must be a non-empty array.', {
        recoverable: false, suggestedAction: 'none',
      });
    }
    for (const c of hand) {
      if (!isValidCard(c)) {
        return errors.domainError('INVALID_HAND', `Hand has invalid card ${c}.`, {
          recoverable: false, suggestedAction: 'none',
        });
      }
    }

    // Update session
    session.board = board.map(r => [...r]);
    session.initialBoard = board.map(r => [...r]);
    session.hand = [...hand];
    session.round = round;
    session.turn = 0;
    session.phase = 'in-round';
    session.version++;
    session.turnHistory = [];
    session.roundPenalties = {};
    session.lastEvent = 'round_started';
    session.lastTurnKey = undefined;
    session.lastTurnPayload = undefined;

    // onRoundStart — notify strategy of new round
    try {
      session.strategy.onRoundStart?.({
        round,
        hand: hand as CardNumber[],
        board: toBoard(board),
      });
    } catch { /* lifecycle errors are non-fatal */ }

    return {
      sessionVersion: session.version,
      phase: 'in-round' as SessionPhase,
      round,
      accepted: true,
    };
  }

  // ── turn_resolved ───────────────────────────────────────────────

  turnResolved(params: {
    sessionId: string;
    expectedVersion: number;
    round: number;
    turn: number;
    plays: { playerId: string; card: number }[];
    resolutions: { playerId: string; card: number; rowIndex: number; causedOverflow: boolean; collectedCards?: number[] }[];
    rowPicks?: { playerId: string; rowIndex: number; collectedCards: number[] }[];
    boardAfter?: unknown;
  }): object | DomainError {
    const { sessionId, expectedVersion, round, turn, plays, resolutions, rowPicks } = params;
    const boardAfter = params.boardAfter != null ? coerceBoard(params.boardAfter) : undefined;

    const session = this.sessions.get(sessionId);
    if (!session) return errors.unknownSession(sessionId);
    if (session.version !== expectedVersion) return errors.versionMismatch(expectedVersion, session.version);
    if (session.phase !== 'in-round' && session.phase !== 'awaiting-row-pick') {
      return errors.invalidPhase(session.phase, 'in-round');
    }

    // Check round matches
    if (round !== session.round) {
      return errors.domainError('INVALID_ROUND', `Expected round ${session.round}, got ${round}.`, {
        recoverable: true, suggestedAction: 'resync_session',
        details: { expected: session.round, got: round },
      });
    }

    // Duplicate detection
    const turnKey = `${round}:${turn}`;
    const payloadStr = JSON.stringify({ plays, resolutions, rowPicks, boardAfter });
    if (session.lastTurnKey === turnKey) {
      if (session.lastTurnPayload === payloadStr) {
        return errors.domainError('DUPLICATE_EVENT', `Turn ${turn} of round ${round} already processed with same data.`, {
          recoverable: true, suggestedAction: 'retry_with_version',
          details: { sessionVersion: session.version, round, turn },
        });
      } else {
        return errors.domainError('EVENT_CONFLICT', `Turn ${turn} of round ${round} already processed with different data.`, {
          recoverable: true, suggestedAction: 'resync_session',
          details: { round, turn },
        });
      }
    }

    // Check turn is sequential
    if (turn !== session.turn + 1) {
      return errors.domainError('INVALID_TURN', `Expected turn ${session.turn + 1}, got ${turn}.`, {
        recoverable: true, suggestedAction: 'resync_session',
        details: { expected: session.turn + 1, got: turn },
      });
    }

    if (!Array.isArray(plays) || plays.length !== session.playerCount || new Set(plays.map(p => p.playerId)).size !== plays.length) {
      return errors.domainError('INVALID_RESOLUTIONS', 'plays must contain exactly one play per player.', { recoverable: true, suggestedAction: 'none' });
    }
    const expectedCards = new Set(plays.map(p => p.card));
    if (!Array.isArray(resolutions) || resolutions.length !== plays.length || resolutions.some(r => !expectedCards.has(r.card))) {
      return errors.domainError('INVALID_RESOLUTIONS', 'Resolutions must contain one entry for every played card.', { recoverable: true, suggestedAction: 'none' });
    }
    const computedBoard = computeBoardAfter(session.board, resolutions, rowPicks ?? []);
    if (!computedBoard) return errors.domainError('INVALID_RESOLUTIONS', 'Resolution contains an invalid row index.', { recoverable: true, suggestedAction: 'none' });
    if (boardAfter && JSON.stringify(boardAfter) !== JSON.stringify(computedBoard)) {
      return errors.domainError('INVALID_RESOLUTIONS', 'boardAfter does not match the computed board.', { recoverable: true, suggestedAction: 'resync_session' });
    }

    // Build TurnResolution
    const normalizedResolutions = [...resolutions].sort((a, b) => a.card - b.card);
    const resolution: TurnResolution = {
      turn,
      plays: plays as unknown as TurnResolution['plays'],
      resolutions: normalizedResolutions as unknown as TurnResolution['resolutions'],
      rowPicks: (rowPicks ?? []) as unknown as TurnResolution['rowPicks'],
      boardAfter: computedBoard as unknown as TurnResolution['boardAfter'],
    };

    // Notify strategy
    try {
      session.strategy.onTurnResolved?.(resolution);
    } catch {
      // non-fatal: strategy error during notification
    }

    // Update board
    session.board = computedBoard.map(r => [...r]);
    for (const resolution of normalizedResolutions) {
      if (resolution.collectedCards) {
        session.roundPenalties[resolution.playerId] = (session.roundPenalties[resolution.playerId] ?? 0) + resolution.collectedCards.reduce((sum, card) => sum + cattleHeads(card), 0);
      }
    }

    // Remove played card from hand
    const myPlay = plays.find(p => p.playerId === session.playerId);
    if (myPlay) {
      const idx = session.hand.indexOf(myPlay.card);
      if (idx >= 0) session.hand.splice(idx, 1);
    }

    // Update session state
    session.turn = turn;
    session.turnHistory.push(resolution);
    session.version++;
    session.phase = 'in-round';
    session.lastEvent = 'turn_resolved';
    session.lastTurnKey = turnKey;
    session.lastTurnPayload = payloadStr;

    return {
      sessionVersion: session.version,
      phase: 'in-round' as SessionPhase,
      round,
      turn,
      accepted: true,
    };
  }

  // ── round_ended ─────────────────────────────────────────────────

  roundEnded(params: {
    sessionId: string;
    expectedVersion: number;
    round: number;
    scores: unknown;
  }): object | DomainError {
    const { sessionId, expectedVersion, round } = params;
    const scores = coerceScores(params.scores);
    if (!scores) {
      return errors.domainError('INVALID_SCORES', 'Scores must be an array of {playerId, score} or an object map {playerId: score}.', {
        recoverable: false, suggestedAction: 'none',
        details: { received: typeof params.scores },
      });
    }

    const session = this.sessions.get(sessionId);
    if (!session) return errors.unknownSession(sessionId);
    if (session.version !== expectedVersion) return errors.versionMismatch(expectedVersion, session.version);
    if (session.phase !== 'in-round') return errors.invalidPhase(session.phase, 'in-round');

    if (round !== session.round) {
      return errors.domainError('INVALID_ROUND', `Expected round ${session.round}, got ${round}.`, {
        recoverable: true, suggestedAction: 'resync_session',
        details: { expected: session.round, got: round },
      });
    }

    // Notify strategy
    try {
      const scoreArg = scores.map(s => ({ id: s.playerId, score: s.score }));
      session.strategy.onRoundEnd?.(scoreArg);
    } catch {
      // non-fatal
    }

    session.scores = [...scores];
    session.completedRounds++;
    session.version++;
    session.lastEvent = 'round_ended';

    // Check game over: any score >= 66
    const gameOver = scores.some(s => s.score >= 66);

    if (gameOver) {
      session.phase = 'game-over';
      // onGameEnd — notify strategy of final outcome
      try {
        const myScore = scores.find(s => s.playerId === session.playerId)?.score ?? 0;
        const won = scores.every(s => s.playerId === session.playerId || s.score >= myScore);
        session.strategy.onGameEnd?.({
          scores: scores.map(s => ({ id: s.playerId, score: s.score })),
          rounds: session.completedRounds,
          won,
        });
      } catch { /* lifecycle errors are non-fatal */ }
      const finalScores = [...scores].sort((a, b) => a.score - b.score);
      return {
        sessionVersion: session.version,
        phase: 'game-over' as SessionPhase,
        round,
        gameOver: true,
        finalScores,
      };
    }

    session.phase = 'awaiting-round';
    return {
      sessionVersion: session.version,
      phase: 'awaiting-round' as SessionPhase,
      round,
      gameOver: false,
      accepted: true,
    };
  }

  // ── session_recommend ───────────────────────────────────────────

  sessionRecommend(params: {
    sessionId: string;
    hand: number[];
    board: unknown;
    decision?: 'card' | 'row';
    timeout?: number;
    triggeringCard?: number;
    revealedThisTurn?: { playerId: string; card: number }[];
    resolutionIndex?: number;
  }): object | DomainError {
    const { sessionId, hand, triggeringCard, revealedThisTurn, resolutionIndex } = params;
    const board = coerceBoard(params.board);
    if (!board) {
      return errors.domainError('INVALID_BOARD', 'Board must be an array of 4 rows, an object with keys 0-3, or { rows: [...] }.', {
        recoverable: false, suggestedAction: 'none',
        details: { received: typeof params.board },
      });
    }

    const session = this.sessions.get(sessionId);
    if (!session) return errors.unknownSession(sessionId);

    if (session.phase !== 'in-round' && session.phase !== 'awaiting-row-pick') {
      return errors.invalidPhase(session.phase, 'in-round');
    }

    // Auto-detect decision type
    const decision: 'card' | 'row' = params.decision ?? (triggeringCard != null ? 'row' : 'card');
    if (decision === 'row' && (triggeringCard == null || !revealedThisTurn || resolutionIndex == null)) {
      return errors.invalidState('Row recommendation requires triggeringCard, revealedThisTurn, and resolutionIndex.');
    }

    // Drift detection
    const warnings: string[] = [];
    const handDiff = symmetricDiff(new Set(hand), new Set(session.hand));
    const boardDiff = JSON.stringify(board) === JSON.stringify(session.board) ? 0 : board.flat().filter((c, i) => c !== session.board.flat()[i]).length;
    const totalDrift = handDiff + boardDiff;

    if (totalDrift > 4) {
      return errors.stateMismatch(`Major drift detected: ${handDiff} hand card(s), ${boardDiff} board card(s) differ.`);
    }
    if (totalDrift > 0) {
      warnings.push(`Minor drift: ${handDiff} hand, ${boardDiff} board card(s) differ. Using agent-provided state.`);
    }

    // Build state and call strategy
    try {
      if (decision === 'card') {
        const cardState: CardChoiceState = {
          hand: hand as unknown as readonly CardNumber[],
          board: { rows: board.map(r => [...r]) as unknown as Board['rows'] },
          playerScores: session.scores.map(s => ({ id: s.playerId, score: s.score, penaltyThisRound: session.roundPenalties[s.playerId] ?? 0 })),
          playerCount: session.playerCount,
          round: session.round,
          turn: session.turn + 1,
          turnHistory: session.turnHistory as unknown as CardChoiceState['turnHistory'],
          initialBoardCards: session.initialBoard.map(r => r[0]) as unknown as CardChoiceState['initialBoardCards'],
        };

        const card = session.strategy.chooseCard(cardState);

        return {
          ok: true,
          decision: 'card',
          strategy: session.strategyName,
          sessionVersion: session.version,
          recommendation: { card: card as number, confidence: null, alternatives: [] },
          warnings,
        };
      } else {
        const rowState: RowChoiceState = {
          board: { rows: board.map(r => [...r]) as unknown as Board['rows'] },
          triggeringCard: (triggeringCard ?? 0) as CardNumber,
          revealedThisTurn: (revealedThisTurn ?? []) as unknown as RowChoiceState['revealedThisTurn'],
          resolutionIndex: resolutionIndex ?? 0,
          hand: hand as unknown as readonly CardNumber[],
          playerScores: session.scores.map(s => ({ id: s.playerId, score: s.score, penaltyThisRound: session.roundPenalties[s.playerId] ?? 0 })),
          playerCount: session.playerCount,
          round: session.round,
          turn: session.turn,
          turnHistory: session.turnHistory as unknown as RowChoiceState['turnHistory'],
          initialBoardCards: session.initialBoard.map(r => r[0]) as unknown as RowChoiceState['initialBoardCards'],
        };

        const row = session.strategy.chooseRow(rowState);
        session.phase = 'awaiting-row-pick';

        return {
          ok: true,
          decision: 'row',
          strategy: session.strategyName,
          sessionVersion: session.version,
          recommendation: { rowIndex: row as number, confidence: null, alternatives: [] },
          warnings,
        };
      }
    } catch (err) {
      // Fallback
      try {
        if (decision === 'card') {
          const fallbackCard = Math.min(...hand);
          return {
            ok: true,
            decision: 'card',
            strategy: session.strategyName,
            sessionVersion: session.version,
            recommendation: { card: fallbackCard, confidence: null, alternatives: [] },
            warnings: [...warnings, `Strategy error, fell back to lowest card: ${(err as Error).message}`],
          };
        } else {
          const rowIdx = fewestHeadsRow(board);
          return {
            ok: true,
            decision: 'row',
            strategy: session.strategyName,
            sessionVersion: session.version,
            recommendation: { rowIndex: rowIdx as number, confidence: null, alternatives: [] },
            warnings: [...warnings, `Strategy error, fell back to fewest-heads row: ${(err as Error).message}`],
          };
        }
      } catch {
        return errors.engineError(`Strategy error with no fallback: ${(err as Error).message}`);
      }
    }
  }

  // ── resync_session ──────────────────────────────────────────────

  resyncSession(params: {
    sessionId: string;
    round: number;
    turn: number;
    board: unknown;
    hand: number[];
    scores: unknown;
    turnHistory?: TurnResolution[];
  }): object | DomainError {
    const { sessionId, round, turn, hand, turnHistory } = params;
    const board = coerceBoard(params.board);
    if (!board) {
      return errors.domainError('INVALID_BOARD', 'Board must be an array of 4 rows, an object with keys 0-3, or { rows: [...] }.', {
        recoverable: false, suggestedAction: 'none',
        details: { received: typeof params.board },
      });
    }
    if (board.length !== 4) {
      return errors.domainError('INVALID_BOARD', 'Board must have exactly 4 rows.', {
        recoverable: false, suggestedAction: 'none',
        details: { rowCount: board.length },
      });
    }
    const scores = coerceScores(params.scores);
    if (!scores) {
      return errors.domainError('INVALID_SCORES', 'Scores must be an array of {playerId, score} or an object map {playerId: score}.', {
        recoverable: false, suggestedAction: 'none',
        details: { received: typeof params.scores },
      });
    }

    const session = this.sessions.get(sessionId);
    if (!session) return errors.unknownSession(sessionId);

    // Re-instantiate strategy with fresh RNG
    const strat = strategies.get(session.strategyName)!(session.strategyOptions);
    const rng = createPlayerRng(session.seed, session.playerId);
    strat.onGameStart?.({ playerId: session.playerId, playerCount: session.playerCount, rng });

    // Replay turn history
    const history = turnHistory ?? [];
    for (const entry of history) {
      try {
        strat.onTurnResolved?.(entry);
      } catch {
        // non-fatal
      }
    }

    session.strategy = strat;
    session.round = round;
    session.turn = turn;
    session.board = board.map(r => [...r]);
    session.initialBoard = board.map(r => [...r]);
    session.hand = [...hand];
    session.scores = [...scores];
    session.roundPenalties = {};
    session.turnHistory = [...history];
    session.phase = turn >= 1 ? 'in-round' : 'awaiting-round';
    session.version++;
    session.lastEvent = 'resync_session';
    session.lastTurnKey = undefined;
    session.lastTurnPayload = undefined;

    return {
      sessionVersion: session.version,
      phase: session.phase,
      round,
      turn,
      resynced: true,
      strategyStateReset: true,
      message: `Session resynced to round ${round}, turn ${turn}. Strategy state was reset and ${history.length} turn(s) replayed.`,
    };
  }

  // ── session_status ──────────────────────────────────────────────

  sessionStatus(params: { sessionId: string }): object | DomainError {
    const session = this.sessions.get(params.sessionId);
    if (!session) return errors.unknownSession(params.sessionId);

    return {
      sessionId: session.id,
      strategy: session.strategyName,
      playerId: session.playerId,
      playerCount: session.playerCount,
      seed: session.seed,
      sessionVersion: session.version,
      phase: session.phase,
      round: session.round,
      turn: session.turn,
      handSize: session.hand.length,
      scores: session.scores,
      turnHistoryLength: session.turnHistory.length,
      lastEvent: session.lastEvent,
    };
  }

  // ── end_session ─────────────────────────────────────────────────

  endSession(params: { sessionId: string }): object | DomainError {
    const session = this.sessions.get(params.sessionId);
    if (!session) return errors.unknownSession(params.sessionId);

    const totalRounds = session.completedRounds;
    this.sessions.delete(params.sessionId);

    return {
      sessionId: params.sessionId,
      ended: true,
      totalRounds,
      finalPhase: 'ended' as SessionPhase,
    };
  }
}

// ── Utility ─────────────────────────────────────────────────────────

function symmetricDiff(a: Set<number>, b: Set<number>): number {
  let count = 0;
  for (const v of a) if (!b.has(v)) count++;
  for (const v of b) if (!a.has(v)) count++;
  return count;
}
