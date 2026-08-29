/**
 * Differential tests: compare engine output against the independent reference model.
 */
import { describe, it, expect } from 'vitest';
import * as engine from '../../src/engine';
import * as ref from '../reference/reference-model';

// ── Helpers ────────────────────────────────────────────────────────────

// ── createDeck comparison ──────────────────────────────────────────────

describe('Differential: createDeck', () => {
  it('engine and reference produce same shuffled deck for 100 seeds', () => {
    for (let i = 0; i < 100; i++) {
      const seed = `diff-deck-${i}`;
      const round = (i % 5) + 1;
      const engineDeck = engine.createDeck(seed, round);
      const refDeck = ref.createDeck(seed, round);
      expect(engineDeck).toStrictEqual(refDeck);
    }
  });
});

// ── determinePlacement comparison ──────────────────────────────────────

describe('Differential: determinePlacement', () => {
  it('engine and reference agree on placement for 1000 random states', () => {
    let matches = 0;
    for (let i = 0; i < 1000; i++) {
      const seed = `diff-place-${i}`;
      const deck = engine.createDeck(seed, 1);

      // Build a random board state from the deck
      const boardCards = deck.slice(0, 4).sort((a, b) => a - b);
      const engineBoard: engine.Board = {
        rows: [
          [boardCards[0]],
          [boardCards[1]],
          [boardCards[2]],
          [boardCards[3]],
        ],
      };
      const refBoard: ref.Board = [
        [boardCards[0]],
        [boardCards[1]],
        [boardCards[2]],
        [boardCards[3]],
      ];

      // Pick a card to place
      const card = deck[4] as engine.CardNumber;

      const engineResult = engine.determinePlacement(engineBoard, card);
      const refResult = ref.determinePlacement(refBoard, card);

      // Engine returns MustPickRow or PlacementResult
      if (engineResult.kind !== 'place') {
        expect(refResult).toBe(-1);
      } else {
        expect(engineResult.rowIndex).toBe(refResult);
      }
      matches++;
    }
    expect(matches).toBe(1000);
  });
});

// ── Full turn resolution comparison ────────────────────────────────────

describe('Differential: full turn resolution', () => {
  it('engine and reference produce same board and collected cards', () => {
    for (let i = 0; i < 100; i++) {
      const seed = `diff-turn-${i}`;
      const playerCount = (i % 4) + 2; // 2-5 players
      const pids = Array.from({ length: playerCount }, (_, j) => `p${j}`);

      // Engine: use createGame + dealRound (which sorts hands)
      const engineState = engine.createGame(pids, seed);
      const dealtState = engine.dealRound(engineState);

      // Play first card from each (sorted) hand
      const enginePlays: engine.PlayCardMove[] = dealtState.players.map((p) => ({
        playerId: p.id,
        card: p.hand[0],
      }));

      let engineResolution = engine.resolveTurn(dealtState, enginePlays);
      while (engineResolution.kind === 'needs-row-pick') {
        engineResolution = engine.applyRowPick(engineResolution.state, engineResolution.playerId, 0);
      }
      const engineAfterState = engineResolution.state;

      // Reference: deal the same way, sort hands to match engine
      const refDeck = ref.createDeck(seed, 1);
      const refDeal = ref.dealRound(refDeck, playerCount);
      for (const h of refDeal.hands) h.sort((a, b) => a - b);

      const refPlays: ref.Play[] = pids.map((pid, j) => ({
        playerId: pid,
        card: refDeal.hands[j][0],
      }));
      const refAfter = ref.resolveTurn(
        refDeal.board,
        refPlays,
        () => 0,
      );

      // Compare boards — engine returns GameState, get board from it
      for (let r = 0; r < 4; r++) {
        expect([...engineAfterState.board.rows[r]]).toStrictEqual(refAfter.board[r]);
      }

      // Compare collected cards per player
      for (const pid of pids) {
        const ePlayer = engineAfterState.players.find((p) => p.id === pid)!;
        const engineCollected = ePlayer.collected;
        const refCollected = refAfter.collectedByPlayer.get(pid) ?? [];
        expect([...engineCollected].sort((a, b) => a - b)).toStrictEqual(
          [...refCollected].sort((a, b) => a - b),
        );
      }
    }
  });
});

// ── Full game comparison ───────────────────────────────────────────────

describe('Differential: full game identical scores', () => {
  it('engine and reference produce identical final scores for 50 games', () => {
    for (let i = 0; i < 50; i++) {
      const playerCount = (i % 4) + 2;
      const gameSeed = `diff-full-${i}`;
      const pids = Array.from({ length: playerCount }, (_, j) => `p${j}`);

      // Use a shared PRNG seed — but we must make the same random choices
      // in both engine and reference. The engine sorts hands, so we sort
      // reference hands too, then use the same PRNG sequence.

      // --- Engine game ---
      const enginePrng = engine.createPrng(`${gameSeed}/full-strat`);
      let eState = engine.createGame(pids, gameSeed);
      let engineRounds = 0;

      while (!engine.isGameOver(eState) && engineRounds < 50) {
        eState = engine.dealRound(eState);
        for (let t = 0; t < 10; t++) {
          const plays: engine.PlayCardMove[] = eState.players.map((p) => {
            const idx = Math.floor(enginePrng.nextFloat() * p.hand.length);
            return { playerId: p.id, card: p.hand[idx] };
          });
          let resolution = engine.resolveTurn(eState, plays);
          while (resolution.kind === 'needs-row-pick') {
            resolution = engine.applyRowPick(resolution.state, resolution.playerId, Math.floor(enginePrng.nextFloat() * 4) as 0 | 1 | 2 | 3);
          }
          eState = resolution.state;
        }
        eState = engine.scoreRound(eState);
        engineRounds++;
      }

      // --- Reference game (must make identical PRNG calls) ---
      const refPrngState = ref.deriveSeedState(`${gameSeed}/full-strat`);
      function refNextFloat(): number {
        return Number(ref.xoshiro256ss(refPrngState) >> 11n) / 2 ** 53;
      }

      const totalScores = new Map<string, number>();
      for (const pid of pids) totalScores.set(pid, 0);

      let refRounds = 0;
      while (!ref.isGameOver(totalScores) && refRounds < 50) {
        refRounds++;
        const deck = ref.createDeck(gameSeed, refRounds);
        const { hands, board } = ref.dealRound(deck, playerCount);
        // Sort hands to match engine behavior
        for (const h of hands) h.sort((a, b) => a - b);

        let currentBoard = board;
        const roundCollected = new Map<string, ref.CardNumber[]>();
        for (const pid of pids) roundCollected.set(pid, []);

        for (let turn = 0; turn < 10; turn++) {
          // Same PRNG calls as engine: one nextFloat per player for card pick
          const plays: ref.Play[] = pids.map((pid, j) => {
            const idx = Math.floor(refNextFloat() * hands[j].length);
            return { playerId: pid, card: hands[j][idx] };
          });

          // Remove played cards from hands
          for (let j = 0; j < pids.length; j++) {
            const idx = hands[j].indexOf(plays[j].card);
            hands[j].splice(idx, 1);
          }

          const result = ref.resolveTurn(
            currentBoard,
            plays,
            () => Math.floor(refNextFloat() * 4),
          );
          currentBoard = result.board;
          for (const [pid, cards] of result.collectedByPlayer) {
            roundCollected.get(pid)!.push(...cards);
          }
        }

        const roundScores = ref.scoreRound(roundCollected);
        for (const [pid, s] of roundScores) {
          totalScores.set(pid, totalScores.get(pid)! + s);
        }
      }

      // Compare round counts
      expect(engineRounds).toBe(refRounds);

      // Compare final scores
      for (const pid of pids) {
        const ePlayer = eState.players.find((p) => p.id === pid)!;
        expect(ePlayer.score).toBe(totalScores.get(pid));
      }
    }
  });
});

// ── cattleHeads comparison ─────────────────────────────────────────────

describe('Differential: cattleHeads', () => {
  it('engine and reference agree on all 104 card values', () => {
    for (let card = 1; card <= 104; card++) {
      expect(engine.cattleHeads(card)).toBe(ref.cattleHeads(card));
    }
  });
});
