/**
 * Stateless MCP tools — no session state required.
 */

import type { CardChoiceState, RowChoiceState } from '../../engine/types.js';
import type { TurnResolution } from '../../engine/strategies/types.js';
import { strategies, deriveSeedState, xoshiro256ss, cattleHeads, validateCardChoiceState, validateRowChoiceState } from '../../engine/index.js';
import { invalidStrategy, invalidState, engineError, type DomainError } from '../errors.js';

// ── Strategy descriptions (mirrors CLI strategies command) ──────────

const strategyDescriptions: Record<string, string> = {
  random: 'Picks a card uniformly at random. Baseline strategy.',
  'dummy-min': 'Always plays the lowest card in hand.',
  'dummy-max': 'Always plays the highest card in hand.',
  'bayesian-simple': 'Expected-penalty minimisation over unseen card distribution.',
  mcs: 'Monte Carlo Simulation. Options: mcPerCard (default 50), mcMax (default 10×mcPerCard), scoring ("self"|"relative").',
  'mcs-prior': 'MCS + prior-based heuristic + opponent modeling. Strongest. Options: mcPerCard (100), timingWeight (0.3), trappedDiscount (0.3), opponentModel ("prior"|"uniform").',
};

// ── list_strategies ─────────────────────────────────────────────────

export interface ListStrategiesResult {
  strategies: { name: string; description: string }[];
  playerCountRange: { min: number; max: number };
}

export function listStrategies(): ListStrategiesResult {
  const stratList = [...strategies.keys()].map((name) => ({
    name,
    description: strategyDescriptions[name] ?? 'No description available.',
  }));

  return {
    strategies: stratList,
    playerCountRange: { min: 2, max: 10 },
  };
}

// ── validate_state ──────────────────────────────────────────────────

export interface ValidateStateParams {
  state: Record<string, unknown>;
  decision?: 'card' | 'row';
}

export interface ValidateStateResult {
  valid: boolean;
  decision: 'card' | 'row';
  warnings: string[];
  errors: string[];
}

const CARD_CHOICE_REQUIRED = ['hand', 'board', 'playerScores', 'playerCount', 'round', 'turn', 'turnHistory', 'initialBoardCards'];
const ROW_CHOICE_REQUIRED = ['board', 'triggeringCard', 'revealedThisTurn', 'resolutionIndex', 'hand', 'playerScores', 'playerCount', 'round', 'turn', 'turnHistory'];

export function validateState(params: ValidateStateParams): ValidateStateResult {
  const { state } = params;
  const decision: 'card' | 'row' = params.decision ?? ('triggeringCard' in state ? 'row' : 'card');

  const errors: string[] = [];
  const warnings: string[] = [];

  // Check required fields
  const required = decision === 'card' ? CARD_CHOICE_REQUIRED : ROW_CHOICE_REQUIRED;
  const missing = required.filter((f) => !(f in state));
  if (missing.length > 0) {
    errors.push(`Missing required fields: ${missing.join(', ')}`);
  }

  // Validate card ranges in hand
  const hand = state.hand as number[] | undefined;
  if (hand && Array.isArray(hand)) {
    for (const c of hand) {
      if (typeof c !== 'number' || c < 1 || c > 104) {
        errors.push(`Card ${c} is outside valid range 1–104.`);
      }
    }
    if (hand.length === 0) {
      warnings.push('Hand is empty.');
    }
  }

  // Validate board structure (4 rows)
  // Accepts { rows: [...] } or { "0": [...], "1": [...], "2": [...], "3": [...] }
  const boardRaw = state.board as Record<string, unknown> | undefined;
  let rows: unknown[] | undefined;
  if (boardRaw && typeof boardRaw === 'object') {
    if (Array.isArray(boardRaw.rows)) {
      rows = boardRaw.rows;
    } else if ('0' in boardRaw && '1' in boardRaw && '2' in boardRaw && '3' in boardRaw) {
      const r = [boardRaw['0'], boardRaw['1'], boardRaw['2'], boardRaw['3']];
      if (r.every(x => Array.isArray(x))) {
        rows = r;
        // Normalize state.board to { rows } for downstream use
        (state as Record<string, unknown>).board = { rows };
      }
    }
    if (!rows) {
      errors.push('Board must have a "rows" array or keys "0","1","2","3".');
    } else {
      if (rows.length !== 4) {
        errors.push(`Board must have exactly 4 rows, got ${rows.length}.`);
      }
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!Array.isArray(row)) {
          errors.push(`Board row ${i} must be an array.`);
          continue;
        }
        if (row.length === 0) {
          errors.push(`Board row ${i} is empty.`);
        }
        for (const c of row) {
          if (typeof c !== 'number' || c < 1 || c > 104) {
            errors.push(`Board row ${i} has card ${c} outside valid range 1–104.`);
          }
        }
      }
    }
  }

  // Validate triggeringCard for row decisions
  if (decision === 'row') {
    const tc = state.triggeringCard;
    if (tc !== undefined && (typeof tc !== 'number' || tc < 1 || tc > 104)) {
      errors.push(`triggeringCard ${tc} is outside valid range 1–104.`);
    }
  }

  if (errors.length === 0 && Array.isArray(state.playerScores) && rows) {
    const result = decision === 'card'
      ? validateCardChoiceState(state as unknown as CardChoiceState)
      : validateRowChoiceState(state as unknown as RowChoiceState);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  // Duplicate detection: hand vs board
  if (hand && Array.isArray(hand) && rows && Array.isArray(rows)) {
    const boardCards = new Set((rows as unknown[][]).flat());
    for (const c of hand) {
      if (boardCards.has(c)) {
        warnings.push(`Card ${c} appears in both hand and board.`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    decision,
    warnings,
    errors,
  };
}

// ── recommend_once ──────────────────────────────────────────────────

export interface RecommendOnceParams {
  state: Record<string, unknown>;
  strategy: string;
  strategyOptions?: Record<string, unknown>;
  decision?: 'card' | 'row';
  timeout?: number;
}

export interface RecommendOnceResult {
  ok: true;
  decision: 'card' | 'row';
  strategy: string;
  recommendation: {
    card?: number;
    rowIndex?: number;
    confidence: number | null;
    alternatives: unknown[];
  };
  stateValid: boolean;
  stateWarnings: string[];
}

export function recommendOnce(params: RecommendOnceParams): RecommendOnceResult | DomainError {
  const { state, strategy: strategyName } = params;

  // Validate strategy
  if (!strategies.has(strategyName)) {
    return invalidStrategy(strategyName, [...strategies.keys()]);
  }

  // Detect decision type
  const decision: 'card' | 'row' = params.decision ?? ('triggeringCard' in state ? 'row' : 'card');

  // Validate state
  const validation = validateState({ state, decision });

  if (!validation.valid) {
    return invalidState(`State validation failed: ${validation.errors.join('; ')}`, {
      errors: validation.errors,
      warnings: validation.warnings,
    });
  }

  // Instantiate strategy
  const strat = strategies.get(strategyName)!(params.strategyOptions);
  const playerCount = (state.playerCount as number) ?? 2;
  const seedStr = 'recommend/' + ((state as Record<string, unknown>).playerId ?? 'recommend-player');
  const rngState = deriveSeedState(seedStr);
  strat.onGameStart?.({
    playerId: (state as Record<string, unknown>).playerId as string ?? 'recommend-player',
    playerCount,
    rng: () => Number(xoshiro256ss(rngState) >> 11n) / 2 ** 53,
  });

  // Replay turn history
  const turnHistory = (state.turnHistory as TurnResolution[]) ?? [];
  for (const entry of turnHistory) {
    try {
      strat.onTurnResolved?.(entry);
    } catch {
      // non-fatal
    }
  }

  try {
    if (decision === 'card') {
      const cardState = state as unknown as CardChoiceState;
      const card = strat.chooseCard(cardState);

      return {
        ok: true,
        decision: 'card',
        strategy: strategyName,
        recommendation: { card: card as number, confidence: null, alternatives: [] },
        stateValid: true,
        stateWarnings: validation.warnings,
      };
    } else {
      const rowState = state as unknown as RowChoiceState;
      const row = strat.chooseRow(rowState);

      return {
        ok: true,
        decision: 'row',
        strategy: strategyName,
        recommendation: { rowIndex: row as number, confidence: null, alternatives: [] },
        stateValid: true,
        stateWarnings: validation.warnings,
      };
    }
  } catch (err) {
    // Fallback: lowest card / fewest-heads row
    try {
      if (decision === 'card') {
        const hand = (state.hand as number[]) ?? [];
        if (hand.length === 0) {
          return invalidState('Cannot recommend a card: hand is empty.');
        }
        const fallbackCard = Math.min(...hand);
        return {
          ok: true,
          decision: 'card',
          strategy: strategyName,
          recommendation: { card: fallbackCard, confidence: null, alternatives: [] },
          stateValid: true,
          stateWarnings: [...validation.warnings, `Strategy error, fell back to lowest card: ${(err as Error).message}`],
        };
      } else {
        const board = state.board as { rows: number[][] };
        let bestRow = 0;
        let bestHeads = Infinity;
        for (let i = 0; i < board.rows.length; i++) {
          const heads = board.rows[i].reduce((sum, c) => sum + cattleHeads(c), 0);
          if (heads < bestHeads) {
            bestHeads = heads;
            bestRow = i;
          }
        }
        return {
          ok: true,
          decision: 'row',
          strategy: strategyName,
          recommendation: { rowIndex: bestRow, confidence: null, alternatives: [] },
          stateValid: true,
          stateWarnings: [...validation.warnings, `Strategy error, fell back to fewest-heads row: ${(err as Error).message}`],
        };
      }
    } catch {
      return engineError(`Strategy error with no fallback: ${(err as Error).message}`);
    }
  }
}
