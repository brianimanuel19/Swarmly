import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { config } from '../config/config.js';
import { v4 as uuidv4 } from 'uuid';
import { refreshOAuthToken } from './claude-oauth.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuthType = 'oauth' | 'api_key';

export interface UserAuthRecord {
  slackUserId: string;
  authType: AuthType;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiry?: number; // unix ms
  apiKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── UserAuthStore ─────────────────────────────────────────────────────────────

export class UserAuthStore {
  private pool: Pool;
  private ready: Promise<void>;

  constructor() {
    this.pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      connectionLimit: 3,
      waitForConnections: true,
      charset: 'utf8mb4',
    });
    this.ready = this._ensureTable();
  }

  private async _ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS user_auth (
        id VARCHAR(36) PRIMARY KEY,
        slack_user_id VARCHAR(50) NOT NULL UNIQUE,
        auth_type ENUM('oauth', 'api_key') NOT NULL DEFAULT 'api_key',
        access_token TEXT,
        refresh_token TEXT,
        token_expiry BIGINT,
        api_key VARCHAR(300),
        created_at DATETIME(3) DEFAULT NOW(3),
        updated_at DATETIME(3) DEFAULT NOW(3)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  async saveOAuthTokens(
    slackUserId: string,
    accessToken: string,
    refreshToken: string | undefined,
    expiresIn: number,
  ): Promise<void> {
    await this.ready;
    const expiry = Date.now() + expiresIn * 1000;
    await this.pool.query(
      `INSERT INTO user_auth (id, slack_user_id, auth_type, access_token, refresh_token, token_expiry, updated_at)
       VALUES (?, ?, 'oauth', ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE
         auth_type = 'oauth',
         access_token = VALUES(access_token),
         refresh_token = VALUES(refresh_token),
         token_expiry = VALUES(token_expiry),
         api_key = NULL,
         updated_at = NOW(3)`,
      [uuidv4(), slackUserId, accessToken, refreshToken ?? null, expiry],
    );
  }

  async saveApiKey(slackUserId: string, apiKey: string): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO user_auth (id, slack_user_id, auth_type, api_key, updated_at)
       VALUES (?, ?, 'api_key', ?, NOW(3))
       ON DUPLICATE KEY UPDATE
         auth_type = 'api_key',
         api_key = VALUES(api_key),
         access_token = NULL,
         refresh_token = NULL,
         token_expiry = NULL,
         updated_at = NOW(3)`,
      [uuidv4(), slackUserId, apiKey],
    );
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /** Returns a valid API key or OAuth access token for the user, or null if not authenticated. */
  async getEffectiveKey(slackUserId: string): Promise<string | null> {
    await this.ready;
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        'SELECT * FROM user_auth WHERE slack_user_id = ? LIMIT 1',
        [slackUserId],
      );
      if (rows.length === 0) return null;
      const row = rows[0]!;

      if (row['auth_type'] === 'api_key') {
        return (row['api_key'] as string | null) ?? null;
      }

      if (row['auth_type'] === 'oauth') {
        const expiry = row['token_expiry'] as number | null;
        const accessToken = row['access_token'] as string | null;
        const refreshToken = row['refresh_token'] as string | null;

        // Token still valid (with 60s buffer)
        if (accessToken && expiry && Date.now() < expiry - 60_000) {
          return accessToken;
        }

        // Attempt refresh
        if (refreshToken) {
          try {
            const tokens = await refreshOAuthToken(refreshToken);
            await this.saveOAuthTokens(slackUserId, tokens.accessToken, tokens.refreshToken, tokens.expiresIn);
            return tokens.accessToken;
          } catch {
            // Refresh failed — user needs to re-auth
            return null;
          }
        }
      }
    } catch (err) {
      console.warn(`[UserAuthStore] getEffectiveKey failed: ${(err as Error).message}`);
    }
    return null;
  }

  async getStatus(slackUserId: string): Promise<{ type: AuthType | 'none'; expiry?: Date }> {
    await this.ready;
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        'SELECT auth_type, token_expiry, updated_at FROM user_auth WHERE slack_user_id = ? LIMIT 1',
        [slackUserId],
      );
      if (rows.length === 0) return { type: 'none' };
      const row = rows[0]!;
      return {
        type: row['auth_type'] as AuthType,
        ...(row['token_expiry'] ? { expiry: new Date(row['token_expiry'] as number) } : {}),
      };
    } catch {
      return { type: 'none' };
    }
  }

  async deleteAuth(slackUserId: string): Promise<void> {
    await this.ready;
    await this.pool.query('DELETE FROM user_auth WHERE slack_user_id = ?', [slackUserId]);
  }
}

export const userAuthStore = new UserAuthStore();
