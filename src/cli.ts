import { Command } from 'commander';
import { loadConfig } from './config.js';
import { runDiffs } from './diff-runner.js';
import { createLogger, newRunId } from './logger.js';
import { createNotifier } from './notify.js';
import { runSync } from './orchestrator/pipeline.js';
import { runRevert } from './orchestrator/revert.js';
import { runWipe } from './orchestrator/wipe.js';
import { runSmokeOne } from './smoke.js';

const program = new Command();
program.name('xyz-sync').description('Trends.nz → GoHighLevel sync tool').version('0.1.0');

program
  .command('diff')
  .description('Run the python diff scripts to produce changes.csv and category_changes.csv')
  .action(async () => {
    const cfg = loadConfig();
    const runId = newRunId();
    const logger = createLogger({ runId, logDir: cfg.logDir, level: cfg.logLevel });
    await runDiffs({ dataDir: cfg.dataDir, pythonBin: cfg.pythonBin, scriptsDir: '.', logger });
    logger.info('diff complete');
  });

program
  .command('sync')
  .description('Run the full sync pipeline: diff → collections → products')
  .option('--dry-run', 'no GHL writes, just log what would happen')
  .option('--allow-create-without-state', 'allow product creation when state.json is empty AND GHL has products (risk: duplicates)')
  .option('--skip-diff', 'skip running the python diff scripts (use existing changes.csv)')
  .action(async (opts) => {
    const cfg = loadConfig();
    const runId = newRunId();
    const logger = createLogger({ runId, logDir: cfg.logDir, level: cfg.logLevel });
    const notifier = createNotifier(cfg, logger);
    try {
      await runSync({
        cfg,
        logger,
        runId,
        notifier,
        dryRun: opts.dryRun,
        allowCreateWithoutState: opts.allowCreateWithoutState,
        skipDiff: opts.skipDiff,
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'sync FAILED');
      process.exit(1);
    }
  });

program
  .command('revert <runId>')
  .description('Undo a previous sync run (delete created products, restore updated ones from baseline)')
  .option('--dry-run', 'log every action but do not call the API or write state')
  .action(async (targetRunId, opts) => {
    const cfg = loadConfig();
    const runId = newRunId();
    const logger = createLogger({ runId, logDir: cfg.logDir, level: cfg.logLevel });
    try {
      await runRevert({ cfg, logger, runId, targetRunId, dryRun: opts.dryRun });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'revert FAILED');
      process.exit(1);
    }
  });

program
  .command('wipe')
  .description('DESTRUCTIVE: delete every product + collection in state.json from the store')
  .option('--dry-run', 'log every action but do not call the API or write state')
  .option('--yes', 'skip the interactive confirmation prompt')
  .action(async (opts) => {
    if (!opts.dryRun && !opts.yes) {
      const { stdin, stdout } = process;
      stdout.write(
        '⚠  This will DELETE every product and collection listed in state.json from your store.\n' +
          '   This cannot be undone. Type "yes" to confirm: ',
      );
      const answer: string = await new Promise((res) => {
        stdin.once('data', (d) => res(d.toString().trim()));
      });
      if (answer.toLowerCase() !== 'yes') {
        console.log('cancelled.');
        process.exit(0);
      }
    }
    const cfg = loadConfig();
    const runId = newRunId();
    const logger = createLogger({ runId, logDir: cfg.logDir, level: cfg.logLevel });
    try {
      await runWipe({ cfg, logger, runId, dryRun: opts.dryRun });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'wipe FAILED');
      process.exit(1);
    }
  });

program
  .command('smoke-one')
  .description('Smoke test: pre-flight scope probes + create one product end-to-end')
  .option('--code <code>', 'product code from changes.csv to push (default: first NEW)', '')
  .action(async (opts) => {
    const cfg = loadConfig();
    const runId = newRunId();
    const logger = createLogger({ runId, logDir: cfg.logDir, level: cfg.logLevel });
    try {
      await runSmokeOne({ cfg, logger, runId, code: opts.code });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'smoke-one FAILED');
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
