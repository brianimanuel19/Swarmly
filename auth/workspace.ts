import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { Workspace, TokenUsage } from '../types/index.js';
import { config } from '../config/config.js';
import { v4 as uuidv4 } from 'uuid';

export class WorkspaceManager {
  private pool: Pool;

  constructor() {
    this.pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      connectionLimit: config.db.poolSize,
      waitForConnections: true,
      charset: 'utf8mb4',
    });
  }

  async getOrCreate(slackTeamId: string, teamName: string): Promise<Workspace> {
    const conn = await this.pool.getConnection();
    try {
      // Insert if not exists; uuidv4() replaces gen_random_uuid()
      await conn.query(
        `INSERT INTO workspaces (id, slack_team_id, team_name, created_at, updated_at)
         VALUES (?, ?, ?, NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE team_name = VALUES(team_name)`,
        [uuidv4(), slackTeamId, teamName],
      );

      const [rows] = await conn.query<RowDataPacket[]>(
        'SELECT * FROM workspaces WHERE slack_team_id = ? LIMIT 1',
        [slackTeamId],
      );

      if (rows.length === 0) {
        throw new Error(`Failed to get or create workspace for team ${slackTeamId}`);
      }

      return this.rowToWorkspace(rows[0] as RowDataPacket);
    } finally {
      conn.release();
    }
  }

  async getBySlackTeam(slackTeamId: string): Promise<Workspace | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM workspaces WHERE slack_team_id = ? LIMIT 1',
      [slackTeamId],
    );
    if (rows.length === 0) return null;
    return this.rowToWorkspace(rows[0] as RowDataPacket);
  }

  async updateBudget(workspaceId: string, usage: TokenUsage): Promise<void> {
    await this.pool.query(
      `UPDATE workspaces
       SET
         used_today_usd      = used_today_usd      + ?,
         used_this_month_usd = used_this_month_usd + ?,
         updated_at          = NOW(3)
       WHERE id = ?`,
      [usage.estimatedCostUsd, usage.estimatedCostUsd, workspaceId],
    );
  }

  async checkBudget(workspaceId: string): Promise<{ allowed: boolean; reason?: string }> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT used_today_usd, used_this_month_usd, daily_budget_usd, monthly_budget_usd
       FROM workspaces
       WHERE id = ? LIMIT 1`,
      [workspaceId],
    );

    if (rows.length === 0) return { allowed: false, reason: 'Workspace not found' };

    const row = rows[0] as RowDataPacket;
    const usedToday = parseFloat((row['used_today_usd'] as string | number | null)?.toString() ?? '0');
    const usedThisMonth = parseFloat((row['used_this_month_usd'] as string | number | null)?.toString() ?? '0');
    const dailyLimit = parseFloat((row['daily_budget_usd'] as string | number | null)?.toString() ?? '50');
    const monthlyLimit = parseFloat((row['monthly_budget_usd'] as string | number | null)?.toString() ?? '500');

    if (usedToday >= dailyLimit) {
      return {
        allowed: false,
        reason: `Daily budget limit reached ($${usedToday.toFixed(2)} / $${dailyLimit.toFixed(2)})`,
      };
    }

    if (usedThisMonth >= monthlyLimit) {
      return {
        allowed: false,
        reason: `Monthly budget limit reached ($${usedThisMonth.toFixed(2)} / $${monthlyLimit.toFixed(2)})`,
      };
    }

    return { allowed: true };
  }

  async getById(workspaceId: string): Promise<Workspace | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM workspaces WHERE id = ? LIMIT 1',
      [workspaceId],
    );
    if (rows.length === 0) return null;
    return this.rowToWorkspace(rows[0] as RowDataPacket);
  }

  async updateApiKey(workspaceId: string, apiKey: string): Promise<void> {
    await this.pool.query(
      'UPDATE workspaces SET anthropic_api_key = ?, updated_at = NOW(3) WHERE id = ?',
      [apiKey, workspaceId],
    );
  }

  private rowToWorkspace(row: RowDataPacket): Workspace {
    const parseJson = <T>(val: unknown): T => {
      if (val === null || val === undefined) return {} as T;
      if (typeof val === 'string') {
        try { return JSON.parse(val) as T; } catch { return {} as T; }
      }
      return val as T;
    };

    return {
      id: row['id'] as string,
      name: (row['team_name'] as string) ?? '',
      slackTeamId: row['slack_team_id'] as string,
      anthropicApiKey: (row['anthropic_api_key'] as string) ?? '',
      jiraConfig: parseJson(row['jira_config']),
      githubConfig: parseJson(row['github_config']),
      budget: {
        dailyLimitUsd: parseFloat((row['daily_budget_usd'] as string | null) ?? '50'),
        monthlyLimitUsd: parseFloat((row['monthly_budget_usd'] as string | null) ?? '500'),
        usedTodayUsd: parseFloat((row['used_today_usd'] as string | null) ?? '0'),
        usedThisMonthUsd: parseFloat((row['used_this_month_usd'] as string | null) ?? '0'),
      },
      createdAt: new Date(row['created_at'] as string),
    };
  }
}

export const workspaceAuth = new WorkspaceManager();
