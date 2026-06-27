import Docker from 'dockerode';
import { Readable } from 'stream';
import { StackDomain, ExecutionResult, TestResult } from '../types/index.js';
import { sandboxManager } from './sandbox-manager.js';
import { config } from '../config/config.js';

// ---------------------------------------------------------------------------
// Helper: collect Docker exec output streams into strings
// ---------------------------------------------------------------------------

async function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

// Docker multiplexes stdout/stderr with an 8-byte header when TTY is false.
// Header: [stream_type(1), 0,0,0(3), size(4 big-endian)]
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

// ---------------------------------------------------------------------------
// Helper: run a single exec inside a container with timeout
// ---------------------------------------------------------------------------

async function runExec(
  container: Docker.Container,
  cmd: string[],
  timeoutMs: number,
): Promise<ExecutionResult> {
  const startTime = Date.now();

  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  // Collect all raw bytes with a timeout race
  const rawBufferPromise = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    (stream as Readable).on('data', (chunk: Buffer) => chunks.push(chunk));
    (stream as Readable).on('end', () => resolve(Buffer.concat(chunks)));
    (stream as Readable).on('error', reject);
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Exec timed out after ${timeoutMs}ms`)), timeoutMs),
  );

  let rawBuffer: Buffer;
  try {
    rawBuffer = await Promise.race([rawBufferPromise, timeoutPromise]);
  } catch (err: unknown) {
    // Best-effort: try to kill stream
    try {
      (stream as Readable).destroy();
    } catch {}
    const durationMs = Date.now() - startTime;
    return {
      stdout: '',
      stderr: (err as Error).message,
      exitCode: 1,
      durationMs,
      success: false,
    };
  }

  const { stdout, stderr } = demuxDockerStream(rawBuffer);

  // Inspect exit code
  const inspected = await exec.inspect();
  const exitCode: number = inspected.ExitCode ?? 1;
  const durationMs = Date.now() - startTime;

  return {
    stdout,
    stderr,
    exitCode,
    durationMs,
    success: exitCode === 0,
  };
}

// ---------------------------------------------------------------------------
// SandboxExecutor
// ---------------------------------------------------------------------------

export class SandboxExecutor {
  private docker: Docker;

  constructor() {
    this.docker = new Docker({ socketPath: config.sandbox.dockerSocket });
  }

  // -------------------------------------------------------------------------
  // exec — run an arbitrary shell command inside the project's container
  // -------------------------------------------------------------------------
  async exec(projectId: string, command: string): Promise<ExecutionResult> {
    const sandbox = await sandboxManager.get(projectId);
    if (!sandbox) {
      throw new Error(`[SandboxExecutor] No sandbox found for project ${projectId}`);
    }

    const container = this.docker.getContainer(sandbox.containerId);

    // Split command into argv array; handle quoted strings naively
    const cmd = this._splitCommand(command);
    return runExec(container, cmd, config.sandbox.timeoutMs);
  }

  // -------------------------------------------------------------------------
  // installDeps — detect package manager and install dependencies
  // -------------------------------------------------------------------------
  async installDeps(projectId: string): Promise<ExecutionResult> {
    const sandbox = await sandboxManager.get(projectId);
    if (!sandbox) {
      throw new Error(`[SandboxExecutor] No sandbox found for project ${projectId}`);
    }

    const container = this.docker.getContainer(sandbox.containerId);

    // Detect manifest files
    const manifestCheck = await runExec(
      container,
      ['find', sandbox.workDir, '-maxdepth', '1', '-type', 'f', '-name', '*'],
      30_000,
    );

    const files = manifestCheck.stdout.split('\n').map((f) => f.trim());

    let installCmd: string;
    if (files.some((f) => f.endsWith('package.json'))) {
      installCmd = 'pnpm install';
    } else if (files.some((f) => f.endsWith('requirements.txt'))) {
      installCmd = 'pip install -r requirements.txt';
    } else if (files.some((f) => f.endsWith('Cargo.toml'))) {
      installCmd = 'cargo build --release';
    } else if (files.some((f) => f.endsWith('go.mod'))) {
      installCmd = 'go mod download';
    } else {
      return {
        stdout: 'No recognisable dependency manifest found.',
        stderr: '',
        exitCode: 0,
        durationMs: 0,
        success: true,
      };
    }

    console.log(`[SandboxExecutor] Installing deps for ${projectId}: ${installCmd}`);
    return runExec(
      container,
      ['sh', '-c', `cd ${sandbox.workDir} && ${installCmd}`],
      config.sandbox.timeoutMs,
    );
  }

  // -------------------------------------------------------------------------
  // runTests — detect or use provided test command
  // -------------------------------------------------------------------------
  async runTests(projectId: string, command?: string): Promise<ExecutionResult> {
    const sandbox = await sandboxManager.get(projectId);
    if (!sandbox) {
      throw new Error(`[SandboxExecutor] No sandbox found for project ${projectId}`);
    }

    const container = this.docker.getContainer(sandbox.containerId);

    let testCmd: string;
    if (command) {
      testCmd = command;
    } else {
      testCmd = await this._detectTestCommand(container, sandbox.workDir);
    }

    console.log(`[SandboxExecutor] Running tests for ${projectId}: ${testCmd}`);
    return runExec(
      container,
      ['sh', '-c', `cd ${sandbox.workDir} && ${testCmd}`],
      config.sandbox.timeoutMs,
    );
  }

  // -------------------------------------------------------------------------
  // buildProject — detect and run build command
  // -------------------------------------------------------------------------
  async buildProject(projectId: string): Promise<ExecutionResult> {
    const sandbox = await sandboxManager.get(projectId);
    if (!sandbox) {
      throw new Error(`[SandboxExecutor] No sandbox found for project ${projectId}`);
    }

    const container = this.docker.getContainer(sandbox.containerId);
    const buildCmd = await this._detectBuildCommand(container, sandbox.workDir);

    console.log(`[SandboxExecutor] Building project ${projectId}: ${buildCmd}`);
    return runExec(
      container,
      ['sh', '-c', `cd ${sandbox.workDir} && ${buildCmd}`],
      config.sandbox.timeoutMs,
    );
  }

  // -------------------------------------------------------------------------
  // runLinter — detect and run linter
  // -------------------------------------------------------------------------
  async runLinter(projectId: string): Promise<ExecutionResult> {
    const sandbox = await sandboxManager.get(projectId);
    if (!sandbox) {
      throw new Error(`[SandboxExecutor] No sandbox found for project ${projectId}`);
    }

    const container = this.docker.getContainer(sandbox.containerId);
    const lintCmd = await this._detectLintCommand(container, sandbox.workDir);

    console.log(`[SandboxExecutor] Running linter for ${projectId}: ${lintCmd}`);
    return runExec(
      container,
      ['sh', '-c', `cd ${sandbox.workDir} && ${lintCmd}`],
      config.sandbox.timeoutMs,
    );
  }

  // -------------------------------------------------------------------------
  // parseTestOutput — parse stdout/stderr for test counts and failures
  // -------------------------------------------------------------------------
  parseTestOutput(output: ExecutionResult, stack: StackDomain): TestResult {
    const stdout = output.stdout;
    const stderr = output.stderr;
    const combined = `${stdout}\n${stderr}`;

    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const failures: Array<{ test: string; error: string }> = [];

    switch (stack) {
      case StackDomain.WEB_SAAS:
      case StackDomain.MOBILE_RN:
      case StackDomain.DESKTOP:
      case StackDomain.CLI_TOOL:
      case StackDomain.BROWSER_EXT:
      case StackDomain.SERVERLESS: {
        // Vitest / Jest output: "Tests  3 passed | 1 failed | 1 skipped"
        // or: "Tests: 3 passed, 1 failed"
        const vitestMatch = combined.match(/(\d+)\s+passed.*?(\d+)\s+failed.*?(\d+)\s+skipped/i);
        const jestMatch = combined.match(
          /Tests?:\s+(?:(\d+)\s+skipped,\s*)?(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/i,
        );
        if (vitestMatch) {
          passed = parseInt(vitestMatch[1] ?? '0', 10);
          failed = parseInt(vitestMatch[2] ?? '0', 10);
          skipped = parseInt(vitestMatch[3] ?? '0', 10);
        } else if (jestMatch) {
          skipped = parseInt(jestMatch[1] ?? '0', 10);
          passed = parseInt(jestMatch[2] ?? '0', 10);
          failed = parseInt(jestMatch[3] ?? '0', 10);
        } else {
          // Fallback: count "✓" and "✗" symbols
          passed = (combined.match(/✓|✔|PASS/g) ?? []).length;
          failed = (combined.match(/✗|✘|FAIL/g) ?? []).length;
        }
        break;
      }

      case StackDomain.IOT_EMBEDDED:
      case StackDomain.AI_ML:
      case StackDomain.DATA_PLATFORM:
      case StackDomain.DEVOPS: {
        // pytest output: "5 passed, 1 failed, 2 errors" or "=== 5 passed ==="
        const pytestMatch = combined.match(/=+\s*([\d\w ,]+)\s*=+/);
        if (pytestMatch) {
          const summary = pytestMatch[1] ?? '';
          const p = summary.match(/(\d+)\s+passed/i);
          const f = summary.match(/(\d+)\s+failed/i);
          const e = summary.match(/(\d+)\s+error/i);
          const s = summary.match(/(\d+)\s+skip/i);
          passed = parseInt(p?.[1] ?? '0', 10);
          failed = parseInt(f?.[1] ?? '0', 10) + parseInt(e?.[1] ?? '0', 10);
          skipped = parseInt(s?.[1] ?? '0', 10);
        }
        break;
      }

      case StackDomain.BLOCKCHAIN_EVM: {
        // Hardhat/Mocha output: "3 passing (200ms)" / "1 failing"
        const passingMatch = combined.match(/(\d+)\s+passing/i);
        const failingMatch = combined.match(/(\d+)\s+failing/i);
        const pendingMatch = combined.match(/(\d+)\s+pending/i);
        passed = parseInt(passingMatch?.[1] ?? '0', 10);
        failed = parseInt(failingMatch?.[1] ?? '0', 10);
        skipped = parseInt(pendingMatch?.[1] ?? '0', 10);
        break;
      }

      case StackDomain.BLOCKCHAIN_SOL: {
        // Anchor test (also Mocha under the hood)
        const passingMatch = combined.match(/(\d+)\s+passing/i);
        const failingMatch = combined.match(/(\d+)\s+failing/i);
        passed = parseInt(passingMatch?.[1] ?? '0', 10);
        failed = parseInt(failingMatch?.[1] ?? '0', 10);
        break;
      }

      default: {
        // Generic: try passed/failed numbers
        const genericPassed = combined.match(/(\d+)\s+(?:test[s]?\s+)?passed/i);
        const genericFailed = combined.match(/(\d+)\s+(?:test[s]?\s+)?failed/i);
        passed = parseInt(genericPassed?.[1] ?? '0', 10);
        failed = parseInt(genericFailed?.[1] ?? '0', 10);
        break;
      }
    }

    // Extract failure details from stderr lines containing "Error:"
    const errorLines = stderr
      .split('\n')
      .filter((line) => line.includes('Error:') || line.includes('FAILED'));

    for (const line of errorLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Try to extract a test name before the colon
      const parts = trimmed.split(/:\s+/);
      failures.push({
        test: parts.length > 1 ? (parts[0] ?? 'Unknown test') : 'Unknown test',
        error: parts.slice(1).join(': ') || trimmed,
      });
    }

    // Ensure failure count matches what we actually extracted when possible
    if (failed === 0 && failures.length > 0) {
      failed = failures.length;
    }

    return {
      passed,
      failed,
      skipped,
      duration: output.durationMs,
      failures,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _splitCommand(command: string): string[] {
    // Simple shell-like split respecting double-quoted segments
    const args: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      if (inQuote) {
        if (ch === quoteChar) {
          inQuote = false;
        } else {
          current += ch;
        }
      } else if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === ' ' || ch === '\t') {
        if (current.length > 0) {
          args.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }
    if (current.length > 0) args.push(current);
    return args.length > 0 ? args : ['sh', '-c', command];
  }

  private async _fileExists(container: Docker.Container, filePath: string): Promise<boolean> {
    const result = await runExec(
      container,
      ['sh', '-c', `test -f "${filePath}" && echo yes || echo no`],
      10_000,
    );
    return result.stdout.trim() === 'yes';
  }

  private async _fileContains(
    container: Docker.Container,
    filePath: string,
    pattern: string,
  ): Promise<boolean> {
    const result = await runExec(
      container,
      ['sh', '-c', `grep -q "${pattern}" "${filePath}" 2>/dev/null && echo yes || echo no`],
      10_000,
    );
    return result.stdout.trim() === 'yes';
  }

  private async _detectTestCommand(container: Docker.Container, workDir: string): Promise<string> {
    const pkgJson = `${workDir}/package.json`;
    const reqTxt = `${workDir}/requirements.txt`;
    const cargoToml = `${workDir}/Cargo.toml`;
    const anchorToml = `${workDir}/Anchor.toml`;

    if (await this._fileExists(container, anchorToml)) {
      return 'anchor test';
    }
    if (await this._fileExists(container, pkgJson)) {
      const hasVitest = await this._fileContains(container, pkgJson, 'vitest');
      const hasJest = await this._fileContains(container, pkgJson, 'jest');
      if (hasVitest || hasJest) return 'pnpm test';
      return 'pnpm test';
    }
    if (await this._fileExists(container, reqTxt)) {
      return 'pytest -v';
    }
    if (await this._fileExists(container, cargoToml)) {
      return 'cargo test';
    }
    return "echo 'No test runner detected'";
  }

  private async _detectBuildCommand(container: Docker.Container, workDir: string): Promise<string> {
    const pkgJson = `${workDir}/package.json`;
    const cargoToml = `${workDir}/Cargo.toml`;
    const setupPy = `${workDir}/setup.py`;
    const pyproject = `${workDir}/pyproject.toml`;

    if (await this._fileExists(container, pkgJson)) {
      const hasTypescript = await this._fileContains(container, pkgJson, 'typescript');
      if (hasTypescript) return 'pnpm tsc --noEmit || pnpm build';
      return 'pnpm build';
    }
    if (await this._fileExists(container, cargoToml)) {
      return 'cargo build';
    }
    if (await this._fileExists(container, setupPy)) {
      return 'python setup.py build';
    }
    if (await this._fileExists(container, pyproject)) {
      return 'python -m build';
    }
    return "echo 'No build system detected'";
  }

  private async _detectLintCommand(container: Docker.Container, workDir: string): Promise<string> {
    // Check for .eslintrc variants
    const eslintCheck = await runExec(
      container,
      ['sh', '-c', `ls "${workDir}"/.eslintrc* "${workDir}"/eslint.config.* 2>/dev/null | head -1`],
      10_000,
    );
    if (eslintCheck.stdout.trim().length > 0) {
      return 'pnpm eslint .';
    }

    // Check for ruff (Python)
    const ruffCheck = await runExec(
      container,
      ['sh', '-c', 'command -v ruff 2>/dev/null && echo yes || echo no'],
      10_000,
    );
    if (ruffCheck.stdout.trim() === 'yes') {
      return 'ruff check .';
    }

    // Check for Cargo (Rust)
    const cargoToml = `${workDir}/Cargo.toml`;
    if (await this._fileExists(container, cargoToml)) {
      return 'cargo clippy';
    }

    return "echo 'No linter detected'";
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------
export const executor = new SandboxExecutor();
