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
      ) return;

      if (message.channel === this.lobbyChannelId) return; // lobby handled separately
      if (message.user === this.botUserId) return;

      const threadTs: string = message.thread_ts ?? message.ts;

      await onMessage({
        channelId: message.channel as string,
        threadTs,
        userMessage: message.text as string,
        userId: message.user as string,
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
  }

  // ─── Slash command handlers ───────────────────────────────────────────────

  setupSlashCommands(handlers: {
    onStatus: SlashHandler;
    onCost: SlashHandler;
    onPause: SlashHandler;
    onResume: SlashHandler;
    onHelp: SlashHandler;
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
