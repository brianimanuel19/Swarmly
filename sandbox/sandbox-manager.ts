import Docker from 'dockerode';
import { StackDomain, SandboxInfo } from '../types/index.js';
import { config } from '../config/config.js';
import { stateStore } from '../memory/state-store.js';

// ---------------------------------------------------------------------------
// Domain -> Docker image map
// ---------------------------------------------------------------------------

const DOMAIN_IMAGE_MAP: Record<StackDomain, string> = {
  [StackDomain.WEB_SAAS]: 'swarmly-web-saas',
  [StackDomain.MOBILE_RN]: 'swarmly-mobile-rn',
  [StackDomain.MOBILE_FLUTTER]: 'node:20-alpine',
  [StackDomain.BLOCKCHAIN_EVM]: 'swarmly-blockchain-evm',
  [StackDomain.BLOCKCHAIN_SOL]: 'swarmly-blockchain-solana',
  [StackDomain.IOT_EMBEDDED]: 'swarmly-iot-embedded',
  [StackDomain.AI_ML]: 'swarmly-ai-ml',
  [StackDomain.DESKTOP]: 'node:20-alpine',
  [StackDomain.DATA_PLATFORM]: 'node:20-alpine',
  [StackDomain.CLI_TOOL]: 'node:20-alpine',
  [StackDomain.BROWSER_EXT]: 'node:20-alpine',
  [StackDomain.GAME]: 'node:20-alpine',
  [StackDomain.SERVERLESS]: 'node:20-alpine',
  [StackDomain.DEVOPS]: 'node:20-alpine',
};

// ---------------------------------------------------------------------------
// SandboxManager
// ---------------------------------------------------------------------------

export class SandboxManager {
  private docker: Docker;
  /** In-memory fallback cache: projectId -> SandboxInfo */
  private cache: Map<string, SandboxInfo> = new Map();

  constructor() {
    this.docker = new Docker({ socketPath: config.sandbox.dockerSocket });
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------
  async create(projectId: string, domain: StackDomain): Promise<SandboxInfo> {
    const image = DOMAIN_IMAGE_MAP[domain] ?? 'node:20-alpine';
    const workDir = `/workspace/${projectId}`;
    const volumeName = `swarmly-${projectId}`;

    // Ensure volume exists
    try {
      await this.docker.createVolume({ Name: volumeName });
    } catch (err: unknown) {
      // Volume may already exist; ignore conflict errors
      const msg = (err as Error).message ?? '';
      if (!msg.includes('already exists') && !msg.includes('409')) {
        console.warn(`[SandboxManager] Volume creation warning: ${msg}`);
      }
    }

    // Create the container
    let container: Docker.Container;
    try {
      container = await this.docker.createContainer({
        Image: image,
        name: `swarmly-${projectId}`,
        WorkingDir: workDir,
        Cmd: ['/bin/sh', '-c', 'tail -f /dev/null'], // keep alive
        HostConfig: {
          Memory: config.sandbox.memoryLimitMb * 1024 * 1024, // bytes
          CpuQuota: config.sandbox.cpuQuota,
          CpuPeriod: 100000,
          Binds: [`${volumeName}:${workDir}`],
          AutoRemove: false,
          NetworkMode: 'none', // isolated by default
        },
        Labels: {
          'swarmly.project': projectId,
          'swarmly.domain': domain,
          'swarmly.managed': 'true',
        },
      });
    } catch (err: unknown) {
      throw new Error(
        `[SandboxManager] Failed to create container for project ${projectId}: ${(err as Error).message}`,
      );
    }

    // Start the container
    try {
      await container.start();
    } catch (err: unknown) {
      throw new Error(
        `[SandboxManager] Failed to start container for project ${projectId}: ${(err as Error).message}`,
      );
    }

    const containerInfo = await container.inspect();
    const sandboxInfo: SandboxInfo = {
      containerId: containerInfo.Id,
      projectId,
      workDir,
      status: 'running',
      createdAt: new Date(),
    };

    // Persist to in-memory cache first
    this.cache.set(projectId, sandboxInfo);

    // Attempt to persist to DB — non-fatal if the table is not yet available
    try {
      await this._saveSandboxToDB(sandboxInfo);
    } catch (err: unknown) {
      console.log(
        `[SandboxManager] DB persistence skipped (table may not exist yet): ${(err as Error).message}`,
      );
    }

    console.log(
      `[SandboxManager] Container created and started: ${containerInfo.Id} for project ${projectId}`,
    );
    return sandboxInfo;
  }

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------
  async destroy(projectId: string): Promise<void> {
    const sandbox = await this.get(projectId);
    if (!sandbox) {
      console.warn(`[SandboxManager] No sandbox found for project ${projectId}`);
      return;
    }

    const container = this.docker.getContainer(sandbox.containerId);

    try {
      await container.stop({ t: 5 });
    } catch (err: unknown) {
      const msg = (err as Error).message ?? '';
      // Ignore "already stopped" errors
      if (!msg.includes('not running') && !msg.includes('304')) {
        console.warn(`[SandboxManager] Stop warning for ${sandbox.containerId}: ${msg}`);
      }
    }

    try {
      await container.remove({ force: true, v: true });
    } catch (err: unknown) {
      throw new Error(
        `[SandboxManager] Failed to remove container ${sandbox.containerId}: ${(err as Error).message}`,
      );
    }

    // Update cache
    const updated: SandboxInfo = { ...sandbox, status: 'stopped' };
    this.cache.set(projectId, updated);

    // Attempt DB update
    try {
      await this._updateSandboxStatus(projectId, 'stopped');
    } catch (err: unknown) {
      console.log(`[SandboxManager] DB update skipped: ${(err as Error).message}`);
    }

    // Remove from active cache
    this.cache.delete(projectId);
    console.log(`[SandboxManager] Container destroyed for project ${projectId}`);
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------
  async get(projectId: string): Promise<SandboxInfo | null> {
    // Try in-memory cache first
    const cached = this.cache.get(projectId);
    if (cached) return cached;

    // Fall back to DB
    try {
      return await this._loadSandboxFromDB(projectId);
    } catch (err: unknown) {
      console.log(`[SandboxManager] DB lookup skipped: ${(err as Error).message}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // listActive
  // -------------------------------------------------------------------------
  async listActive(): Promise<SandboxInfo[]> {
    try {
      const containers = await this.docker.listContainers({
        filters: JSON.stringify({
          label: ['swarmly.managed=true'],
          status: ['running'],
        }),
      });

      return containers.map((c) => {
        const projectId = c.Labels['swarmly.project'] ?? '';
        const info: SandboxInfo = {
          containerId: c.Id,
          projectId,
          workDir: `/workspace/${projectId}`,
          status: 'running',
          createdAt: new Date(c.Created * 1000),
        };
        // Refresh cache entry
        if (projectId) this.cache.set(projectId, info);
        return info;
      });
    } catch (err: unknown) {
      // If Docker is unavailable, fall back to in-memory cache
      console.warn(`[SandboxManager] listActive fell back to cache: ${(err as Error).message}`);
      return Array.from(this.cache.values()).filter((s) => s.status === 'running');
    }
  }

  // -------------------------------------------------------------------------
  // cleanup — remove stopped/exited containers managed by Swarmly
  // -------------------------------------------------------------------------
  async cleanup(): Promise<void> {
    let containers: Docker.ContainerInfo[];
    try {
      containers = await this.docker.listContainers({
        all: true,
        filters: JSON.stringify({
          label: ['swarmly.managed=true'],
          status: ['exited', 'dead', 'created'],
        }),
      });
    } catch (err: unknown) {
      throw new Error(
        `[SandboxManager] cleanup failed to list containers: ${(err as Error).message}`,
      );
    }

    const results = await Promise.allSettled(
      containers.map(async (c) => {
        const container = this.docker.getContainer(c.Id);
        await container.remove({ force: true, v: true });
        const projectId = c.Labels['swarmly.project'];
        if (projectId) this.cache.delete(projectId);
        console.log(`[SandboxManager] Cleaned up container ${c.Id}`);
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn(`[SandboxManager] cleanup partial failure: ${result.reason}`);
      }
    }

    console.log(`[SandboxManager] Cleanup complete. Processed ${containers.length} container(s).`);
  }

  // -------------------------------------------------------------------------
  // Private DB helpers — wrapped so callers can try/catch gracefully
  // -------------------------------------------------------------------------

  private async _saveSandboxToDB(info: SandboxInfo): Promise<void> {
    // stateStore does not yet expose a sandbox table; use raw pool via a
    // duck-typed access to avoid breaking if the table doesn't exist.
    const pool = (stateStore as unknown as { pool: { query: Function } }).pool;
    await pool.query(
      `INSERT INTO sandboxes (container_id, project_id, work_dir, status, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id) DO UPDATE
         SET container_id = EXCLUDED.container_id,
             status       = EXCLUDED.status`,
      [info.containerId, info.projectId, info.workDir, info.status, info.createdAt],
    );
  }

  private async _updateSandboxStatus(
    projectId: string,
    status: SandboxInfo['status'],
  ): Promise<void> {
    const pool = (stateStore as unknown as { pool: { query: Function } }).pool;
    await pool.query(`UPDATE sandboxes SET status = $1 WHERE project_id = $2`, [status, projectId]);
  }

  private async _loadSandboxFromDB(projectId: string): Promise<SandboxInfo | null> {
    const pool = (stateStore as unknown as { pool: { query: Function } }).pool;
    const result = await pool.query(
      `SELECT container_id, project_id, work_dir, status, created_at
       FROM sandboxes WHERE project_id = $1 LIMIT 1`,
      [projectId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      containerId: row.container_id as string,
      projectId: row.project_id as string,
      workDir: row.work_dir as string,
      status: row.status as SandboxInfo['status'],
      createdAt: new Date(row.created_at as string),
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------
export const sandboxManager = new SandboxManager();
