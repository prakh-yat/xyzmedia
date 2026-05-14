/**
 * GoHighLevel OAuth 2.0 Authorization Code flow primitives.
 *
 * - Authorize URL: marketplace.leadconnectorhq.com/oauth/chooselocation
 * - Token endpoint: services.leadconnectorhq.com/oauth/token (form-urlencoded)
 * - user_type=Location for sub-account-scoped tokens
 * - Refresh tokens are rolling: every refresh response contains a NEW refresh_token,
 *   the old one is invalidated immediately. CALLER MUST PERSIST before retry.
 */

export const REQUIRED_SCOPES = [
  'products.readonly',
  'products.write',
  'products/prices.readonly',
  'products/prices.write',
  'products/collection.readonly',
  'products/collection.write',
  'medias.readonly',
  'medias.write',
] as const;

const AUTHORIZE_URL = 'https://marketplace.leadconnectorhq.com/oauth/chooselocation';
const TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  scope: string;
  locationId: string;
  companyId: string;
  userId: string;
}

export interface BuildAuthorizeUrlOpts {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
}

export function buildAuthorizeUrl(opts: BuildAuthorizeUrlOpts): string {
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    scope: opts.scopes.join(' '),
    state: opts.state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
  locationId?: string;
  companyId?: string;
  userId?: string;
  userType?: string;
}

function parseTokenResponse(j: TokenEndpointResponse): Tokens {
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Date.now() + j.expires_in * 1000,
    scope: j.scope ?? '',
    locationId: j.locationId ?? '',
    companyId: j.companyId ?? '',
    userId: j.userId ?? '',
  };
}

async function postToken(body: URLSearchParams): Promise<Tokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await res.text();
  let j: TokenEndpointResponse | { error?: string; error_description?: string; message?: string };
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`OAuth token endpoint returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = j as { error?: string; error_description?: string; message?: string };
    const detail = err.error_description ?? err.message ?? err.error ?? text;
    if (err.error === 'invalid_grant') {
      throw new ReinstallRequiredError(`OAuth refresh failed: ${detail}`);
    }
    throw new Error(`OAuth token exchange failed (${res.status}): ${detail}`);
  }
  return parseTokenResponse(j as TokenEndpointResponse);
}

export class ReinstallRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReinstallRequiredError';
  }
}

export interface ExchangeCodeOpts {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}

export async function exchangeCode(opts: ExchangeCodeOpts): Promise<Tokens> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    user_type: 'Location',
  });
  return postToken(body);
}

export interface RefreshTokensOpts {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  redirectUri: string;
}

export async function refreshTokens(opts: RefreshTokensOpts): Promise<Tokens> {
  // CRITICAL: send the same fields as exchangeCode plus user_type=Location.
  // Omitting user_type returns a Company token; omitting redirect_uri 422s on some tenants.
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    redirect_uri: opts.redirectUri,
    user_type: 'Location',
  });
  return postToken(body);
}
