import type { CardChoiceState, RowChoiceState, Board } from './types';
import { isValidCardNumber } from './card';

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

function boardRows(board: unknown): unknown[][] | undefined {
  if (Array.isArray(board)) return board as unknown[][];
  if (board && typeof board === 'object' && Array.isArray((board as { rows?: unknown }).rows)) return (board as { rows: unknown[][] }).rows;
  return undefined;
}

function validateBase(state: CardChoiceState | RowChoiceState, rowDecision: boolean): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rows = boardRows(state.board);
  if (!rows || rows.length !== 4) errors.push('Board must have exactly 4 rows.');
  const cards: number[] = [];
  for (const [i, row] of (rows ?? []).entries()) {
    if (!Array.isArray(row) || row.length < 1 || row.length > 5) errors.push(`Board row ${i} must contain 1–5 cards.`);
    if (Array.isArray(row)) {
      for (let j = 0; j < row.length; j++) {
        const card = row[j];
        if (!isValidCardNumber(card as number)) errors.push(`Board row ${i} has invalid card ${card}.`);
        if (j > 0 && (row[j - 1] as number) >= (card as number)) errors.push(`Board row ${i} must be strictly increasing.`);
        cards.push(card as number);
      }
    }
  }
  for (const card of state.hand) {
    if (!isValidCardNumber(card)) errors.push(`Hand has invalid card ${card}.`);
    cards.push(card);
  }
  if (new Set(cards).size !== cards.length) errors.push('Duplicate cards exist across hand and board.');
  if (state.playerCount < 2 || state.playerCount > 10) errors.push('Player count must be 2–10.');
  if (state.round < 1) errors.push('Round must be at least 1.');
  if (state.turn < 1 || state.turn > 10) errors.push('Turn must be 1–10.');
  if (!rowDecision && state.hand.length === 0) errors.push('Hand must be non-empty for card choice.');
  if (rowDecision && !isValidCardNumber((state as RowChoiceState).triggeringCard)) errors.push('Row choice requires a valid triggeringCard.');
  if (state.hand.length !== 11 - state.turn && state.turn <= 10) warnings.push(`Hand size ${state.hand.length} differs from expected ${11 - state.turn}.`);
  return { valid: errors.length === 0, errors, warnings };
}

export function validateCardChoiceState(state: CardChoiceState): ValidationResult { return validateBase(state, false); }
export function validateRowChoiceState(state: RowChoiceState): ValidationResult { return validateBase(state, true); }
export function boardFromJson(rows: unknown): Board {
  const parsed = boardRows(rows);
  if (!parsed || parsed.length !== 4 || parsed.some((r) => !Array.isArray(r))) throw new Error('Invalid board.');
  return { rows: parsed as unknown as Board['rows'] };
}
