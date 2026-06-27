import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { config } from '../config/config.js';
import {
  ProjectState,
  ProjectPhase,
  FileChange,
  Sprint,
  SprintBudget,
  TokenUsage,
  AgentRole,
  RepoAnalysis,
} from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Pool factory
// ---------------------------------------------------------------------------

function createPool(): Pool {
  return mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    connectionLimit: config.db.poolSize,
    waitForConnections: true,
    charset: 'utf8mb4',
    typeCast(field, next) {
      if (field.type === 'JSON') {
        const str = field.string();
        if (str === null) return null;
        try {
          return JSON.parse(str);
        } catch {
          return str;
        }
      }
      return next();
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson<T>(val: unknown): T {
  if (val === null || val === undefined) return {} as T;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return {} as T;
    }
  }
  return val as T;
}

function rowToProjectState(row: RowDataPacket, codebase: Record<string, string> = {}): ProjectState {
  return {
    id: row['id'] as string,
    workspaceId: row['workspace_id'] as string,
    slug: row['slug'] as string,
    name: row['name'] as string,
    phase: row['phase'] as ProjectPhase,
    requirement: parseJson<ProjectState['requirement']>(row['requirement']),
    stack: parseJson<ProjectState['stack']>(row['stack']),
    sprint: parseJson<Sprint>(row['sprint']),
    codebase,
    prd: (row['prd'] ?? '') as string,
    slackProjectChannelId: (row['slack_project_channel'] ?? '') as string,
    jiraProjectKey: (row['jira_project_key'] as string | null) ?? null,
    jiraSprintId: (row['jira_sprint_id'] ?? '') as string,
    githubRepo: (row['github_repo'] as string | null) ?? null,
    githubBranch: (row['github_branch'] ?? '') as string,
    budget: parseJson<SprintBudget>(row['budget']),
    createdAt: new Date(row['created_at'] as string),
    updatedAt: new Date(row['updated_at'] as string),
    completedAt: row['completed_at'] ? new Date(row['completed_at'] as string) : null,
    ...(row['source_repo'] ? { sourceRepo: row['source_repo'] as string } : {}),
    ...(row['repo_analysis'] ? { repoAnalysis: parseJson<RepoAnalysis>(row['repo_analysis']) } : {}),
    ...(row['target_branch'] ? { targetBranch: row['target_branch'] as string } : {}),
    ...(row['pause_reason'] ? { pauseReason: row['pause_reason'] as 'CREDIT_EXHAUSTED' | 'HUMAN_PAUSE' } : {}),
    ...(row['paused_at_task_id'] ? { pausedAtTaskId: row['paused_at_task_id'] as string } : {}),
  };
}

async function loadCodebase(pool: Pool, projectId: string): Promise<Record<string, string>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT file_path, content FROM project_files WHERE project_id = ?',
    [projectId],
  );
  const codebase: Record<string, string> = {};
  for (const row of rows) {
    codebase[row['file_path'] as string] = row['content'] as string;
  }
  return codebase;
}

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

export class StateStore {
  private pool: Pool;

  constructor() {
    this.pool = createPool();
  }

  // -------------------------------------------------------------------------
  // saveProject — upsert
  // -------------------------------------------------------------------------
  async saveProject(state: ProjectState): Promise<void> {
    const sql = `
      INSERT INTO projects (
        id, workspace_id, slug, name, phase,
        requirement, stack, prd, sprint,
        slack_project_channel, jira_project_key, jira_sprint_id,
        github_repo, github_branch,
        budget, created_at, updated_at, completed_at,
        source_repo, repo_analysis, target_branch,
        pause_reason, paused_at_task_id
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?
      )
      ON DUPLICATE KEY UPDATE
        name                  = VALUES(name),
        phase                 = VALUES(phase),
        requirement           = VALUES(requirement),
        stack                 = VALUES(stack),
        prd                   = VALUES(prd),
        sprint                = VALUES(sprint),
        slack_project_channel = VALUES(slack_project_channel),
        jira_project_key      = VALUES(jira_project_key),
        jira_sprint_id        = VALUES(jira_sprint_id),
        github_repo           = VALUES(github_repo),
        github_branch         = VALUES(github_branch),
        budget                = VALUES(budget),
        updated_at            = NOW(3),
        completed_at          = VALUES(completed_at),
        source_repo           = VALUES(source_repo),
        repo_analysis         = VALUES(repo_analysis),
        target_branch         = VALUES(target_branch),
        pause_reason          = VALUES(pause_reason),
        paused_at_task_id     = VALUES(paused_at_task_id)
    `;

    const values = [
      state.id,
      state.workspaceId,
      state.slug,
      state.name,
      state.phase,
      JSON.stringify(state.requirement),
      JSON.stringify(state.stack),
      state.prd,
      JSON.stringify(state.sprint),
      state.slackProjectChannelId,
      state.jiraProjectKey,
      state.jiraSprintId,
      state.githubRepo,
      state.githubBranch,
      JSON.stringify(state.budget),
      state.createdAt,
      state.updatedAt,
      state.completedAt,
      state.sourceRepo ?? null,
      state.repoAnalysis ? JSON.stringify(state.repoAnalysis) : null,
      state.targetBranch ?? null,
      state.pauseReason ?? null,
      state.pausedAtTaskId ?? null,
    ];

    try {
      await this.pool.query(sql, values);
    } catch (err) {
      throw new Error(`StateStore.saveProject failed: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // loadProject
  // -------------------------------------------------------------------------
  async loadProject(projectId: string): Promise<ProjectState | null> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        'SELECT * FROM projects WHERE id = ? LIMIT 1',
        [projectId],
      );
      if (rows.length === 0) return null;
      const codebase = await loadCodebase(this.pool, projectId);
      return rowToProjectState(rows[0] as RowDataPacket, codebase);
    } catch (err) {
      throw new Error(`StateStore.loadProject failed: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // updatePhase
  // -------------------------------------------------------------------------
  async updatePhase(projectId: string, phase: ProjectPhase): Promise<void> {
    try {
      await this.pool.query('UPDATE projects SET phase = ?, updated_at = NOW(3) WHERE id = ?', [
        phase,
        projectId,
      ]);
    } catch (err) {
      throw new Error(`StateStore.updatePhase failed: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // updateCodebase — upsert/delete rows in project_files (1 row = 1 file)
  // -------------------------------------------------------------------------
  async updateCodebase(projectId: string, files: FileChange[]): Promise<void> {
    try {
      for (const file of files) {
        if (file.action === 'delete') {
          await this.pool.query(
            'DELETE FROM project_files WHERE project_id = ? AND file_path = ?',
            [projectId, file.path],
          );
        } else {
          await this.pool.query(
            `INSERT INTO project_files (id, project_id, file_path, content)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE content = VALUES(content)`,
            [uuidv4(), projectId, file.path, file.content],
          );
        }
      }
      await this.pool.query(
        'UPDATE projects SET updated_at = NOW(3) WHERE id = ?',
        [projectId],
      );
    } catch (err) {
      throw new Error(`StateStore.updateCodebase failed: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // updateSprint
  // -------------------------------------------------------------------------
  async updateSprint(projectId: string, sprint: Sprint): Promise<void> {
    try {
      await this.pool.query(
        'UPDATE projects SET sprint = ?, updated_at = NOW(3) WHERE id = ?',
        [JSON.stringify(sprint), projectId],
      );
    } catch (err) {
      throw new Error(`StateStore.updateSprint failed: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // updateBudget
  // -------------------------------------------------------------------------
  async updateBudget(projectId: string, budget: SprintBudget): Promise<void> {
    try {
      await this.pool.query(
        'UPDATE projects SET budget = ?, updated_at = NOW(3) WHERE id = ?',
        [JSON.stringify(budget), projectId],
      );
    } catch (err) {
      throw new Error(`StateStore.updateBudget failed: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // listProjects
  // -------------------------------------------------------------------------
  async listProjects(workspaceId: string): Promise<ProjectState[]> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        'SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at DESC',
        [workspaceId],
      );
      return rows.map((r) => rowToProjectState(r as RowDataPacket));
    } catch (err) {
      throw new Error(`StateStore.listProjects failed: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // getActiveProjects
  // -------------------------------------------------------------------------
  async getActiveProjects(workspaceId: string): Promise<ProjectState[]> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT * FROM projects
         WHERE workspace_id = ?
           AND phase NOT IN ('DONE', 'FAILED')
         ORDER BY created_at DESC`,
        [workspaceId],
      );
      return rows.map((r) => rowToProjectState(r as RowDataPacket));
    } catch (err) {
      throw new Error(`StateStore.getActiveProjects failed: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // savePendingProject / loadPendingProject / deletePendingProject
  // Persist lobby confirmation state so it survives container restarts.
  // -------------------------------------------------------------------------
  async savePendingProject(key: string, data: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO pending_projects (pending_key, data, created_at)
       VALUES (?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE data = VALUES(data), created_at = NOW(3)`,
      [key, JSON.stringify(data)],
    );
  }

  async loadPendingProject(key: string): Promise<unknown | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT data FROM pending_projects WHERE pending_key = ? LIMIT 1',
      [key],
    );
    if (rows.length === 0) return null;
    const raw = rows[0]!['data'];
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  async deletePendingProject(key: string): Promise<void> {
    await this.pool.query('DELETE FROM pending_projects WHERE pending_key = ?', [key]);
  }

  // -------------------------------------------------------------------------
  // logTokenUsage
  // -------------------------------------------------------------------------
  async logTokenUsage(
    projectId: string,
    workspaceId: string,
    agentRole: AgentRole,
    model: string,
    usage: TokenUsage,
  ): Promise<void> {
    const sql = `
      INSERT INTO token_usage_log
        (id, project_id, workspace_id, agent_role, model,
         input_tokens, output_tokens, cache_hits, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    try {
      await this.pool.query(sql, [
        uuidv4(),
        projectId,
        workspaceId,
        agentRole,
        model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheHits,
        usage.estimatedCostUsd,
      ]);
    } catch (err) {
      throw new Error(`StateStore.logTokenUsage failed: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // getCostSummary
  // -------------------------------------------------------------------------
  async getCostSummary(workspaceId: string, period: 'today' | 'month'): Promise<number> {
    const whereClause =
      period === 'today'
        ? 'created_at >= DATE(NOW())'
        : "created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')";

    const sql = `
      SELECT COALESCE(SUM(cost_usd), 0) AS total
      FROM token_usage_log
      WHERE workspace_id = ?
        AND ${whereClause}
    `;

    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(sql, [workspaceId]);
      return parseFloat((rows[0]?.['total'] as string | number | undefined)?.toString() ?? '0');
    } catch (err) {
      throw new Error(`StateStore.getCostSummary failed: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------
  async close(): Promise<void> {
    try {
      await this.pool.end();
    } catch (err) {
      throw new Error(`StateStore.close failed: ${(err as Error).message}`);
    }
  }
}

export const stateStore = new StateStore();
