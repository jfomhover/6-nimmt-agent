/** Pure, immutable game lifecycle operations for 6 Nimmt!. */
import type {
  Board, CardNumber, GameState, PlayerState, PlayCardMove,
  TurnHistoryEntry, TurnResolutionResult,
} from './types';
import { createDeck, cattleHeads } from './card';
import { determinePlacement, placeCard, collectRow } from './board';

function penalty(cards: readonly CardNumber[]): number {
  return cards.reduce((sum, card) => sum + cattleHeads(card), 0);
}

function serializedBoard(board: Board): readonly CardNumber[][] {
  return board.rows.map((row) => [...row]);
}

export function createGame(playerIds: string[], seed: string): GameState {
  if (playerIds.length < 2 || playerIds.length > 10) throw new Error(`Invalid player count: ${playerIds.length}. Must be 2–10.`);
  if (new Set(playerIds).size !== playerIds.length) throw new Error('Duplicate player IDs.');
  if (!seed) throw new Error('Seed must be non-empty.');
  const players: PlayerState[] = playerIds.map((id) => ({ id, hand: [], collected: [], score: 0 }));
  const empty: readonly CardNumber[] = [];
  const board: Board = { rows: [empty, empty, empty, empty] };
  return { players, board, deck: createDeck(seed, 0), round: 1, turn: 0, phase: 'round-over', seed, turnHistory: [], initialBoardCards: [] };
}

export function dealRound(state: GameState): GameState {
  if (state.phase !== 'round-over') throw new Error(`Cannot deal: phase is "${state.phase}", expected "round-over".`);
  const deck = createDeck(state.seed, state.round);
  const playerCount = state.players.length;
  const players = state.players.map((p, i) => ({ ...p, hand: deck.slice(i * 10, (i + 1) * 10).sort((a, b) => a - b), collected: [] }));
  const boardCards = deck.slice(playerCount * 10, playerCount * 10 + 4) as CardNumber[];
  const board: Board = { rows: [[boardCards[0]], [boardCards[1]], [boardCards[2]], [boardCards[3]]] };
  return { ...state, players, board, deck: deck.slice(playerCount * 10 + 4), turn: 1, phase: 'awaiting-cards', turnHistory: [], initialBoardCards: [...boardCards] };
}

function validatePlays(state: GameState, plays: readonly PlayCardMove[]): PlayCardMove[] {
  if (state.phase !== 'awaiting-cards') throw new Error(`Cannot resolve: phase is "${state.phase}", expected "awaiting-cards".`);
  if (plays.length !== state.players.length) throw new Error(`Expected ${state.players.length} plays, got ${plays.length}.`);
  const players = new Map(state.players.map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (const play of plays) {
    if (seen.has(play.playerId)) throw new Error(`Duplicate play from player "${play.playerId}".`);
    seen.add(play.playerId);
    const player = players.get(play.playerId);
    if (!player) throw new Error(`Unknown player "${play.playerId}".`);
    if (!player.hand.includes(play.card)) throw new Error(`Card ${play.card} not in hand of player "${play.playerId}".`);
  }
  return [...plays].sort((a, b) => a.card - b.card);
}

function continueResolution(state: GameState, pending: NonNullable<GameState['pendingResolution']>): TurnResolutionResult {
  let board = state.board;
  let nextIndex = pending.nextIndex;
  let resolutions = [...pending.resolutions];
  let rowPicks = [...pending.rowPicks];
  while (nextIndex < pending.sortedPlays.length) {
    const play = pending.sortedPlays[nextIndex];
    const placement = determinePlacement(board, play.card);
    if (!('rowIndex' in placement)) {
      const paused: GameState = { ...state, board, phase: 'awaiting-row-pick', pendingResolution: { ...pending, nextIndex, pendingRowPick: { playerId: play.playerId, card: play.card }, resolutions, rowPicks } };
      return { ...paused, kind: 'needs-row-pick', playerId: play.playerId, card: play.card, state: paused };
    }
    const collected = placement.collectedCards;
    board = placeCard(board, play.card, placement.rowIndex);
    state = { ...state, players: state.players.map((p) => p.id === play.playerId ? { ...p, hand: p.hand.filter((card) => card !== play.card) } : p) };
    resolutions.push({ playerId: play.playerId, card: play.card, rowIndex: placement.rowIndex, causedOverflow: placement.causedOverflow, ...(collected ? { collectedCards: [...collected] } : {}) });
    if (collected) {
      const players = state.players.map((p) => p.id === play.playerId ? { ...p, collected: [...p.collected, ...collected] } : p);
      state = { ...state, players };
    }
    nextIndex++;
  }
  const finalTurn = state.turn === 10;
  const entry: TurnHistoryEntry = { turn: state.turn, plays: pending.sortedPlays, resolutions, rowPicks, boardAfter: serializedBoard(board) };
  const stateWithoutPending = Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'pendingResolution')) as unknown as GameState;
  const finalState: GameState = { ...stateWithoutPending, board, phase: finalTurn ? 'round-over' : 'awaiting-cards', turn: finalTurn ? 10 : state.turn + 1, turnHistory: [...state.turnHistory, entry] };
  return { ...finalState, kind: 'completed', state: finalState };
}

export function resolveTurn(state: GameState, plays: readonly PlayCardMove[]): TurnResolutionResult {
  const sortedPlays = validatePlays(state, plays);
  const pending = { sortedPlays, nextIndex: 0, resolutions: [], rowPicks: [] } satisfies NonNullable<GameState['pendingResolution']>;
  return continueResolution({ ...state, phase: 'resolving', pendingResolution: pending }, pending);
}

export function applyRowPick(state: GameState, playerId: string, rowIndex: 0 | 1 | 2 | 3): TurnResolutionResult {
  if (state.phase !== 'awaiting-row-pick' || !state.pendingResolution?.pendingRowPick) throw new Error('Cannot apply row pick: no row pick is pending.');
  const pending = state.pendingResolution;
  const pendingPick = pending.pendingRowPick;
  if (!pendingPick || pendingPick.playerId !== playerId) throw new Error(`Player "${playerId}" is not the pending row picker.`);
  const play = pending.sortedPlays[pending.nextIndex];
  if (!play) throw new Error('Pending row pick has no corresponding play.');
  const { newBoard, collected } = collectRow(state.board, rowIndex, play.card);
  const players = state.players.map((p) => p.id === playerId ? { ...p, hand: p.hand.filter((card) => card !== play.card), collected: [...p.collected, ...collected] } : p);
  const resolutions = [...pending.resolutions, { playerId, card: play.card, rowIndex, causedOverflow: false, collectedCards: [...collected] }];
  const rowPicks = [...pending.rowPicks, { playerId, rowIndex, collectedCards: [...collected] }];
  return continueResolution({ ...state, board: newBoard, players, phase: 'resolving' }, { ...pending, nextIndex: pending.nextIndex + 1, pendingRowPick: undefined, resolutions, rowPicks });
}

export function scoreRound(state: GameState): GameState {
  if (state.phase !== 'round-over') throw new Error(`Cannot score round: phase is "${state.phase}", expected "round-over".`);
  if (state.turn !== 10) throw new Error(`Cannot score round: turn is ${state.turn}, expected 10.`);
  const players = state.players.map((p) => ({ ...p, score: p.score + penalty(p.collected) }));
  const gameOver = players.some((p) => p.score >= 66);
  return { ...state, players, phase: gameOver ? 'game-over' : 'round-over', round: gameOver ? state.round : state.round + 1, turn: gameOver ? 10 : 0 };
}

export function isGameOver(state: GameState): boolean { return state.phase === 'game-over' || state.players.some((p) => p.score >= 66); }
export function getWinners(state: GameState): string[] {
  const minScore = Math.min(...state.players.map((p) => p.score));
  return state.players.filter((p) => p.score === minScore).map((p) => p.id);
}
