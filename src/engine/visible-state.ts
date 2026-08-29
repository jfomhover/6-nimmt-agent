import type { GameState, CardChoiceState, RowChoiceState } from './types';

function scores(state: GameState) {
  return state.players.map((p) => ({
    id: p.id,
    score: p.score,
    penaltyThisRound: p.collected.reduce((sum, card) => sum + (card === 55 ? 7 : card % 11 === 0 ? 5 : card % 10 === 0 ? 3 : card % 5 === 0 ? 2 : 1), 0),
  }));
}

export function toCardChoiceState(state: GameState, playerId: string): CardChoiceState {
  if (state.phase !== 'awaiting-cards') throw new Error(`Cannot project card-choice state: phase is "${state.phase}", expected "awaiting-cards".`);
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`Unknown player "${playerId}".`);
  return { hand: player.hand, board: state.board, playerScores: scores(state), playerCount: state.players.length, round: state.round, turn: state.turn, turnHistory: state.turnHistory, initialBoardCards: state.initialBoardCards };
}

export function toRowChoiceState(state: GameState, playerId: string): RowChoiceState {
  if (state.phase !== 'awaiting-row-pick') throw new Error(`Cannot project row-choice state: phase is "${state.phase}", expected "awaiting-row-pick".`);
  if (!state.pendingResolution?.pendingRowPick) throw new Error('No pending row pick in state.');
  if (state.pendingResolution.pendingRowPick.playerId !== playerId) throw new Error(`Player "${playerId}" is not the pending row picker.`);
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`Unknown player "${playerId}".`);
  const pending = state.pendingResolution;
  const pendingPick = pending.pendingRowPick;
  if (!pendingPick) throw new Error('No pending row pick in state.');
  return {
    board: state.board,
    hand: player.hand.filter((card) => card !== pendingPick.card),
    playerScores: scores(state),
    playerCount: state.players.length,
    round: state.round,
    turn: state.turn,
    turnHistory: state.turnHistory,
    initialBoardCards: state.initialBoardCards,
    triggeringCard: pendingPick.card,
    revealedThisTurn: pending.sortedPlays,
    resolutionIndex: pending.nextIndex,
  };
}
