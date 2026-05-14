import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
  REQUIRED_SCOPES,
} from '../src/oauth/flow.js';

const mswServer = setupServer();

beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterAll(() => mswServer.close());
afterEach(() => mswServer.resetHandlers());

describe('buildAuthorizeUrl', () => {
  test('encodes correctly with space-separated scopes', () => {
    const url = buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: 'http://localhost:3000/api/oauth/callback',
      scopes: REQUIRED_SCOPES,
      state: 'nonce-abc',
    });
    const u = new URL(url);
    expect(u.host).toBe('marketplace.leadconnectorhq.com');
    expect(u.pathname).toBe('/oauth/chooselocation');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('state')).toBe('nonce-abc');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/oauth/callback');
    const scope = u.searchParams.get('scope') ?? '';
    expect(scope).toContain('products.write');
    expect(scope).toContain('medias.write');
    expect(scope).toContain('products/collection.write');
    // Space-separated, exactly 8 scopes
    expect(scope.split(' ').length).toBe(8);
  });
});

describe('exchangeCode', () => {
  test('sends form-urlencoded with grant_type=authorization_code and user_type=Location', async () => {
    let capturedBody = '';
    let capturedContentType = '';
    mswServer.use(
      http.post('https://services.leadconnectorhq.com/oauth/token', async ({ request }) => {
        capturedBody = await request.text();
        capturedContentType = request.headers.get('content-type') ?? '';
        return HttpResponse.json({
          access_token: 'at1',
          refresh_token: 'rt1',
          expires_in: 86399,
          scope: 'products.write',
          token_type: 'Bearer',
          locationId: 'loc1',
          companyId: 'co1',
          userId: 'u1',
          userType: 'Location',
        });
      }),
    );
    const tokens = await exchangeCode({
      clientId: 'cid',
      clientSecret: 'sec',
      code: 'auth1',
      redirectUri: 'http://localhost:3000/api/oauth/callback',
    });
    expect(capturedContentType).toContain('application/x-www-form-urlencoded');
    expect(capturedBody).toContain('grant_type=authorization_code');
    expect(capturedBody).toContain('user_type=Location');
    expect(capturedBody).toContain('code=auth1');
    expect(capturedBody).toContain('client_id=cid');
    expect(tokens.accessToken).toBe('at1');
    expect(tokens.refreshToken).toBe('rt1');
    expect(tokens.locationId).toBe('loc1');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  test('throws on non-200', async () => {
    mswServer.use(
      http.post('https://services.leadconnectorhq.com/oauth/token', () =>
        HttpResponse.json({ error: 'invalid_request', error_description: 'bad code' }, { status: 400 }),
      ),
    );
    await expect(
      exchangeCode({ clientId: 'cid', clientSecret: 's', code: 'x', redirectUri: 'http://localhost:3000/api/oauth/callback' }),
    ).rejects.toThrow(/bad code|invalid_request|400/);
  });
});

describe('refreshTokens', () => {
  test('sends grant_type=refresh_token with user_type=Location and returns NEW refresh_token', async () => {
    let capturedBody = '';
    mswServer.use(
      http.post('https://services.leadconnectorhq.com/oauth/token', async ({ request }) => {
        capturedBody = await request.text();
        return HttpResponse.json({
          access_token: 'at2',
          refresh_token: 'rt2-NEW',
          expires_in: 86399,
          scope: 'products.write',
          token_type: 'Bearer',
          locationId: 'loc1',
          companyId: 'co1',
          userId: 'u1',
          userType: 'Location',
        });
      }),
    );
    const tokens = await refreshTokens({
      clientId: 'cid',
      clientSecret: 'sec',
      refreshToken: 'rt1',
      redirectUri: 'http://localhost:3000/api/oauth/callback',
    });
    expect(capturedBody).toContain('grant_type=refresh_token');
    expect(capturedBody).toContain('refresh_token=rt1');
    expect(capturedBody).toContain('user_type=Location');
    expect(capturedBody).toContain('redirect_uri='); // present
    // CRITICAL: caller MUST persist this rotated refresh_token before retrying
    expect(tokens.refreshToken).toBe('rt2-NEW');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 86_000_000);
  });

  test('throws ReinstallRequiredError on invalid_grant', async () => {
    mswServer.use(
      http.post('https://services.leadconnectorhq.com/oauth/token', () =>
        HttpResponse.json(
          { error: 'invalid_grant', error_description: 'This refresh token is invalid' },
          { status: 400 },
        ),
      ),
    );
    await expect(
      refreshTokens({
        clientId: 'cid',
        clientSecret: 's',
        refreshToken: 'old',
        redirectUri: 'http://localhost:3000/api/oauth/callback',
      }),
    ).rejects.toThrow(/refresh failed/i);
  });
});
