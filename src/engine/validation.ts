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

function validateBase(state: unknown, rowDecision: boolean): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!state || typeof state !== 'object') return { valid: false, errors: ['State must be an object.'], warnings };
  const value = state as Partial<CardChoiceState & RowChoiceState>;
  if (!Array.isArray(value.hand)) errors.push('hand must be an array.');
  if (!Array.isArray(value.playerScores) || value.playerScores.some((score) => !score || typeof score !== 'object' || typeof score.id !== 'string' || typeof score.score !== 'number' || typeof score.penaltyThisRound !== 'number')) errors.push('playerScores must be an array of { id, score, penaltyThisRound }.');
  if (!Array.isArray(value.turnHistory)) errors.push('turnHistory must be an array.');
  if (!Array.isArray(value.initialBoardCards) || value.initialBoardCards.length !== 4 || value.initialBoardCards.some((card) => !isValidCardNumber(card))) errors.push('initialBoardCards must contain four valid cards.');
  if (rowDecision && (!Array.isArray(value.revealedThisTurn) || value.revealedThisTurn.some((play) => !play || typeof play.playerId !== 'string' || !isValidCardNumber(play.card)))) errors.push('revealedThisTurn must contain valid public plays.');
  if (rowDecision && (!Number.isInteger(value.resolutionIndex) || (value.resolutionIndex as number) < 0)) errors.push('resolutionIndex must be a non-negative integer.');
  if (!Number.isInteger(value.playerCount) || !Number.isInteger(value.round) || !Number.isInteger(value.turn)) errors.push('playerCount, round, and turn must be integers.');
  const rows = boardRows(value.board);
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
  for (const card of value.hand ?? []) {
    if (!isValidCardNumber(card)) errors.push(`Hand has invalid card ${card}.`);
    cards.push(card);
  }
  if (new Set(cards).size !== cards.length) errors.push('Duplicate cards exist across hand and board.');
  if (typeof value.playerCount === 'number' && (value.playerCount < 2 || value.playerCount > 10)) errors.push('Player count must be 2–10.');
  if (typeof value.round === 'number' && value.round < 1) errors.push('Round must be at least 1.');
  if (typeof value.turn === 'number' && (value.turn < 1 || value.turn > 10)) errors.push('Turn must be 1–10.');
  if (!rowDecision && (value.hand?.length ?? 0) === 0) errors.push('Hand must be non-empty for card choice.');
  if (rowDecision && !isValidCardNumber(value.triggeringCard as number)) errors.push('Row choice requires a valid triggeringCard.');
  if (rowDecision && Array.isArray(value.hand) && value.hand.includes(value.triggeringCard as number)) errors.push('Row-choice hand must exclude the triggering card.');
  if (typeof value.turn === 'number' && (value.hand?.length ?? 0) !== 11 - value.turn && value.turn <= 10) warnings.push(`Hand size ${value.hand?.length ?? 0} differs from expected ${11 - value.turn}.`);
  return { valid: errors.length === 0, errors, warnings };
}

export function validateCardChoiceState(state: CardChoiceState): ValidationResult { return validateBase(state, false); }
export function validateRowChoiceState(state: RowChoiceState): ValidationResult { return validateBase(state, true); }
export function boardFromJson(rows: unknown): Board {
  const parsed = boardRows(rows);
  if (!parsed || parsed.length !== 4 || parsed.some((r) => !Array.isArray(r) || r.length < 1 || r.length > 5)) throw new Error('Invalid board.');
  const cards = parsed.flat();
  if (cards.some((card) => !isValidCardNumber(card as number)) || new Set(cards).size !== cards.length) throw new Error('Invalid board cards.');
  if (parsed.some((row) => row.some((card, index) => index > 0 && (row[index - 1] as number) >= (card as number)))) throw new Error('Board rows must be strictly increasing.');
  return { rows: parsed as unknown as Board['rows'] };
}
