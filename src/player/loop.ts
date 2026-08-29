/**
 * Game loop — the core play cycle.
 *
 * Architecture: poll for action → read state → get recommendation → execute → collect data.
 *
 * KEY DESIGN DECISIONS:
 * - Turn number is DERIVED from hand size (11 - cards), not incremented.
 *   This ensures correctness even when reconnecting mid-game (counter would reset to 0).
 * - Round transitions are detected by hand size jumping to ≥9 from <9.
 *   After the last turn, hand goes to 0; when BGA deals new round, it jumps to 10.
 * - After playing a card, we poll until hand size actually decreases.
 *   BGA animations can take 1-5s — without this wait, we'd re-read stale state
 *   and try to play the same card again.
 * - When hand empties (all 10 cards played), we enter a wait loop for either
 *   new round deal (hand > 0) or game end (gamestate name check).
 *
 * STRATEGY LIFECYCLE:
 * - onGameStart(): called once at attachment with player ID, count, rng.
 * - onTurnResolved(): called after each turn with a partial resolution built
 *   from board diffs. We can't identify which opponent played which card, but
 *   we DO report all new cards that appeared on the board — this feeds the
 *   seenCards set for card counting. Cards removed by row clears are not
 *   currently captured by this board-diff logic.
 * - onRoundEnd(): called at round transitions with current scores from DOM.
 * - Round numbers are "rounds since attachment" — reconnecting mid-game starts
 *   at round 1 even if the true game round is higher.
 */
import type { Page } from 'playwright';
import type { Strategy } from '../engine/strategies/types.js';
import type { CardChoiceState, RowChoiceState, CardNumber, Board } from '../engine/types.js';
import { readGameState, detectAction, getFinalScores, findCheapestRow, captureErrorContext, type GameStateFromDOM } from './state-reader.js';
import { playCard, pickRow } from './actor.js';
import { log, logError } from './logger.js';
import { GameCollector } from './collector.js';
import { deriveSeedState, xoshiro256ss } from '../engine/index.js';

/** Safely extract message and stack from any thrown value. */
function formatError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { message: String(err) };
}

export interface PlayOptions {
  strategy: Strategy;
  strategyName?: string;
  playerCount?: number;
  delay?: number;
  timeout?: number;
  verbose?: boolean;
  collect?: boolean; // enable data collection (default: true)
}

export interface GameResult {
  scores: Record<string, number>;
  turnsPlayed: number;
  rounds: number;
  dataFile?: string; // path to saved game log
}

/**
 * Wait for our turn or game end. Returns the detected action.
 * Polls every 500ms — BGA has no reliable event we can hook into from CDP.
 */
async function waitForAction(
  page: Page,
  timeout: number
): Promise<'playCard' | 'pickRow' | 'gameEnd'> {
  const startTime = Date.now();
  const pollInterval = 500;

  while (Date.now() - startTime < timeout) {
    const action = await detectAction(page);
    if (action !== 'waiting') return action;
    await page.waitForTimeout(pollInterval);
  }

  throw new Error(`Timed out waiting for action after ${timeout}ms`);
}

/**
 * After playing a card, wait for BGA to fully resolve the turn before we poll
 * for the next action. Without this, `waitForAction` returns `playCard` again
 * immediately because the gamestate stays `cardSelect` while waiting for other
 * players — causing the agent to re-run the strategy and click a second card.
 *
 * Strategy: poll until gamestate is no longer `cardSelect`/`playerTurn` (i.e.
 * BGA has moved into resolution — cardProcess, cardReveal, etc.), then return.
 * The main loop resumes and calls `waitForAction` which will correctly wait
 * for the next interactive state.
 */
async function waitForTurnResolution(page: Page, timeout: number, emit: (entry: Record<string, unknown>) => void): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const leftCardSelect = await page.evaluate(() => {
      const gsName = (window as any).gameui?.gamedatas?.gamestate?.name ?? '';
      // Wait until we leave the card-selection phase entirely.
      // takeRow (for any player) also indicates resolution has begun.
      return gsName !== 'cardSelect' && gsName !== 'playerTurn';
    });
    if (leftCardSelect) return;
    await page.waitForTimeout(300);
  }
  // Timeout is suspicious — log it so we can detect stuck states in diagnostics.
  // Non-fatal: the main waitForAction loop will handle the next iteration.
  emit({ event: 'warning', message: `waitForTurnResolution timed out after ${timeout}ms` });
}

/**
 * Play a full game from current page state until game ends.
 * Can be started mid-game (e.g. after reconnecting) — state is inferred from DOM.
 */
export async function playGame(page: Page, opts: PlayOptions): Promise<GameResult> {
  const { strategy, delay = 0, timeout = 180_000, verbose = false, collect = true } = opts;
  let currentRound = 1;
  let lastHandSize = 0;

  // Ring buffer: keep last 10 log entries in memory for error diagnostics.
  // When an error occurs, we attach this to the error event so callers can
  // see exactly what happened in the turns leading up to the crash.
  const eventBuffer: Record<string, unknown>[] = [];
  const RING_SIZE = 10;
  function emit(entry: Record<string, unknown>): void {
    const stamped = { ...entry, timestamp: new Date().toISOString() };
    eventBuffer.push(stamped);
    if (eventBuffer.length > RING_SIZE) eventBuffer.shift();
    log(stamped as any, verbose); // timestamp already set — log() won't overwrite
  }

  // Initialize strategy with game metadata
  const initialState = await readGameState(page);
  const playerCount = opts.playerCount ?? initialState.playerCount;
  strategy.onGameStart?.({
    playerId: initialState.myPlayerId,
    playerCount,
    rng: (() => { const state = deriveSeedState(`headless/${initialState.myPlayerId}/${opts.strategyName ?? strategy.name}`); return () => Number(xoshiro256ss(state) >> 11n) / 2 ** 53; })(),
  });

  /** Called when game ends. Determines win based on lowest score. */
  function onGameEnd(scores: Record<string, number>, rounds: number): void {
    if (!strategy.onGameEnd) return;
    const myId = initialState.myPlayerId;
    const scoreEntries = Object.entries(scores).map(([id, score]) => ({ id, score }));
    const hasMyScore = Object.prototype.hasOwnProperty.call(scores, myId);
    const won = hasMyScore && scoreEntries.length > 0
      ? scoreEntries.every(e => e.id === myId || e.score >= scores[myId]!)
      : false;
    strategy.onGameEnd({ scores: scoreEntries, rounds, won });
  }

  // Turn inference: in 6 Nimmt, each player gets 10 cards per round and plays
  // one per turn. So turn number = 11 - current hand size.
  // This works even on reconnect (no counter to reset).
  const inferTurn = (handSize: number) => 11 - handSize;
  let turnsPlayed = inferTurn(initialState.hand.length) - 1; // turns already played

  // Initialize data collector
  const collector = collect ? new GameCollector({
    playerCount,
    strategy: opts.strategyName ?? strategy.name,
  }) : null;

  // Start first round — track initial board for strategy context
  const initialHand = initialState.hand.map(h => h.cardValue as number);
  const initialBoard = initialState.board.rows.map(r => [...r]);
  let roundStartBoard = initialBoard; // snapshot of board at round start (for initialBoardCards)
  let lastPlayedCard: CardNumber | undefined; // track last card we played (needed for row pick context)
  let lastNotifiedResolutionKey: string | undefined;
  collector?.startRound(1, initialBoard, initialHand);
  strategy.onRoundStart?.({
    round: 1,
    hand: initialHand as CardNumber[],
    board: { rows: initialBoard as Board['rows'] },
  });

  while (true) {
    // 1. Wait for our turn or game end
    let action: 'playCard' | 'pickRow' | 'gameEnd';
    try {
      action = await waitForAction(page, timeout);
    } catch (err) {
      const dom = await captureErrorContext(page);
      const { message, stack } = formatError(err);
      logError({
        event: 'error',
        message,
        context: { action: 'waitForAction', dom, ...(stack ? { stack } : {}) },
        lastEvents: [...eventBuffer],
      });
      throw err;
    }

    if (action === 'gameEnd') {
      const scores = await getFinalScores(page);
      emit({ event: 'gameEnd', scores, turnsPlayed, rounds: currentRound });
      onGameEnd(scores, currentRound);
      
      // Save collected data
      let dataFile: string | undefined;
      if (collector) {
        collector.endRound(scores);
        dataFile = collector.finalize(scores);
        emit({ event: 'dataSaved', file: dataFile });
      }
      
      return { scores, turnsPlayed, rounds: currentRound, dataFile };
    }

    // 2. Read state — handle empty hand (round just ended)
    // After playing 10 cards, hand is empty. We need to wait for BGA to deal
    // the next round (hand refills to 10) or end the game.
    let state = await readGameState(page);
    let stateReadAt = Date.now(); // track when state was read for staleAgeMs diagnostics
    if (state.hand.length === 0 && action === 'playCard') {
      emit({ event: 'roundComplete', message: 'Hand empty — waiting for next round or game end', round: currentRound });
      let foundNewState = false;
      for (let retry = 0; retry < 20; retry++) {
        await page.waitForTimeout(1500);
        // Check gamestate for game end (most reliable end-of-game signal)
        const gameOver = await page.evaluate(() => {
          const gs = (window as any).gameui?.gamedatas?.gamestate;
          return gs?.name === 'gameEnd' || gs?.name === 'endGame';
        });
        if (gameOver) {
          emit({ event: 'gameEnd', round: currentRound });
          const scores = await getFinalScores(page);
          onGameEnd(scores, currentRound);
          let dataFile: string | undefined;
          if (collector) {
            collector.endRound(scores);
            dataFile = collector.finalize(scores);
          }
          return { scores, turnsPlayed, rounds: currentRound, dataFile };
        }
        state = await readGameState(page);
        if (state.hand.length > 0) {
          foundNewState = true;
          break;
        }
      }
      if (!foundNewState) {
        throw new Error('Timed out waiting for new round after hand emptied.');
      }
    }

    const currentTurn = inferTurn(state.hand.length);

    // Detect new round: hand jumped from <9 to ≥9 cards.
    // Normal flow: last turn hand=1 → play → hand=0 → BGA deals → hand=10.
    // We use ≥9 (not ==10) because getAllItems() can briefly return 9 during animation.
    // The turnsPlayed>0 guard prevents false-triggering on initial game join.
    if (state.hand.length >= 9 && lastHandSize < 9 && lastHandSize >= 0 && turnsPlayed > 0) {
      // Notify strategy that previous round ended (scores are from DOM, always current)
      if (strategy.onRoundEnd) {
        const roundScores = Object.entries(state.scores).map(([id, score]) => ({ id, score }));
        strategy.onRoundEnd(roundScores);
      }
      currentRound++;
      emit({ event: 'newRound', round: currentRound });
      const hand = state.hand.map(h => h.cardValue as number);
      const board = state.board.rows.map(r => [...r]);
      roundStartBoard = board; // save for initialBoardCards in strategy state
      lastNotifiedResolutionKey = undefined;
      collector?.startRound(currentRound, board, hand);
      strategy.onRoundStart?.({
        round: currentRound,
        hand: hand as CardNumber[],
        board: { rows: board as Board['rows'] },
      });
    }
    lastHandSize = state.hand.length;

    // 3. Execute action
    if (action === 'playCard') {
      const boardBefore = state.board.rows.map(r => [...r]);
      const cardState = buildCardChoiceState(state, playerCount, currentRound, currentTurn, roundStartBoard);
      
      const t0 = Date.now();
      const card = strategy.chooseCard(cardState);
      const decisionTime = Date.now() - t0;
      
      if (delay) await page.waitForTimeout(delay);

      // Attempt card play — on failure, emit enriched error with full context
      try {
        await playCard(page, card);
      } catch (err) {
        const { message, stack } = formatError(err);
        const expectedMissingMsg = `Failed to play card ${card}: Card ${card} not found`;

        // If the card-not-found error matches our last played card and the card
        // is no longer in hand, this is a stale-state replay: the card was already
        // submitted but BGA's hand stock hasn't visually removed it yet (common
        // when waitForTurnResolution times out with slow human opponents).
        // Requiring absence from hand prevents cross-round false positives.
        const cardStillInHand = state.hand.some(h => h.cardValue === card);
        if (message === expectedMissingMsg && card === lastPlayedCard && !cardStillInHand) {
          emit({
            event: 'warning',
            message: `Stale replay detected: card ${card} already submitted, skipping`,
          });
          // Wait briefly for BGA to catch up, then re-enter the main loop
          await page.waitForTimeout(2000);
          continue;
        }

        const dom = await captureErrorContext(page);
        logError({
          event: 'error',
          message,
          context: {
            action: 'playCard',
            targetCard: card,
            stateAgeMs: Date.now() - stateReadAt,
            hand: state.hand.map(h => h.cardValue as number),
            board: boardBefore,
            dom,
            ...(stack ? { stack } : {}),
          },
          lastEvents: [...eventBuffer],
        });

        // Before crashing: check if the game ended abruptly (e.g. a player quit).
        // Only treat as abrupt end if the gamestate is a known terminal state.
        // Non-interactive states like cardProcess/cardReveal are normal mid-game
        // states — we should NOT abort for those (they'll resolve and play continues).
        const TERMINAL_STATES = ['gameEnd', 'endGame', 'gameOver'];
        const abruptEnd = await page.evaluate((terminals: string[]) => {
          const gs = (window as any).gameui?.gamedatas?.gamestate;
          const gsName: string = gs?.name ?? '';
          return terminals.includes(gsName);
        }, TERMINAL_STATES).catch(() => true); // if evaluate fails, assume game ended

        if (abruptEnd) {
          emit({ event: 'gameAborted', reason: 'card not found in non-interactive state', gamestateName: dom.gamestateName });
          const scores = await getFinalScores(page).catch(() => ({}));
          onGameEnd(scores, currentRound);
          if (collector) {
            collector.endRound(scores);
            collector.finalize(scores);
          }
          return { scores, turnsPlayed, rounds: currentRound };
        }

        throw err;
      }

      lastPlayedCard = card; // track for potential row pick that follows
      turnsPlayed++;

      // Emit immediately after successful click — NOT after resolution waits.
      // This gives accurate timestamps reflecting when the decision was executed.
      emit({
        event: 'playCard',
        card,
        round: currentRound,
        turn: currentTurn,
        handSize: state.hand.length - 1,
        decisionTime,
      });

      // CRITICAL: Wait for card to actually leave hand before continuing.
      // Without this, the next loop iteration would read the same hand state
      // (card still animating out) and try to play the same card again.
      // BGA card animations take 1-3s depending on resolution speed.
      const expectedSize = state.hand.length - 1;
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(500);
        const check = await page.evaluate(() => {
          return (window as any).gameui?.playerHand?.getAllItems?.()?.length ?? -1;
        });
        if (check <= expectedSize) break;
      }

      // Wait for BGA to leave the card-selection gamestate entirely before looping.
      // This prevents waitForAction from firing 'playCard' again while other players
      // are still selecting (gamestate stays 'cardSelect' until all have submitted).
      // Fixes: agent re-running strategy and clicking a second card mid-turn.
      await waitForTurnResolution(page, 60_000, emit);

      // Record turn data for training/analysis collection
      collector?.recordTurn({
        turn: currentTurn,
        ourCard: card as number,
        ourRecommendation: card as number,
        boardBefore,
        decision: {
          hand: state.hand.map(h => h.cardValue as number),
          board: boardBefore,
          strategyUsed: opts.strategyName ?? strategy.name,
          timeToDecide: decisionTime,
        },
      });

    } else if (action === 'pickRow') {
      // Row pick: our played card was lower than all row tails, so we must
      // pick a row to take (absorb its penalty points). Strategy decides which;
      // fallback to cheapest row (fewest cattle heads) if strategy throws.
      let rowIdx: 0 | 1 | 2 | 3;
      try {
         const rowState = buildRowChoiceState(state, playerCount, currentRound, Math.max(1, currentTurn - 1), roundStartBoard, lastPlayedCard);
        rowIdx = strategy.chooseRow(rowState);
      } catch {
        rowIdx = findCheapestRow(state.board);
      }

      if (delay) await page.waitForTimeout(delay);

      // Attempt row pick — on failure, emit enriched error with full context
      try {
        await pickRow(page, rowIdx);
      } catch (err) {
        const dom = await captureErrorContext(page);
        const { message, stack } = formatError(err);
        logError({
          event: 'error',
          message,
          context: {
            action: 'pickRow',
            targetRow: rowIdx,
            stateAgeMs: Date.now() - stateReadAt,
            hand: state.hand.map(h => h.cardValue as number),
            board: state.board.rows.map(r => [...r]),
            dom,
            ...(stack ? { stack } : {}),
          },
          lastEvents: [...eventBuffer],
        });

        // Same abrupt-end handling as playCard — game may have ended mid-action
        const TERMINAL_STATES = ['gameEnd', 'endGame', 'gameOver'];
        const abruptEnd = await page.evaluate((terminals: string[]) => {
          const gs = (window as any).gameui?.gamedatas?.gamestate;
          const gsName: string = gs?.name ?? '';
          return terminals.includes(gsName);
        }, TERMINAL_STATES).catch(() => true);

        if (abruptEnd) {
          emit({ event: 'gameAborted', reason: 'row pick failed in terminal state', gamestateName: dom.gamestateName });
          const scores = await getFinalScores(page).catch(() => ({}));
          onGameEnd(scores, currentRound);
          if (collector) {
            collector.endRound(scores);
            collector.finalize(scores);
          }
          return { scores, turnsPlayed, rounds: currentRound };
        }

        throw err;
      }

      // Record row pick in data collection
      collector?.recordRowPick(rowIdx, state.board.rows.map(r => [...r]));

      emit({
        event: 'pickRow',
        row: rowIdx,
        round: currentRound,
        turn: currentTurn,
      });

      // Wait for BGA to leave the row-pick state before looping.
      // Without this, detectAction() sees the title still saying "must take a row"
      // and selectable_row arrows on the next poll, causing repeated row picks.
      // Poll until selectable_row arrows disappear (BGA confirmed our pick).
      await page.waitForTimeout(500);
      for (let i = 0; i < 20; i++) {
        const pickDone = await page.evaluate(() => {
          const arrows = (window as any).document.querySelectorAll(
            '#row_slot_1_arrow, #row_slot_2_arrow, #row_slot_3_arrow, #row_slot_4_arrow'
          );
          let anySelectable = false;
          arrows.forEach((el: any) => {
            if (el.classList.contains('selectable_row')) anySelectable = true;
          });
          return !anySelectable;
        });
        if (pickDone) break;
        await page.waitForTimeout(300);
      }
    }

    // Wait for BGA animations to resolve (card placement, row clearing, etc.)
    // then snapshot the board and feed strategy lifecycle methods.
    await page.waitForTimeout(1500);
    try {
      const postState = await readGameState(page);
      collector?.recordBoardAfter(postState.board.rows.map(r => [...r]));

      // Feed onTurnResolved with what we can infer from the board diff.
      // We can't know which opponent played which card, but we CAN tell the
      // strategy about all new cards that appeared on the board — this feeds
      // the seenCards set for better unknown pool calculation.
      if (strategy.onTurnResolved) {
        const newCardsOnBoard = new Set<number>();
        for (const row of postState.board.rows) {
          for (const c of row) newCardsOnBoard.add(c);
        }
        // Cards that are on the post-board but weren't before this action
        const boardBefore = state.board.rows;
        for (const row of boardBefore) {
          for (const c of row) newCardsOnBoard.delete(c);
        }
        // Build a partial resolution — we attribute all new cards to "unknown" players
        const plays: { playerId: string; card: CardNumber }[] = [];
        for (const card of newCardsOnBoard) {
          plays.push({ playerId: 'unknown', card: card as CardNumber });
        }
        if (plays.length > 0 || lastPlayedCard) {
          // Include our own played card if it's not already on the board
          if (lastPlayedCard && !newCardsOnBoard.has(lastPlayedCard)) {
            plays.push({ playerId: initialState.myPlayerId, card: lastPlayedCard });
          }
          // When action is pickRow, hand already decreased from the prior playCard,
          // so inferTurn() is +1 ahead — use the previous turn number instead.
          const resolvedTurn = action === 'pickRow' ? Math.max(1, currentTurn - 1) : currentTurn;
          const resolutionKey = `${currentRound}:${resolvedTurn}`;
          if (resolutionKey !== lastNotifiedResolutionKey) strategy.onTurnResolved({
            turn: resolvedTurn,
            plays,
            resolutions: [],
            rowPicks: [],
            boardAfter: postState.board.rows.map(r => [...r]) as unknown as CardNumber[][],
          });
          lastNotifiedResolutionKey = resolutionKey;
        }
      }
    } catch { /* non-critical — don't crash if post-read fails */ }
  }
}

function buildCardChoiceState(
  state: GameStateFromDOM,
  playerCount: number,
  round: number,
  turn: number,
  roundStartBoard: number[][],
): CardChoiceState {
  const board = { rows: state.board.rows as unknown as readonly [readonly CardNumber[], readonly CardNumber[], readonly CardNumber[], readonly CardNumber[]] };
  const initialBoardCards = roundStartBoard.map((row) => row[0]) as CardNumber[];
  return {
    hand: state.hand.map(h => h.cardValue),
    board,
    playerScores: Object.entries(state.scores).map(([id, score]) => ({ id, score, penaltyThisRound: 0 })),
    playerCount,
    round,
    turn, // already 1-based from inferTurn (11 - handSize)
    turnHistory: [],
    initialBoardCards,
  };
}

function buildRowChoiceState(
  state: GameStateFromDOM,
  playerCount: number,
  round: number,
  turn: number,
  roundStartBoard: number[][],
  lastPlayedCard?: CardNumber,
): RowChoiceState {
  const board = { rows: state.board.rows as unknown as readonly [readonly CardNumber[], readonly CardNumber[], readonly CardNumber[], readonly CardNumber[]] };
  return {
    board,
    // triggeringCard is the card we played that forced the row pick.
    // We track it from the previous play action; fallback to 1 if unknown.
    triggeringCard: lastPlayedCard ?? (() => { throw new Error('Cannot build row-choice state without the triggering card.'); })(),
    // BGA does not expose opponent reveals reliably before row-pick UI appears.
    // Preserve the known public reveal rather than inventing opponent cards.
    revealedThisTurn: lastPlayedCard ? [{ playerId: state.myPlayerId, card: lastPlayedCard }] : [],
    resolutionIndex: 0,
    hand: state.hand.map(h => h.cardValue).filter((card) => card !== lastPlayedCard),
    playerScores: Object.entries(state.scores).map(([id, score]) => ({ id, score, penaltyThisRound: 0 })),
    playerCount,
    round,
    turn, // already 1-based from inferTurn
    turnHistory: [],
    initialBoardCards: roundStartBoard.map((row) => row[0]) as CardNumber[],
  };
}
