import 'dotenv/config';
import { z } from 'zod';

const Schema = z.object({
  ghlClientId: z.string().min(1, 'GHL_CLIENT_ID required (get from Marketplace app)'),
  ghlClientSecret: z.string().min(1, 'GHL_CLIENT_SECRET required'),
  ghlRedirectUri: z.string().url().default('http://localhost:3000/api/oauth/callback'),
  ghlLocationId: z.string().min(1, 'GHL_LOCATION_ID required'),
  ghlBaseUrl: z.string().url().default('https://services.leadconnectorhq.com'),
  ghlApiVersion: z.string().default('2021-07-28'),
  ghlCurrency: z.enum(['USD', 'NZD', 'AUD', 'GBP', 'EUR']).default('USD'),

  dataDir: z.string().default('.'),
  stateFile: z.string().default('./state.json'),
  /** Separate state file for dry-runs so they can resume but never pollute the real run's state. */
  stateDryRunFile: z.string().default('./state.dryrun.json'),
  /** Snapshot of all GHL collections, refreshed at the end of every real sync. */
  collectionsJsonFile: z.string().default('./collections.json'),
  tokensFile: z.string().default('./tokens.json'),
  logDir: z.string().default('./logs'),
  reportDir: z.string().default('./reports'),

  notifyChannel: z.enum(['slack', 'email', 'none']).default('none'),
  slackWebhookUrl: z.string().url().optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.coerce.number().default(587),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  smtpFrom: z.string().optional(),
  smtpTo: z.string().optional(),

  dryRun: z.string().transform((v) => v === 'true').default('false'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  pythonBin: z.string().default('python3'),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(): Config {
  const raw = {
    ghlClientId: process.env.GHL_CLIENT_ID,
    ghlClientSecret: process.env.GHL_CLIENT_SECRET,
    ghlRedirectUri: process.env.GHL_REDIRECT_URI,
    ghlLocationId: process.env.GHL_LOCATION_ID,
    ghlBaseUrl: process.env.GHL_BASE_URL,
    ghlApiVersion: process.env.GHL_API_VERSION,
    ghlCurrency: process.env.GHL_CURRENCY,
    dataDir: process.env.DATA_DIR,
    stateFile: process.env.STATE_FILE,
    stateDryRunFile: process.env.STATE_DRY_RUN_FILE,
    collectionsJsonFile: process.env.COLLECTIONS_JSON_FILE,
    tokensFile: process.env.TOKENS_FILE,
    logDir: process.env.LOG_DIR,
    reportDir: process.env.REPORT_DIR,
    notifyChannel: process.env.NOTIFY_CHANNEL,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    smtpHost: process.env.SMTP_HOST,
    smtpPort: process.env.SMTP_PORT,
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
    smtpFrom: process.env.SMTP_FROM,
    smtpTo: process.env.SMTP_TO,
    dryRun: process.env.DRY_RUN,
    logLevel: process.env.LOG_LEVEL,
    pythonBin: process.env.PYTHON_BIN,
  };
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([_, v]) => v !== undefined));
  return Schema.parse(cleaned);
}

export function loadConfigForOAuthSetup(): Pick<Config, 'ghlClientId' | 'ghlClientSecret' | 'ghlRedirectUri' | 'tokensFile'> {
  const Mini = z.object({
    ghlClientId: z.string().min(1),
    ghlClientSecret: z.string().min(1),
    ghlRedirectUri: z.string().url().default('http://localhost:3000/api/oauth/callback'),
    tokensFile: z.string().default('./tokens.json'),
  });
  const cleaned = Object.fromEntries(
    Object.entries({
      ghlClientId: process.env.GHL_CLIENT_ID,
      ghlClientSecret: process.env.GHL_CLIENT_SECRET,
      ghlRedirectUri: process.env.GHL_REDIRECT_URI,
      tokensFile: process.env.TOKENS_FILE,
    }).filter(([_, v]) => v !== undefined),
  );
  return Mini.parse(cleaned);
}
