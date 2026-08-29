import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import type { CardChoiceState, RowChoiceState } from '../../engine/types.js';
import type { TurnResolution } from '../../engine/strategies/types.js';
import { strategies, parseStrategySpec, deriveSeedState, xoshiro256ss, validateCardChoiceState, validateRowChoiceState } from '../../engine/index.js';
import { format } from '../formatters/index.js';
import type { RecommendResult, OutputFormat } from '../formatters/types.js';
import { didYouMean, outputError, createMeta } from '../helpers.js';

function validateCardState(state: Record<string, unknown>): string[] {
  const required = ['hand', 'board', 'playerScores', 'playerCount', 'round', 'turn', 'turnHistory', 'initialBoardCards'];
  const missing = required.filter((f) => !(f in state));
  return missing;
}

function validateRowState(state: Record<string, unknown>): string[] {
  const required = ['board', 'triggeringCard', 'revealedThisTurn'];
  const missing = required.filter((f) => !(f in state));
  return missing;
}

function checkWarnings(state: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const hand = state.hand as number[] | undefined;
  const board = state.board as { rows: number[][] } | undefined;

  if (hand && board?.rows) {
    const boardCards = new Set(board.rows.flat());
    for (const c of hand) {
      if (boardCards.has(c)) {
        warnings.push(`Card ${c} appears in both hand and board.`);
      }
    }
  }

  if (hand) {
    for (const c of hand) {
      if (typeof c !== 'number' || c < 1 || c > 104) {
        warnings.push(`Card ${c} is outside valid range 1–104.`);
      }
    }
  }

  return warnings;
}

export const recommendCommand = new Command('recommend')
  .description('Get AI move recommendation for a given game state')
  .option('--state <json>', 'Game state as inline JSON')
  .option('--state-file <path>', 'Path to game state JSON file')
  .requiredOption('-s, --strategy <strategy>', 'Strategy to use for recommendation')
  .option('-d, --decision <type>', 'Decision type (card or row)')
  .option('-t, --timeout <ms>', 'Timeout in milliseconds', '10000')
  .option('-f, --format <format>', 'Output format (json, table)', 'json')
  .action((opts) => {
    const fmt = opts.format as OutputFormat;
    const startTime = Date.now();

    // Validate strategy (supports name:key=val syntax)
    const strategySpec = parseStrategySpec(opts.strategy as string);
    const strategyName = strategySpec.name;
    if (!strategies.has(strategyName)) {
      const valid = [...strategies.keys()];
      const suggestion = didYouMean(strategyName, valid);
      outputError(fmt, 'INVALID_STRATEGY',
        `Unknown strategy '${strategyName}'.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`, valid);
      process.exit(1);
    }

    // Read state
    let stateJson: string;
    if (opts.state && opts.stateFile) {
      outputError(fmt, 'INVALID_STATE', 'Exactly one of --state or --state-file must be provided.');
      process.exit(1);
      return;
    } else if (opts.state) {
      stateJson = opts.state as string;
    } else if (opts.stateFile) {
      try {
        stateJson = (opts.stateFile as string) === '-'
          ? readFileSync(0, 'utf-8')
          : readFileSync(opts.stateFile as string, 'utf-8');
      } catch (err) {
        outputError(fmt, 'INVALID_STATE', `Failed to read state file: ${(err as Error).message}`);
        process.exit(1);
        return; // unreachable but satisfies TS
      }
    } else {
      outputError(fmt, 'INVALID_STATE', 'Must provide --state or --state-file.');
      process.exit(1);
      return;
    }

    let state: Record<string, unknown>;
    try {
      state = JSON.parse(stateJson);
    } catch {
      outputError(fmt, 'INVALID_STATE', 'Failed to parse state JSON.');
      process.exit(1);
      return;
    }

    // Detect decision type
    let decision: 'card' | 'row';
    if (opts.decision) {
      decision = opts.decision as 'card' | 'row';
      if (decision !== 'card' && decision !== 'row') {
        outputError(fmt, 'INCOMPATIBLE_DECISION', `Invalid decision type '${decision}'.`, ['card', 'row']);
        process.exit(1);
        return;
      }
    } else {
      decision = 'triggeringCard' in state ? 'row' : 'card';
    }

    // Validate state fields
    const missingFields = decision === 'card' ? validateCardState(state) : validateRowState(state);
    if (missingFields.length > 0) {
      outputError(fmt, 'INVALID_STATE', `Missing required fields: ${missingFields.join(', ')}`);
      process.exit(1);
      return;
    }

    const warnings = checkWarnings(state);
    let validationErrors: string[] = [];
    if (missingFields.length === 0 && Array.isArray(state.playerScores)) {
      const validation = decision === 'card'
        ? validateCardChoiceState(state as unknown as CardChoiceState)
        : validateRowChoiceState(state as unknown as RowChoiceState);
      validationErrors = [...validation.errors];
      warnings.push(...validation.warnings);
      if (validationErrors.length > 0) {
        outputError(fmt, 'INVALID_STATE', `State validation failed: ${validationErrors.join('; ')}`, validationErrors);
        process.exit(1);
        return;
      }
    }

    // Instantiate strategy
    const strat = strategies.get(strategyName)!(strategySpec.options);
    const playerCount = (state.playerCount as number) ?? 2;
    const seedStr = 'recommend/' + JSON.stringify(state);
    const rngState = deriveSeedState(seedStr);
    strat.onGameStart?.({
      playerId: 'recommend-player',
      playerCount,
      rng: () => Number(xoshiro256ss(rngState) >> 11n) / 2 ** 53,
    });

    // Replay turn history
    const turnHistory = (state.turnHistory as TurnResolution[]) ?? [];
    for (const entry of turnHistory) {
      try { strat.onTurnResolved?.(entry); } catch { /* non-fatal */ }
    }

    try {
      if (decision === 'card') {
        const cardState = state as unknown as CardChoiceState;
        const card = strat.chooseCard(cardState);

        const output: RecommendResult = {
          meta: createMeta('recommend', startTime),
          decision: 'card',
          strategy: strategyName,
          recommendation: { card: card as number, confidence: null, alternatives: [] },
          stateValid: missingFields.length === 0,
          stateWarnings: warnings,
        };
        console.log(format(output, fmt));
      } else {
        const rowState = state as unknown as RowChoiceState;
        const row = strat.chooseRow(rowState);

        const output: RecommendResult = {
          meta: createMeta('recommend', startTime),
          decision: 'row',
          strategy: strategyName,
          recommendation: { rowIndex: row as number, confidence: null, alternatives: [] },
          stateValid: missingFields.length === 0,
          stateWarnings: warnings,
        };
        console.log(format(output, fmt));
      }
    } catch (err) {
      outputError(fmt, 'ENGINE_ERROR', `Strategy error: ${(err as Error).message}`);
      process.exit(2);
    }
  });
