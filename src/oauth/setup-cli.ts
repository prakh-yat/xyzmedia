import { randomBytes } from 'node:crypto';
import { writeFile, chmod } from 'node:fs/promises';
import open from 'open';
import { loadConfigForOAuthSetup } from '../config.js';
import { buildAuthorizeUrl, exchangeCode, REQUIRED_SCOPES, type Tokens } from './flow.js';
import { assertPortFree, waitForCallback } from './server.js';

async function main(): Promise<void> {
  const cfg = loadConfigForOAuthSetup();
  const url = new URL(cfg.ghlRedirectUri);
  const port = url.port ? Number(url.port) : 80;

  console.log('\n┌───────────────────────────────────────────────────────────┐');
  console.log('│ GoHighLevel OAuth Setup                                   │');
  console.log('└───────────────────────────────────────────────────────────┘\n');
  console.log('Pre-flight checks:');
  console.log(`  • Redirect URI: ${cfg.ghlRedirectUri}`);
  console.log(`  • Port:         ${port}`);
  console.log('  • Confirm this redirect URI is registered in your Marketplace app');
  console.log("    under 'Redirect URLs' (exact match — trailing slashes matter).\n");
  console.log('  Required scopes:');
  for (const s of REQUIRED_SCOPES) console.log(`    - ${s}`);
  console.log();

  // Pre-flight: port available?
  await assertPortFree(port);
  console.log(`  ✓ Port ${port} is free.\n`);

  const state = randomBytes(16).toString('hex');
  const authUrl = buildAuthorizeUrl({
    clientId: cfg.ghlClientId,
    redirectUri: cfg.ghlRedirectUri,
    scopes: REQUIRED_SCOPES,
    state,
  });

  console.log('Opening browser. If it does not open automatically, paste this URL:\n');
  console.log(`  ${authUrl}\n`);

  // Listen BEFORE opening browser so we don't miss the redirect
  const callbackPromise = waitForCallback({
    port,
    expectedState: state,
    timeoutMs: 10 * 60 * 1000, // 10 min
  });

  try {
    await open(authUrl);
  } catch {
    // Some headless envs can't open a browser; ignore and let user paste manually
  }

  console.log('Waiting for browser callback (timeout: 10 min)...\n');
  const { code } = await callbackPromise;

  console.log('✓ Got auth code, exchanging for tokens...');

  const tokens = await exchangeCode({
    clientId: cfg.ghlClientId,
    clientSecret: cfg.ghlClientSecret,
    code,
    redirectUri: cfg.ghlRedirectUri,
  });

  await persistTokens(cfg.tokensFile, tokens);

  console.log('\n✓ Success!\n');
  console.log(`  Location ID: ${tokens.locationId}`);
  console.log(`  Scopes:      ${tokens.scope}`);
  console.log(`  Expires:     ${new Date(tokens.expiresAt).toISOString()}`);
  console.log(`  Saved to:    ${cfg.tokensFile} (mode 0600, gitignored)`);
  console.log('\nYou can also paste these into .env if you prefer:');
  console.log(`  GHL_ACCESS_TOKEN=${tokens.accessToken}`);
  console.log(`  GHL_REFRESH_TOKEN=${tokens.refreshToken}`);
  console.log(`  GHL_TOKEN_EXPIRES_AT=${tokens.expiresAt}`);
  console.log('\nNext: npm run sync:dry');
}

async function persistTokens(path: string, tokens: Tokens): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

main().catch((err) => {
  console.error('\n✗ OAuth setup failed:', err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
