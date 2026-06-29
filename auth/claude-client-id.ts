// Provides the Anthropic OAuth client_id used for the PKCE login flow.
//
// Anthropic does not publicly issue OAuth client_ids to third-party apps.
// Swarmly supports two auth modes that do NOT require a client_id:
//   1. API key  (sk-ant-api03-*)  — from console.anthropic.com
//   2. Subscription token (sk-ant-oat01-*) — from `claude setup-token` CLI
//
// Full PKCE OAuth is available only when CLAUDE_OAUTH_CLIENT_ID is set
// (e.g. if Anthropic issues a client_id for your app in the future, or for
// internal/enterprise deployments).

import { execSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

let _cached: string | null = null;

export function getOAuthClientId(): string {
  if (process.env.CLAUDE_OAUTH_CLIENT_ID) return process.env.CLAUDE_OAUTH_CLIENT_ID;
  if (_cached !== null) return _cached;

  _cached = detectFromGlobalCli() ?? '';
  if (_cached) {
    console.log('[OAuth] Auto-detected client_id from globally installed claude CLI');
  }
  return _cached;
}

export function isOAuthReady(): boolean {
  return !!getOAuthClientId() && !!process.env.CLAUDE_OAUTH_REDIRECT_URI;
}

// Scan the globally-installed @anthropic-ai/claude-code JS files for the UUID.
// This only works if the user has claude CLI installed globally with npm/pnpm
// (not the compiled binary-only package, which ships no greppable JS).
function detectFromGlobalCli(): string | null {
  const dirs: string[] = [];

  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8', timeout: 5000 }).trim();
    dirs.push(join(npmRoot, '@anthropic-ai', 'claude-code'));
  } catch { /* ignore */ }

  const extraRoots = [
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code',
    '/usr/lib/node_modules/@anthropic-ai/claude-code',
    `${process.env.HOME ?? ''}/.npm/global/node_modules/@anthropic-ai/claude-code`,
    `${process.env.HOME ?? ''}/.local/share/pnpm/global/5/node_modules/@anthropic-ai/claude-code`,
  ];
  dirs.push(...extraRoots);

  for (const dir of dirs) {
    const found = searchForClientId(dir);
    if (found) return found;
  }
  return null;
}

function searchForClientId(dir: string): string | null {
  const patterns = [
    /client_id['":\s]+['"]([0-9a-f-]{36})['"]/i,
    /clientId['":\s]+['"]([0-9a-f-]{36})['"]/i,
    /OAUTH_CLIENT_ID['":\s=]+['"]([0-9a-f-]{36})['"]/i,
  ];

  try {
    const files = findJsFiles(dir, 4);
    for (const file of files) {
      try {
        const src = readFileSync(file, 'utf8');
        if (!/oauth|client.?id/i.test(src)) continue;
        for (const pattern of patterns) {
          const m = src.match(pattern);
          if (m?.[1] && m[1] !== '00000000-0000-0000-0000-000000000000') return m[1];
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir doesn't exist */ }
  return null;
}

function findJsFiles(dir: string, maxDepth: number): string[] {
  if (maxDepth === 0) return [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.js')) files.push(full);
      else if (e.isDirectory() && e.name !== 'node_modules') {
        files.push(...findJsFiles(full, maxDepth - 1));
      }
    }
    return files;
  } catch { return []; }
}
