import type { KnownBlock } from '@slack/types';
import type {
  BugReport,
  CheckpointRequest,
  CostReport,
  Sprint,
  SprintBudget,
  Task,
  TokenUsage,
} from '../types/index.js';
import { AgentRole } from '../types/index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function divider(): KnownBlock {
  return { type: 'divider' };
}

function header(text: string): KnownBlock {
  return {
    type: 'header',
    text: { type: 'plain_text', text, emoji: true },
  };
}

function section(mrkdwn: string): KnownBlock {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: mrkdwn },
  };
}

function context(mrkdwn: string): KnownBlock {
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: mrkdwn }],
  };
}

function buildProgressBar(used: number, allocated: number, width = 20): string {
  const ratio = Math.min(used / Math.max(allocated, 1), 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const pct = Math.round(ratio * 100);
  return `\`[${bar}] ${pct}%\``;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── FILE 1 EXPORTS ─────────────────────────────────────────────────────────

export function buildRunConfirmationBlock(params: {
  projectName: string;
  requirement: string;
  domains: string[];
  estimatedCostRange: string;
  estimatedTimeRange: string;
}): KnownBlock[] {
  const { projectName, requirement, domains, estimatedCostRange, estimatedTimeRange } = params;

  const domainList = domains.map((d) => `• ${d}`).join('\n');

  return [
    header(`🚀 New Project: ${projectName}`),
    divider(),
    section(`*Requirement*\n${requirement}`),
    divider(),
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Detected Domains*\n${domainList || '• None detected'}` },
        {
          type: 'mrkdwn',
          text: `*Estimates*\n💰 Cost: ${estimatedCostRange}\n⏱️ Time: ${estimatedTimeRange}`,
        },
      ],
    },
    divider(),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '▶ Run Now', emoji: true },
          style: 'primary',
          action_id: 'run_confirm',
          value: projectName,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '✏️ Edit', emoji: true },
          action_id: 'run_edit',
          value: projectName,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '✖ Cancel', emoji: true },
          style: 'danger',
          action_id: 'run_cancel',
          value: projectName,
        },
      ],
    },
  ];
}

export function buildStandupBlock(report: {
  projectName: string;
  doneTasks: string[];
  inProgressTask: string;
  blockers: string[];
  tokenUsage: TokenUsage;
}): KnownBlock[] {
  const { projectName, doneTasks, inProgressTask, blockers, tokenUsage } = report;

  const doneList =
    doneTasks.length > 0 ? doneTasks.map((t) => `✅ ${t}`).join('\n') : '_Nothing completed yet._';

  const blockerList =
    blockers.length > 0 ? blockers.map((b) => `🚧 ${b}`).join('\n') : '_No blockers._';

  const costLine = `💰 *$${tokenUsage.estimatedCostUsd.toFixed(4)}* (${formatTokens(tokenUsage.totalTokens)} tokens — ${formatTokens(tokenUsage.inputTokens)} in / ${formatTokens(tokenUsage.outputTokens)} out / ${formatTokens(tokenUsage.cacheHits)} cached)`;

  return [
    header(`📋 Daily Standup — ${projectName}`),
    context(`Generated at ${new Date().toUTCString()}`),
    divider(),
    section(`*✅ Done*\n${doneList}`),
    section(`*🔄 In Progress*\n${inProgressTask || '_Nothing in progress._'}`),
    section(`*🚧 Blockers*\n${blockerList}`),
    divider(),
    section(`*Token Usage*\n${costLine}`),
  ];
}

export function buildCheckpointBlock(
  params: CheckpointRequest & { costSoFar?: string },
): KnownBlock[] {
  const { phase, summary, questions, costSoFar } = params;

  const questionList =
    questions.length > 0
      ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
      : '_No questions at this time._';

  const blocks: KnownBlock[] = [
    header(`🔍 Checkpoint — Phase: ${phase}`),
    divider(),
    section(`*Summary*\n${summary}`),
    divider(),
    section(`*Questions for Review*\n${questionList}`),
  ];

  if (costSoFar) {
    blocks.push(section(`*Cost So Far*\n💰 ${costSoFar}`));
  }

  blocks.push(divider(), {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '✅ Approve', emoji: true },
        style: 'primary',
        action_id: 'checkpoint_approve',
        value: params.projectId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '❌ Reject', emoji: true },
        style: 'danger',
        action_id: 'checkpoint_reject',
        value: params.projectId,
      },
    ],
  });

  return blocks;
}

export function buildBugAlertBlock(bugs: BugReport[]): KnownBlock[] {
  const severityOrder: BugReport['severity'][] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const severityEmoji: Record<BugReport['severity'], string> = {
    CRITICAL: '🔴',
    HIGH: '🟠',
    MEDIUM: '🟡',
    LOW: '🟢',
  };

  const sorted = [...bugs].sort(
    (a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity),
  );

  const blocks: KnownBlock[] = [
    header(`🐛 Bug Report — ${bugs.length} Issue${bugs.length === 1 ? '' : 's'} Found`),
    divider(),
  ];

  const grouped = new Map<BugReport['severity'], BugReport[]>();
  for (const sev of severityOrder) {
    const group = sorted.filter((b) => b.severity === sev);
    if (group.length > 0) grouped.set(sev, group);
  }

  grouped.forEach((group, sev) => {
    blocks.push(section(`*${severityEmoji[sev]} ${sev} (${group.length})*`));
    for (const bug of group) {
      blocks.push(
        section(
          `*${bug.title}*\n` +
            `_File:_ \`${bug.affectedFile}\`\n` +
            `_Expected:_ ${bug.expected}\n` +
            `_Actual:_ ${bug.actual}\n` +
            `_Fix:_ ${bug.suggestedFix}` +
            (bug.jiraId ? `\n_Jira:_ ${bug.jiraId}` : ''),
        ),
      );
    }
    blocks.push(divider());
  });

  return blocks;
}

export function buildTaskCompleteBlock(task: Task, commitUrl: string): KnownBlock[] {
  const typeBadge: Record<Task['type'], string> = {
    BE: '⚙️ Backend',
    FE: '🎨 Frontend',
    TEST: '🧪 Test',
    INFRA: '🏗️ Infra',
    DESIGN: '📐 Design',
  };

  const priorityEmoji: Record<Task['priority'], string> = {
    HIGH: '🔴',
    MEDIUM: '🟡',
    LOW: '🟢',
  };

  return [
    header(`✅ Task Complete`),
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${task.title}*` },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'View Commit', emoji: true },
        url: commitUrl,
        action_id: 'view_commit',
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Type*\n${typeBadge[task.type]}` },
        { type: 'mrkdwn', text: `*Priority*\n${priorityEmoji[task.priority]} ${task.priority}` },
        { type: 'mrkdwn', text: `*Assignee*\n${task.assignee}` },
        { type: 'mrkdwn', text: `*Attempts*\n${task.attempts}` },
      ],
    },
    context(
      task.acceptanceCriteria.length > 0
        ? `*Acceptance Criteria:* ${task.acceptanceCriteria.join(' · ')}`
        : '_No acceptance criteria defined._',
    ),
  ];
}

export function buildSprintSummaryBlock(params: {
  sprint: Sprint;
  totalCost: string;
  duration: string;
  prUrl: string;
  stats: { tasksCompleted: number; bugsFixed: number; testsWritten: number };
}): KnownBlock[] {
  const { sprint, totalCost, duration, prUrl, stats } = params;

  return [
    header(`🏁 Sprint Complete — ${sprint.goal}`),
    divider(),
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Tasks Completed*\n✅ ${stats.tasksCompleted}` },
        { type: 'mrkdwn', text: `*Bugs Fixed*\n🐛 ${stats.bugsFixed}` },
        { type: 'mrkdwn', text: `*Tests Written*\n🧪 ${stats.testsWritten}` },
        { type: 'mrkdwn', text: `*Duration*\n⏱️ ${duration}` },
      ],
    },
    section(`*Total Cost*\n💰 ${totalCost}`),
    divider(),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔗 View Pull Request', emoji: true },
          style: 'primary',
          url: prUrl,
          action_id: 'view_pr',
        },
      ],
    },
  ];
}

export function buildCostAlertBlock(budget: SprintBudget): KnownBlock[] {
  const bar = buildProgressBar(budget.usedTokens, budget.allocatedTokens);
  const usdBar = buildProgressBar(budget.usedUsd * 100, budget.allocatedUsd * 100);
  const alertEmoji = budget.isOverBudget ? '🚨' : '⚠️';
  const alertLabel = budget.isOverBudget ? 'OVER BUDGET' : 'APPROACHING LIMIT';

  return [
    header(`${alertEmoji} Budget Alert — ${alertLabel}`),
    divider(),
    section(
      `*Token Usage*\n` +
        `${bar}\n` +
        `Used: ${formatTokens(budget.usedTokens)} / ${formatTokens(budget.allocatedTokens)} ` +
        `(${formatTokens(budget.remainingTokens)} remaining)`,
    ),
    section(
      `*USD Usage*\n` +
        `${usdBar}\n` +
        `Used: $${budget.usedUsd.toFixed(4)} / $${budget.allocatedUsd.toFixed(4)}`,
    ),
    context(
      budget.isOverBudget
        ? '🚨 Sprint is *over budget*. Consider pausing with `/swarmly-pause`.'
        : '⚠️ Sprint is approaching the budget limit. Monitor usage closely.',
    ),
  ];
}

export function buildCostReportBlock(report: CostReport): KnownBlock[] {
  const agentEmoji: Record<AgentRole, string> = {
    [AgentRole.PM]: '👩‍💼',
    [AgentRole.DEV]: '👨‍💻',
    [AgentRole.TESTER]: '🧪',
  };

  const rows = Object.entries(report.byAgent)
    .map(([role, usage]) => {
      const r = role as AgentRole;
      return (
        `${agentEmoji[r]} *${r}*\n` +
        `  ${formatTokens(usage.totalTokens)} tokens — $${usage.estimatedCostUsd.toFixed(4)}`
      );
    })
    .join('\n');

  const periodLabel = report.period.charAt(0).toUpperCase() + report.period.slice(1);

  return [
    header(`💰 Cost Report — ${periodLabel}`),
    divider(),
    section(rows || '_No agent data available._'),
    divider(),
    section(
      `*Total*\n` +
        `${formatTokens(report.total.totalTokens)} tokens — ` +
        `$${report.total.estimatedCostUsd.toFixed(4)}\n` +
        `_${formatTokens(report.total.inputTokens)} in / ` +
        `${formatTokens(report.total.outputTokens)} out / ` +
        `${formatTokens(report.total.cacheHits)} cached_`,
    ),
    context(`Generated at ${report.generatedAt.toUTCString()}`),
  ];
}
