import crypto from 'crypto';
import { getOAuthClientId, isOAuthReady } from './claude-client-id.js';

// ── OAuth configuration ───────────────────────────────────────────────────────
// client_id is auto-detected from the installed `claude` CLI on the server,
// or can be overridden via CLAUDE_OAUTH_CLIENT_ID env var.
// CLAUDE_OAUTH_REDIRECT_URI must point to your publicly accessible server,
// e.g. https://swarmly.example.com/oauth/callback

// Claude Code's registered redirect URI — the only one Anthropic's OAuth server accepts for this client_id
export const OAUTH_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
export const OAUTH_AUTH_URL = process.env.CLAUDE_OAUTH_AUTH_URL ?? 'https://claude.com/cai/oauth/authorize';
export const OAUTH_TOKEN_URL = process.env.CLAUDE_OAUTH_TOKEN_URL ?? 'https://platform.claude.com/v1/oauth/token';
export const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference';

// Re-export for convenience
export { getOAuthClientId, isOAuthReady };

export function isOAuthConfigured(): boolean {
  return isOAuthReady();
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

// ── Auth URL builder ──────────────────────────────────────────────────────────

export function buildAuthUrl(state: string, challenge: string): string {
  const url = new URL(OAUTH_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', getOAuthClientId());
  url.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI);
  url.searchParams.set('scope', OAUTH_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

// ── Token exchange ────────────────────────────────────────────────────────────

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

export async function exchangeCode(code: string, verifier: string): Promise<OAuthTokens> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: getOAuthClientId(),
      redirect_uri: OAUTH_REDIRECT_URI,
      code,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }
  const data = await res.json() as Record<string, unknown>;
  return {
    accessToken: data['access_token'] as string,
    ...(data['refresh_token'] !== undefined ? { refreshToken: data['refresh_token'] as string } : {}),
    expiresIn: (data['expires_in'] as number | undefined) ?? 3600,
  };
}

// ── User info ─────────────────────────────────────────────────────────────────
// Tries the standard OAuth2 userinfo endpoint and Anthropic's account endpoint.
// Returns whatever fields are available; caller must handle nulls gracefully.

export interface OAuthUserInfo {
  email?: string;
  name?: string;
  organizationName?: string;
  plan?: string;
}

export async function fetchUserInfo(accessToken: string): Promise<OAuthUserInfo> {
  const endpoints = [
    process.env.CLAUDE_OAUTH_USERINFO_URL ?? 'https://claude.ai/oauth/userinfo',
    'https://api.anthropic.com/v1/account',
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!res.ok) continue;
      const data = await res.json() as Record<string, unknown>;
      const org = (data['organization'] ?? data['org'] ?? data['workspace']) as Record<string, unknown> | undefined;
      const email = (data['email'] ?? data['sub']) as string | undefined;
      const name = data['name'] as string | undefined;
      const orgName = (org?.['name'] ?? data['organization_name']) as string | undefined;
      const plan = (data['plan'] ?? data['subscription_plan'] ?? org?.['plan']) as string | undefined;
      return {
        ...(email !== undefined ? { email } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(orgName !== undefined ? { organizationName: orgName } : {}),
        ...(plan !== undefined ? { plan } : {}),
      };
    } catch { /* try next */ }
  }
  return {};
}

export async function refreshOAuthToken(refreshToken: string): Promise<OAuthTokens> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: getOAuthClientId(),
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json() as Record<string, unknown>;
  const newRefreshToken = (data['refresh_token'] as string | undefined) ?? refreshToken;
  return {
    accessToken: data['access_token'] as string,
    ...(newRefreshToken !== undefined ? { refreshToken: newRefreshToken } : {}),
    expiresIn: (data['expires_in'] as number | undefined) ?? 3600,
  };
}
