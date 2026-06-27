import { WebClient } from '@slack/web-api';
import { SlackListener } from '../integrations/slack-listener.js';
import { SlackChannelManager } from '../integrations/slack-channels.js';
import { stackDetector } from './stack-detector.js';
import { stateStore } from '../memory/state-store.js';
import { tokenTracker } from '../cost-control/token-tracker.js';
import { workspaceAuth } from '../auth/workspace.js';
import { startDashboard } from '../dashboard/server.js';
import { config } from '../config/config.js';
import {
  ProjectPhase,
  ProjectState,
  LobbyMessage,
  ConversationHistory,
  AgentRole,
  AgentMessage,
} from '../types/index.js';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';

// ─── Lazy imports for agents (created on first use) ──────────────────────────
// pm-agent and pipeline are imported inline to allow circular-ref safety and
// to avoid instantiation at module load when env vars may not be set yet.

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class Orchestrator {
  private slackListener!: SlackListener;
  private slackChannelManager!: SlackChannelManager;
  private webClient!: WebClient;
  private pool: Pool;
  /**
   * In-memory lobby conversations per Slack thread.
   * Key: `{channelId}:{threadTs}`
   */
  private lobbyConversations: Map<string, ConversationHistory> = new Map();

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
  }

  // ─── Public: start Slack mode ─────────────────────────────────────────────

  async startSlackMode(): Promise<void> {
    // 1. Test DB connection
    try {
      await this.pool.query('SELECT 1 AS ok');
      console.log('[Orchestrator] DB connection OK');
    } catch (err) {
      console.error('[Orchestrator] DB connection FAILED:', err);
      throw err;
    }

    // 2. Initialise Slack clients
    this.webClient = new WebClient(config.slack.botToken);
    this.slackListener = new SlackListener();
    this.slackChannelManager = new SlackChannelManager(this.webClient);

    // 3. Start dashboard server
    await startDashboard();

    // 4. Register lobby handler
    this.slackListener.setupLobbyHandler(async (msg: LobbyMessage) => {
      await this.handleLobbyMessage(msg);
    });

    // 4b. Register chat channel handler (optional — only if SLACK_CHAT_CHANNEL is set)
    if (config.slack.chatChannelId) {
      const chatChannelId = config.slack.chatChannelId;
      this.slackListener.setupChatHandler(chatChannelId, async ({ threadKey, userMessage, userId, channelId, threadTs }) => {
        try {
          const { chatReply, clearThread } = await import('../agents/chat-agent.js');

          if (userMessage.trim().toLowerCase() === 'reset') {
            clearThread(threadKey);
            await this.webClient.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: 'Conversation reset. Start fresh!',
            });
            return;
          }

          const reply = await chatReply({ threadKey, userMessage, userId });
          await this.webClient.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: reply,
          });
        } catch (err) {
          console.error('[Orchestrator] chatHandler error:', err);
        }
      });
      console.log(`[Orchestrator] Chat channel registered: ${chatChannelId}`);
    }

    // 5. Register action handlers (run_confirm / run_cancel / checkpoint)
    this.slackListener.setupActionHandlers({
      onRunConfirm: async (event) => {
        await this.handleRunConfirm(event);
      },
      onRunEdit: async (event) => {
        // Cast to access raw Bolt payload
        const payload = event as unknown as {
          body?: { channel?: { id?: string }; message?: { ts?: string } };
          say?: (msg: string) => Promise<void>;
        };
        const channelId = payload.body?.channel?.id ?? config.slack.lobbyChannelId;
        const ts = payload.body?.message?.ts ?? '';
        await this.webClient.chat.postMessage({
          channel: channelId,
          thread_ts: ts,
          text: 'Please update your requirements and send another message in this thread.',
        });
      },
      onRunCancel: async (event) => {
        const payload = event as unknown as {
          body?: { channel?: { id?: string }; message?: { ts?: string } };
        };
        const channelId = payload.body?.channel?.id ?? config.slack.lobbyChannelId;
        const ts = payload.body?.message?.ts ?? '';
        await this.webClient.chat.postMessage({
          channel: channelId,
          thread_ts: ts,
          text: 'Cancelled. Feel free to start a new project whenever you are ready.',
        });
      },
      onCheckpointApprove: async (event) => {
        await this.handleCheckpointAction(event, true);
      },
      onCheckpointReject: async (event) => {
        await this.handleCheckpointAction(event, false);
      },
    });

    // 6. Register mention handler
    this.slackListener.setupMentionHandler(async (mention) => {
      await this.handleMention(mention);
    });

    // 7. Register slash commands
    this.slackListener.setupSlashCommands({
      onStatus: async (args) => {
        const channelId = args.command.channel_id;
        const project = await this.findProjectByChannel(channelId);
        if (!project) {
          await this.webClient.chat.postMessage({
            channel: channelId,
            text: 'No active project found in this channel. Use the lobby to start one.',
          });
          return;
        }
        const budget = project.budget;
        const report =
          `*Project:* ${project.name}\n` +
          `*Phase:* ${project.phase}\n` +
          `*Sprint:* ${project.sprint?.goal ?? 'N/A'}\n` +
          `*Cost so far:* ${formatCost(budget.usedUsd)} / ${formatCost(budget.allocatedUsd)}\n` +
          `*Tokens used:* ${budget.usedTokens.toLocaleString()}`;
        await this.webClient.chat.postMessage({ channel: channelId, text: report });
      },

      onCost: async (args) => {
        const channelId = args.command.channel_id;
        const project = await this.findProjectByChannel(channelId);
        if (!project) {
          await this.webClient.chat.postMessage({
            channel: channelId,
            text: 'No project found in this channel.',
          });
          return;
        }
        const report = tokenTracker.getSprintReport();
        const lines = Object.entries(report.byAgent).map(
          ([role, usage]) =>
            `• *${role}*: ${usage.totalTokens.toLocaleString()} tokens — ${formatCost(usage.estimatedCostUsd)}`,
        );
        await this.webClient.chat.postMessage({
          channel: channelId,
          text: `*Cost breakdown for ${project.name}:*\n${lines.join('\n')}\n*Total:* ${formatCost(report.total.estimatedCostUsd)}`,
        });
      },

      onPause: async (args) => {
        const channelId = args.command.channel_id;
        const project = await this.findProjectByChannel(channelId);
        if (!project) {
          await this.webClient.chat.postMessage({
            channel: channelId,
            text: 'No project found in this channel.',
          });
          return;
        }
        await stateStore.updatePhase(project.id, ProjectPhase.PAUSED);
        await this.webClient.chat.postMessage({
          channel: channelId,
          text: `⏸ Project *${project.name}* has been paused. Use \`/swarmly-resume\` to continue.`,
        });
      },

      onResume: async (args) => {
        const channelId = args.command.channel_id;
        const project = await this.findProjectByChannel(channelId);
        if (!project) {
          await this.webClient.chat.postMessage({
            channel: channelId,
            text: 'No project found in this channel.',
          });
          return;
        }
        await stateStore.updatePhase(project.id, ProjectPhase.DEVELOPING);
        await this.webClient.chat.postMessage({
          channel: channelId,
          text: `▶ Project *${project.name}* has been resumed.`,
        });
      },

      onHelp: async (args) => {
        await this.webClient.chat.postMessage({
          channel: args.command.channel_id,
          text: [
            '*Swarmly Slash Commands:*',
            '• `/swarmly-status` — Show current project phase and cost',
            '• `/swarmly-cost` — Detailed cost breakdown by agent',
            '• `/swarmly-pause` — Pause the current project',
            '• `/swarmly-resume` — Resume a paused project',
            '• `/swarmly-help` — Show this help message',
            '',
            'To start a new project, describe it in the lobby channel.',
          ].join('\n'),
        });
      },
    });

    // 8. Reaction handler (e.g. :white_check_mark: for checkpoint approval)
    this.slackListener.setupReactionHandler(async (reaction) => {
      if (reaction.emoji === 'white_check_mark') {
        console.log(`[Orchestrator] Reaction checkpoint approve in ${reaction.channelId}`);
      }
    });

    // 9. Daily standup cron: 9 AM Asia/Ho_Chi_Minh
    cron.schedule(
      '0 9 * * *',
      async () => {
        await this.postDailyStandup();
      },
      { timezone: 'Asia/Ho_Chi_Minh' },
    );

    // 10. Start Slack socket mode listener
    await this.slackListener.start();

    // 11. Ready log
    console.log(
      `🤖 Swarmly is listening in #${config.slack.lobbyChannelId}... Dashboard at http://localhost:${config.dashboard.port}`,
    );
  }

  // ─── Lobby message handler ─────────────────────────────────────────────────

  private async handleLobbyMessage(msg: LobbyMessage): Promise<void> {
    const threadKey = `${msg.channelId}:${msg.ts}`;

    // Load or initialise conversation history for this thread
    let history = this.lobbyConversations.get(threadKey) ?? (msg.history as ConversationHistory);

    // Add the incoming user message to history
    const userMsg: AgentMessage = {
      role: 'user',
      content: msg.text,
      timestamp: new Date(),
    };
    history = [...history, userMsg];
    this.lobbyConversations.set(threadKey, history);

    try {
      // Dynamically import pm-agent to avoid circular dep issues at boot
      const { pmAgent } = await import('../agents/pm-agent.js');

      const result = await pmAgent.chatInLobby(msg.text, history, msg.workspaceId);

      // Append assistant response to history
      const assistantMsg: AgentMessage = {
        role: 'assistant',
        content: result.text,
        agentRole: AgentRole.PM,
        timestamp: new Date(),
      };
      this.lobbyConversations.set(threadKey, [...history, assistantMsg]);

      // Post reply in the thread
      await this.slackListener.replyInThread(msg.channelId, msg.ts, result.text);

      // If PM signals the project is READY_TO_RUN, show the confirmation block
      if (result.type === 'READY_TO_RUN') {
        // Summarise the conversation to get a structured requirement
        const requirement = await pmAgent.summarizeRequirement(history);
        const detectedStack = await stackDetector.detect(requirement);
        const projectName =
          requirement
            .split('.')[0]
            ?.replace(/^Build a? /i, '')
            .trim() ?? 'New Project';
        const domains = detectedStack.domains.map((d) => String(d));
        const costRange = stackDetector.estimateCost(detectedStack);
        const timeRange = stackDetector.estimateTime(detectedStack);

        const { buildRunConfirmationBlock } = await import('../integrations/slack-messages.js');
        const blocks = buildRunConfirmationBlock({
          projectName,
          requirement,
          domains,
          estimatedCostRange: costRange,
          estimatedTimeRange: timeRange,
        });

        await this.slackListener.postMessage(
          msg.channelId,
          `Ready to build *${projectName}*! Please confirm:`,
          blocks,
        );

        // Store the pending project summary for when the user confirms
        this.lobbyConversations.set(`pending:${msg.channelId}:${msg.ts}`, [
          {
            role: 'user',
            content: JSON.stringify({
              type: 'pending_project',
              summary: {
                name: projectName,
                requirement,
                domains,
                estimatedCostRange: costRange,
                estimatedTimeRange: timeRange,
              },
              userId: msg.userId,
              channelId: msg.channelId,
              ts: msg.ts,
              workspaceId: msg.workspaceId,
            }),
            timestamp: new Date(),
          },
        ]);
      }
    } catch (err) {
      console.error('[Orchestrator] handleLobbyMessage error:', err);
      await this.slackListener.replyInThread(
        msg.channelId,
        msg.ts,
        'Sorry, I ran into an issue processing your request. Please try again.',
      );
    }
  }

  // ─── Run confirm handler ──────────────────────────────────────────────────

  private async handleRunConfirm(event: unknown): Promise<void> {
    const e = event as {
      body?: {
        channel?: { id?: string };
        message?: { ts?: string; thread_ts?: string };
        user?: { id?: string };
      };
    };

    const channelId = e.body?.channel?.id ?? config.slack.lobbyChannelId;
    const ts = e.body?.message?.thread_ts ?? e.body?.message?.ts ?? '';
    const userId = e.body?.user?.id ?? 'unknown';

    // Find the pending project
    const pendingKey = `pending:${channelId}:${ts}`;
    const pendingHistory = this.lobbyConversations.get(pendingKey);

    if (!pendingHistory || pendingHistory.length === 0) {
      await this.webClient.chat.postMessage({
        channel: channelId,
        thread_ts: ts,
        text: 'Could not find the project details. Please start over by describing your project again.',
      });
      return;
    }

    let pendingData: {
      type: string;
      summary: {
        name: string;
        requirement: string;
        domains: string[];
        estimatedCostRange: string;
        estimatedTimeRange: string;
      };
      userId: string;
      channelId: string;
      ts: string;
      workspaceId: string;
    };

    try {
      const rawContent = pendingHistory[0]?.content ?? '{}';
      pendingData = JSON.parse(rawContent);
    } catch {
      await this.webClient.chat.postMessage({
        channel: channelId,
        thread_ts: ts,
        text: 'Failed to parse project details. Please try again.',
      });
      return;
    }

    this.lobbyConversations.delete(pendingKey);

    await this.webClient.chat.postMessage({
      channel: channelId,
      thread_ts: ts,
      text: `Got it! Starting the project *${pendingData.summary.name}*...`,
    });

    // Run in background
    this.createAndRunProject({
      name: pendingData.summary.name,
      requirement: pendingData.summary.requirement,
      userId: userId || pendingData.userId,
      channelId,
      ts,
      workspaceId: pendingData.workspaceId,
    }).catch((err) => {
      console.error('[Orchestrator] createAndRunProject error:', err);
      this.webClient.chat
        .postMessage({
          channel: channelId,
          thread_ts: ts,
          text: `Failed to start project: ${(err as Error).message}`,
        })
        .catch(console.error);
    });
  }

  // ─── Create and run project ───────────────────────────────────────────────

  private async createAndRunProject(params: {
    name: string;
    requirement: string;
    userId: string;
    channelId: string;
    ts: string;
    workspaceId: string;
  }): Promise<void> {
    const { name, requirement, userId, channelId, ts, workspaceId } = params;
    const projectId = uuidv4();
    const slug = slugify(name);

    // Detect stack
    const stack = await stackDetector.detect(requirement);

    // Get or create workspace
    const workspace = await workspaceAuth.getOrCreate(workspaceId, workspaceId);

    // Auto-create a dedicated Jira project for this project
    const { jiraIntegration } = await import('../integrations/jira.js');
    let jiraProjectKey: string | null = null;
    try {
      jiraProjectKey = await jiraIntegration.createProject({
        name,
        description: requirement.slice(0, 500),
      });
      console.log(`[Orchestrator] Created Jira project: ${jiraProjectKey}`);
    } catch (err) {
      console.error('[Orchestrator] createJiraProject error (continuing):', err);
    }

    // Auto-create a dedicated GitHub repo for this project
    const { githubIntegration } = await import('../integrations/github.js');
    let githubRepoFullName: string | null = null;
    let projectGitHub = githubIntegration;
    try {
      const repoName = `swarmly-${slug}-${projectId.slice(0, 6)}`;
      const created = await githubIntegration.createRepo({
        name: repoName,
        description: requirement.slice(0, 100),
        isPrivate: true,
      });
      githubRepoFullName = `${created.owner}/${created.repo}`;
      projectGitHub = created.integration;
      console.log(`[Orchestrator] Created GitHub repo: ${githubRepoFullName}`);
    } catch (err) {
      console.error('[Orchestrator] createGitHubRepo error (continuing):', err);
    }

    // Create project state
    const now = new Date();
    const projectState: ProjectState = {
      id: projectId,
      workspaceId: workspace.id,
      slug,
      name,
      phase: ProjectPhase.DETECTING,
      requirement: {
        raw: requirement,
        summary: requirement.slice(0, 200),
        workspaceId: workspace.id,
        slackChannelId: channelId,
        userId,
        createdAt: now,
      },
      stack,
      sprint: {
        id: uuidv4(),
        goal: `Build ${name}`,
        tasks: [],
        startDate: now,
        endDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
      codebase: {},
      prd: '',
      slackProjectChannelId: '',
      jiraProjectKey,
      jiraSprintId: '',
      githubRepo: githubRepoFullName,
      githubBranch: `feature/${slug}-${projectId.slice(0, 8)}`,
      budget: {
        allocatedTokens: config.budget.maxTokensPerSprint,
        usedTokens: 0,
        remainingTokens: config.budget.maxTokensPerSprint,
        allocatedUsd: config.budget.maxCostUsdPerDay,
        usedUsd: 0,
        isOverBudget: false,
        isApproachingLimit: false,
      },
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    // Save initial state
    await stateStore.saveProject(projectState);

    // Create Slack project channel
    let projectChannelId = channelId;
    try {
      projectChannelId = await this.slackChannelManager.createProjectChannel({
        projectName: name,
        projectSlug: slug,
        description: requirement,
        userId,
      });
      projectState.slackProjectChannelId = projectChannelId;
      projectState.updatedAt = new Date();
      await stateStore.saveProject(projectState);
    } catch (err) {
      console.error('[Orchestrator] createProjectChannel error (continuing):', err);
    }

    // Notify user of project channel + links to created resources
    const resourceLinks: string[] = [];
    if (jiraProjectKey) resourceLinks.push(`• Jira: \`${jiraProjectKey}\``);
    if (githubRepoFullName) resourceLinks.push(`• GitHub: \`${githubRepoFullName}\``);
    await this.webClient.chat.postMessage({
      channel: channelId,
      thread_ts: ts,
      text: [
        `Project created! Follow progress in <#${projectChannelId}>.`,
        ...(resourceLinks.length > 0 ? ['', 'Resources created:'] : []),
        ...resourceLinks,
      ].join('\n'),
    });

    // Create initial branch in the per-project GitHub repo
    try {
      await projectGitHub.createBranch(projectState.githubBranch);
    } catch (err) {
      console.error('[Orchestrator] createBranch error (continuing):', err);
    }

    // Run the full pipeline in background (pipeline uses projectState.jiraProjectKey / githubRepo)
    const { pipeline } = await import('./pipeline.js');
    pipeline.run(projectId, this.slackListener).catch((err) => {
      console.error(`[Orchestrator] Pipeline failed for project ${projectId}:`, err);
      stateStore.updatePhase(projectId, ProjectPhase.FAILED).catch(console.error);
      this.webClient.chat
        .postMessage({
          channel: projectChannelId,
          text: `Pipeline encountered an error: ${(err as Error).message}. The project has been marked as FAILED.`,
        })
        .catch(console.error);
    });
  }

  // ─── Mention handler ──────────────────────────────────────────────────────

  private async handleMention(mention: {
    targetAgent: AgentRole;
    text: string;
    userId: string;
    channelId: string;
    ts: string;
    projectId: string;
  }): Promise<void> {
    const project = await this.findProjectByChannel(mention.channelId);
    if (!project) {
      await this.webClient.chat.postMessage({
        channel: mention.channelId,
        thread_ts: mention.ts,
        text: 'No active project found in this channel.',
      });
      return;
    }

    try {
      const { pmAgent } = await import('../agents/pm-agent.js');
      const history: ConversationHistory = [
        {
          role: 'user',
          content: mention.text,
          timestamp: new Date(),
        },
      ];

      // Route to correct agent (simplified: all mentions go through PM for now)
      const result = await pmAgent.generateStatusReport(project);

      await this.webClient.chat.postMessage({
        channel: mention.channelId,
        thread_ts: mention.ts,
        text: result,
      });
    } catch (err) {
      console.error('[Orchestrator] handleMention error:', err);
      await this.webClient.chat.postMessage({
        channel: mention.channelId,
        thread_ts: mention.ts,
        text: 'Sorry, I ran into an issue. Please try again.',
      });
    }
  }

  // ─── Checkpoint action handler ────────────────────────────────────────────

  private async handleCheckpointAction(event: unknown, approved: boolean): Promise<void> {
    const e = event as {
      body?: {
        channel?: { id?: string };
        message?: { ts?: string };
        user?: { id?: string };
        actions?: Array<{ value?: string }>;
      };
    };

    const channelId = e.body?.channel?.id ?? '';
    const ts = e.body?.message?.ts ?? '';
    const userId = e.body?.user?.id ?? 'unknown';
    const projectId = e.body?.actions?.[0]?.value ?? '';

    const { humanCheckpoint } = await import('./human-checkpoint.js');
    if (approved) {
      humanCheckpoint.handleApproval(projectId, userId);
    } else {
      humanCheckpoint.handleRejection(projectId, userId, 'Rejected via Slack');
    }

    await this.webClient.chat.postMessage({
      channel: channelId,
      thread_ts: ts,
      text: approved
        ? 'Checkpoint approved. Continuing...'
        : 'Checkpoint rejected. The team will pause and await further instructions.',
    });
  }

  // ─── Daily standup ────────────────────────────────────────────────────────

  private async postDailyStandup(): Promise<void> {
    console.log('[Orchestrator] Posting daily standup...');

    // We iterate over all workspaces by querying the DB directly
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT DISTINCT workspace_id AS id FROM projects WHERE phase NOT IN ('DONE','FAILED')`,
      );

      for (const row of rows) {
        const workspaceId = (row as RowDataPacket)['id'] as string;
        const projects = await stateStore.getActiveProjects(workspaceId);

        for (const project of projects) {
          try {
            const { pmAgent } = await import('../agents/pm-agent.js');
            const report = await pmAgent.generateStatusReport(project);

            if (project.slackProjectChannelId) {
              await this.webClient.chat.postMessage({
                channel: project.slackProjectChannelId,
                text: `*Daily Standup — ${new Date().toLocaleDateString()}*\n\n${report}`,
              });
            }
          } catch (err) {
            console.error(`[Orchestrator] standup error for project ${project.id}:`, err);
          }
        }
      }
    } catch (err) {
      console.error('[Orchestrator] postDailyStandup error:', err);
    }
  }

  // ─── Find project by channel ──────────────────────────────────────────────

  private async findProjectByChannel(channelId: string): Promise<ProjectState | null> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT id FROM projects WHERE slack_project_channel = ? AND phase NOT IN ('DONE','FAILED') LIMIT 1`,
        [channelId],
      );

      if (rows.length === 0) return null;

      const projectId = (rows[0] as RowDataPacket)['id'] as string | undefined;
      if (!projectId) return null;

      return stateStore.loadProject(projectId);
    } catch (err) {
      console.error('[Orchestrator] findProjectByChannel error:', err);
      return null;
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const orchestrator = new Orchestrator();
orchestrator.startSlackMode().catch(console.error);

export { orchestrator };
