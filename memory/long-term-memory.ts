import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/config.js';
import { AgentRole, MemoryEntry } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Deterministic mock-embedding generator (no pgvector dependency)
// ---------------------------------------------------------------------------
// Anthropic does not expose a standalone text-embedding API.
// We generate a 1536-dimensional unit vector seeded from the content's hash
// so that semantically similar content yields the same vector.
// ---------------------------------------------------------------------------

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return hash;
}

function generateMockEmbedding(text: string): number[] {
  const DIMS = 1536;
  const embedding = new Array<number>(DIMS).fill(0);

  const seed = simpleHash(text);
  const seed2 = simpleHash(text.slice(0, Math.max(1, text.length / 2)));
  const seed3 = simpleHash(text.split(' ').reverse().join(' '));

  const positions: Array<[number, number]> = [
    [Math.abs(seed) % DIMS, (seed % 1000) / 1000],
    [(Math.abs(seed) + 97) % DIMS, (seed2 % 1000) / 1000],
    [(Math.abs(seed2) + 211) % DIMS, (seed3 % 1000) / 1000],
    [(Math.abs(seed3) + 383) % DIMS, (seed % 500) / 500],
    [(Math.abs(seed ^ seed2) + 509) % DIMS, ((seed2 ^ seed3) % 700) / 700],
  ];

  for (const [idx, val] of positions) {
    embedding[idx] = val;
  }

  const magnitude = Math.sqrt(embedding.reduce((acc, v) => acc + v * v, 0)) || 1;
  return embedding.map((v) => v / magnitude);
}

// ---------------------------------------------------------------------------
// JS cosine similarity (replaces pgvector <=> operator)
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// LongTermMemory
// ---------------------------------------------------------------------------

export class LongTermMemory {
  private pool: Pool;
  private anthropic: Anthropic;

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
    this.anthropic = new Anthropic({ apiKey: config.anthropic.apiKey, baseURL: config.anthropic.baseUrl });
  }

  // -------------------------------------------------------------------------
  // summariseWithClaude
  // -------------------------------------------------------------------------
  private async summariseWithClaude(content: string): Promise<string> {
    try {
      const message = await this.anthropic.messages.create({
        model: config.anthropic.models.lobby,
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: `Summarise the following agent decision or observation in 1–3 sentences, preserving all key facts:\n\n${content}`,
          },
        ],
      });

      const block = message.content[0];
      if (block && block.type === 'text') return block.text.trim();
      return content;
    } catch (err) {
      console.warn(`[LongTermMemory] summarise failed, storing raw: ${(err as Error).message}`);
      return content;
    }
  }

  // -------------------------------------------------------------------------
  // remember — store a memory entry with embedding as JSON string
  // -------------------------------------------------------------------------
  async remember(params: {
    projectId: string;
    workspaceId: string;
    agentRole: AgentRole;
    content: string;
  }): Promise<void> {
    const { projectId, workspaceId, agentRole, content } = params;

    try {
      const summary = await this.summariseWithClaude(content);
      const embedding = generateMockEmbedding(summary);

      const sql = `
        INSERT INTO agent_memories
          (id, project_id, workspace_id, agent_role, content, embedding)
        VALUES (?, ?, ?, ?, ?, ?)
      `;

      await this.pool.query(sql, [
        uuidv4(),
        projectId,
        workspaceId,
        agentRole,
        summary,
        JSON.stringify(embedding),
      ]);
    } catch (err) {
      console.warn(`[LongTermMemory] remember skipped (non-critical): ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // recall — JS cosine similarity (replaces pgvector)
  // -------------------------------------------------------------------------
  async recall(params: {
    projectId: string;
    query: string;
    limit?: number;
    threshold?: number;
  }): Promise<MemoryEntry[]> {
    const { projectId, query, limit = 5, threshold = 0.5 } = params;

    try {
      const queryEmbedding = generateMockEmbedding(query);

      // Fetch all memories for this project (embeddings stored as LONGTEXT JSON)
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT id, project_id, workspace_id, agent_role, content, embedding, created_at
         FROM agent_memories
         WHERE project_id = ?`,
        [projectId],
      );

      // Compute cosine similarity in JS
      const scored = rows
        .map((row) => {
          let emb: number[] = [];
          try {
            const raw = row['embedding'] as string | null;
            if (raw) emb = JSON.parse(raw) as number[];
          } catch {
            emb = [];
          }
          return { row, similarity: cosineSimilarity(queryEmbedding, emb) };
        })
        .filter(({ similarity }) => similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

      return scored.map(({ row, similarity: _sim }): MemoryEntry => {
        const raw = row['embedding'] as string | null;
        let emb: number[] | undefined;
        try {
          if (raw) emb = JSON.parse(raw) as number[];
        } catch {
          emb = undefined;
        }
        const base: MemoryEntry = {
          id: row['id'] as string,
          projectId: row['project_id'] as string,
          workspaceId: row['workspace_id'] as string,
          agentRole: row['agent_role'] as AgentRole,
          content: row['content'] as string,
          createdAt: new Date(row['created_at'] as string),
        };
        return emb ? { ...base, embedding: emb } : base;
      });
    } catch (err) {
      console.warn(`[LongTermMemory] recall skipped (non-critical): ${(err as Error).message}`);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // recallForAgent - formatted string for agent context injection
  // -------------------------------------------------------------------------
  async recallForAgent(params: {
    projectId: string;
    agentRole: AgentRole;
    query: string;
  }): Promise<string> {
    const { projectId, agentRole, query } = params;

    try {
      const entries = await this.recall({ projectId, query, limit: 8, threshold: 0.4 });

      const agentEntries = entries.filter((e) => e.agentRole === agentRole);
      const otherEntries = entries.filter((e) => e.agentRole !== agentRole);
      const combined = [...agentEntries, ...otherEntries].slice(0, 5);

      if (combined.length === 0) {
        return 'No relevant previous decisions found.';
      }

      const bulletPoints = combined.map((e) => `- [${e.agentRole}] ${e.content}`).join('\n');
      return `Previous decisions relevant to your task:\n${bulletPoints}`;
    } catch (err) {
      console.warn(`[LongTermMemory] recallForAgent skipped (non-critical): ${(err as Error).message}`);
      return 'No relevant previous decisions found.';
    }
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------
  async close(): Promise<void> {
    try {
      await this.pool.end();
    } catch (err) {
      throw new Error(`LongTermMemory.close failed: ${(err as Error).message}`);
    }
  }
}

export const longTermMemory = new LongTermMemory();
