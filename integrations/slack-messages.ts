import type { KnownBlock } from '@slack/types';
import type {
  BugReport,
  CheckpointRequest,
  CostReport,
  RepoAnalysis,
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

// ─── Agent identity ───────────────────────────────────────────────────────────

const AGENT_IDENTITY: Record<string, { label: string; emoji: string }> = {
  [AgentRole.PM]:     { label: 'PM Agent',     emoji: '📋' },
  [AgentRole.PO]:     { label: 'PO Agent',     emoji: '💼' },
  [AgentRole.DEV]:    { label: 'Dev Agent',    emoji: '💻' },
  [AgentRole.DEVOPS]: { label: 'DevOps Agent', emoji: '⚙️' },
  [AgentRole.TESTER]: { label: 'Tester Agent', emoji: '🔬' },
};

/**
 * Wraps any agent reply in Block Kit with a context header showing the agent
 * identity. Works in every Slack channel — no webhook or scope required.
 *
 * @param text    - The message body (supports mrkdwn)
 * @param role    - AgentRole or freeform string key (e.g. 'devops')
 */
export function buildAgentMessage(text: string, role: AgentRole | string): KnownBlock[] {
  const identity = AGENT_IDENTITY[role];
  const blocks: KnownBlock[] = [];

  if (identity) {
    blocks.push(context(`${identity.emoji}  *${identity.label}*`));
  }

  // Split long messages into multiple section blocks (Slack limit: 3000 chars/block)
  const chunks = text.match(/.{1,2900}/gs) ?? [text];
  for (const chunk of chunks) {
    blocks.push(section(chunk));
  }

  return blocks;
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

export function buildRepoAnalysisBlock(
  analysis: RepoAnalysis,
  projectId: string,
): KnownBlock[] {
  const severityEmoji: Record<string, string> = {
    CRITICAL: '🔴',
    HIGH: '🟠',
    MEDIUM: '🟡',
    LOW: '🟢',
  };
  const priorityEmoji: Record<string, string> = {
    MUST: '🔴',
    SHOULD: '🟡',
    COULD: '🟢',
    WONT: '⚪',
  };

  const debtLines = analysis.technicalDebt
    .slice(0, 5)
    .map((d) => `${severityEmoji[d.severity] ?? '•'} ${d.description}${d.file ? ` _(${d.file})_` : ''}`)
    .join('\n');

  const secLines = analysis.securityConcerns
    .slice(0, 3)
    .map((s) => `${severityEmoji[s.severity] ?? '•'} ${s.description}`)
    .join('\n');

  const improvLines = analysis.improvementAreas
    .slice(0, 6)
    .map((i) => `${priorityEmoji[i.priority] ?? '•'} *${i.title}* (~${i.estimateHours}h) — ${i.description}`)
    .join('\n');

  const blocks: KnownBlock[] = [
    header(`🔍 Repo Analysis: ${analysis.repoName}`),
    divider(),
    section(
      `*Stack Detected:* ${analysis.detectedStack.join(', ')}\n` +
      `*Files in repo:* ${analysis.fileCount} total, ${analysis.sampledFiles.length} analyzed`,
    ),
    divider(),
    section(`*Summary*\n${analysis.summary}`),
  ];

  if (debtLines) {
    blocks.push(divider(), section(`*Technical Debt*\n${debtLines}`));
  }
  if (secLines) {
    blocks.push(section(`*Security Concerns*\n${secLines}`));
  }
  if (improvLines) {
    blocks.push(divider(), section(`*Improvement Backlog (PO-Prioritised)*\n${improvLines}`));
  }

  blocks.push(
    divider(),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve & Start Sprint', emoji: true },
          style: 'primary',
          action_id: 'checkpoint_approve',
          value: projectId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Cancel', emoji: true },
          style: 'danger',
          action_id: 'checkpoint_reject',
          value: projectId,
        },
      ],
    },
  );

  return blocks;
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

export function buildSprintPlanBlock(params: {
  sprint: Sprint;
  projectId: string;
  jiraSprintId?: string;
  jiraProjectKey?: string | null;
  jiraBaseUrl?: string;
}): KnownBlock[] {
  const { sprint, projectId, jiraSprintId, jiraProjectKey, jiraBaseUrl } = params;

  const typeEmoji: Record<string, string> = {
    BE: '⚙️', FE: '🖥️', TEST: '🧪', INFRA: '🏗️', DEVOPS: '🚀', DESIGN: '🎨',
  };
  const priorityEmoji: Record<string, string> = { HIGH: '🔴', MEDIUM: '🟡', LOW: '🟢' };

  const taskLines = sprint.tasks
    .map(
      (t) =>
        `${typeEmoji[t.type] ?? '•'} ${priorityEmoji[t.priority] ?? ''} *${t.title}*` +
        `  _[${t.type} · ${t.estimateHours}h]_`,
    )
    .join('\n');

  const totalHours = sprint.tasks.reduce((s, t) => s + t.estimateHours, 0);

  const jiraLink =
    jiraBaseUrl && jiraProjectKey && jiraSprintId
      ? `\n\n*Jira Sprint:* <${jiraBaseUrl}/jira/software/projects/${jiraProjectKey}/boards|Open board>`
      : '';

  const blocks: KnownBlock[] = [
    header(`📋 Sprint Plan Ready — ${sprint.goal}`),
    divider(),
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Tasks*\n${sprint.tasks.length}` },
        { type: 'mrkdwn', text: `*Estimated total*\n${totalHours}h` },
      ],
    },
    divider(),
    section(`*Task Breakdown*\n${taskLines || '_No tasks_'}${jiraLink}`),
    divider(),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve & Start Coding', emoji: true },
          style: 'primary',
          action_id: 'checkpoint_approve',
          value: projectId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Reject & Re-plan', emoji: true },
          style: 'danger',
          action_id: 'checkpoint_reject',
          value: projectId,
        },
      ],
    },
  ];

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
    DEVOPS: '🔧 DevOps',
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
    [AgentRole.PO]: '💼',
    [AgentRole.DEV]: '👨‍💻',
    [AgentRole.DEVOPS]: '⚙️',
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

export function buildCreditExhaustedBlock(params: {
  projectId: string;
  projectName: string;
  pausedTaskTitle: string;
  doneTasks: number;
  totalTasks: number;
  costSoFar: string;
  creditType: 'API_402' | 'BUDGET_DAILY' | 'BUDGET_SPRINT';
}): KnownBlock[] {
  const { projectId, projectName, pausedTaskTitle, doneTasks, totalTasks, costSoFar, creditType } =
    params;

  const reasonText =
    creditType === 'API_402'
      ? 'Anthropic API credit exhausted — please top up your account'
      : creditType === 'BUDGET_DAILY'
        ? 'Daily budget limit reached — resets at midnight or raise the limit'
        : 'Sprint token limit reached — reset the sprint budget to continue';

  const resumeHint =
    creditType === 'BUDGET_DAILY'
      ? 'Raise the daily limit in config or wait until tomorrow, then resume.'
      : 'Top up your Anthropic credits, then resume.';

  return [
    header('Project Paused — Credits Exhausted'),
    divider(),
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Project:*\n${projectName}` },
        { type: 'mrkdwn', text: `*Paused at task:*\n${pausedTaskTitle}` },
        { type: 'mrkdwn', text: `*Progress:*\n${doneTasks}/${totalTasks} tasks done` },
        { type: 'mrkdwn', text: `*Cost so far:*\n${costSoFar}` },
      ],
    },
    section(`*Reason:* ${reasonText}`),
    section(`_${resumeHint}_`),
    divider(),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Resume Project', emoji: false },
          style: 'primary',
          action_id: 'resume_project',
          value: projectId,
        },
      ],
    },
  ];
}
