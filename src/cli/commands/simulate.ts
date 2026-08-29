import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { runBatch } from '../../sim/index.js';
import { strategies, parseStrategySpec } from '../../engine/index.js';
import { format } from '../formatters/index.js';
import type { SimulateResult, StrategyResultRow, SeatResultRow, OutputFormat } from '../formatters/types.js';
import { didYouMean, outputError, createMeta, parseStrategies } from '../helpers.js';
import { computeStats } from '../../sim/stats.js';


function buildResultRows(
  result: import('../../sim/types.js').BatchResult,
  config: import('../../sim/types.js').SimConfig,
): StrategyResultRow[] {
  const rows: StrategyResultRow[] = [];
  for (const [strategy, stats] of result.perStrategy) {
    const seatIndices: number[] = [];
    const playerIds: string[] = [];
    config.players.forEach((p, i) => {
      if (p.strategy === strategy) {
        seatIndices.push(i);
        playerIds.push(p.id);
      }
    });
    rows.push({
      strategy,
      seatIndices,
      playerIds,
      playerCount: seatIndices.length,
      wins: stats.wins,
      winRate: stats.winRate,
      avgScore: stats.avgScore,
      avgWinningScore: stats.avgWinningScore,
      medianScore: stats.medianScore,
      minScore: stats.minScore,
      maxScore: stats.maxScore,
      scoreStdDev: stats.scoreStdDev,
    });
  }
  return rows;
}

function buildSeatRows(
  result: import('../../sim/types.js').BatchResult,
  config: import('../../sim/types.js').SimConfig,
): SeatResultRow[] {
  const rows: SeatResultRow[] = [];
  const numPlayers = config.players.length;

  for (let seat = 0; seat < numPlayers; seat++) {
    const player = config.players[seat];
    const scores: number[] = [];
    const winningScores: number[] = [];
    let wins = 0;

    for (const game of result.gameResults) {
      const pr = game.playerResults.find((p) => p.id === player.id)!;
      scores.push(pr.finalScore);
      if (pr.rank === 1) {
        wins++;
        winningScores.push(pr.finalScore);
      }
    }

    const stats = computeStats(scores, wins, result.gamesPlayed, winningScores);
    rows.push({
      seatIndex: seat,
      playerId: player.id,
      strategy: player.strategy,
      wins: stats.wins,
      winRate: stats.winRate,
      avgScore: stats.avgScore,
      avgWinningScore: stats.avgWinningScore,
      medianScore: stats.medianScore,
      minScore: stats.minScore,
      maxScore: stats.maxScore,
      scoreStdDev: stats.scoreStdDev,
    });
  }

  return rows;
}

export const simulateCommand = new Command('simulate')
  .description('Run batch simulations across strategies')
  .requiredOption('-s, --strategies <strategies>', 'Comma-separated strategy names or JSON array')
  .option('-n, --games <count>', 'Number of games to simulate', '100')
  .option('-S, --seed <seed>', 'Random seed for reproducibility')
  .option('-f, --format <format>', 'Output format (table, json, csv)', 'table')
  .option('-v, --verbose', 'Enable verbose output')
  .option('--dry-run', 'Validate options without running')
  .action((opts) => {
    const fmt = opts.format as OutputFormat;
    const startTime = Date.now();

    // Parse strategies (supports name:key=val,key=val syntax)
    let strategySpecs: { name: string; options?: Record<string, unknown> }[];
    const raw = opts.strategies as string;
    try {
      const names = parseStrategies(raw);
      strategySpecs = names.map(parseStrategySpec);
    } catch {
      outputError(fmt, 'INVALID_STRATEGY', `Failed to parse strategies: ${raw}`);
      process.exit(1);
    }

    // Validate strategies exist
    for (const spec of strategySpecs) {
      if (!strategies.has(spec.name)) {
        const valid = [...strategies.keys()];
        const suggestion = didYouMean(spec.name, valid);
        outputError(
          fmt,
          'INVALID_STRATEGY',
          `Unknown strategy '${spec.name}'.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`,
          valid,
        );
        process.exit(1);
      }
    }

    // Validate player count
    if (strategySpecs.length < 2 || strategySpecs.length > 10) {
      outputError(fmt, 'INVALID_PLAYER_COUNT', `Need 2–10 strategies, got ${strategySpecs.length}.`, [
        'Provide 2 to 10 comma-separated strategy names',
      ]);
      process.exit(1);
    }

    // Validate format
    if (!['table', 'json', 'csv'].includes(fmt)) {
      outputError(fmt, 'INVALID_FORMAT', `Unknown format '${fmt}'.`, ['table', 'json', 'csv']);
      process.exit(1);
    }

    const games = parseInt(opts.games, 10);
    if (!Number.isInteger(games) || games <= 0 || String(opts.games).trim() !== String(games)) {
      outputError(fmt, 'INVALID_ARGUMENTS', `--games must be a positive integer, got '${opts.games}'.`);
      process.exit(1);
      return;
    }
    const seed = opts.seed ?? randomUUID();

    // Dry run
    if (opts.dryRun) {
      console.log(JSON.stringify({ dryRun: true, strategies: strategySpecs.map(s => s.name), games, seed, format: fmt }));
      return;
    }

    // Build SimConfig
    const config = {
      players: strategySpecs.map((s, i) => ({
        id: `player-${i}`,
        strategy: s.name,
        ...(s.options ? { strategyOptions: s.options } : {}),
      })),
      seed,
    };

    // Run batch
    try {
      const result = runBatch(config, games, seed);

      const output: SimulateResult = {
        meta: createMeta('simulate', startTime),
        gamesPlayed: result.gamesPlayed,
        strategies: strategySpecs.map(s => s.name),
        seed,
        results: buildResultRows(result, config),
        perSeat: buildSeatRows(result, config),
      };

      console.log(format(output, fmt));
    } catch (err) {
      outputError(fmt, 'ENGINE_ERROR', `Engine error: ${(err as Error).message}`);
      process.exit(2);
    }
  });
