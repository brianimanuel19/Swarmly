import { App, type SlackActionMiddlewareArgs, type SlackCommandMiddlewareArgs } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import type { LobbyMessage, AgentMention } from '../types/index.js';
import { AgentRole } from '../types/index.js';
import { config } from '../config/config.js';

// ─── Action payload helper types ────────────────────────────────────────────

type ActionEvent = SlackActionMiddlewareArgs & { ack: () => Promise<void> };

// ─── Reaction callback shape ─────────────────────────────────────────────────

export interface ReactionEvent {
  emoji: string;
  messageTs: string;
  userId: string;
  channelId: string;
}

// ─── SlashCommand handler shape ──────────────────────────────────────────────

export type SlashHandler = (
  args: SlackCommandMiddlewareArgs & { ack: () => Promise<void> },
) => Promise<void>;

// ─── Main class ─────────────────────────────────────────────────────────────

export class SlackListener {
  private readonly app: App;
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
    this.app.message(async ({ message, client }) => {
      // Type narrowing — Bolt can surface subtypes; ignore non-plain messages
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

      // Only process messages in the lobby channel
      if (message.channel !== this.lobbyChannelId) return;

      // Skip messages from the bot itself
      if (message.user === this.botUserId) return;

      // Build conversation history from thread if available
      let history: LobbyMessage['history'] = [];
      const threadTs: string = (message as { thread_ts?: string }).thread_ts ?? message.ts;

      if ((message as { thread_ts?: string }).thread_ts) {
        const repliesResult = await client.conversations.replies({
          channel: this.lobbyChannelId,
          ts: threadTs,
          limit: 50,
        });

        history = (repliesResult.messages ?? [])
          .filter((m) => 'text' in m && m.text)
          .map((m) => ({
            role: (m as { user?: string }).user === this.botUserId ? 'assistant' : 'user',
            content: (m as { text?: string }).text ?? '',
            timestamp: new Date(parseFloat((m as { ts?: string }).ts ?? '0') * 1000),
          }));
      }

      const lobbyMsg: LobbyMessage = {
        text: message.text,
        userId: message.user,
        channelId: message.channel,
        ts: message.ts,
        history,
        workspaceId: (message as { team?: string }).team ?? '',
      };

      await onMessage(lobbyMsg);
    });
  }

  // ─── App mention listener ─────────────────────────────────────────────────

  setupMentionHandler(onMention: (mention: AgentMention) => Promise<void>): void {
    this.app.event('app_mention', async ({ event }) => {
      const text: string = event.text ?? '';
      const lower = text.toLowerCase();

      let targetAgent: AgentRole;
      if (lower.includes('@tester') || lower.includes('tester')) {
        targetAgent = AgentRole.TESTER;
      } else if (lower.includes('@dev') || lower.includes('dev')) {
        targetAgent = AgentRole.DEV;
      } else {
        // Default to PM if no specific agent is mentioned
        targetAgent = AgentRole.PM;
      }

      // Strip the bot mention token from the text
      const cleanText = text.replace(/<@[A-Z0-9]+>/gi, '').trim();

      const mention: AgentMention = {
        targetAgent,
        text: cleanText,
        userId: event.user ?? '',
        channelId: event.channel,
        ts: event.ts,
        projectId: (event as { channel?: string }).channel ?? '',
      };

      await onMention(mention);
    });
  }

  // ─── Reaction listener ────────────────────────────────────────────────────

  setupReactionHandler(onReaction: (reaction: ReactionEvent) => Promise<void>): void {
    this.app.event('reaction_added', async ({ event }) => {
      const reactionEvent: ReactionEvent = {
        emoji: event.reaction,
        messageTs: event.item.type === 'message' ? event.item.ts : '',
        userId: event.user,
        channelId: event.item.type === 'message' ? event.item.channel : '',
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
  }): void {
    this.app.action('run_confirm', async (args) => {
      await args.ack();
      await handlers.onRunConfirm(args as unknown as ActionEvent);
    });

    this.app.action('run_edit', async (args) => {
      await args.ack();
      await handlers.onRunEdit(args as unknown as ActionEvent);
    });

    this.app.action('run_cancel', async (args) => {
      await args.ack();
      await handlers.onRunCancel(args as unknown as ActionEvent);
    });

    this.app.action('checkpoint_approve', async (args) => {
      await args.ack();
      await handlers.onCheckpointApprove(args as unknown as ActionEvent);
    });

    this.app.action('checkpoint_reject', async (args) => {
      await args.ack();
      await handlers.onCheckpointReject(args as unknown as ActionEvent);
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
    this.app.command('/swarmly-status', async (args) => {
      await args.ack();
      await handlers.onStatus(args);
    });

    this.app.command('/swarmly-cost', async (args) => {
      await args.ack();
      await handlers.onCost(args);
    });

    this.app.command('/swarmly-pause', async (args) => {
      await args.ack();
      await handlers.onPause(args);
    });

    this.app.command('/swarmly-resume', async (args) => {
      await args.ack();
      await handlers.onResume(args);
    });

    this.app.command('/swarmly-help', async (args) => {
      await args.ack();
      await handlers.onHelp(args);
    });
  }

  // ─── Messaging helpers ────────────────────────────────────────────────────

  /**
   * Post a message to a channel and return the message timestamp.
   */
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

  /**
   * Reply inside an existing thread.
   */
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

  /**
   * Update an existing message in place.
   */
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
