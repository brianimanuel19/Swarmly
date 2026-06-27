import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import { buildRunConfirmationBlock } from './slack-messages.js';

export class SlackChannelManager {
  private readonly web: WebClient;

  constructor(webClient: WebClient) {
    this.web = webClient;
  }

  /**
   * Create a new project Slack channel, set its topic, invite the user, post
   * a welcome message, and return the channel ID.
   */
  async createProjectChannel(params: {
    projectName: string;
    projectSlug: string;
    description: string;
    userId: string;
  }): Promise<string> {
    const { projectName, projectSlug, description, userId } = params;

    // Normalise the channel name: lowercase, spaces → hyphens, strip invalid chars
    const safeName = `project-${projectSlug}`
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-_]/g, '')
      .slice(0, 80); // Slack channel-name limit

    // Create the channel
    const createResult = await this.web.conversations.create({ name: safeName });
    if (!createResult.ok || !createResult.channel?.id) {
      throw new Error(
        `Failed to create Slack channel "${safeName}": ${createResult.error ?? 'unknown error'}`,
      );
    }
    const channelId = createResult.channel.id;

    // Set the topic / description
    await this.web.conversations.setTopic({
      channel: channelId,
      topic: description.slice(0, 250), // Slack topic limit
    });

    // Invite the requesting user (bot is already a member as the creator)
    await this.web.conversations.invite({
      channel: channelId,
      users: userId,
    });

    // Post a welcome / run-confirmation message so the user sees the project card
    const welcomeBlocks: KnownBlock[] = buildRunConfirmationBlock({
      projectName,
      requirement: description,
      domains: [],
      estimatedCostRange: 'Calculating…',
      estimatedTimeRange: 'Calculating…',
    });

    await this.web.chat.postMessage({
      channel: channelId,
      text: `Welcome to *${projectName}*! Your Swarmly agents are ready.`,
      blocks: welcomeBlocks,
    });

    return channelId;
  }

  /**
   * Post an introduction message for the three AI agents into a project channel.
   */
  async introduceAgents(channelId: string, projectName: string): Promise<void> {
    const blocks: KnownBlock[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `👋 Meet Your Swarmly Team — ${projectName}`,
          emoji: true,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            'Three specialised AI agents will build your project end-to-end:\n\n' +
            '👩‍💼 *PM* — manages the sprint, writes the PRD, reviews every output, and keeps the team on track.\n' +
            '👨‍💻 *Dev* — implements features, writes clean code, and commits to GitHub.\n' +
            '🧪 *Tester* — writes automated tests, runs the test suite, and files bug reports.',
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '💬 *Talking to the team*\n' +
            'Mention `@pm`, `@dev`, or `@tester` to send a direct message to a specific agent.\n' +
            'Use `/swarmly-status` for a live progress snapshot, or `/swarmly-help` for all commands.',
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Swarmly agents respond asynchronously. You will receive checkpoint prompts when human input is required.',
          },
        ],
      },
    ];

    await this.web.chat.postMessage({
      channel: channelId,
      text: `👋 Meet your Swarmly team for *${projectName}*.`,
      blocks,
    });
  }

  /**
   * Post a final summary, then archive the project channel.
   */
  async archiveProjectChannel(channelId: string, summary: string): Promise<void> {
    const blocks: KnownBlock[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🏁 Project Complete — Channel Archived', emoji: true },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: summary },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `This channel will be archived at ${new Date().toUTCString()}. All history is preserved and searchable.`,
          },
        ],
      },
    ];

    await this.web.chat.postMessage({
      channel: channelId,
      text: 'Project complete — this channel is being archived.',
      blocks,
    });

    await this.web.conversations.archive({ channel: channelId });
  }

  /**
   * Look up a channel by its project slug and return its ID, or null if not found.
   */
  async getChannelId(slug: string): Promise<string | null> {
    const targetName = `project-${slug}`
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-_]/g, '');

    let cursor: string | undefined;

    do {
      const result = await this.web.conversations.list({
        exclude_archived: false,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });

      if (!result.ok || !result.channels) break;

      const match = result.channels.find((ch) => ch.name === targetName);
      if (match?.id) return match.id;

      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    return null;
  }
}
