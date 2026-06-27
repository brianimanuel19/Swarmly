import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import type { SampledRepo } from '../types/index.js';
import { config } from '../config/config.js';

const execAsync = promisify(exec);

// ─── GitHub URL detection ─────────────────────────────────────────────────────

const GITHUB_URL_RE = /https?:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/;

export function detectGithubUrl(text: string): string | null {
  const match = GITHUB_URL_RE.exec(text);
  return match ? match[0]!.replace(/\.git$/, '') : null;
}

export function parseGithubUrl(url: string): { owner: string; repo: string; fullName: string } {
  const match = GITHUB_URL_RE.exec(url);
  if (!match) throw new Error(`Invalid GitHub URL: ${url}`);
  const owner = match[1]!;
  const repo = match[2]!.replace(/\.git$/, '');
  return { owner, repo, fullName: `${owner}/${repo}` };
}

// ─── Clone ────────────────────────────────────────────────────────────────────

export async function cloneRepo(
  url: string,
  destPath: string,
  token?: string,
): Promise<void> {
  if (fs.existsSync(destPath)) {
    fs.rmSync(destPath, { recursive: true, force: true });
  }
  fs.mkdirSync(destPath, { recursive: true });

  let cloneUrl = url.endsWith('.git') ? url : `${url}.git`;
  if (token) {
    const u = new URL(cloneUrl);
    cloneUrl = `https://${token}@${u.host}${u.pathname}`;
  }

  await execAsync(`git clone --depth 1 "${cloneUrl}" "${destPath}"`, {
    timeout: 120_000,
  });
}

// ─── Smart file sampling ──────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', 'vendor', '.git', 'dist', 'build', '__pycache__',
  '.venv', 'venv', '.next', '.nuxt', 'coverage', '.nyc_output',
  'target', '.gradle', 'out', '.cache', '.parcel-cache',
]);

const SKIP_EXTENSIONS = new Set([
  '.lock', '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.zip', '.tar', '.gz', '.pdf', '.exe', '.dll', '.so', '.dylib',
  '.class', '.pyc', '.wasm', '.ttf', '.woff', '.woff2', '.eot',
  '.mp3', '.mp4', '.avi', '.mov', '.webm',
]);

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.rb', '.php', '.cs', '.cpp', '.c', '.h',
  '.vue', '.svelte', '.elm',
]);

function filePriority(relPath: string): number {
  const base = path.basename(relPath).toLowerCase();
  const dir = path.dirname(relPath);

  if (dir === '.' && /^(readme|package\.json|go\.mod|requirements\.txt|cargo\.toml|\.env\.example|tsconfig\.json|makefile|dockerfile)/i.test(base)) return 0;
  if (dir === '.' && /^(docker-compose|\.eslintrc|\.prettierrc|pyproject\.toml|build\.gradle|pom\.xml)/i.test(base)) return 1;
  if (/^\.github[/\\]workflows[/\\]/.test(relPath) || /^(\.gitlab-ci\.yml|jenkinsfile)$/i.test(base)) return 2;
  if (/[/\\]?(index|main|app|server|cmd)\.(ts|js|py|go|rs|java|kt|mjs|cjs)$/.test(relPath)) return 3;
  if (SOURCE_EXTENSIONS.has(path.extname(base))) return 4 + relPath.split(/[/\\]/).length;
  return 100;
}

function walkDir(dir: string, baseDir: string, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      walkDir(fullPath, baseDir, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!SKIP_EXTENSIONS.has(ext)) {
        results.push(relPath);
      }
    }
  }
}

export async function readRepoFiles(repoPath: string): Promise<SampledRepo> {
  const { maxFiles, maxFileSizeBytes } = config.repoAnalysis;

  const allFiles: string[] = [];
  walkDir(repoPath, repoPath, allFiles);
  allFiles.sort((a, b) => filePriority(a) - filePriority(b));

  const fileTree = allFiles.slice(0, 200);
  const toSample = allFiles.slice(0, maxFiles);
  const sampledFiles: Array<{ path: string; content: string }> = [];

  for (const relPath of toSample) {
    const fullPath = path.join(repoPath, relPath);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > maxFileSizeBytes) {
        if (filePriority(relPath) < 4) {
          const raw = fs.readFileSync(fullPath, 'utf8');
          sampledFiles.push({ path: relPath, content: raw.slice(0, 2000) + '\n... (truncated)' });
        }
        continue;
      }
      const content = fs.readFileSync(fullPath, 'utf8');
      sampledFiles.push({ path: relPath, content });
    } catch {
      // skip unreadable
    }
  }

  return { repoPath, fileCount: allFiles.length, sampledFiles, fileTree };
}
