import { config } from '../config/config.js';
import { AgentRole, TokenUsage, CostReport } from '../types/index.js';

// ---------------------------------------------------------------------------
// Internal tracking types
// ---------------------------------------------------------------------------

interface AgentTally {
  inputTokens: number;
  outputTokens: number;
  cacheHits: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

function emptyTally(): AgentTally {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheHits: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
  };
}

function tallyToTokenUsage(t: AgentTally): TokenUsage {
  return { ...t };
}

// ---------------------------------------------------------------------------
// TokenTracker
// ---------------------------------------------------------------------------

export class TokenTracker {
  /** Per-agent tallies for the current sprint */
  private sprintTotals: Map<AgentRole, AgentTally> = new Map();

  /** Per-agent tallies for the current calendar day */
  private dailyTotals: Map<AgentRole, AgentTally> = new Map();

  /** Cumulative tokens across all agents for the sprint (for limit checks) */
  private sprintTotalTokens: number = 0;

  /** Date string (YYYY-MM-DD) for when dailyTotals was last reset */
  private dailyResetDate: string = new Date().toISOString().slice(0, 10);

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private ensureDayReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyResetDate) {
      this.dailyTotals.clear();
      this.dailyResetDate = today;
    }
  }

  private getTally(map: Map<AgentRole, AgentTally>, agent: AgentRole): AgentTally {
    if (!map.has(agent)) {
      map.set(agent, emptyTally());
    }
    return map.get(agent)!;
  }

  private formatNumber(n: number): string {
    return n.toLocaleString('en-US');
  }

  // -------------------------------------------------------------------------
  // estimateCost
  // -------------------------------------------------------------------------
  estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheHits: number = 0,
  ): number {
    const pricing = config.anthropic.pricing[model];
    if (!pricing) {
      // Unknown model — fall back to Sonnet pricing
      const fallback = config.anthropic.pricing['claude-sonnet-4-6']!;
      return (
        ((inputTokens - cacheHits) * fallback.input +
          outputTokens * fallback.output +
          cacheHits * fallback.cacheHit) /
        1_000_000
      );
    }

    return (
      ((inputTokens - cacheHits) * pricing.input +
        outputTokens * pricing.output +
        cacheHits * pricing.cacheHit) /
      1_000_000
    );
  }

  // -------------------------------------------------------------------------
  // record
  // -------------------------------------------------------------------------
  record(
    agent: AgentRole,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheHits: number = 0,
  ): void {
    this.ensureDayReset();

    const cost = this.estimateCost(model, inputTokens, outputTokens, cacheHits);
    const totalTokens = inputTokens + outputTokens;

    // --- Sprint totals ---
    const sprintTally = this.getTally(this.sprintTotals, agent);
    sprintTally.inputTokens += inputTokens;
    sprintTally.outputTokens += outputTokens;
    sprintTally.cacheHits += cacheHits;
    sprintTally.totalTokens += totalTokens;
    sprintTally.estimatedCostUsd += cost;
    this.sprintTotalTokens += totalTokens;

    // --- Daily totals ---
    const dailyTally = this.getTally(this.dailyTotals, agent);
    dailyTally.inputTokens += inputTokens;
    dailyTally.outputTokens += outputTokens;
    dailyTally.cacheHits += cacheHits;
    dailyTally.totalTokens += totalTokens;
    dailyTally.estimatedCostUsd += cost;

    // --- Sprint aggregate cost for the log line ---
    const sprintTotalUsd = Array.from(this.sprintTotals.values()).reduce(
      (acc, t) => acc + t.estimatedCostUsd,
      0,
    );

    console.log(
      `[COST] ${agent} | ` +
        `${this.formatNumber(inputTokens)} in / ` +
        `${this.formatNumber(outputTokens)} out / ` +
        `${this.formatNumber(cacheHits)} cached | ` +
        `$${cost.toFixed(4)} | ` +
        `Sprint total: $${sprintTotalUsd.toFixed(2)}`,
    );
  }

  // -------------------------------------------------------------------------
  // getDailyReport
  // -------------------------------------------------------------------------
  getDailyReport(): CostReport {
    this.ensureDayReset();

    const byAgent = {} as Record<AgentRole, TokenUsage>;
    const total = emptyTally();

    for (const role of Object.values(AgentRole)) {
      const tally = this.dailyTotals.get(role) ?? emptyTally();
      byAgent[role] = tallyToTokenUsage(tally);
      total.inputTokens += tally.inputTokens;
      total.outputTokens += tally.outputTokens;
      total.cacheHits += tally.cacheHits;
      total.totalTokens += tally.totalTokens;
      total.estimatedCostUsd += tally.estimatedCostUsd;
    }

    return {
      period: 'daily',
      byAgent,
      total: tallyToTokenUsage(total),
      generatedAt: new Date(),
    };
  }

  // -------------------------------------------------------------------------
  // getSprintReport
  // -------------------------------------------------------------------------
  getSprintReport(): CostReport {
    const byAgent = {} as Record<AgentRole, TokenUsage>;
    const total = emptyTally();

    for (const role of Object.values(AgentRole)) {
      const tally = this.sprintTotals.get(role) ?? emptyTally();
      byAgent[role] = tallyToTokenUsage(tally);
      total.inputTokens += tally.inputTokens;
      total.outputTokens += tally.outputTokens;
      total.cacheHits += tally.cacheHits;
      total.totalTokens += tally.totalTokens;
      total.estimatedCostUsd += tally.estimatedCostUsd;
    }

    return {
      period: 'sprint',
      byAgent,
      total: tallyToTokenUsage(total),
      generatedAt: new Date(),
    };
  }

  // -------------------------------------------------------------------------
  // isApproachingLimit
  // -------------------------------------------------------------------------
  isApproachingLimit(): boolean {
    return (
      this.sprintTotalTokens >= config.budget.maxTokensPerSprint * config.budget.warningThreshold
    );
  }

  // -------------------------------------------------------------------------
  // resetSprint
  // -------------------------------------------------------------------------
  resetSprint(): void {
    this.sprintTotals.clear();
    this.sprintTotalTokens = 0;
    console.log('[COST] Sprint token counters reset.');
  }

  // -------------------------------------------------------------------------
  // Expose raw sprint token count for BudgetGuard
  // -------------------------------------------------------------------------
  getSprintTotalTokens(): number {
    return this.sprintTotalTokens;
  }

  getDailyTotalUsd(): number {
    this.ensureDayReset();
    return Array.from(this.dailyTotals.values()).reduce((acc, t) => acc + t.estimatedCostUsd, 0);
  }
}

export const tokenTracker = new TokenTracker();
