import Docker from 'dockerode';
import { FileChange } from '../types/index.js';
import { sandboxManager } from './sandbox-manager.js';
import path from 'path';
import { config } from '../config/config.js';

// ---------------------------------------------------------------------------
// Helper: collect Docker exec stream output
// ---------------------------------------------------------------------------

// Docker multiplexes stdout/stderr with an 8-byte header when TTY is false.
function demuxDockerStream(raw: Buffer): { stdout: string; stderr: string } {
  let offset = 0;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  while (offset + 8 <= raw.length) {
    const streamType = raw[offset]; // 1 = stdout, 2 = stderr
    const size = raw.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > raw.length) break;
    const payload = raw.slice(offset, offset + size);
    offset += size;
    if (streamType === 1) stdoutChunks.push(payload);
    else if (streamType === 2) stderrChunks.push(payload);
  }

  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
    stderr: Buffer.concat(stderrChunks).toString('utf-8'),
  };
}

async function runExecRaw(
  container: Docker.Container,
  cmd: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  const rawBuffer = await Promise.race<Buffer>([
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      (stream as NodeJS.ReadableStream).on('data', (c: Buffer) => chunks.push(c));
      (stream as NodeJS.ReadableStream).on('end', () => resolve(Buffer.concat(chunks)));
      (stream as NodeJS.ReadableStream).on('error', reject);
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Exec timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);

  const { stdout, stderr } = demuxDockerStream(rawBuffer);
  const inspected = await exec.inspect();
  return { stdout, stderr, exitCode: inspected.ExitCode ?? 1 };
}

// For binary/tar streams we need the raw multiplexed buffer collected without demuxing
async function collectRawStream(
  stream: NodeJS.ReadableStream,
  timeoutMs = 300_000,
): Promise<Buffer> {
  return Promise.race<Buffer>([
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Stream timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// WorkspaceManager
// ---------------------------------------------------------------------------

export class WorkspaceManager {
  private docker: Docker;

  constructor() {
    this.docker = new Docker({ socketPath: config.sandbox.dockerSocket });
  }

  // -------------------------------------------------------------------------
  // writeFile — write content into a container path via base64 + sh decode
  // -------------------------------------------------------------------------
  async writeFile(projectId: string, filePath: string, content: string): Promise<void> {
    const sandbox = await sandboxManager.get(projectId);
    if (!sandbox) {
      throw new Error(`[WorkspaceManager] No sandbox for project ${projectId}`);
    }

    const container = this.docker.getContainer(sandbox.containerId);
    const absolutePath = this._resolvePath(sandbox.workDir, filePath);
    const dir = path.posix.dirname(absolutePath);

    // Ensure parent directory
    await runExecRaw(container, ['sh', '-c', `mkdir -p "${dir}"`]);

    // Encode content as base64 to safely transfer arbitrary text/binary
    const encoded = Buffer.from(content, 'utf-8').toString('base64');

    const result = await runExecRaw(container, [
      'sh',
      '-c',
      `echo '${encoded}' | base64 -d > "${absolutePath}"`,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`[WorkspaceManager] writeFile failed for ${absolutePath}: ${result.stderr}`);
    }
  }

  // -------------------------------------------------------------------------
  // readFile — read file content from container
  // -------------------------------------------------------------------------
  async readFile(projectId: string, filePath: string): Promise<string> {
    const sandbox = await sandboxManager.get(projectId);
    if (!sandbox) {
      throw new Error(`[WorkspaceManager] No sandbox for project ${projectId}`);
    }

    const container = this.docker.getContainer(sandbox.containerId);
    const absolutePath = this._resolvePath(sandbox.workDir, filePath);

    const result = await runExecRaw(container, ['cat', absolutePath]);

    if (result.exitCode !== 0) {
      throw new Error(`[WorkspaceManager] readFile failed for ${absolutePath}: ${result.stderr}`);
    }

    return result.stdout;
  }

  // -------------------------------------------------------------------------
  // deleteFile — remove a file from the container
  // -------------------------------------------------------------------------
  async deleteFile(projectId: string, filePath: string): Promise<void> {
    const sandbox = await sandboxManager.get(projectId);
    if (!sandbox) {
      throw new Error(`[WorkspaceManager] No sandbox for project ${projectId}`);
    }

    const container = this.docker.getContainer(sandbox.containerId);
    const absolutePath = this._resolvePath(sandbox.workDir, filePath);

    const result = await runExecRaw(container, ['rm', '-f', absolutePath]);
    if (result.exitCode !== 0) {
      throw new Error(`[WorkspaceManager] deleteFile failed for ${absolutePath}: ${result.stderr}`);
    }
  }

  // -------------------------------------------------------------------------
  // listFiles — list files in a directory within the container
  // -------------------------------------------------------------------------
  async listFiles(projectId: string, dir?: string): Promise<string[]> {
    const sandbox = await sandboxManager.get(projectId);
    if (!sandbox) {
      throw new Error(`[WorkspaceManager] No sandbox for project ${projectId}`);
    }

    const container = this.docker.getContainer(sandbox.containerId);
    const searchDir = dir ? this._resolvePath(sandbox.workDir, dir) : sandbox.workDir;

    const result = await runExecRaw(container, [
      'find',
      searchDir,
      '-type',
      'f',
      '-not',
      '-path',
      '*/node_modules/*',
      '-not',
      '-path',
      '*/.git/*',
      '-not',
      '-path',
      '*/__pycache__/*',
      '-not',
      '-path',
      '*/target/*',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`[WorkspaceManager] listFiles failed in ${searchDir}: ${result.stderr}`);
    }

    return result.stdout
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  }

  // -------------------------------------------------------------------------
  // fileExists — check if a file path exists in the container
  // -------------------------------------------------------------------------
  async fileExists(projectId: string, filePath: string): Promise<boolean> {
    const sandbox = await sandboxManager.get(projectId);
    if (!sandbox) {
      throw new Error(`[WorkspaceManager] No sandbox for project ${projectId}`);
    }

    const container = this.docker.getContainer(sandbox.containerId);
    const absolutePath = this._resolvePath(sandbox.workDir, filePath);

    const result = await runExecRaw(container, [
      'sh',
      '-c',
      `test -f "${absolutePath}" && echo yes || echo no`,
    ]);

    return result.stdout.trim() === 'yes';
  }

  // -------------------------------------------------------------------------
  // applyChanges — apply a batch of FileChange objects to the workspace
  // -------------------------------------------------------------------------
  async applyChanges(projectId: string, changes: FileChange[]): Promise<void> {
    const sandbox = await sandboxManager.get(projectId);
    if (!sandbox) {
      throw new Error(`[WorkspaceManager] No sandbox for project ${projectId}`);
    }

    // Ensure parent dirs for all create/modify actions upfront
    const dirsToCreate = new Set<string>();
    for (const change of changes) {
      if (change.action !== 'delete') {
        const absolutePath = this._resolvePath(sandbox.workDir, change.path);
        dirsToCreate.add(path.posix.dirname(absolutePath));
      }
    }

    if (dirsToCreate.size > 0) {
      const container = this.docker.getContainer(sandbox.containerId);
      await runExecRaw(container, [
        'sh',
        '-c',
        Array.from(dirsToCreate)
          .map((d) => `mkdir -p "${d}"`)
          .join(' && '),
      ]);
    }

    // Apply changes sequentially to preserve ordering (e.g. create before modify)
    for (const change of changes) {
      try {
        if (change.action === 'create' || change.action === 'modify') {
          await this.writeFile(projectId, change.path, change.content);
        } else if (change.action === 'delete') {
          await this.deleteFile(projectId, change.path);
        }
      } catch (err: unknown) {
        throw new Error(
          `[WorkspaceManager] applyChanges failed on ${change.path} (${change.action}): ${(err as Error).message}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // readCodebase — read all files below the project workspace into a map
  // -------------------------------------------------------------------------
  async readCodebase(projectId: string, maxFileSizeKb = 50): Promise<Record<string, string>> {
    const sandbox = await sandboxManager.get(projectId);
    if (!sandbox) {
      throw new Error(`[WorkspaceManager] No sandbox for project ${projectId}`);
    }

    const container = this.docker.getContainer(sandbox.containerId);

    // List all files excluding noise directories
    const listResult = await runExecRaw(container, [
      'find',
      sandbox.workDir,
      '-type',
      'f',
      '-not',
      '-path',
      '*/node_modules/*',
      '-not',
      '-path',
      '*/.git/*',
      '-not',
      '-path',
      '*/__pycache__/*',
      '-not',
      '-path',
      '*/target/*',
      '-not',
      '-path',
      '*/.next/*',
      '-not',
      '-path',
      '*/dist/*',
      '-not',
      '-path',
      '*/build/*',
    ]);

    if (listResult.exitCode !== 0) {
      throw new Error(`[WorkspaceManager] readCodebase listing failed: ${listResult.stderr}`);
    }

    const filePaths = listResult.stdout
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);

    const codebase: Record<string, string> = {};
    const maxBytes = maxFileSizeKb * 1024;

    // Read each file; skip files that are too large
    await Promise.allSettled(
      filePaths.map(async (absPath) => {
        try {
          // Check file size first
          const sizeResult = await runExecRaw(container, [
            'sh',
            '-c',
            `wc -c < "${absPath}" 2>/dev/null || echo 0`,
          ]);
          const fileSize = parseInt(sizeResult.stdout.trim(), 10);
          if (fileSize > maxBytes) {
            console.log(`[WorkspaceManager] Skipping large file (${fileSize} bytes): ${absPath}`);
            return;
          }

          const readResult = await runExecRaw(container, ['cat', absPath]);
          if (readResult.exitCode === 0) {
            // Store with relative path as key
            const relPath = absPath.startsWith(sandbox.workDir)
              ? absPath.slice(sandbox.workDir.length + 1)
              : absPath;
            codebase[relPath] = readResult.stdout;
          }
        } catch (err: unknown) {
          console.warn(
            `[WorkspaceManager] Skipping unreadable file ${absPath}: ${(err as Error).message}`,
          );
        }
      }),
    );

    return codebase;
  }

  // -------------------------------------------------------------------------
  // exportZip — export the workspace as a gzipped tar Buffer
  // -------------------------------------------------------------------------
  async exportZip(projectId: string): Promise<Buffer> {
    const sandbox = await sandboxManager.get(projectId);
    if (!sandbox) {
      throw new Error(`[WorkspaceManager] No sandbox for project ${projectId}`);
    }

    const container = this.docker.getContainer(sandbox.containerId);

    // Use Docker's built-in archive endpoint for the workspace directory path.
    // This returns a tar stream directly from the container filesystem.
    try {
      const archiveStream = await container.getArchive({
        path: sandbox.workDir,
      });

      const rawBuffer = await collectRawStream(
        archiveStream as unknown as NodeJS.ReadableStream,
        config.sandbox.timeoutMs,
      );

      return rawBuffer;
    } catch (err: unknown) {
      // Fallback: use tar inside the container and demux the exec stream
      console.warn(
        `[WorkspaceManager] getArchive failed, falling back to exec tar: ${(err as Error).message}`,
      );

      const exec = await container.exec({
        Cmd: ['tar', '-czf', '-', sandbox.workDir],
        AttachStdout: true,
        AttachStderr: false,
        Tty: false,
      });

      const stream = await exec.start({ hijack: true, stdin: false });
      const rawBuffer = await collectRawStream(
        stream as unknown as NodeJS.ReadableStream,
        config.sandbox.timeoutMs,
      );

      // Demux and return only the stdout bytes (the actual tar data)
      const { stdout } = demuxDockerStream(rawBuffer);
      return Buffer.from(stdout, 'binary');
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _resolvePath(workDir: string, filePath: string): string {
    // If absolute path provided, use it; otherwise join with workDir
    if (path.posix.isAbsolute(filePath)) {
      return filePath;
    }
    // Normalise Windows-style separators just in case
    const normalised = filePath.replace(/\\/g, '/');
    return path.posix.join(workDir, normalised);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------
export const workspaceManager = new WorkspaceManager();
