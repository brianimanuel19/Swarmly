// Tracks per-user token usage in rolling 5h and 7-day windows (local, in-memory).
// Mirrors the "Session (5hr)" and "Weekly (7 day)" display in Claude Code for VSCode.
// Approximate — does not include usage from other Swarmly instances or claude.ai.

const SESSION_MS = 5 * 60 * 60 * 1000;   // 5 hours
const WEEKLY_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

// Estimated token limits per plan (conservative — used only for % calculation)
const PLAN_SESSION_LIMIT: Record<string, number> = {
  'claude team':  500_000,
  'claude max':   1_000_000,
  'default':      200_000,
};

interface SessionWindow {
  tokens: number;
  startedAt: number;
}

interface WeeklyBucket {
  date: string;
  tokens: number;
}

interface UserRecord {
  session: SessionWindow;
  weeklyBuckets: WeeklyBucket[];
  plan: string | undefined;
}

export interface UsageStats {
  sessionTokens: number;
  weeklyTokens: number;
  sessionPercent: number;
  weeklyPercent: number;
  sessionResetsInMs: number;
  weeklyResetsInMs: number;
  plan: string | undefined;
}

export class UserSessionTracker {
  private readonly users = new Map<string, UserRecord>();

  // ── Record usage after a successful AI call ─────────────────────────────────

  record(slackUserId: string, tokens: number, plan?: string): void {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    let rec = this.users.get(slackUserId);
    if (!rec) {
      rec = { session: { tokens: 0, startedAt: now }, weeklyBuckets: [], plan: plan ?? undefined };
      this.users.set(slackUserId, rec);
    }

    // Reset session if 5h has elapsed
    if (now - rec.session.startedAt >= SESSION_MS) {
      rec.session = { tokens: 0, startedAt: now };
    }
    rec.session.tokens += tokens;

    // Update today's weekly bucket
    let bucket = rec.weeklyBuckets.find((b) => b.date === today);
    if (!bucket) {
      bucket = { date: today, tokens: 0 };
      rec.weeklyBuckets.push(bucket);
    }
    bucket.tokens += tokens;

    // Keep only last 7 days
    const cutoff = new Date(now - WEEKLY_MS).toISOString().slice(0, 10);
    rec.weeklyBuckets = rec.weeklyBuckets.filter((b) => b.date >= cutoff);

    if (plan) rec.plan = plan;
  }

  // ── Read stats for a user ───────────────────────────────────────────────────

  getStats(slackUserId: string): UsageStats {
    const now = Date.now();
    const rec = this.users.get(slackUserId);

    if (!rec) {
      return {
        sessionTokens: 0, weeklyTokens: 0,
        sessionPercent: 0, weeklyPercent: 0,
        sessionResetsInMs: SESSION_MS,
        weeklyResetsInMs: WEEKLY_MS,
        plan: undefined,
      };
    }

    // Reset session if 5h has elapsed
    const sessionElapsed = now - rec.session.startedAt;
    if (sessionElapsed >= SESSION_MS) {
      rec.session = { tokens: 0, startedAt: now };
    }

    const planKey = rec.plan?.toLowerCase() ?? '';
    const sessionLimit = PLAN_SESSION_LIMIT[planKey] ?? PLAN_SESSION_LIMIT['default']!;
    const weeklyLimit = sessionLimit * (WEEKLY_MS / SESSION_MS);

    const cutoff = new Date(now - WEEKLY_MS).toISOString().slice(0, 10);
    const weeklyTokens = rec.weeklyBuckets
      .filter((b) => b.date >= cutoff)
      .reduce((s, b) => s + b.tokens, 0);

    const sorted = [...rec.weeklyBuckets].sort((a, b) => a.date.localeCompare(b.date));
    const oldestBucket = sorted[0];
    const weeklyStartMs = oldestBucket
      ? new Date(oldestBucket.date + 'T00:00:00Z').getTime()
      : now - WEEKLY_MS;

    return {
      sessionTokens: rec.session.tokens,
      weeklyTokens,
      sessionPercent: Math.min(100, Math.round((rec.session.tokens / sessionLimit) * 100)),
      weeklyPercent: Math.min(100, Math.round((weeklyTokens / weeklyLimit) * 100)),
      sessionResetsInMs: Math.max(0, SESSION_MS - sessionElapsed),
      weeklyResetsInMs: Math.max(0, WEEKLY_MS - (now - weeklyStartMs)),
      plan: rec.plan,
    };
  }

  updatePlan(slackUserId: string, plan: string): void {
    const rec = this.users.get(slackUserId);
    if (rec) rec.plan = plan;
  }
}

export const userSessionTracker = new UserSessionTracker();

// ── Formatting helpers ────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 24) return `${Math.floor(h / 24)}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export function progressBar(percent: number, width = 20): string {
  const filled = Math.round((percent / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
