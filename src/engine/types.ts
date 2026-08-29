/**
 * Core types for the 6 Nimmt! game engine.
 * All state types are deeply readonly (immutable engine contract).
 */

// ── Card ───────────────────────────────────────────────────────────────

/** Branded number type for valid card values (1–104). */
export type CardNumber = number & { readonly __brand: 'CardNumber' };

/** A single board row — immutable array of CardNumbers. */
export type Row = readonly CardNumber[];

/** The board: always exactly 4 rows. */
export interface Board {
  readonly rows: readonly [Row, Row, Row, Row];
}

// ── Player ─────────────────────────────────────────────────────────────

export interface PlayerState {
  readonly id: string;
  readonly hand: readonly CardNumber[];
  readonly collected: readonly CardNumber[];
  readonly score: number;
}

// ── Game phases ────────────────────────────────────────────────────────

export type GamePhase =
  | 'round-over'
  | 'awaiting-cards'
  | 'resolving'
  | 'awaiting-row-pick'
  | 'game-over';

// ── Game state ─────────────────────────────────────────────────────────

export interface GameState {
  readonly players: readonly PlayerState[];
  readonly board: Board;
  readonly deck: readonly CardNumber[];
  readonly round: number;
  readonly turn: number;
  readonly phase: GamePhase;
  readonly seed: string;
  readonly turnHistory: readonly TurnHistoryEntry[];
  readonly initialBoardCards: readonly CardNumber[];
  readonly pendingResolution?: PendingTurnResolution;
}

// ── Moves ──────────────────────────────────────────────────────────────

export interface PlayCardMove {
  readonly playerId: string;
  readonly card: CardNumber;
}

export interface PickRowMove {
  readonly playerId: string;
  readonly rowIndex: number;
}

// ── Placement ──────────────────────────────────────────────────────────

export type PlacementResult =
  | { readonly kind: 'place'; readonly rowIndex: 0 | 1 | 2 | 3; readonly causedOverflow: boolean; readonly collectedCards?: readonly CardNumber[] }
  | { readonly kind: string };

// ── Turn resolution ────────────────────────────────────────────────────

export interface TurnResolutionDetail {
  readonly resolutions: ReadonlyArray<{
    readonly playerId: string;
    readonly card: CardNumber;
    readonly rowIndex: number;
    readonly causedOverflow: boolean;
    readonly collectedCards?: readonly CardNumber[];
  }>;
  readonly rowPicks: ReadonlyArray<{
    readonly playerId: string;
    readonly rowIndex: number;
    readonly collectedCards: readonly CardNumber[];
  }>;
  readonly collected: Readonly<Record<string, CardNumber[]>>;
  readonly boardAfter: readonly CardNumber[][];
}

export type TurnResolutionResult =
  | (GameState & { readonly kind: 'completed'; readonly state: GameState })
  | (GameState & { readonly kind: 'needs-row-pick'; readonly playerId: string; readonly card: CardNumber; readonly state: GameState });

// ── Turn history ───────────────────────────────────────────────────────

export interface TurnHistoryEntry {
  readonly turn: number;
  readonly plays: readonly PlayCardMove[];
  readonly resolutions: TurnResolutionDetail['resolutions'];
  readonly rowPicks: TurnResolutionDetail['rowPicks'];
  readonly boardAfter: readonly CardNumber[][];
}

export interface PendingTurnResolution {
  readonly sortedPlays: readonly PlayCardMove[];
  readonly nextIndex: number;
  readonly pendingRowPick?: { readonly playerId: string; readonly card: CardNumber };
  readonly resolutions: TurnResolutionDetail['resolutions'];
  readonly rowPicks: TurnResolutionDetail['rowPicks'];
}

// ── Visible state for agents ───────────────────────────────────────────

/** Visible state for card selection (what the agent sees when picking a card). */
export interface CardChoiceState {
  readonly hand: readonly CardNumber[];
  readonly board: Board;
  readonly playerScores: readonly { readonly id: string; readonly score: number; readonly penaltyThisRound: number }[];
  readonly playerCount: number;
  readonly round: number;
  readonly turn: number;
  readonly turnHistory: readonly TurnHistoryEntry[];
  readonly initialBoardCards: readonly CardNumber[];
}

/** Visible state for row pick (what the agent sees when forced to pick a row). */
export interface RowChoiceState {
  readonly board: Board;
  readonly triggeringCard: CardNumber;
  readonly revealedThisTurn: readonly PlayCardMove[];
  readonly resolutionIndex: number;
  readonly hand: readonly CardNumber[];
  readonly playerScores: readonly { readonly id: string; readonly score: number; readonly penaltyThisRound: number }[];
  readonly playerCount: number;
  readonly round: number;
  readonly turn: number;
  readonly turnHistory: readonly TurnHistoryEntry[];
  readonly initialBoardCards: readonly CardNumber[];
}
