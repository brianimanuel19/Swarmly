import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import crypto from 'crypto';
import { config } from '../config/config.js';
import { v4 as uuidv4 } from 'uuid';

export class ApiKeyManager {
  private pool: Pool;

  constructor() {
    this.pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      connectionLimit: 5,
      waitForConnections: true,
      charset: 'utf8mb4',
    });

    this.initTable().catch((err) => {
      console.error('[ApiKeyManager] Failed to initialize api_keys table:', err);
    });
  }

  private async initTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id          VARCHAR(36)   NOT NULL PRIMARY KEY,
        workspace_id VARCHAR(36)  NOT NULL,
        name        VARCHAR(255)  NOT NULL,
        key_hash    VARCHAR(64)   NOT NULL UNIQUE,
        key_prefix  VARCHAR(20)   NOT NULL,
        created_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        last_used_at DATETIME(3)  NULL,
        revoked_at  DATETIME(3)   NULL,
        CONSTRAINT fk_ak_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  private hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  async createKey(workspaceId: string, name: string): Promise<{ key: string; id: string }> {
    const rawRandom = crypto.randomBytes(32).toString('base64url');
    const key = `swm_${rawRandom}`;
    const keyHash = this.hashKey(key);
    const keyPrefix = key.slice(0, 10);
    const id = uuidv4();

    await this.pool.query(
      `INSERT INTO api_keys (id, workspace_id, name, key_hash, key_prefix)
       VALUES (?, ?, ?, ?, ?)`,
      [id, workspaceId, name, keyHash, keyPrefix],
    );

    return { key, id };
  }

  async validateKey(key: string): Promise<{ valid: boolean; workspaceId?: string }> {
    const keyHash = this.hashKey(key);

    // MySQL UPDATE does not support RETURNING; fetch then update
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, workspace_id FROM api_keys
       WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1`,
      [keyHash],
    );

    if (rows.length === 0) return { valid: false };

    const row = rows[0] as RowDataPacket;
    const workspaceId = row['workspace_id'] as string;

    await this.pool.query(
      'UPDATE api_keys SET last_used_at = NOW(3) WHERE id = ?',
      [row['id']],
    );

    return { valid: true, workspaceId };
  }

  async listKeys(
    workspaceId: string,
  ): Promise<Array<{ id: string; name: string; createdAt: Date; lastUsed: Date | null }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, name, created_at, last_used_at
       FROM api_keys
       WHERE workspace_id = ?
         AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [workspaceId],
    );

    return rows.map((row) => ({
      id: row['id'] as string,
      name: row['name'] as string,
      createdAt: new Date(row['created_at'] as string),
      lastUsed: row['last_used_at'] ? new Date(row['last_used_at'] as string) : null,
    }));
  }

  async revokeKey(keyId: string, workspaceId: string): Promise<void> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE api_keys
       SET revoked_at = NOW(3)
       WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`,
      [keyId, workspaceId],
    );

    if (result.affectedRows === 0) {
      throw new Error(`API key ${keyId} not found or already revoked for workspace ${workspaceId}`);
    }
  }
}

export const apiKeyManager = new ApiKeyManager();
