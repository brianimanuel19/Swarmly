import { CheckpointRequest, CheckpointResponse, ProjectPhase } from '../types/index.js';
import { buildCheckpointBlock } from '../integrations/slack-messages.js';
import { config } from '../config/config.js';

// ─── Internal pending-checkpoint record ──────────────────────────────────────

interface PendingCheckpoint {
  resolve: (response: CheckpointResponse) => void;
  reject: (reason: Error) => void;
  reminderHandle: ReturnType<typeof setInterval>;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// ─── SlackPoster — minimal typing for the Slack WebClient subset we need ─────

interface SlackPoster {
  chat: {
    postMessage: (params: {
      channel: string;
      text: string;
      blocks?: unknown[];
    }) => Promise<{ ok: boolean; error?: string }>;
  };
}

// ─── HumanCheckpoint ─────────────────────────────────────────────────────────

export class HumanCheckpoint {
  /** projectId → pending Promise handles */
  private pending: Map<string, PendingCheckpoint> = new Map();

  /** Injected Slack web client — set via setSlackClient() before first use */
  private slack: SlackPoster | null = null;

  /**
   * Provide the Slack WebClient. Called by the pipeline (or app bootstrap) so
   * this module does not depend on a global singleton that may not be ready at
   * import time.
   */
  setSlackClient(client: SlackPoster): void {
    this.slack = client;
  }

  // ─── request ───────────────────────────────────────────────────────────────

  /**
   * Post a Block Kit checkpoint card to the project Slack channel and return a
   * Promise that resolves when a human clicks Approve or Reject, or after the
   * configured timeout (auto-approved).
   */
  async request(params: CheckpointRequest): Promise<CheckpointResponse> {
    const { projectId, slackChannelId } = params;
    const timeoutMs = config.checkpoints.timeoutMs;
    const reminderMs = config.checkpoints.reminderIntervalMs;

    // Post the initial checkpoint message
    await this._postCheckpointMessage(params);

    return new Promise<CheckpointResponse>((resolve, reject) => {
      // Reminder: re-post the card so it surfaces in the channel
      const reminderHandle = setInterval(async () => {
        try {
          await this._postCheckpointMessage(params, true);
        } catch (err: unknown) {
          console.warn(
            `[HumanCheckpoint] Reminder re-post failed for ${projectId}: ${(err as Error).message}`,
          );
        }
      }, reminderMs);

      // Timeout: auto-approve so the pipeline is never permanently blocked
      const timeoutHandle = setTimeout(() => {
        const checkpoint = this.pending.get(projectId);
        if (!checkpoint) return;

        clearInterval(checkpoint.reminderHandle);
        this.pending.delete(projectId);

        console.log(
          `[HumanCheckpoint] Checkpoint for project ${projectId} timed out — auto-approving.`,
        );

        resolve({
          approved: true,
          feedback: 'Auto-approved due to timeout',
          userId: 'system',
          timestamp: new Date(),
        });
      }, timeoutMs);

      this.pending.set(projectId, {
        resolve,
        reject,
        reminderHandle,
        timeoutHandle,
      });
    });
  }

  // ─── askClarification ──────────────────────────────────────────────────────

  /**
   * Post each ambiguity question to the channel as a Block Kit message with
   * option buttons. Waits up to 30 minutes for human answers, then returns a
   * combined string of all answers (or "No answer provided" for unanswered ones).
   *
   * The answers accumulate via handleClarificationAnswer(), which the Slack
   * action handler must call when a button is clicked.
   */
  async askClarification(
    ambiguities: Array<{ question: string; options: string[] }>,
    projectId: string,
    channelId: string,
  ): Promise<string> {
    if (!this.slack) {
      console.warn('[HumanCheckpoint] No Slack client set — skipping clarification.');
      return 'No clarification available (Slack not connected).';
    }

    if (ambiguities.length === 0) {
      return '';
    }

    const CLARIFICATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

    const answers: Map<number, string> = new Map();
    const resolvers: Map<number, (answer: string) => void> = new Map();

    const answerPromises = ambiguities.map((ambiguity, index) => {
      // Post a Block Kit message for this question
      const blocks = this._buildClarificationBlock(ambiguity, projectId, index);
      this.slack!.chat.postMessage({
        channel: channelId,
        text: `Question ${index + 1}: ${ambiguity.question}`,
        blocks,
      }).catch((err: unknown) => {
        console.warn(
          `[HumanCheckpoint] Failed to post clarification question ${index}: ${(err as Error).message}`,
        );
      });

      // Register resolver so handleClarificationAnswer() can fulfil it
      return new Promise<string>((resolve) => {
        resolvers.set(index, resolve);

        // Store resolver in pending map keyed by `${projectId}::q${index}`
        this.pending.set(`${projectId}::q${index}`, {
          resolve: (resp: CheckpointResponse) => resolve(resp.feedback),
          reject: () => resolve('No answer provided'),
          reminderHandle: 0 as unknown as ReturnType<typeof setInterval>,
          timeoutHandle: setTimeout(() => {
            resolvers.delete(index);
            resolve('No answer provided');
          }, CLARIFICATION_TIMEOUT_MS),
        });
      });
    });

    const resolved = await Promise.all(answerPromises);

    // Clean up pending entries
    ambiguities.forEach((_, i) => {
      this.pending.delete(`${projectId}::q${i}`);
    });

    // Combine into a single readable string
    return ambiguities
      .map((a, i) => `Q: ${a.question}\nA: ${resolved[i] ?? 'No answer provided'}`)
      .join('\n\n');
  }

  // ─── handleApproval ────────────────────────────────────────────────────────

  /**
   * Called by the Slack action handler when a user clicks the Approve button.
   * Resolves the pending checkpoint Promise for the given projectId.
   */
  handleApproval(projectId: string, userId: string): boolean {
    const checkpoint = this.pending.get(projectId);
    if (!checkpoint) {
      console.warn(`[HumanCheckpoint] handleApproval: no pending checkpoint for ${projectId}`);
      return false;
    }

    clearInterval(checkpoint.reminderHandle);
    clearTimeout(checkpoint.timeoutHandle);
    this.pending.delete(projectId);

    console.log(`[HumanCheckpoint] Project ${projectId} approved by user ${userId}`);

    checkpoint.resolve({
      approved: true,
      feedback: '',
      userId,
      timestamp: new Date(),
    });
    return true;
  }

  // ─── handleRejection ───────────────────────────────────────────────────────

  /**
   * Called by the Slack action handler when a user clicks the Reject button.
   * Resolves the pending checkpoint Promise with approved: false.
   */
  handleRejection(projectId: string, userId: string, feedback: string): void {
    const checkpoint = this.pending.get(projectId);
    if (!checkpoint) {
      console.warn(`[HumanCheckpoint] handleRejection: no pending checkpoint for ${projectId}`);
      return;
    }

    clearInterval(checkpoint.reminderHandle);
    clearTimeout(checkpoint.timeoutHandle);
    this.pending.delete(projectId);

    console.log(`[HumanCheckpoint] Project ${projectId} rejected by user ${userId}: "${feedback}"`);

    checkpoint.resolve({
      approved: false,
      feedback,
      userId,
      timestamp: new Date(),
    });
  }

  /**
   * Called by the Slack action handler when a user answers a clarification
   * question (button click). The `questionIndex` maps to the question position
   * in the original ambiguities array.
   */
  handleClarificationAnswer(projectId: string, questionIndex: number, answer: string): void {
    const key = `${projectId}::q${questionIndex}`;
    const pending = this.pending.get(key);
    if (!pending) {
      console.warn(`[HumanCheckpoint] handleClarificationAnswer: no pending entry for ${key}`);
      return;
    }

    clearTimeout(pending.timeoutHandle);
    this.pending.delete(key);

    pending.resolve({
      approved: true,
      feedback: answer,
      userId: 'human',
      timestamp: new Date(),
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async _postCheckpointMessage(
    params: CheckpointRequest,
    isReminder = false,
  ): Promise<void> {
    if (!this.slack) {
      console.warn('[HumanCheckpoint] No Slack client set — checkpoint message not posted.');
      return;
    }

    const blocks = buildCheckpointBlock(params);

    const text = isReminder
      ? `[REMINDER] Checkpoint awaiting review — Phase: ${params.phase} — Project: ${params.projectId}`
      : `Checkpoint — Phase: ${params.phase} — Your review is needed.`;

    const result = await this.slack.chat.postMessage({
      channel: params.slackChannelId,
      text,
      blocks,
    });

    if (!result.ok) {
      console.error(
        `[HumanCheckpoint] Failed to post checkpoint message: ${result.error ?? 'unknown error'}`,
      );
    }
  }

  private _buildClarificationBlock(
    ambiguity: { question: string; options: string[] },
    projectId: string,
    questionIndex: number,
  ): unknown[] {
    const optionButtons = ambiguity.options.map((option) => ({
      type: 'button',
      text: { type: 'plain_text', text: option, emoji: true },
      action_id: `clarification_${projectId}_${questionIndex}_${option
        .toLowerCase()
        .replace(/\s+/g, '_')
        .slice(0, 50)}`,
      value: JSON.stringify({ projectId, questionIndex, answer: option }),
    }));

    return [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `Question ${questionIndex + 1}: ${ambiguity.question}`,
          emoji: true,
        },
      },
      { type: 'divider' },
      {
        type: 'actions',
        elements: optionButtons,
      },
    ];
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const humanCheckpoint = new HumanCheckpoint();
