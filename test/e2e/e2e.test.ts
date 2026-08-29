import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../../src/mcp/session.js';
import { listStrategies, recommendOnce } from '../../src/mcp/tools/stateless.js';

// ── CLI Helper ──────────────────────────────────────────────────────

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const CLI = resolve(__dirname, '../../src/cli/index.ts');
const NODE = process.execPath;
const TSX_ARGS = ['--import', 'tsx/esm'];

function runCli(
  args: string[],
  options?: { input?: string; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(NODE, [...TSX_ARGS, CLI, ...args], {
      encoding: 'utf-8',
      input: options?.input,
      timeout: options?.timeout ?? 60_000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

// ── State file helpers ──────────────────────────────────────────────

const TEMP_DIR = resolve(__dirname, '../../');
const tempFiles: string[] = [];

function writeTempState(name: string, data: object): string {
  const filePath = resolve(TEMP_DIR, name);
  writeFileSync(filePath, JSON.stringify(data), 'utf-8');
  tempFiles.push(filePath);
  return filePath;
}

afterEach(() => {
  for (const f of tempFiles) {
    if (existsSync(f)) unlinkSync(f);
  }
  tempFiles.length = 0;
});

// ── Session Manager helpers ─────────────────────────────────────────

interface DomainError {
  ok: false;
  code: string;
  message: string;
  [key: string]: unknown;
}

function isDomainError(v: unknown): v is DomainError {
  return typeof v === 'object' && v !== null && 'ok' in v && (v as DomainError).ok === false;
}

// ── Shared state fixtures ───────────────────────────────────────────

const cardState = {
  hand: [3, 17, 42, 55, 67],
  board: { rows: [[5], [10], [20], [30]] },
  playerScores: { p0: 0, p1: 0 },
  playerCount: 2,
  round: 1,
  turn: 1,
  turnHistory: [],
  initialBoardCards: { rows: [[5], [10], [20], [30]] },
};

const rowState = {
  board: { rows: [[5], [10], [20], [30]] },
  triggeringCard: 2,
  revealedThisTurn: [{ playerId: 'p0', card: 2 }],
  resolutionIndex: 0,
  hand: [17, 42],
  playerScores: { p0: 0, p1: 0 },
  playerCount: 2,
  round: 1,
  turn: 1,
  turnHistory: [],
};

// =====================================================================
// 1. CLI simulate pipeline
// =====================================================================

describe('E2E: simulate', () => {
  it('2-player simulation produces valid JSON', () => {
    const { stdout, exitCode } = runCli([
      'simulate', '--strategies', 'random,random',
      '--games', '10', '--seed', 'e2e-seed-2p', '--format', 'json',
    ]);
    expect(exitCode).toBe(0);

    const data = JSON.parse(stdout);
    expect(data.gamesPlayed).toBe(10);
    expect(data.strategies).toEqual(['random', 'random']);
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results[0].winRate).toBeGreaterThanOrEqual(0);
    expect(data.results[0].winRate).toBeLessThanOrEqual(1);
  });

  it('5-player simulation produces valid results', () => {
    const strats = 'random,random,random,random,random';
    const { stdout, exitCode } = runCli([
      'simulate', '--strategies', strats,
      '--games', '10', '--seed', 'e2e-seed-5p', '--format', 'json',
    ]);
    expect(exitCode).toBe(0);

    const data = JSON.parse(stdout);
    expect(data.gamesPlayed).toBe(10);
    expect(data.strategies).toHaveLength(5);
    expect(data.results.length).toBeGreaterThan(0);

    for (const row of data.results) {
      expect(row.avgScore).toBeGreaterThanOrEqual(0);
      expect(row.wins).toBeGreaterThanOrEqual(0);
    }
  });

  it('10-player simulation produces valid results', () => {
    const strats = Array(10).fill('random').join(',');
    const { stdout, exitCode } = runCli([
      'simulate', '--strategies', strats,
      '--games', '5', '--seed', 'e2e-seed-10p', '--format', 'json',
    ]);
    expect(exitCode).toBe(0);

    const data = JSON.parse(stdout);
    expect(data.gamesPlayed).toBe(5);
    expect(data.strategies).toHaveLength(10);
    expect(data.results.length).toBeGreaterThan(0);
  });

  it('seeded replay produces identical output', () => {
    const args = [
      'simulate', '--strategies', 'random,random,random',
      '--games', '5', '--seed', 'replay-seed', '--format', 'json',
    ];
    const r1 = runCli(args);
    const r2 = runCli(args);
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);

    const d1 = JSON.parse(r1.stdout);
    const d2 = JSON.parse(r2.stdout);
    // Exclude meta (timestamps, duration)
    delete d1.meta;
    delete d2.meta;
    expect(d1).toEqual(d2);
  });

  it('table format produces non-empty output', () => {
    const { stdout, exitCode } = runCli([
      'simulate', '--strategies', 'random,random',
      '--games', '3', '--seed', 'table-fmt', '--format', 'table',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    // Table format should contain strategy name
    expect(stdout).toContain('random');
  });

  it('csv format produces valid CSV', () => {
    const { stdout, exitCode } = runCli([
      'simulate', '--strategies', 'random,random',
      '--games', '3', '--seed', 'csv-fmt', '--format', 'csv',
    ]);
    expect(exitCode).toBe(0);

    const lines = stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2); // header + data
    // CSV header should contain column names
    const header = lines[0].toLowerCase();
    expect(header).toContain('strategy');
  });

  it('1000 games completes within 30s', () => {
    const start = Date.now();
    const { exitCode } = runCli(
      [
        'simulate', '--strategies', 'random,random,random,random,random',
        '--games', '1000', '--seed', 'perf-seed', '--format', 'json',
      ],
      { timeout: 30_000 },
    );
    expect(exitCode).toBe(0);
    expect(Date.now() - start).toBeLessThan(30_000);
  });
}, { timeout: 60_000 });

// =====================================================================
// 2. CLI error scenarios
// =====================================================================

describe('E2E: errors', () => {
  it('invalid strategy returns INVALID_STRATEGY', () => {
    const { stdout, exitCode } = runCli([
      'simulate', '--strategies', 'nonexistent,random', '--format', 'json',
    ]);
    expect(exitCode).toBe(1);

    const data = JSON.parse(stdout);
    expect(data.error).toBe(true);
    expect(data.code).toBe('INVALID_STRATEGY');
  });

  it('single player returns INVALID_PLAYER_COUNT', () => {
    const { stdout, exitCode } = runCli([
      'simulate', '--strategies', 'random', '--format', 'json',
    ]);
    expect(exitCode).toBe(1);

    const data = JSON.parse(stdout);
    expect(data.error).toBe(true);
    expect(data.code).toBe('INVALID_PLAYER_COUNT');
  });

  it('11 players returns INVALID_PLAYER_COUNT', () => {
    const strats = Array(11).fill('random').join(',');
    const { stdout, exitCode } = runCli([
      'simulate', '--strategies', strats, '--format', 'json',
    ]);
    expect(exitCode).toBe(1);

    const data = JSON.parse(stdout);
    expect(data.error).toBe(true);
    expect(data.code).toBe('INVALID_PLAYER_COUNT');
  });

  it('unsupported format returns INVALID_FORMAT', () => {
    const { stdout, stderr, exitCode } = runCli([
      'simulate', '--strategies', 'random,random', '--format', 'xml',
    ]);
    expect(exitCode).toBe(1);
    const output = stdout + stderr;
    expect(output).toContain('INVALID_FORMAT');
  });
}, { timeout: 30_000 });

// =====================================================================
// 3. CLI recommend
// =====================================================================

describe('E2E: recommend', () => {
  it('card recommendation from state file', () => {
    const stateFile = writeTempState('_e2e_card_state.json', cardState);

    const { stdout, exitCode } = runCli([
      'recommend', '--state-file', stateFile, '--strategy', 'random', '--format', 'json',
    ]);
    expect(exitCode).toBe(0);

    const data = JSON.parse(stdout);
    expect(data.decision).toBe('card');
    expect(data.strategy).toBe('random');
    expect(cardState.hand).toContain(data.recommendation.card);
    expect(data.stateValid).toBe(true);
  });

  it('row recommendation from state file', () => {
    const stateFile = writeTempState('_e2e_row_state.json', rowState);

    const { stdout, exitCode } = runCli([
      'recommend', '--state-file', stateFile, '--strategy', 'random',
      '--decision', 'row', '--format', 'json',
    ]);
    expect(exitCode).toBe(0);

    const data = JSON.parse(stdout);
    expect(data.decision).toBe('row');
    expect(data.recommendation.rowIndex).toBeGreaterThanOrEqual(0);
    expect(data.recommendation.rowIndex).toBeLessThanOrEqual(3);
  });

  it('INVALID_STATE with incomplete state', () => {
    const badState = { hand: [1, 2, 3] };
    const stateFile = writeTempState('_e2e_bad_state.json', badState);

    const { stdout, exitCode } = runCli([
      'recommend', '--state-file', stateFile, '--strategy', 'random', '--format', 'json',
    ]);
    expect(exitCode).toBe(1);

    const data = JSON.parse(stdout);
    expect(data.error).toBe(true);
    expect(data.code).toBe('INVALID_STATE');
  });
}, { timeout: 60_000 });

// =====================================================================
// 4. CLI play command
// =====================================================================

describe('E2E: play', () => {
  it('outputs complete game trace with rounds and rankings', () => {
    const { stdout, exitCode } = runCli([
      'play', '--strategies', 'random,random', '--seed', 'play-seed', '--format', 'json',
    ]);
    expect(exitCode).toBe(0);

    const data = JSON.parse(stdout);
    expect(data.rounds.length).toBeGreaterThan(0);
    expect(data.finalResults).toHaveLength(2);
    expect(data.finalResults[0].rank).toBe(1);
    expect(typeof data.finalResults[0].finalScore).toBe('number');
    expect(typeof data.finalResults[0].strategy).toBe('string');

    // Verify round structure
    const round = data.rounds[0];
    expect(round.round).toBe(1);
    expect(round.turns.length).toBeGreaterThan(0);
  });

  it('3-player game completes correctly', () => {
    const { stdout, exitCode } = runCli([
      'play', '--strategies', 'random,random,random', '--seed', 'play-3p', '--format', 'json',
    ]);
    expect(exitCode).toBe(0);

    const data = JSON.parse(stdout);
    expect(data.finalResults).toHaveLength(3);

    // Rankings should be 1, 2, 3
    const ranks = data.finalResults.map((r: { rank: number }) => r.rank).sort();
    expect(ranks).toEqual([1, 2, 3]);
  });

  it('seeded play is deterministic', () => {
    const args = [
      'play', '--strategies', 'random,random', '--seed', 'play-det', '--format', 'json',
    ];
    const r1 = JSON.parse(runCli(args).stdout);
    const r2 = JSON.parse(runCli(args).stdout);

    delete r1.meta;
    delete r2.meta;
    expect(r1).toEqual(r2);
  });
}, { timeout: 60_000 });

// =====================================================================
// 5. CLI strategies command
// =====================================================================

describe('E2E: strategies', () => {
  it('lists available strategies in JSON', () => {
    const { stdout, exitCode } = runCli(['strategies', '--format', 'json']);
    expect(exitCode).toBe(0);

    const data = JSON.parse(stdout);
    expect(Array.isArray(data.strategies)).toBe(true);
    expect(data.strategies.length).toBeGreaterThan(0);

    const names = data.strategies.map((s: { name: string }) => s.name);
    expect(names).toContain('random');
  });

  it('CLI strategies match MCP listStrategies', () => {
    const { stdout, exitCode } = runCli(['strategies', '--format', 'json']);
    expect(exitCode).toBe(0);

    const cliData = JSON.parse(stdout);
    const mcpData = listStrategies();

    const cliNames = cliData.strategies.map((s: { name: string }) => s.name).sort();
    const mcpNames = mcpData.strategies.map(s => s.name).sort();
    expect(cliNames).toEqual(mcpNames);
  });
}, { timeout: 30_000 });

// =====================================================================
// 6. MCP full lifecycle
// =====================================================================

describe('E2E: MCP full lifecycle', () => {
  it('full session lifecycle completes', () => {
    const mgr = new SessionManager(4);

    // Start session
    const start = mgr.startSession({
      strategy: 'random',
      playerCount: 2,
      playerId: 'p0',
      seed: 'e2e-mcp',
    });
    expect(isDomainError(start)).toBe(false);
    const { sessionId } = start as { sessionId: string; sessionVersion: number };
    let version = (start as { sessionVersion: number }).sessionVersion;

    // Round started
    const rs = mgr.roundStarted({
      sessionId,
      expectedVersion: version,
      round: 1,
      board: [[1], [2], [3], [4]],
      hand: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
    });
    expect(isDomainError(rs)).toBe(false);
    expect(rs).toHaveProperty('accepted', true);
    version = (rs as { sessionVersion: number }).sessionVersion;

    // Session recommend (card)
    const rec = mgr.sessionRecommend({
      sessionId,
      hand: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      board: [[1], [2], [3], [4]],
    });
    expect(isDomainError(rec)).toBe(false);
    expect(rec).toHaveProperty('decision', 'card');
    const recCard = (rec as { recommendation: { card: number } }).recommendation.card;
    expect([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]).toContain(recCard);

    // Resolve all ten turns with a legal single-row progression.
    let board = [[1], [2], [3], [4]];
    for (let turn = 1; turn <= 10; turn++) {
      const card = turn * 10;
      const opponentCard = card + 1;
      const firstOverflow = board[3].length === 5;
      const firstCollected = firstOverflow ? [...board[3]] : undefined;
      board[3] = firstOverflow ? [card] : [...board[3], card];
      const secondOverflow = board[3].length === 5;
      const secondCollected = secondOverflow ? [...board[3]] : undefined;
      board[3] = secondOverflow ? [opponentCard] : [...board[3], opponentCard];
      const tr = mgr.turnResolved({
        sessionId,
        expectedVersion: version,
        round: 1,
        turn,
        plays: [{ playerId: 'p0', card }, { playerId: 'p1', card: opponentCard }],
        resolutions: [
          { playerId: 'p0', card, rowIndex: 3, causedOverflow: firstOverflow, ...(firstCollected ? { collectedCards: firstCollected } : {}) },
          { playerId: 'p1', card: opponentCard, rowIndex: 3, causedOverflow: secondOverflow, ...(secondCollected ? { collectedCards: secondCollected } : {}) },
        ],
        boardAfter: board,
      });
      expect(isDomainError(tr)).toBe(false);
      expect(tr).toHaveProperty('accepted', true);
      version = (tr as { sessionVersion: number }).sessionVersion;
    }

    // Round ended
    const re = mgr.roundEnded({
      sessionId,
      expectedVersion: version,
      round: 1,
      scores: [
        { playerId: 'p0', score: 5 },
        { playerId: 'p1', score: 3 },
      ],
    });
    expect(isDomainError(re)).toBe(false);
    version = (re as { sessionVersion: number }).sessionVersion;

    // End session
    const end = mgr.endSession({ sessionId });
    expect(isDomainError(end)).toBe(false);
    expect(end).toHaveProperty('ended', true);
  });

  it('session_status returns correct state', () => {
    const mgr = new SessionManager(4);

    const start = mgr.startSession({
      strategy: 'random',
      playerCount: 3,
      playerId: 'hero',
      seed: 'status-test',
    });
    expect(isDomainError(start)).toBe(false);
    const { sessionId, sessionVersion } = start as { sessionId: string; sessionVersion: number };

    // Check status before round
    const status1 = mgr.sessionStatus({ sessionId });
    expect(isDomainError(status1)).toBe(false);
    expect(status1).toHaveProperty('phase', 'awaiting-round');
    expect(status1).toHaveProperty('strategy', 'random');
    expect(status1).toHaveProperty('playerId', 'hero');
    expect(status1).toHaveProperty('playerCount', 3);

    // Start round and check again
    mgr.roundStarted({
      sessionId,
      expectedVersion: sessionVersion,
      round: 1,
      board: [[5], [15], [25], [35]],
      hand: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
    });

    const status2 = mgr.sessionStatus({ sessionId });
    expect(isDomainError(status2)).toBe(false);
    expect(status2).toHaveProperty('phase', 'in-round');
    expect(status2).toHaveProperty('round', 1);

    mgr.endSession({ sessionId });
  });

  it('drift recovery: resync after STATE_MISMATCH', () => {
    const mgr = new SessionManager(4);
    const start = mgr.startSession({
      strategy: 'random',
      playerCount: 2,
      playerId: 'p0',
      seed: 'drift-test',
    }) as { sessionId: string; sessionVersion: number };
    const { sessionId } = start;

    mgr.roundStarted({
      sessionId,
      expectedVersion: start.sessionVersion,
      round: 1,
      board: [[5], [15], [25], [35]],
      hand: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
    });

    // Try recommend with a totally different board to trigger drift
    const rec = mgr.sessionRecommend({
      sessionId,
      hand: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      board: [[99, 98, 97, 96, 95], [94, 93, 92], [91, 90], [89]],
    });

    if (isDomainError(rec) && rec.code === 'STATE_MISMATCH') {
      // Resync with turn >= 1 so phase is 'in-round' (turn 0 → awaiting-round)
      const resync = mgr.resyncSession({
        sessionId,
        round: 1,
        turn: 1,
        board: [[5], [15], [25], [35]],
        hand: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
        scores: [
          { playerId: 'p0', score: 0 },
          { playerId: 'p1', score: 0 },
        ],
      });
      expect(isDomainError(resync)).toBe(false);
      expect(resync).toHaveProperty('resynced', true);
      expect(resync).toHaveProperty('phase', 'in-round');

      // Recommend now works
      const rec2 = mgr.sessionRecommend({
        sessionId,
        hand: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
        board: [[5], [15], [25], [35]],
      });
      expect(isDomainError(rec2)).toBe(false);
      expect(rec2).toHaveProperty('decision', 'card');
    } else {
      // Minor drift just produces a warning — recommendation still works
      expect(isDomainError(rec)).toBe(false);
      expect(rec).toHaveProperty('decision', 'card');
    }

    mgr.endSession({ sessionId });
  });

  it('VERSION_MISMATCH returns recoverable error', () => {
    const mgr = new SessionManager(4);
    const start = mgr.startSession({
      strategy: 'random',
      playerCount: 2,
      playerId: 'p0',
      seed: 'version-test',
    }) as { sessionId: string; sessionVersion: number };
    const { sessionId } = start;

    // Use wrong version
    const result = mgr.roundStarted({
      sessionId,
      expectedVersion: 999,
      round: 1,
      board: [[5], [15], [25], [35]],
      hand: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
    });

    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('VERSION_MISMATCH');
    expect((result as DomainError).recoverable).toBe(true);

    mgr.endSession({ sessionId });
  });

  it('UNKNOWN_SESSION for invalid sessionId', () => {
    const mgr = new SessionManager(4);
    const result = mgr.sessionStatus({ sessionId: 'nonexistent-id' });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('UNKNOWN_SESSION');
  });

  it('MAX_SESSIONS_REACHED when limit exceeded', () => {
    const mgr = new SessionManager(2); // limit of 2

    const s1 = mgr.startSession({ strategy: 'random', playerCount: 2, playerId: 'p0', seed: 'a' });
    expect(isDomainError(s1)).toBe(false);

    const s2 = mgr.startSession({ strategy: 'random', playerCount: 2, playerId: 'p0', seed: 'b' });
    expect(isDomainError(s2)).toBe(false);

    const s3 = mgr.startSession({ strategy: 'random', playerCount: 2, playerId: 'p0', seed: 'c' });
    expect(isDomainError(s3)).toBe(true);
    expect((s3 as DomainError).code).toBe('MAX_SESSIONS_REACHED');

    // Clean up
    mgr.endSession({ sessionId: (s1 as { sessionId: string }).sessionId });
    mgr.endSession({ sessionId: (s2 as { sessionId: string }).sessionId });
  });
});

// =====================================================================
// 7. MCP stateless tools
// =====================================================================

describe('E2E: MCP stateless', () => {
  it('recommendOnce card decision returns valid card', () => {
    const result = recommendOnce({
      state: cardState as Record<string, unknown>,
      strategy: 'random',
    });
    expect(isDomainError(result)).toBe(false);

    const rec = result as { decision: string; recommendation: { card: number } };
    expect(rec.decision).toBe('card');
    expect(cardState.hand).toContain(rec.recommendation.card);
  });

  it('recommendOnce row decision returns valid row index', () => {
    const result = recommendOnce({
      state: rowState as Record<string, unknown>,
      strategy: 'random',
      decision: 'row',
    });
    expect(isDomainError(result)).toBe(false);

    const rec = result as { decision: string; recommendation: { rowIndex: number } };
    expect(rec.decision).toBe('row');
    expect(rec.recommendation.rowIndex).toBeGreaterThanOrEqual(0);
    expect(rec.recommendation.rowIndex).toBeLessThanOrEqual(3);
  });

  it('INVALID_STRATEGY for unknown strategy', () => {
    const result = recommendOnce({
      state: cardState as Record<string, unknown>,
      strategy: 'nonexistent',
    });
    expect(isDomainError(result)).toBe(true);
    expect((result as DomainError).code).toBe('INVALID_STRATEGY');
  });
});

// =====================================================================
// 8. CLI/MCP consistency
// =====================================================================

describe('E2E: CLI/MCP consistency', () => {
  it('both produce valid recommendations from same state', () => {
    // CLI recommend
    const stateFile = writeTempState('_e2e_consistency.json', cardState);
    const { stdout, exitCode } = runCli([
      'recommend', '--state-file', stateFile, '--strategy', 'random', '--format', 'json',
    ]);
    expect(exitCode).toBe(0);
    const cliResult = JSON.parse(stdout);

    // MCP recommend_once
    const mcpResult = recommendOnce({
      state: cardState as Record<string, unknown>,
      strategy: 'random',
    });
    expect(isDomainError(mcpResult)).toBe(false);

    const mcpRec = mcpResult as { recommendation: { card: number } };

    // Both should return valid cards from the hand
    expect(cardState.hand).toContain(cliResult.recommendation.card);
    expect(cardState.hand).toContain(mcpRec.recommendation.card);

    // Both should report card decision
    expect(cliResult.decision).toBe('card');
    expect((mcpResult as { decision: string }).decision).toBe('card');
  });

  it('simulate and play agree on game rules (scores are non-negative)', () => {
    // Simulate: all scores should be >= 0
    const simResult = runCli([
      'simulate', '--strategies', 'random,random', '--games', '10',
      '--seed', 'consistency-sim', '--format', 'json',
    ]);
    expect(simResult.exitCode).toBe(0);
    const simData = JSON.parse(simResult.stdout);

    for (const row of simData.results) {
      expect(row.avgScore).toBeGreaterThanOrEqual(0);
      expect(row.minScore).toBeGreaterThanOrEqual(0);
    }

    // Play: final scores should be >= 0
    const playResult = runCli([
      'play', '--strategies', 'random,random', '--seed', 'consistency-play', '--format', 'json',
    ]);
    expect(playResult.exitCode).toBe(0);
    const playData = JSON.parse(playResult.stdout);

    for (const r of playData.finalResults) {
      expect(r.finalScore).toBeGreaterThanOrEqual(0);
    }
  });
}, { timeout: 60_000 });
