import { config } from '../config/config.js';
import { tokenTracker, TokenTracker } from './token-tracker.js';
import { stateStore, StateStore } from '../memory/state-store.js';
import { AgentRole, TokenUsage } from '../types/index.js';

// ---------------------------------------------------------------------------
// BudgetExceededError
// ---------------------------------------------------------------------------

export class BudgetExceededError extends Error {
  public readonly agent: AgentRole;
  public readonly reason: string;
  public readonly currentValue: number;
  public readonly limit: number;

  constructor(params: { agent: AgentRole; reason: string; currentValue: number; limit: number }) {
    super(
      `Budget exceeded for agent ${params.agent}: ${params.reason} ` +
        `(current: ${params.currentValue.toLocaleString('en-US')}, limit: ${params.limit.toLocaleString('en-US')})`,
    );
    this.name = 'BudgetExceededError';
    this.agent = params.agent;
    this.reason = params.reason;
    this.currentValue = params.currentValue;
    this.limit = params.limit;
  }
}

// ---------------------------------------------------------------------------
// BudgetGuard
// ---------------------------------------------------------------------------

export class BudgetGuard {
  private tracker: TokenTracker;
  private store: StateStore;

  constructor(tracker: TokenTracker = tokenTracker, store: StateStore = stateStore) {
    this.tracker = tracker;
    this.store = store;
  }

  // -------------------------------------------------------------------------
  // checkBefore - throws BudgetExceededError when any limit is breached
  // -------------------------------------------------------------------------
  async checkBefore(agent: AgentRole, projectId: string, estimatedTokens: number): Promise<void> {
    try {
      // 1. Sprint token limit
      const sprintTokensAfter = this.tracker.getSprintTotalTokens() + estimatedTokens;
      if (sprintTokensAfter > config.budget.maxTokensPerSprint) {
        throw new BudgetExceededError({
          agent,
          reason: 'Sprint token limit would be exceeded',
          currentValue: sprintTokensAfter,
          limit: config.budget.maxTokensPerSprint,
        });
      }

      // 2. Daily cost limit (in-memory)
      const dailyUsd = this.tracker.getDailyTotalUsd();
      if (dailyUsd >= config.budget.maxCostUsdPerDay) {
        throw new BudgetExceededError({
          agent,
          reason: 'Daily USD cost limit already reached',
          currentValue: dailyUsd,
          limit: config.budget.maxCostUsdPerDay,
        });
      }

      // 3. Workspace monthly limit (from DB)
      const project = await this.store.loadProject(projectId);
      if (project) {
        const monthlyUsd = await this.store.getCostSummary(project.workspaceId, 'month');
        // Fetch workspace monthly limit from DB via a direct query isn't exposed in StateStore,
        // so we use the workspace monthly limit from the token_usage_log aggregate.
        // Default workspace monthly limit is 500 USD (from migration default).
        // We surface this via config.budget if not workspace-specific.
        const monthlyLimit = config.budget.maxCostUsdPerDay * 30; // approximate
        if (monthlyUsd >= monthlyLimit) {
          throw new BudgetExceededError({
            agent,
            reason: 'Workspace monthly USD limit reached',
            currentValue: monthlyUsd,
            limit: monthlyLimit,
          });
        }
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      // Unexpected DB error — log and allow (fail-open to avoid blocking agents)
      console.error(`[BudgetGuard] checkBefore DB error (fail-open): ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // recordUsage - delegates to TokenTracker in-memory accounting
  // -------------------------------------------------------------------------
  recordUsage(agent: AgentRole, usage: TokenUsage): void {
    // TokenTracker.record expects model, but usage already has cost pre-computed.
    // We derive a notional model from the agent's configured model and re-record.
    // Since the cost is already estimated by the caller, we use a zero-cost
    // pass-through model to avoid double-counting — instead we directly update
    // the tracker by calling record with matched token counts.
    // The simplest approach: call record with the standard model for the agent
    // and pass the actual token counts; the cost will be recomputed consistently.
    const model = this.resolveModel(agent);
    this.tracker.record(agent, model, usage.inputTokens, usage.outputTokens, usage.cacheHits);
  }

  // -------------------------------------------------------------------------
  // checkAndAlert - post a Slack message if approaching token limit
  // -------------------------------------------------------------------------
  async checkAndAlert(projectId: string, channelId: string): Promise<void> {
    if (!this.tracker.isApproachingLimit()) return;

    try {
      const report = this.tracker.getSprintReport();
      const usedTokens = this.tracker.getSprintTotalTokens();
      const maxTokens = config.budget.maxTokensPerSprint;
      const pct = ((usedTokens / maxTokens) * 100).toFixed(1);

      const message =
        `:warning: *Budget Alert* — Project \`${projectId}\`\n` +
        `Sprint token usage is at *${pct}%* of the limit ` +
        `(${usedTokens.toLocaleString('en-US')} / ${maxTokens.toLocaleString('en-US')} tokens).\n` +
        `Total sprint cost so far: *$${report.total.estimatedCostUsd.toFixed(2)}*\n` +
        `Consider pausing non-critical tasks to stay within budget.`;

      // Lazy-import the Slack web client to avoid circular deps at startup
      const { WebClient } = await import('@slack/web-api');
      const slack = new WebClient(config.slack.botToken);
      await slack.chat.postMessage({ channel: channelId, text: message });

      console.log(
        `[BudgetGuard] Alert posted to channel ${channelId}: ${pct}% of sprint budget used.`,
      );
    } catch (err) {
      // Alert failure must never crash the pipeline
      console.error(`[BudgetGuard] checkAndAlert failed: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Private: resolve canonical model name for an agent
  // -------------------------------------------------------------------------
  private resolveModel(agent: AgentRole): string {
    switch (agent) {
      case AgentRole.PM:
        return config.anthropic.models.pm;
      case AgentRole.DEV:
        return config.anthropic.models.dev;
      case AgentRole.TESTER:
        return config.anthropic.models.tester;
      default:
        return config.anthropic.models.lobby;
    }
  }
}

export const budgetGuard = new BudgetGuard();
