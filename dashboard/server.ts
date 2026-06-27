import express, { Request, Response } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { authMiddleware, AuthRequest, generateToken } from '../auth/middleware.js';
import { stateStore } from '../memory/state-store.js';
import { config } from '../config/config.js';
import { ProjectPhase } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const pool: Pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: 5,
  waitForConnections: true,
  charset: 'utf8mb4',
});

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());

app.use((_req: Request, res: Response, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.use(express.static(join(__dirname, 'public')));

// ─── Public routes ────────────────────────────────────────────────────────────

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/auth/token', (req: Request, res: Response) => {
  const { workspaceId, userId } = req.body as {
    workspaceId?: string;
    userId?: string;
  };

  const token = generateToken({
    workspaceId: workspaceId ?? 'demo-workspace',
    userId: userId ?? 'demo-user',
  });

  res.json({ token, expiresIn: '24h' });
});

// ─── Protected routes ─────────────────────────────────────────────────────────

app.get('/api/projects', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const workspaceId = req.user?.workspaceId ?? '';
    const projects = await stateStore.listProjects(workspaceId);

    const summary = projects.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      phase: p.phase,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      budget: p.budget,
      stack: {
        primaryDomain: p.stack?.primaryDomain,
        languages: p.stack?.languages,
      },
    }));

    res.json({ projects: summary });
  } catch (err) {
    console.error('[dashboard] GET /api/projects error:', err);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

app.get('/api/projects/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const project = await stateStore.loadProject(req.params['id'] ?? '');

    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    if (project.workspaceId !== req.user?.workspaceId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    res.json({ project });
  } catch (err) {
    console.error('[dashboard] GET /api/projects/:id error:', err);
    res.status(500).json({ error: 'Failed to load project' });
  }
});

app.get('/api/projects/:id/logs', authMiddleware, async (req: AuthRequest, res: Response) => {
  const projectId = req.params['id'] ?? '';

  try {
    const project = await stateStore.loadProject(projectId);
    if (!project || project.workspaceId !== req.user?.workspaceId) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
  } catch {
    res.status(500).json({ error: 'Failed to load project' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (data: unknown): void => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent({ type: 'connected', projectId, timestamp: new Date().toISOString() });

  const streamLogs = async (): Promise<void> => {
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT agent_role, model, input_tokens, output_tokens, cost_usd, created_at
         FROM token_usage_log
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT 50`,
        [projectId],
      );

      for (const row of [...rows].reverse()) {
        sendEvent({
          type: 'log',
          timestamp: row['created_at'],
          agent: row['agent_role'],
          model: row['model'],
          tokens: (row['input_tokens'] as number) + (row['output_tokens'] as number),
          costUsd: row['cost_usd'],
        });
      }
    } catch {
      // DB may not be available; just continue streaming
    }
  };

  await streamLogs();

  const interval = setInterval(async () => {
    try {
      const project = await stateStore.loadProject(projectId);
      if (project) {
        sendEvent({
          type: 'status',
          phase: project.phase,
          budget: project.budget,
          updatedAt: project.updatedAt,
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // continue
    }
  }, 2000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

app.post('/api/projects/:id/pause', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const projectId = req.params['id'] ?? '';
    const project = await stateStore.loadProject(projectId);

    if (!project || project.workspaceId !== req.user?.workspaceId) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    await stateStore.updatePhase(projectId, ProjectPhase.PAUSED);
    res.json({ success: true, phase: ProjectPhase.PAUSED });
  } catch (err) {
    console.error('[dashboard] POST /api/projects/:id/pause error:', err);
    res.status(500).json({ error: 'Failed to pause project' });
  }
});

app.post('/api/projects/:id/resume', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const projectId = req.params['id'] ?? '';
    const project = await stateStore.loadProject(projectId);

    if (!project || project.workspaceId !== req.user?.workspaceId) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    await stateStore.updatePhase(projectId, ProjectPhase.DEVELOPING);
    res.json({ success: true, phase: ProjectPhase.DEVELOPING });
  } catch (err) {
    console.error('[dashboard] POST /api/projects/:id/resume error:', err);
    res.status(500).json({ error: 'Failed to resume project' });
  }
});

/**
 * GET /api/costs/summary
 * MySQL: DATE() replaces DATE_TRUNC('day', ...), DATE_SUB replaces INTERVAL subtraction
 */
app.get('/api/costs/summary', authMiddleware, async (req: AuthRequest, res: Response) => {
  const workspaceId = req.user?.workspaceId ?? '';

  try {
    const [byDayRows] = await pool.query<RowDataPacket[]>(
      `SELECT
         DATE(created_at)                              AS day,
         SUM(cost_usd)                                 AS total_cost_usd,
         SUM(input_tokens + output_tokens)             AS total_tokens
       FROM token_usage_log
       WHERE workspace_id = ?
         AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY DATE(created_at)
       ORDER BY day DESC`,
      [workspaceId],
    );

    const [byAgentRows] = await pool.query<RowDataPacket[]>(
      `SELECT
         agent_role,
         SUM(cost_usd)                     AS total_cost_usd,
         SUM(input_tokens + output_tokens) AS total_tokens,
         COUNT(*)                          AS call_count
       FROM token_usage_log
       WHERE workspace_id = ?
       GROUP BY agent_role
       ORDER BY total_cost_usd DESC`,
      [workspaceId],
    );

    const [byProjectRows] = await pool.query<RowDataPacket[]>(
      `SELECT
         t.project_id,
         p.name                            AS project_name,
         SUM(t.cost_usd)                   AS total_cost_usd,
         SUM(t.input_tokens + t.output_tokens) AS total_tokens
       FROM token_usage_log t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.workspace_id = ?
       GROUP BY t.project_id, p.name
       ORDER BY total_cost_usd DESC`,
      [workspaceId],
    );

    const [todayCost, monthCost] = await Promise.all([
      stateStore.getCostSummary(workspaceId, 'today'),
      stateStore.getCostSummary(workspaceId, 'month'),
    ]);

    res.json({
      summary: {
        todayUsd: todayCost,
        monthUsd: monthCost,
      },
      byDay: byDayRows,
      byAgent: byAgentRows,
      byProject: byProjectRows,
    });
  } catch (err) {
    console.error('[dashboard] GET /api/costs/summary error:', err);
    res.status(500).json({ error: 'Failed to fetch cost summary' });
  }
});

app.get('/api/workspaces/me', authMiddleware, async (req: AuthRequest, res: Response) => {
  const workspaceId = req.user?.workspaceId ?? '';

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT
         id, slack_team_id, team_name,
         daily_budget_usd, monthly_budget_usd,
         used_today_usd, used_this_month_usd,
         created_at, updated_at
       FROM workspaces
       WHERE id = ? LIMIT 1`,
      [workspaceId],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const workspace = rows[0] as RowDataPacket;
    const [todayCost, monthCost] = await Promise.all([
      stateStore.getCostSummary(workspaceId, 'today'),
      stateStore.getCostSummary(workspaceId, 'month'),
    ]);

    res.json({
      workspace: {
        id: workspace['id'],
        slackTeamId: workspace['slack_team_id'],
        teamName: workspace['team_name'],
        budget: {
          dailyLimitUsd: parseFloat((workspace['daily_budget_usd'] as string | null) ?? '50'),
          monthlyLimitUsd: parseFloat((workspace['monthly_budget_usd'] as string | null) ?? '500'),
          usedTodayUsd: todayCost,
          usedThisMonthUsd: monthCost,
        },
        createdAt: workspace['created_at'],
        updatedAt: workspace['updated_at'],
      },
    });
  } catch (err) {
    console.error('[dashboard] GET /api/workspaces/me error:', err);
    res.status(500).json({ error: 'Failed to fetch workspace' });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

export async function startDashboard(): Promise<void> {
  return new Promise((resolve) => {
    app.listen(config.dashboard.port, () => {
      console.log(`[dashboard] Server running on http://localhost:${config.dashboard.port}`);
      resolve();
    });
  });
}

// ─── Standalone entry point ───────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startDashboard().catch((err) => {
    console.error('[dashboard] Failed to start:', err);
    process.exit(1);
  });
}
