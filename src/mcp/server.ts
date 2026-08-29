/**
 * MCP server for 6 Nimmt! advisory services.
 * Uses the low-level Server API for full control over tool registration.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { listStrategies, validateState, recommendOnce } from './tools/stateless.js';
import { SessionManager } from './session.js';
import { notImplemented, type DomainError } from './errors.js';

// ── Tool definitions ────────────────────────────────────────────────

const ALL_TOOL_NAMES = [
  'server_info',
  'list_strategies',
  'validate_state',
  'recommend_once',
  'start_session',
  'round_started',
  'turn_resolved',
  'round_ended',
  'session_recommend',
  'resync_session',
  'session_status',
  'end_session',
] as const;

const TOOL_DEFINITIONS = [
  {
    name: 'server_info',
    description: 'Returns server metadata, supported tools, and capabilities.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_strategies',
    description: 'Lists all available 6 Nimmt! strategies with descriptions and valid player count range.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'validate_state',
    description: 'Validates a game state object for use with recommendation tools. Auto-detects card vs row decision.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        state: { type: 'object' as const, description: 'Game state to validate' },
        decision: { type: 'string' as const, enum: ['card', 'row'], description: 'Decision type (auto-detected if omitted)' },
      },
      required: ['state'],
    },
  },
  {
    name: 'recommend_once',
    description: 'Gets a one-shot move recommendation from a strategy given a game state. Stateless — no session needed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        state: { type: 'object' as const, description: 'Game state for recommendation' },
        strategy: { type: 'string' as const, description: 'Strategy name to use' },
        strategyOptions: { type: 'object' as const, description: 'Strategy-specific options (e.g. { mcPerCard: 100 } for mcs)' },
        decision: { type: 'string' as const, enum: ['card', 'row'], description: 'Decision type (auto-detected if omitted)' },
        timeout: { type: 'number' as const, description: 'Timeout in milliseconds' },
      },
      required: ['state', 'strategy'],
    },
  },
  {
    name: 'start_session',
    description: 'Starts a new advisory session with a strategy, player count, and player ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        strategy: { type: 'string' as const, description: 'Strategy name' },
        playerCount: { type: 'number' as const, description: 'Number of players (2–10)' },
        playerId: { type: 'string' as const, description: 'Player ID for this session' },
        seatIndex: { type: 'number' as const, description: 'Seat index (optional)' },
        seed: { type: 'string' as const, description: 'RNG seed (optional)' },
        strategyOptions: { type: 'object' as const, description: 'Strategy-specific options (e.g. { mcPerCard: 100 } for mcs)' },
      },
      required: ['strategy', 'playerCount', 'playerId'],
    },
  },
  {
    name: 'round_started',
    description: 'Notifies the session that a new round has started with the given board and hand. Board accepts { "0": [...], "1": [...], "2": [...], "3": [...] } or { "rows": [[...], ...] }.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string' as const },
        expectedVersion: { type: 'number' as const },
        round: { type: 'number' as const },
        board: { type: 'object' as const },
        hand: { type: 'array' as const, items: { type: 'number' as const } },
      },
      required: ['sessionId', 'expectedVersion', 'round', 'board', 'hand'],
    },
  },
  {
    name: 'turn_resolved',
    description: 'Notifies the session that a turn has been resolved.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string' as const },
        expectedVersion: { type: 'number' as const },
        round: { type: 'number' as const },
        turn: { type: 'number' as const },
        plays: { type: 'array' as const, items: { type: 'object' as const } },
        resolutions: { type: 'array' as const, items: { type: 'object' as const } },
        rowPicks: { type: 'array' as const, items: { type: 'object' as const } },
        boardAfter: { type: 'object' as const },
      },
      required: ['sessionId', 'expectedVersion', 'round', 'turn', 'plays', 'resolutions'],
    },
  },
  {
    name: 'round_ended',
    description: 'Notifies the session that a round has ended with the given scores.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string' as const },
        expectedVersion: { type: 'number' as const },
        round: { type: 'number' as const },
        scores: { type: 'object' as const },
      },
      required: ['sessionId', 'expectedVersion', 'round', 'scores'],
    },
  },
  {
    name: 'session_recommend',
    description: 'Gets a move recommendation from the session strategy, using session state for context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string' as const },
        hand: { type: 'array' as const, items: { type: 'number' as const } },
        board: { type: 'object' as const },
        decision: { type: 'string' as const, enum: ['card', 'row'] },
        timeout: { type: 'number' as const },
        triggeringCard: { type: 'number' as const },
        revealedThisTurn: { type: 'array' as const, items: { type: 'object' as const } },
        resolutionIndex: { type: 'number' as const },
      },
      required: ['sessionId', 'hand', 'board'],
    },
  },
  {
    name: 'resync_session',
    description: 'Resyncs a session with the current game state, recovering from state drift.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string' as const },
        round: { type: 'number' as const },
        turn: { type: 'number' as const },
        board: { type: 'object' as const },
        hand: { type: 'array' as const, items: { type: 'number' as const } },
        scores: { type: 'object' as const },
        turnHistory: { type: 'array' as const, items: { type: 'object' as const } },
      },
      required: ['sessionId', 'round', 'turn', 'board', 'hand', 'scores'],
    },
  },
  {
    name: 'session_status',
    description: 'Returns the current status and metadata for a session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string' as const },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'end_session',
    description: 'Ends and cleans up an advisory session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string' as const },
      },
      required: ['sessionId'],
    },
  },
];

// ── Tool result helpers ─────────────────────────────────────────────

function toolResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function toolError(error: DomainError) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
}

// ── Result helper ───────────────────────────────────────────────────

function resultOrError(result: object | DomainError) {
  if ('ok' in result && (result as DomainError).ok === false) {
    return toolError(result as DomainError);
  }
  return toolResult(result);
}

// ── Server creation ─────────────────────────────────────────────────

export interface ServerConfig {
  logLevel?: string;
  maxSessions?: number;
}

export function createServer(config: ServerConfig = {}) {
  const maxSessions = config.maxSessions ?? 4;
  const sessionManager = new SessionManager(maxSessions);

  const server = new Server(
    { name: '6nimmt', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'server_info':
        return toolResult({
          name: '6nimmt',
          version: '1.0.0',
          tools: [...ALL_TOOL_NAMES],
          sessionSupport: true,
          maxConcurrentSessions: maxSessions,
        });

      case 'list_strategies':
        return toolResult(listStrategies());

      case 'validate_state':
        return toolResult(validateState({
          state: (args?.state as Record<string, unknown>) ?? {},
          decision: args?.decision as 'card' | 'row' | undefined,
        }));

      case 'recommend_once': {
        const result = recommendOnce({
          state: (args?.state as Record<string, unknown>) ?? {},
          strategy: (args?.strategy as string) ?? '',
          strategyOptions: args?.strategyOptions as Record<string, unknown> | undefined,
          decision: args?.decision as 'card' | 'row' | undefined,
          timeout: args?.timeout as number | undefined,
        });
        if ('ok' in result && result.ok === false) {
          return toolError(result as DomainError);
        }
        return toolResult(result);
      }

      case 'start_session':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return resultOrError(sessionManager.startSession(args as any));

      case 'round_started':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return resultOrError(sessionManager.roundStarted(args as any));

      case 'turn_resolved':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return resultOrError(sessionManager.turnResolved(args as any));

      case 'round_ended':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return resultOrError(sessionManager.roundEnded(args as any));

      case 'session_recommend':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return resultOrError(sessionManager.sessionRecommend(args as any));

      case 'resync_session':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return resultOrError(sessionManager.resyncSession(args as any));

      case 'session_status':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return resultOrError(sessionManager.sessionStatus(args as any));

      case 'end_session':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return resultOrError(sessionManager.endSession(args as any));

      default:
        return toolError(notImplemented(name));
    }
  });

  return server;
}

export async function startServer(config: ServerConfig = {}): Promise<void> {
  const server = createServer(config);
  const transport = new StdioServerTransport();

  console.error(`6nimmt MCP server starting (log-level: ${config.logLevel ?? 'warn'}, max-sessions: ${config.maxSessions ?? 4})...`);

  await server.connect(transport);

  console.error('6nimmt MCP server running on stdio.');
}
