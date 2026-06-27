import mysql from 'mysql2/promise';
import type { Connection } from 'mysql2/promise';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export async function runMigrations(conn: Connection): Promise<void> {
  // Ensure tracking table exists
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // List all .sql files sorted by name
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT 1 FROM schema_migrations WHERE filename = ? LIMIT 1',
      [file],
    );

    if (rows.length > 0) continue; // already applied

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

    // Split on semicolons so multi-statement files work
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      await conn.query(stmt);
    }

    await conn.query(
      'INSERT INTO schema_migrations (filename) VALUES (?)',
      [file],
    );

    console.log(`[Migrator] Applied: ${file}`);
  }
}
