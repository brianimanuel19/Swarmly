import { WebClient } from '@slack/web-api';
import { SlackListener } from '../integrations/slack-listener.js';
import { SlackChannelManager } from '../integrations/slack-channels.js';
import { stackDetector } from './stack-detector.js';
import { stateStore } from '../memory/state-store.js';
import { tokenTracker, TokenTracker } from '../cost-control/token-tracker.js';
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
import { buildAgentMessage } from '../integrations/slack-messages.js';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';

// ─── Lazy imports for agents (created on first use) ──────────────────────────
// pm-agent and pipeline are imported inline to allow circular-ref safety and
// to avoid instantiation at module load when env vars may not be set yet.
import { projectCommands } from './project-commands.js';

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

  /** Active project count — used for concurrency limit enforcement */
  private activeProjectCount = 0;

  /** Per-project token trackers keyed by projectId */
  private projectTrackers: Map<string, TokenTracker> = new Map();

  /** Conversation history per thread in project channels (channelId:threadTs → messages) */
  private projectChannelHistory: Map<string, Array<{ role: 'user' | 'assistant'; content: string }>> = new Map();

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
      typeCast(field, next) {
        if (field.type === 'JSON') {
          const str = field.string('utf8');
          if (str === null) return null;
          try { return JSON.parse(str); } catch { return str; }
        }
        return next();
      },
    });
  }

  // ─── Public: start Slack mode ─────────────────────────────────────────────

  async startSlackMode(): Promise<void> {
    // 1. Test DB connection + run pending migrations
    let conn: import('mysql2/promise').Connection | null = null;
    try {
      await this.pool.query('SELECT 1 AS ok');
      console.log('[Orchestrator] DB connection OK');

      conn = await (await import('mysql2/promise')).createConnection({
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        multipleStatements: false,
      });
      const { runMigrations } = await import('../memory/migrator.js');
      await runMigrations(conn);
    } catch (err) {
      console.error('[Orchestrator] DB connection FAILED:', err);
      throw err;
    } finally {
      await conn?.end().catch(() => {});
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
      this.slackListener.setupChatHandler(chatChannelId, async ({ userMessage, userId, channelId }) => {
        try {
          const { chatReply, clearThread, detectRole } = await import('../agents/chat-agent.js');

          // Per-user history so multiple people can chat independently
          const threadKey = `chat:${channelId}:${userId}`;

          if (userMessage.trim().toLowerCase() === 'reset') {
            clearThread(threadKey);
            await this.webClient.chat.postMessage({
              channel: channelId,
              text: 'Cleared! Start fresh anytime.',
            });
            return;
          }

          const role = detectRole(userMessage);
          const reply = await chatReply({ threadKey, userMessage, userId });

          // Map chat role string to AgentRole enum (or skip header for 'default')
          const roleToAgentRole: Record<string, AgentRole | undefined> = {
            pm:     AgentRole.PM,
            po:     AgentRole.PO,
            dev:    AgentRole.DEV,
            devops: AgentRole.DEVOPS,
            tester: AgentRole.TESTER,
          };
          const agentRole = roleToAgentRole[role];

          await this.webClient.chat.postMessage({
            channel: channelId,
            text: reply, // plain-text fallback for notifications
            blocks: agentRole ? buildAgentMessage(reply, agentRole) : undefined,
          });
        } catch (err) {
          console.error('[Orchestrator] chatHandler error:', err);
        }
      });
      console.log(`[Orchestrator] Chat channel registered: ${chatChannelId}`);
    }

    // 4c. Register project channel handler — full codebase-aware agent (like Claude for VSCode)
    this.slackListener.setupProjectChannelHandler(async ({ channelId, threadTs, userMessage, userId, uploadedFiles }) => {
      try {
        const project = await stateStore.getProjectByChannelId(channelId);
        if (!project) return; // not a project channel

        const threadKey = `${channelId}:${threadTs}`;

        // "reset" clears conversation history for this thread
        if (userMessage.trim().toLowerCase() === 'reset') {
          this.projectChannelHistory.delete(threadKey);
          await stateStore.deletePendingProject(`conv_${threadKey}`).catch(() => {});
          await this.webClient.chat.postMessage({
            channel: channelId, thread_ts: threadTs,
            text: '🔄 Conversation cleared. Start fresh!',
          });
          return;
        }

        // Auto-detect auth code paste (user pastes code from platform.claude.com after /swarmly-login)
        if (await this.tryHandleOAuthCode(userId, channelId, threadTs, userMessage)) return;

        // ── Pipeline control commands (status, re-run phases) ─────────────
        const lower = userMessage.toLowerCase();

        if (/\bstatus\b|trạng thái|progress|tiến độ/.test(lower)) {
          const tasks = project.sprint?.tasks ?? [];
          const taskLines = tasks.length > 0
            ? tasks.map((t) => {
                const icon = t.status === 'DONE' ? '✅' : t.status === 'BLOCKED' ? '🚫' : t.status === 'IN_PROGRESS' ? '⏳' : '⬜';
                return `${icon} ${t.title}`;
              }).join('\n')
            : '_No tasks yet_';
          await this.webClient.chat.postMessage({
            channel: channelId, thread_ts: threadTs,
            text: `*Project:* ${project.name}\n*Phase:* ${project.phase}\n*Sprint:* ${project.sprint?.goal ?? 'N/A'}\n\n*Tasks:*\n${taskLines}`,
          });
          return;
        }

        const isRerunDev = /re.?run|restart|chạy lại|retry all|redo all/.test(lower) &&
          /cod(e|ing)|dev(elop)?|task|sprint|phase/.test(lower);
        if (isRerunDev) {
          if (project.sprint?.tasks) {
            const { TaskStatus } = await import('../types/index.js');
            const resetDone = /redo|re-do|làm lại/.test(lower);
            for (const t of project.sprint.tasks) {
              if (t.status === TaskStatus.BLOCKED || (resetDone && t.status === TaskStatus.DONE)) {
                t.status = TaskStatus.TODO; t.attempts = 0; t.filesWritten = [];
              }
            }
            await stateStore.updateSprint(project.id, project.sprint);
          }
          await stateStore.updatePhase(project.id, ProjectPhase.DEVELOPING);
          await this.webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: '🔄 Resetting blocked tasks and resuming coding phase…' });
          await this.handleResumeProject(project.id, channelId);
          return;
        }

        const isRerunTest = /re.?run|restart|chạy lại/.test(lower) && /test(ing)?|kiểm thử|qa/.test(lower);
        if (isRerunTest) {
          await stateStore.updatePhase(project.id, ProjectPhase.DEVELOPING);
          await this.webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: '🧪 Resuming from testing phase…' });
          await this.handleResumeProject(project.id, channelId);
          return;
        }

        const isRerunPlan = /re.?run|restart|chạy lại/.test(lower) && /plan(ning)?|prd|sprint.?plan|lập kế hoạch|backlog/.test(lower);
        if (isRerunPlan) {
          await stateStore.updateSprint(project.id, null as unknown as import('../types/index.js').Sprint);
          await stateStore.updatePhase(project.id, ProjectPhase.DETECTING);
          await this.webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: '📋 Resetting sprint plan and resuming from planning phase…' });
          await this.handleResumeProject(project.id, channelId);
          return;
        }

        // ── Command routing (slash commands, shortcuts) — handled FIRST ──
        const cmdResult = await projectCommands.handle({
          text: userMessage,
          project,
          channelId,
          threadTs,
          webClient: this.webClient,
          userId,
        });

        // Handle /compact specially — needs access to history
        if ((cmdResult as unknown as { compactRequested?: boolean }).compactRequested) {
          const history = this.projectChannelHistory.get(threadKey) ?? [];
          const msg = await this.webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: '⏳ Compacting context…' });
          const compacted = await projectCommands.compactHistory(history);
          this.projectChannelHistory.set(threadKey, compacted);
          await stateStore.savePendingProject(`conv_${threadKey}`, compacted).catch(() => {});
          await this.webClient.chat.update({ channel: channelId, ts: msg.ts as string, text: `✅ Context compacted: ${history.length} messages → ${compacted.length}. Summary:\n${compacted[0]?.content?.slice(0, 300) ?? ''}` });
          return;
        }

        if (cmdResult.handled) return;

        // ── Load/resume conversation history (persisted across restarts) ──
        let history = this.projectChannelHistory.get(threadKey);
        if (!history) {
          // Try to resume from DB
          const saved = await stateStore.loadPendingProject(`conv_${threadKey}`).catch(() => null);
          history = (Array.isArray(saved) ? saved : []) as Array<{ role: 'user' | 'assistant'; content: string }>;
          // Also inherit from branch source if this is a branch
          if (history.length === 0) {
            const sourceKey = projectCommands.getBranchSource(threadKey);
            if (sourceKey) history = [...(this.projectChannelHistory.get(sourceKey) ?? [])];
          }
          this.projectChannelHistory.set(threadKey, history);
        }

        // ── Download uploaded files and append to user message ──
        let enrichedMessage = userMessage;
        if (uploadedFiles && uploadedFiles.length > 0) {
          const fileContents: string[] = [];
          for (const file of uploadedFiles) {
            try {
              if (file.size > 500_000) { fileContents.push(`[File too large: ${file.name}]`); continue; }
              const resp = await fetch(file.urlPrivate, { headers: { Authorization: `Bearer ${config.slack.botToken}` } });
              if (!resp.ok) { fileContents.push(`[Could not download: ${file.name}]`); continue; }
              const text = await resp.text();
              const snippet = text.length > 8000 ? text.slice(0, 8000) + '\n…[truncated]' : text;
              fileContents.push(`### Uploaded file: ${file.name}\n\`\`\`\n${snippet}\n\`\`\``);
            } catch { fileContents.push(`[Error reading: ${file.name}]`); }
          }
          if (fileContents.length > 0) {
            enrichedMessage = [userMessage, ...fileContents].filter(Boolean).join('\n\n');
          }
          // Acknowledge file receipt
          await this.webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `📎 Received ${uploadedFiles.map((f) => `\`${f.name}\``).join(', ')}` });
        }

        // Post "thinking" indicator immediately
        const thinkingMsg = await this.webClient.chat.postMessage({
          channel: channelId, thread_ts: threadTs,
          text: '⏳ Thinking…',
        });

        // Load codebase: try workspace first, fall back to DB
        let codebase: Record<string, string> = project.codebase ?? {};
        try {
          const { workspaceManager } = await import('../sandbox/workspace-manager.js');
          const wsCb = await workspaceManager.readCodebase(project.id);
          if (Object.keys(wsCb).length > 0) codebase = wsCb;
        } catch { /* sandbox may not exist — use DB codebase */ }

        // ── Per-channel settings (model, thinking, mode) ──
        const chanSettings = projectCommands.getSettings(channelId);

        // Look up per-user auth key (OAuth token or custom API key)
        const { userAuthStore } = await import('../auth/user-auth-store.js');
        const userApiKey = await userAuthStore.getEffectiveKey(userId).catch(() => null);

        const { projectAgent } = await import('../agents/project-agent.js');
        const response = await projectAgent.handleMessage({
          message: enrichedMessage,
          history,
          codebase,
          project,
          projectId: project.id,
          ...(chanSettings.model ? { model: chanSettings.model } : {}),
          ...(chanSettings.thinking ? { thinking: chanSettings.thinking } : {}),
          ...(userApiKey ? { userApiKey } : {}),
        });

        // ── Session usage exhausted (OAuth / personal key 5h limit) ──────────
        if (response.sessionExhausted) {
          const waitMin = response.retryAfterSeconds ? Math.ceil(response.retryAfterSeconds / 60) : null;
          const waitText = waitMin ? ` Session resets in ~${waitMin} min.` : '';
          await this.webClient.chat.update({
            channel: channelId,
            ts: thinkingMsg.ts as string,
            text: `⏳ *Your Claude session usage is exhausted.*${waitText}\n\nYou can:\n• Wait for the 5-hour window to reset\n• Run \`/swarmly-switch\` to use a different auth method\n• Or run \`/swarmly-login\` to re-authenticate`,
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: `⏳ *Your Claude session usage is exhausted.*${waitText}\n\nYour personal Claude account has reached its usage limit for this 5-hour window.` } },
              {
                type: 'actions',
                elements: [
                  { type: 'button' as const, text: { type: 'plain_text' as const, text: '↺ Switch Account' }, action_id: 'switch_to_oauth', value: `${userId}::${channelId}::${threadTs}`, style: 'primary' as const },
                ],
              },
              { type: 'context', elements: [{ type: 'mrkdwn', text: `_Or use \`/swarmly-login\` to re-authenticate, or \`/swarmly-logout\` to revert to the workspace default key._` }] },
            ],
          });
          return;
        }

        // Record token usage for /usage dashboard (local 5h + 7-day tracking)
        {
          const { userSessionTracker } = await import('../auth/user-session-tracker.js');
          const approxTokens = Math.ceil((enrichedMessage.length + response.text.length) / 4);
          const { userAuthStore: uas } = await import('../auth/user-auth-store.js');
          const authStatus = await uas.getStatus(userId).catch(() => ({ type: 'none' as const }));
          userSessionTracker.record(userId, approxTokens);
          if (authStatus.type !== 'none') {
            // Plan will be filled in when user runs /account
          }
        }

        // Update history (keep last 20 turns) and persist to DB for resume across restarts
        history.push({ role: 'user', content: enrichedMessage });
        history.push({ role: 'assistant', content: response.text });
        const trimmedHistory = history.slice(-20);
        this.projectChannelHistory.set(threadKey, trimmedHistory);
        stateStore.savePendingProject(`conv_${threadKey}`, trimmedHistory).catch(() => {});

        // If agent made code changes — handle plan mode or apply directly
        if (response.type === 'changes' && response.files && response.files.length > 0) {
          // Save checkpoint BEFORE applying changes
          const currentCodebase = project.codebase ?? {};
          projectCommands.saveCheckpoint(
            project.id,
            `Before: ${userMessage.slice(0, 30)}`,
            currentCodebase,
          );

          if (chanSettings.mode === 'plan') {
            // Plan mode: show proposal with Approve/Cancel buttons, don't apply yet
            await projectCommands.storePendingPlan({
              project,
              channelId,
              threadTs,
              thinkingTs: thinkingMsg.ts as string,
              description: response.text,
              files: response.files,
              webClient: this.webClient,
            });
            return;
          }

          // Auto or default mode: apply changes immediately
          try {
            const { workspaceManager } = await import('../sandbox/workspace-manager.js');
            await workspaceManager.applyChanges(project.id, response.files);
            await stateStore.updateCodebase(project.id, response.files);
          } catch (applyErr) {
            console.warn(`[Orchestrator] projectChannel applyChanges: ${(applyErr as Error).message}`);
          }

          const fileList = response.files
            .map((f) => `• \`${f.path}\` _(${f.action})_`)
            .join('\n');

          const fullText = `${response.text}\n\n*Files changed:*\n${fileList}`;
          await this.webClient.chat.update({
            channel: channelId,
            ts: thinkingMsg.ts as string,
            text: fullText,
            blocks: buildAgentMessage(fullText, AgentRole.DEV),
          });
        } else {
          await this.webClient.chat.update({
            channel: channelId,
            ts: thinkingMsg.ts as string,
            text: response.text,
            blocks: buildAgentMessage(response.text, AgentRole.PM),
          });
        }
      } catch (err) {
        console.warn(`[Orchestrator] projectChannelHandler error: ${(err as Error).message}`);
      }
    });

    // 4d. Register DM handler for auth commands (auth, auth status, auth logout, apikey)
    this.slackListener.setupDMHandler(async ({ userId, channelId, text }) => {
      await this.handleAuthDM(userId, channelId, text);
    });

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
      onResumeProject: async (event) => {
        const payload = event as unknown as { body?: { actions?: Array<{ value?: string }>; channel?: { id?: string } } };
        const projectId = payload.body?.actions?.[0]?.value ?? '';
        const channelId = payload.body?.channel?.id ?? '';
        await this.handleResumeProject(projectId, channelId);
      },
      onClarificationAnswer: async (event) => {
        const payload = event as unknown as {
          body?: {
            actions?: Array<{ value?: string }>;
            channel?: { id?: string };
            message?: { ts?: string };
          };
        };
        const rawValue = payload.body?.actions?.[0]?.value ?? '{}';
        try {
          const { projectId, questionIndex, answer } = JSON.parse(rawValue) as {
            projectId: string;
            questionIndex: number;
            answer: string;
          };
          const channelId = payload.body?.channel?.id ?? '';
          const ts = payload.body?.message?.ts ?? '';
          const { humanCheckpoint } = await import('./human-checkpoint.js');
          humanCheckpoint.handleClarificationAnswer(projectId, questionIndex, answer);
          await this.webClient.chat.postMessage({
            channel: channelId,
            thread_ts: ts,
            text: `Got it! You chose: *${answer}*`,
          });
        } catch (err) {
          console.warn(`[Orchestrator] Clarification answer parse error: ${(err as Error).message}`);
        }
      },
      onTaskRetry: async (event) => {
        await this.handleTaskRetry(event);
      },
      onTaskRedo: async (event) => {
        await this.handleTaskRedo(event);
      },
      onPlanApprove: async (event) => {
        const planId = (event.payload?.value ?? event.body?.actions?.[0]?.value ?? '') as string;
        const plan = projectCommands.getPendingPlan(planId);
        if (!plan) {
          await this.webClient.chat.postMessage({
            channel: (event.body?.channel?.id ?? '') as string,
            text: '❌ Plan expired or already applied.',
          });
          return;
        }
        projectCommands.deletePendingPlan(planId);
        try {
          const { workspaceManager } = await import('../sandbox/workspace-manager.js');
          await workspaceManager.applyChanges(plan.projectId, plan.files);
          await stateStore.updateCodebase(plan.projectId, plan.files);
          const fileList = plan.files.map((f) => `• \`${f.path}\``).join('\n');
          await this.webClient.chat.update({
            channel: plan.channelId,
            ts: plan.thinkingTs,
            text: `✅ *Changes applied!*\n\n${fileList}`,
          });
        } catch (err) {
          await this.webClient.chat.postMessage({
            channel: plan.channelId,
            text: `❌ Apply failed: ${(err as Error).message}`,
          });
        }
      },
      onPlanCancel: async (event) => {
        const channelId = (event.body?.channel?.id ?? '') as string;
        const messageTs = (event.body?.message?.ts ?? '') as string;
        const planId = (event.payload?.value ?? event.body?.actions?.[0]?.value ?? '') as string;
        projectCommands.deletePendingPlan(planId);
        await this.webClient.chat.update({
          channel: channelId,
          ts: messageTs,
          text: '❌ Changes cancelled.',
        });
      },
      onSwitchToOAuth: async (event) => {
        // Value: "userId::channelId::threadTs"
        const raw = (event.payload?.value ?? event.body?.actions?.[0]?.value ?? '') as string;
        const [userId, channelId, threadTs] = raw.split('::');
        if (!userId || !channelId) return;
        const { projectCommands: pc } = await import('./project-commands.js');
        const project = await stateStore.getProjectByChannelId(channelId);
        if (!project) return;
        await pc.handle({ text: '/swarmly-login', project, channelId, threadTs: threadTs ?? '', webClient: this.webClient, userId });
      },
      onSwitchLogout: async (event) => {
        const raw = (event.payload?.value ?? event.body?.actions?.[0]?.value ?? '') as string;
        const [userId, channelId, threadTs] = raw.split('::');
        if (!userId || !channelId) return;
        const { userAuthStore } = await import('../auth/user-auth-store.js');
        await userAuthStore.deleteAuth(userId);
        await this.webClient.chat.postMessage({
          channel: channelId,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          text: `✅ Signed out <@${userId}>. Workspace default key will be used.`,
        });
      },
      onCheckpointRestore: async (event) => {
        const channelId = (event.body?.channel?.id ?? '') as string;
        const raw = (event.payload?.value ?? event.body?.actions?.[0]?.value ?? '{}') as string;
        let projectId = '';
        let checkpointId = '';
        try {
          ({ projectId, checkpointId } = JSON.parse(raw) as { projectId: string; checkpointId: string });
        } catch {
          await this.webClient.chat.postMessage({ channel: channelId, text: '❌ Invalid checkpoint data.' });
          return;
        }
        const checkpoint = projectCommands.getCheckpointById(projectId, checkpointId);
        if (!checkpoint) {
          await this.webClient.chat.postMessage({ channel: channelId, text: '❌ Checkpoint not found.' });
          return;
        }
        try {
          const files = Object.entries(checkpoint.files).map(([path, content]) => ({
            action: 'modify' as const,
            path,
            content,
          }));
          const { workspaceManager } = await import('../sandbox/workspace-manager.js');
          await workspaceManager.applyChanges(projectId, files);
          await stateStore.updateCodebase(projectId, files);
          await this.webClient.chat.postMessage({
            channel: channelId,
            text: `✅ Restored checkpoint *${checkpoint.label}* — ${files.length} files restored.`,
          });
        } catch (err) {
          await this.webClient.chat.postMessage({
            channel: channelId,
            text: `❌ Restore failed: ${(err as Error).message}`,
          });
        }
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
        // Use per-project tracker when available, fall back to global singleton
        const tracker = this.projectTrackers.get(project.id) ?? tokenTracker;
        const report = tracker.getSprintReport();
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
        await this.handleResumeProject(project.id, channelId);
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
            '*Account & Auth:*',
            '• `/swarmly-login` — Sign in with Claude OAuth or API key',
            '• `/swarmly-switch` — View current account and switch auth method',
            '• `/swarmly-logout` — Sign out and remove stored credentials',
            '• `/swarmly-account` — Account & Usage panel (5hr session, weekly %, plan info)',
            '',
            'In any project channel, type `/swarmly-help` for per-channel AI commands.',
            'To start a new project, describe it in the lobby channel.',
          ].join('\n'),
        });
      },

      // All auth slash commands delegate to projectCommands for a single source of truth.
      // projectCommands.runXxx() handles both project-channel and non-project-channel contexts.

      onAccount: async (args) => {
        await projectCommands.runAccountUsage(
          args.command.channel_id as string, '',
          this.webClient, args.command.user_id as string,
        );
      },

      onLogin: async (args) => {
        await projectCommands.runLogin(
          args.command.channel_id as string, '',
          this.webClient, args.command.user_id as string,
        );
      },

      onSwitchAccount: async (args) => {
        await projectCommands.runSwitchAccount(
          args.command.channel_id as string, '',
          this.webClient, args.command.user_id as string,
        );
      },

      onLogout: async (args) => {
        await projectCommands.runLogout(
          args.command.channel_id as string, '',
          this.webClient, args.command.user_id as string,
        );
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

  // ─── OAuth code auto-detection ────────────────────────────────────────────
  // Called from both the project channel handler and the DM handler.
  // Returns true if the message was an auth code and was handled.

  private async tryHandleOAuthCode(userId: string, channelId: string, threadTs: string, text: string): Promise<boolean> {
    const trimmed = text.trim();
    // Auth codes from platform.claude.com look like:
    //   "sxk6W4RUqSepeCWmvHWWHypB79O4zDjujeVmLT6q0aX0c18I#4172d3b297721575014e2af85053a78f"
    // Pattern: 30+ base64url chars, optionally followed by #<hex>
    if (!/^[A-Za-z0-9+\-_/]{30,}(#[A-Za-z0-9a-f]{10,})?$/.test(trimmed)) return false;

    const entry = await stateStore.loadPendingProject(`oauth_user_${userId}`) as {
      codeVerifier?: string; expiresAt?: number;
    } | null;
    if (!entry?.codeVerifier || (entry.expiresAt ?? 0) < Date.now()) return false;

    const postReply = (msg: string) => this.webClient.chat.postMessage({
      channel: channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: msg,
    });

    try {
      const { exchangeCode } = await import('../auth/claude-oauth.js');
      const { userAuthStore } = await import('../auth/user-auth-store.js');
      const tokens = await exchangeCode(trimmed, entry.codeVerifier);
      await userAuthStore.saveOAuthTokens(userId, tokens.accessToken, tokens.refreshToken, tokens.expiresIn);
      await stateStore.deletePendingProject(`oauth_user_${userId}`);
      await postReply('✅ *Signed in successfully!* Your Claude account is now linked to Swarmly. All AI calls in project channels will use your subscription.');
    } catch (err) {
      await postReply(`❌ Code exchange failed: ${(err as Error).message}\n\nPlease send \`auth\` again to get a fresh login link.`);
    }
    return true;
  }

  // ─── Auth DM handler ──────────────────────────────────────────────────────

  private async handleAuthDM(userId: string, channelId: string, text: string): Promise<void> {
    // Auto-detect auth code paste from platform.claude.com (no prefix needed)
    if (await this.tryHandleOAuthCode(userId, channelId, '', text)) return;

    const { userAuthStore } = await import('../auth/user-auth-store.js');
    const { isOAuthConfigured, generatePKCE, generateState, buildAuthUrl } = await import('../auth/claude-oauth.js');
    const lower = text.toLowerCase().trim();

    const reply = async (msg: string) => {
      await this.webClient.chat.postMessage({ channel: channelId, text: msg });
    };

    // auth status
    if (lower === 'auth status' || lower === 'auth info') {
      const status = await userAuthStore.getStatus(userId);
      if (status.type === 'none') {
        await reply('You are not authenticated. Send `auth` to connect via OAuth, or `apikey <your-key>` to use an API key.');
      } else if (status.type === 'oauth') {
        const expiry = status.expiry ? ` (expires ${status.expiry.toLocaleString()})` : '';
        await reply(`✅ Authenticated via *OAuth*${expiry}. Your Claude subscription is active.`);
      } else {
        await reply('✅ Authenticated via *API key*. Your personal key is used for all AI calls.');
      }
      return;
    }

    // auth logout / disconnect
    if (lower === 'auth logout' || lower === 'auth disconnect' || lower === 'logout') {
      await userAuthStore.deleteAuth(userId);
      await reply('✅ Disconnected. Your auth credentials have been removed.');
      return;
    }

    // apikey <key>  — accepts both sk-ant-api03-* (API key) and sk-ant-oat01-* (Subscription OAuth token)
    if (lower.startsWith('apikey ') || lower.startsWith('api key ') || lower.startsWith('api_key ')) {
      const parts = text.trim().split(/\s+/);
      const key = parts[1] ?? '';
      if (!key.startsWith('sk-ant-')) {
        await reply(
          '❌ Invalid format. Accepted:\n' +
          '• `sk-ant-oat01-...` — Subscription token (từ `claude setup-token`, dùng plan Pro/Max/Team)\n' +
          '• `sk-ant-api03-...` — API key (từ console.anthropic.com, bill by token)',
        );
        return;
      }
      await userAuthStore.saveApiKey(userId, key);
      const isSubscription = key.startsWith('sk-ant-oat');
      await reply(
        isSubscription
          ? '✅ *Subscription token saved!* AI calls trong Swarmly sẽ dùng plan Claude Pro/Max/Team của bạn.'
          : '✅ *API key saved!* Your personal key will be used for all AI calls in Swarmly project channels.',
      );
      return;
    }

    // auth (start OAuth flow)
    if (lower === 'auth' || lower === 'login' || lower === 'authenticate') {
      if (!isOAuthConfigured()) {
        await reply(
          '⚠️ OAuth is not configured on this Swarmly instance.\n' +
          'You can still use a personal API key: send `apikey sk-ant-...`',
        );
        return;
      }

      const { verifier, challenge } = generatePKCE();
      const state = generateState();

      const oauthExpiry = Date.now() + 10 * 60 * 1000;
      // Store verifier keyed by state (for server-side callback) and by userId (for manual code paste)
      await Promise.all([
        stateStore.savePendingProject(`oauth_state_${state}`, {
          slackUserId: userId,
          codeVerifier: verifier,
          channelId,
          expiresAt: oauthExpiry,
        }),
        stateStore.savePendingProject(`oauth_user_${userId}`, {
          codeVerifier: verifier,
          expiresAt: oauthExpiry,
        }),
      ]);

      const authUrl = buildAuthUrl(state, challenge);
      await reply(
        `🔐 *Authenticate with Claude*\n\n` +
        `1. Click: <${authUrl}|→ Connect Claude Account>\n` +
        `2. Sign in và authorize.\n` +
        `3. Bạn sẽ thấy trang *"Authentication Code"* với một đoạn code dài.\n` +
        `4. Copy code đó và *paste thẳng vào đây* — Swarmly tự nhận diện, không cần thêm gì.\n\n` +
        `_Link hết hạn sau 10 phút. Gửi \`auth\` lại để lấy link mới._`,
      );
      return;
    }

    // help / fallback
    await reply(
      '*Auth commands:*\n' +
      '• `apikey sk-ant-oat01-...` — Subscription token (chạy `claude setup-token` để lấy) ⭐\n' +
      '• `apikey sk-ant-api03-...` — API key từ console.anthropic.com\n' +
      '• `auth status` — Check current auth\n' +
      '• `auth logout` — Remove stored credentials\n' +
      '\n' +
      '*Cách lấy Subscription token:*\n' +
      '```\nnpm install -g @anthropic-ai/claude-code\nclaude setup-token\n```\n' +
      'Copy token `sk-ant-oat01-...` rồi gửi: `apikey sk-ant-oat01-...`',
    );
  }

  // ─── Lobby message handler ─────────────────────────────────────────────────

  private async handleLobbyMessage(msg: LobbyMessage): Promise<void> {
    const threadKey = `${msg.channelId}:${msg.ts}`;

    // If this thread already has a pending project awaiting confirmation, handle it
    // directly instead of re-entering chatInLobby (which would loop READY_TO_RUN).
    const pendingKey = `pending:${threadKey}`;
    const pendingHistory = await stateStore.loadPendingProject(pendingKey);
    if (pendingHistory !== null) {
      const isConfirm = /^\s*(yes|yes[,!.]|yeah|yep|ok|okay|sure|ready|có|đồng ý|bắt đầu|go|let'?s go|ready to build)\s*$/i.test(
        msg.text.trim(),
      );
      if (isConfirm) {
        // Delegate to the same logic as the button click
        await this.handleRunConfirmFromText(pendingKey, msg.channelId, msg.ts, msg.userId);
      } else {
        // User is chatting while project is pending — remind them to click the button
        await this.slackListener.replyInThread(
          msg.channelId,
          msg.ts,
          'Dự án đang chờ xác nhận. Nhấn nút *[Run Project]* ở trên để bắt đầu, hoặc nói "cancel" để huỷ.',
        );
      }
      return;
    }

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

        // Detect GitHub URL anywhere in the conversation
        const { detectGithubUrl, parseGithubUrl } = await import('../integrations/repo-cloner.js');
        const allText = [...history, { role: 'user' as const, content: msg.text, timestamp: new Date() }]
          .map((m) => m.content)
          .join('\n');
        const sourceRepo = detectGithubUrl(allText);

        const detectedStack = await stackDetector.detect(requirement);
        const costRange = stackDetector.estimateCost(detectedStack);
        const timeRange = stackDetector.estimateTime(detectedStack);

        let projectName: string;
        let confirmText: string;

        if (sourceRepo) {
          const { fullName } = parseGithubUrl(sourceRepo);
          projectName = `Improve ${fullName.split('/')[1] ?? fullName}`;
          confirmText = `Ready to analyze and improve *${fullName}*! Please confirm:`;
        } else {
          projectName =
            requirement
              .split('.')[0]
              ?.replace(/^Build a? /i, '')
              .trim() ?? 'New Project';
          confirmText = `Ready to build *${projectName}*! Please confirm:`;
        }

        const domains = detectedStack.domains.map((d) => String(d));

        const { buildRunConfirmationBlock } = await import('../integrations/slack-messages.js');
        const blocks = buildRunConfirmationBlock({
          projectName,
          requirement: sourceRepo
            ? `Improve existing repo: ${sourceRepo}\n\nGoals: ${requirement}`
            : requirement,
          domains,
          estimatedCostRange: costRange,
          estimatedTimeRange: timeRange,
        });

        await this.slackListener.replyInThread(msg.channelId, msg.ts, confirmText, blocks);

        // Persist pending project to DB so it survives container restarts
        await stateStore.savePendingProject(`pending:${msg.channelId}:${msg.ts}`, {
          type: sourceRepo ? 'pending_repo_project' : 'pending_project',
          summary: { name: projectName, requirement, domains, estimatedCostRange: costRange, estimatedTimeRange: timeRange },
          sourceRepo: sourceRepo ?? null,
          userId: msg.userId,
          channelId: msg.channelId,
          ts: msg.ts,
          workspaceId: msg.workspaceId,
        });
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

  // ─── Run confirm via text reply ("yes", "có", etc.) ─────────────────────

  private async handleRunConfirmFromText(
    pendingKey: string,
    channelId: string,
    ts: string,
    userId: string,
  ): Promise<void> {
    const raw = await stateStore.loadPendingProject(pendingKey);
    if (raw === null) return;

    const pendingData = raw as {
      type: string;
      summary: { name: string; requirement: string; domains: string[]; estimatedCostRange: string; estimatedTimeRange: string };
      sourceRepo: string | null;
      userId: string;
      channelId: string;
      ts: string;
      workspaceId: string;
    };

    await stateStore.deletePendingProject(pendingKey);

    await this.webClient.chat.postMessage({
      channel: channelId,
      thread_ts: ts,
      text: `Got it! Starting the project *${pendingData.summary.name}*...`,
    });

    this.createAndRunProject({
      name: pendingData.summary.name,
      requirement: pendingData.summary.requirement,
      userId: userId || pendingData.userId,
      channelId,
      ts,
      workspaceId: pendingData.workspaceId,
      ...(pendingData.sourceRepo ? { sourceRepo: pendingData.sourceRepo } : {}),
    }).catch((err) => {
      console.error('[Orchestrator] createAndRunProject error:', err);
      this.webClient.chat
        .postMessage({ channel: channelId, thread_ts: ts, text: `Failed to start project: ${(err as Error).message}` })
        .catch(console.error);
    });
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
    const raw = await stateStore.loadPendingProject(pendingKey);

    if (raw === null) {
      await this.webClient.chat.postMessage({
        channel: channelId,
        thread_ts: ts,
        text: 'Could not find the project details. Please start over by describing your project again.',
      });
      return;
    }

    const pendingData = raw as {
      type: string;
      summary: { name: string; requirement: string; domains: string[]; estimatedCostRange: string; estimatedTimeRange: string };
      sourceRepo: string | null;
      userId: string;
      channelId: string;
      ts: string;
      workspaceId: string;
    };

    await stateStore.deletePendingProject(pendingKey);

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
      ...(pendingData.sourceRepo ? { sourceRepo: pendingData.sourceRepo } : {}),
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
    sourceRepo?: string;
  }): Promise<void> {
    const { name, requirement, userId, channelId, ts, workspaceId, sourceRepo } = params;

    // ── Concurrency guard ────────────────────────────────────────────────────
    const limit = config.sandbox.maxConcurrentProjects;
    if (this.activeProjectCount >= limit) {
      await this.webClient.chat.postMessage({
        channel: channelId,
        thread_ts: ts,
        text:
          `Cannot start *${name}* — there ${this.activeProjectCount === 1 ? 'is' : 'are'} already ` +
          `*${this.activeProjectCount}* project${this.activeProjectCount === 1 ? '' : 's'} running ` +
          `(limit: ${limit}). Please wait for the current project to finish, then try again.`,
      });
      return;
    }

    this.activeProjectCount++;
    const projectId = uuidv4();
    const tracker = new TokenTracker();
    this.projectTrackers.set(projectId, tracker);

    const slug = `${slugify(name).slice(0, 44)}-${projectId.slice(0, 6)}`;

    // Detect stack
    const stack = await stackDetector.detect(requirement);

    // Get or create workspace
    const workspace = await workspaceAuth.getOrCreate(workspaceId, workspaceId);

    // Auto-create Jira project (deferred for repo-improvement to after analysis checkpoint)
    const { jiraIntegration } = await import('../integrations/jira.js');
    let jiraProjectKey: string | null = null;
    if (!sourceRepo) {
      try {
        jiraProjectKey = await jiraIntegration.createProject({
          name,
          description: requirement.slice(0, 500),
        });
        console.log(`[Orchestrator] Created Jira project: ${jiraProjectKey}`);
      } catch (err) {
        console.error('[Orchestrator] createJiraProject error (continuing):', err);
      }
    }

    // For repo improvement: reuse the source repo; for greenfield: create a new one
    const { githubIntegration } = await import('../integrations/github.js');
    let githubRepoFullName: string | null = sourceRepo
      ? (() => { try { const u = new URL(sourceRepo); return u.pathname.replace(/^\//, '').replace(/\.git$/, ''); } catch { return null; } })()
      : null;
    let projectGitHub = githubIntegration;

    if (!sourceRepo) {
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
      ...(sourceRepo ? { sourceRepo } : {}),
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

    // Create initial branch only for greenfield projects (repo improvement uses source repo)
    if (!sourceRepo) {
      try {
        await projectGitHub.createBranch(projectState.githubBranch);
      } catch (err) {
        console.error('[Orchestrator] createBranch error (continuing):', err);
      }
    }

    // Run the full pipeline in background (pipeline uses projectState.jiraProjectKey / githubRepo)
    const { pipeline } = await import('./pipeline.js');
    pipeline
      .run(projectId, this.slackListener)
      .catch((err) => {
        console.error(`[Orchestrator] Pipeline failed for project ${projectId}:`, err);
        stateStore.updatePhase(projectId, ProjectPhase.FAILED).catch(console.error);
        this.webClient.chat
          .postMessage({
            channel: projectChannelId,
            text: `Pipeline encountered an error: ${(err as Error).message}. The project has been marked as FAILED.`,
          })
          .catch(console.error);
      })
      .finally(() => {
        this.activeProjectCount = Math.max(0, this.activeProjectCount - 1);
        this.projectTrackers.delete(projectId);
      });
  }

  // ─── Resume handler ───────────────────────────────────────────────────────

  private async handleResumeProject(projectId: string, channelId: string): Promise<void> {
    const project = await stateStore.loadProject(projectId);
    if (!project) {
      await this.webClient.chat.postMessage({ channel: channelId, text: 'Project not found.' });
      return;
    }

    const resumablePhases = [
      ProjectPhase.PAUSED, ProjectPhase.ANALYZING, ProjectPhase.FAILED,
      ProjectPhase.CLONING, ProjectPhase.DETECTING, ProjectPhase.PLANNING,
    ];
    if (!resumablePhases.includes(project.phase)) {
      await this.webClient.chat.postMessage({
        channel: channelId,
        text: `Project *${project.name}* cannot be resumed from phase: ${project.phase}.`,
      });
      return;
    }

    // Guard against duplicate pipelines
    if (this.activeProjectCount > 0) {
      await this.webClient.chat.postMessage({
        channel: channelId,
        text: `A pipeline is already running (${this.activeProjectCount} active). Wait for it to finish or restart the container.`,
      });
      return;
    }

    // Probe API credit before resuming
    try {
      const { pipeline } = await import('./pipeline.js');
      await (pipeline as unknown as { _probeApiCredit: () => Promise<void> })._probeApiCredit();
    } catch (err) {
      await this.webClient.chat.postMessage({
        channel: channelId,
        text: `:x: Cannot resume — credits still unavailable: ${(err as Error).message}\nPlease top up your Anthropic account and try again.`,
      });
      return;
    }

    // Reset PAUSED task → TODO so it gets retried from scratch
    const sprint = project.sprint;
    if (sprint?.tasks) {
      let changed = false;
      for (const task of sprint.tasks) {
        if (task.status === 'PAUSED' as unknown) {
          task.status = 'TODO' as unknown as import('../types/index.js').TaskStatus;
          task.filesWritten = [];
          changed = true;
        }
      }
      if (changed) {
        await stateStore.updateSprint(projectId, sprint);
      }
    }

    // For PAUSED: reset to DEVELOPING so the pipeline loop resumes task execution.
    // For ANALYZING/FAILED: leave phase as-is — pipeline will re-enter _runRepoAnalysisPhase
    // which now skips clone+analysis if project.repoAnalysis already exists.
    if (project.phase === ProjectPhase.PAUSED) {
      project.phase = ProjectPhase.DEVELOPING;
      project.updatedAt = new Date();
      await stateStore.saveProject(project);
      await stateStore.updatePhase(projectId, ProjectPhase.DEVELOPING);
    }

    await this.webClient.chat.postMessage({
      channel: channelId,
      text: `Resuming *${project.name}*... picking up from where it left off.`,
    });

    const { pipeline } = await import('./pipeline.js');
    pipeline
      .run(projectId, this.slackListener)
      .catch((err) => {
        console.error(`[Orchestrator] Resume pipeline failed for ${projectId}:`, err);
        this.webClient.chat
          .postMessage({ channel: channelId, text: `Resume failed: ${(err as Error).message}` })
          .catch(console.error);
      })
      .finally(() => {
        this.activeProjectCount = Math.max(0, this.activeProjectCount - 1);
        this.projectTrackers.delete(projectId);
      });

    this.activeProjectCount++;
    this.projectTrackers.set(projectId, new TokenTracker());
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
      const resolved = humanCheckpoint.handleApproval(projectId, userId);
      if (!resolved) {
        // No pipeline is waiting — try to auto-start it (e.g. after container restart)
        const project = await stateStore.loadProject(projectId);
        const resumable = [
        ProjectPhase.ANALYZING, ProjectPhase.CLONING,
        ProjectPhase.DETECTING, ProjectPhase.PLANNING,
        ProjectPhase.PAUSED, ProjectPhase.FAILED,
      ];
        if (project && resumable.includes(project.phase)) {
          await this.webClient.chat.postMessage({
            channel: channelId,
            thread_ts: ts,
            text: 'Pipeline was not running — restarting now…',
          });
          await this.handleResumeProject(projectId, project.slackProjectChannelId || channelId);
          return;
        }
        // Project already done or actively running — just ack
        await this.webClient.chat.postMessage({
          channel: channelId,
          thread_ts: ts,
          text: 'No pending checkpoint found (pipeline may already be running or completed).',
        });
        return;
      }
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

  // ─── handleTaskRedo ────────────────────────────────────────────────────────

  private async handleTaskRedo(event: unknown): Promise<void> {
    const e = event as {
      body?: {
        channel?: { id?: string };
        actions?: Array<{ value?: string }>;
      };
    };

    const rawValue = e.body?.actions?.[0]?.value ?? '{}';
    const channelId = e.body?.channel?.id ?? '';

    let projectId = '';
    let taskId = '';
    try {
      ({ projectId, taskId } = JSON.parse(rawValue) as { projectId: string; taskId: string });
    } catch {
      console.warn('[Orchestrator] handleTaskRedo: could not parse action value');
      return;
    }

    const project = await stateStore.loadProject(projectId);
    if (!project?.sprint) {
      await this.webClient.chat.postMessage({ channel: channelId, text: 'Project or sprint not found.' });
      return;
    }

    const task = project.sprint.tasks.find((t) => t.id === taskId);
    if (!task) {
      await this.webClient.chat.postMessage({ channel: channelId, text: 'Task not found.' });
      return;
    }

    const { TaskStatus } = await import('../types/index.js');
    task.status = TaskStatus.TODO;
    task.attempts = 0;
    task.filesWritten = [];
    await stateStore.updateSprint(projectId, project.sprint);

    await this.webClient.chat.postMessage({
      channel: channelId,
      text: `🔁 Re-doing task *${task.title}*… Pipeline resuming.`,
    });

    await this.handleResumeProject(projectId, channelId);
  }

  // ─── handleTaskRetry ───────────────────────────────────────────────────────

  private async handleTaskRetry(event: unknown): Promise<void> {
    const e = event as {
      body?: {
        channel?: { id?: string };
        actions?: Array<{ value?: string }>;
      };
    };

    const rawValue = e.body?.actions?.[0]?.value ?? '{}';
    const channelId = e.body?.channel?.id ?? '';

    let projectId = '';
    let taskId = '';
    try {
      ({ projectId, taskId } = JSON.parse(rawValue) as { projectId: string; taskId: string });
    } catch {
      console.warn('[Orchestrator] handleTaskRetry: could not parse action value');
      return;
    }

    const project = await stateStore.loadProject(projectId);
    if (!project?.sprint) {
      await this.webClient.chat.postMessage({ channel: channelId, text: 'Project or sprint not found.' });
      return;
    }

    const task = project.sprint.tasks.find((t) => t.id === taskId);
    if (!task) {
      await this.webClient.chat.postMessage({ channel: channelId, text: 'Task not found.' });
      return;
    }

    // Reset task (and any downstream tasks that were BLOCKED) back to TODO
    const { TaskStatus } = await import('../types/index.js');
    task.status = TaskStatus.TODO;
    task.attempts = 0;
    await stateStore.updateSprint(projectId, project.sprint);

    await this.webClient.chat.postMessage({
      channel: channelId,
      text: `🔄 Retrying task *${task.title}*… Pipeline resuming.`,
    });

    await this.handleResumeProject(projectId, channelId);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const orchestrator = new Orchestrator();
orchestrator.startSlackMode().catch(console.error);

export { orchestrator };
