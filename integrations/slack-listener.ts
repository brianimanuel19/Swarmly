// @slack/bolt is CommonJS — use default import for ESM compatibility
import bolt from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import type { LobbyMessage, AgentMention } from '../types/index.js';
import { AgentRole } from '../types/index.js';
import { config } from '../config/config.js';

const { App } = bolt;
type BoltApp = InstanceType<typeof bolt.App>;

// ─── Action payload helper types ────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ActionEvent = { ack: () => Promise<void>; body: any; payload: any };

// ─── Reaction callback shape ─────────────────────────────────────────────────

export interface ReactionEvent {
  emoji: string;
  messageTs: string;
  userId: string;
  channelId: string;
}

// ─── SlashCommand handler shape ──────────────────────────────────────────────

export type SlashHandler = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: { ack: () => Promise<void>; command: any; say: any },
) => Promise<void>;

// ─── Main class ─────────────────────────────────────────────────────────────

export class SlackListener {
  private readonly app: BoltApp;
  private readonly lobbyChannelId: string;
  private readonly botUserId: string;

  constructor() {
    this.lobbyChannelId = config.slack.lobbyChannelId;
    this.botUserId = config.slack.botUserId;

    this.app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
      socketMode: true,
      appToken: config.slack.appToken,
    });
  }

  /** Start the Bolt app in Socket Mode (no HTTP port needed). */
  async start(): Promise<void> {
    await this.app.start();
    console.log('[SlackListener] Connected via Socket Mode.');
  }

  // ─── Message listener (lobby channel) ─────────────────────────────────────

  setupLobbyHandler(onMessage: (msg: LobbyMessage) => Promise<void>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.app.message(async ({ message, client }: { message: any; client: any }) => {
      if (
        message.subtype !== undefined ||
        !('text' in message) ||
        !message.text ||
        !message.channel ||
        !message.ts ||
        !message.user
      ) {
        return;
      }

      if (message.channel !== this.lobbyChannelId) return;
      if (message.user === this.botUserId) return;

      let history: LobbyMessage['history'] = [];
      const threadTs: string = message.thread_ts ?? message.ts;

      if (message.thread_ts) {
        const repliesResult = await client.conversations.replies({
          channel: this.lobbyChannelId,
          ts: threadTs,
          limit: 50,
        });

        history = (repliesResult.messages ?? [])
          .filter((m: any) => 'text' in m && m.text)
          .map((m: any) => ({
            role: m.user === this.botUserId ? 'assistant' : 'user',
            content: m.text ?? '',
            timestamp: new Date(parseFloat(m.ts ?? '0') * 1000),
          }));
      }

      const lobbyMsg: LobbyMessage = {
        text: message.text,
        userId: message.user,
        channelId: message.channel,
        ts: threadTs,   // always use thread root ts so all messages in a thread share the same key
        history,
        workspaceId: message.team ?? '',
      };

      await onMessage(lobbyMsg);
    });
  }

  // ─── Chat channel handler (test/tán gẫu — Haiku only, no project flow) ────

  setupChatHandler(
    chatChannelId: string,
    onMessage: (params: {
      threadKey: string;
      userMessage: string;
      userId: string;
      channelId: string;
      threadTs: string;
    }) => Promise<void>,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.app.message(async ({ message }: { message: any }) => {
      if (
        message.subtype !== undefined ||
        !('text' in message) ||
        !message.text ||
        !message.channel ||
        !message.ts ||
        !message.user
      ) {
        return;
      }

      if (message.channel !== chatChannelId) return;
      if (message.user === this.botUserId) return;

      const threadTs: string = message.thread_ts ?? message.ts;

      await onMessage({
        threadKey: `chat:${chatChannelId}:${message.user as string}`,
        userMessage: message.text as string,
        userId: message.user as string,
        channelId: message.channel as string,
        threadTs,
      });
    });
  }

  // ─── Project channel handler — respond to messages inside project channels ──

  setupProjectChannelHandler(
    onMessage: (params: {
      channelId: string;
      threadTs: string;
      userMessage: string;
      userId: string;
      uploadedFiles?: Array<{ name: string; mimetype: string; urlPrivate: string; size: number }>;
    }) => Promise<void>,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.app.message(async ({ message }: { message: any }) => {
      // Allow normal messages AND file_share subtypes
      const isFileShare = message.subtype === 'file_share';
      const hasFiles = Array.isArray(message.files) && message.files.length > 0;

      if (!isFileShare && message.subtype !== undefined) return;
      if (!message.channel || !message.ts || !message.user) return;
      // Must have text OR files — not completely empty
      if (!message.text && !hasFiles) return;

      if (message.channel === this.lobbyChannelId) return;
      if (message.user === this.botUserId) return;

      const threadTs: string = message.thread_ts ?? message.ts;

      // Collect uploaded file metadata (content will be downloaded by orchestrator)
      const uploadedFiles = hasFiles
        ? (message.files as any[]).map((f: any) => ({
            name: f.name as string,
            mimetype: (f.mimetype ?? 'text/plain') as string,
            urlPrivate: (f.url_private ?? f.url_private_download ?? '') as string,
            size: (f.size ?? 0) as number,
          }))
        : undefined;

      await onMessage({
        channelId: message.channel as string,
        threadTs,
        userMessage: (message.text as string | undefined) ?? '',
        userId: message.user as string,
        ...(uploadedFiles !== undefined ? { uploadedFiles } : {}),
      });
    });
  }

  // ─── DM handler — handles direct messages for auth commands ─────────────────

  setupDMHandler(
    onDM: (params: { userId: string; channelId: string; text: string }) => Promise<void>,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.app.message(async ({ message }: { message: any }) => {
      // Only handle DMs (channel_type === 'im') not already handled by project/lobby handlers
      if (message.channel_type !== 'im') return;
      if (message.subtype !== undefined) return;
      if (!message.user || !message.text || !message.channel) return;
      if (message.user === this.botUserId) return;

      await onDM({
        userId: message.user as string,
        channelId: message.channel as string,
        text: (message.text as string).trim(),
      });
    });
  }

  // ─── App mention listener ─────────────────────────────────────────────────

  setupMentionHandler(onMention: (mention: AgentMention) => Promise<void>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.app.event('app_mention', async ({ event }: { event: any }) => {
      const text: string = event.text ?? '';
      const lower = text.toLowerCase();

      let targetAgent: AgentRole;
      if (lower.includes('@tester') || lower.includes('tester')) {
        targetAgent = AgentRole.TESTER;
      } else if (lower.includes('@dev') || lower.includes('dev')) {
        targetAgent = AgentRole.DEV;
      } else {
        targetAgent = AgentRole.PM;
      }

      const cleanText = text.replace(/<@[A-Z0-9]+>/gi, '').trim();

      const mention: AgentMention = {
        targetAgent,
        text: cleanText,
        userId: event.user ?? '',
        channelId: event.channel,
        ts: event.ts,
        projectId: event.channel ?? '',
      };

      await onMention(mention);
    });
  }

  // ─── Reaction listener ────────────────────────────────────────────────────

  setupReactionHandler(onReaction: (reaction: ReactionEvent) => Promise<void>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.app.event('reaction_added', async ({ event }: { event: any }) => {
      const reactionEvent: ReactionEvent = {
        emoji: event.reaction,
        messageTs: event.item?.type === 'message' ? event.item.ts : '',
        userId: event.user,
        channelId: event.item?.type === 'message' ? event.item.channel : '',
      };

      await onReaction(reactionEvent);
    });
  }

  // ─── Action handlers ─────────────────────────────────────────────────────

  setupActionHandlers(handlers: {
    onRunConfirm: (event: ActionEvent) => Promise<void>;
    onRunEdit: (event: ActionEvent) => Promise<void>;
    onRunCancel: (event: ActionEvent) => Promise<void>;
    onCheckpointApprove: (event: ActionEvent) => Promise<void>;
    onCheckpointReject: (event: ActionEvent) => Promise<void>;
    onResumeProject: (event: ActionEvent) => Promise<void>;
    onClarificationAnswer: (event: ActionEvent) => Promise<void>;
    onTaskRetry: (event: ActionEvent) => Promise<void>;
    onTaskRedo: (event: ActionEvent) => Promise<void>;
    onPlanApprove: (event: ActionEvent) => Promise<void>;
    onPlanCancel: (event: ActionEvent) => Promise<void>;
    onCheckpointRestore: (event: ActionEvent) => Promise<void>;
    onSwitchToOAuth: (event: ActionEvent) => Promise<void>;
    onSwitchLogout: (event: ActionEvent) => Promise<void>;
  }): void {
    this.app.action('run_confirm', async (args: any) => {
      await args.ack();
      await handlers.onRunConfirm(args as ActionEvent);
    });

    this.app.action('run_edit', async (args: any) => {
      await args.ack();
      await handlers.onRunEdit(args as ActionEvent);
    });

    this.app.action('run_cancel', async (args: any) => {
      await args.ack();
      await handlers.onRunCancel(args as ActionEvent);
    });

    this.app.action('checkpoint_approve', async (args: any) => {
      await args.ack();
      await handlers.onCheckpointApprove(args as ActionEvent);
    });

    this.app.action('checkpoint_reject', async (args: any) => {
      await args.ack();
      await handlers.onCheckpointReject(args as ActionEvent);
    });

    this.app.action('resume_project', async (args: any) => {
      await args.ack();
      await handlers.onResumeProject(args as ActionEvent);
    });

    // Wildcard handler for clarification question buttons (dynamic action_id)
    this.app.action(/^clarification_/, async (args: any) => {
      await args.ack();
      await handlers.onClarificationAnswer(args as ActionEvent);
    });

    // Wildcard handler for task retry buttons (task_retry_<projectId>_<taskId>)
    this.app.action(/^task_retry_/, async (args: any) => {
      await args.ack();
      await handlers.onTaskRetry(args as ActionEvent);
    });

    // Wildcard handler for task re-do buttons (task_redo_<projectId>_<taskId>)
    this.app.action(/^task_redo_/, async (args: any) => {
      await args.ack();
      await handlers.onTaskRedo(args as ActionEvent);
    });

    // Wildcard handler for plan approval buttons (plan_approve_<planId>)
    this.app.action(/^plan_approve_/, async (args: any) => {
      await args.ack();
      await handlers.onPlanApprove(args as ActionEvent);
    });

    // Wildcard handler for plan cancel buttons (plan_cancel_<planId>)
    this.app.action(/^plan_cancel_/, async (args: any) => {
      await args.ack();
      await handlers.onPlanCancel(args as ActionEvent);
    });

    // Wildcard handler for checkpoint restore buttons (checkpoint_restore_<checkpointId>)
    this.app.action(/^checkpoint_restore_/, async (args: any) => {
      await args.ack();
      await handlers.onCheckpointRestore(args as ActionEvent);
    });

    // /switch account — OAuth button
    this.app.action('switch_to_oauth', async (args: any) => {
      await args.ack();
      await handlers.onSwitchToOAuth(args as ActionEvent);
    });

    // /switch account — logout button
    this.app.action('switch_logout', async (args: any) => {
      await args.ack();
      await handlers.onSwitchLogout(args as ActionEvent);
    });

    // /login OAuth link button (link_button — just ack, no action needed)
    this.app.action('oauth_login_link', async (args: any) => {
      await args.ack();
    });

    // /account usage external link button (just ack)
    this.app.action('open_usage_link', async (args: any) => {
      await args.ack();
    });
  }

  // ─── Slash command handlers ───────────────────────────────────────────────

  setupSlashCommands(handlers: {
    onStatus: SlashHandler;
    onCost: SlashHandler;
    onPause: SlashHandler;
    onResume: SlashHandler;
    onHelp: SlashHandler;
    onLogin: SlashHandler;
    onSwitchAccount: SlashHandler;
    onLogout: SlashHandler;
    onAccount: SlashHandler;
  }): void {
    this.app.command('/swarmly-status', async (args: any) => {
      await args.ack();
      await handlers.onStatus(args);
    });

    this.app.command('/swarmly-cost', async (args: any) => {
      await args.ack();
      await handlers.onCost(args);
    });

    this.app.command('/swarmly-pause', async (args: any) => {
      await args.ack();
      await handlers.onPause(args);
    });

    this.app.command('/swarmly-resume', async (args: any) => {
      await args.ack();
      await handlers.onResume(args);
    });

    this.app.command('/swarmly-help', async (args: any) => {
      await args.ack();
      await handlers.onHelp(args);
    });

    // ── Account & Usage — /swarmly-account / /swarmly-usage ──
    for (const cmd of ['/swarmly-account', '/swarmly-usage']) {
      this.app.command(cmd, async (args: any) => {
        await args.ack();
        await handlers.onAccount(args);
      });
    }

    // ── Auth commands — all prefixed /swarmly-* to avoid text chat conflicts ──
    this.app.command('/swarmly-login', async (args: any) => {
      await args.ack();
      await handlers.onLogin(args);
    });

    this.app.command('/swarmly-switch', async (args: any) => {
      await args.ack();
      await handlers.onSwitchAccount(args);
    });

    this.app.command('/swarmly-logout', async (args: any) => {
      await args.ack();
      await handlers.onLogout(args);
    });
  }

  // ─── Messaging helpers ────────────────────────────────────────────────────

  async postMessage(channelId: string, text: string, blocks?: KnownBlock[]): Promise<string> {
    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      text,
      ...(blocks && blocks.length > 0 ? { blocks } : {}),
    });

    if (!result.ok || !result.ts) {
      throw new Error(`chat.postMessage failed: ${result.error ?? 'unknown error'}`);
    }

    return result.ts;
  }

  async replyInThread(
    channelId: string,
    threadTs: string,
    text: string,
    blocks?: KnownBlock[],
  ): Promise<void> {
    await this.app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text,
      ...(blocks && blocks.length > 0 ? { blocks } : {}),
    });
  }

  async updateMessage(
    channelId: string,
    ts: string,
    text: string,
    blocks?: KnownBlock[],
  ): Promise<void> {
    await this.app.client.chat.update({
      channel: channelId,
      ts,
      text,
      ...(blocks && blocks.length > 0 ? { blocks } : {}),
    });
  }
}
