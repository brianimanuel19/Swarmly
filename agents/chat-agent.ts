import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/config.js';
import type { ConversationHistory } from '../types/index.js';

// ---------------------------------------------------------------------------
// Cost-optimised chat agent — Haiku only, no project flow, no DB writes
// ---------------------------------------------------------------------------

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SYSTEM_PROMPT = `You are Swarmly, an AI dev team assistant. You can answer questions about software, architecture, code, and the Swarmly platform. You are helpful, concise, and direct. If the user wants to build a project, tell them to go to the lobby channel instead.`;

// Keep only the last N messages to minimise token spend
const MAX_HISTORY = 10;

// In-memory thread history: threadTs → messages
const threadHistories = new Map<string, ConversationHistory>();

export async function chatReply(params: {
  threadKey: string;
  userMessage: string;
  userId: string;
}): Promise<string> {
  const { threadKey, userMessage, userId: _userId } = params;

  // Load or init thread history
  const history: ConversationHistory = threadHistories.get(threadKey) ?? [];

  // Append new user message
  history.push({ role: 'user', content: userMessage, timestamp: new Date() });

  // Trim to last MAX_HISTORY messages
  const trimmed = history.slice(-MAX_HISTORY);

  const messages: Anthropic.MessageParam[] = trimmed
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  try {
    const response = await client.messages.create({
      model: config.anthropic.models.lobby, // Haiku — cheapest
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages,
    });

    const text =
      response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('') || 'Sorry, I could not generate a response.';

    // Persist assistant reply to thread history
    trimmed.push({ role: 'assistant', content: text, timestamp: new Date() });
    threadHistories.set(threadKey, trimmed.slice(-MAX_HISTORY));

    const inTok = response.usage.input_tokens;
    const outTok = response.usage.output_tokens;
    const pricing = config.anthropic.pricing[config.anthropic.models.lobby]!;
    const cost = (inTok / 1e6) * pricing.input + (outTok / 1e6) * pricing.output;
    console.log(`[chat-agent] ${inTok}in ${outTok}out $${cost.toFixed(6)}`);

    return text;
  } catch (err) {
    console.error('[chat-agent] error:', err);
    return 'Sorry, I ran into an issue. Please try again.';
  }
}

/** Clear thread history (e.g. when user types "reset") */
export function clearThread(threadKey: string): void {
  threadHistories.delete(threadKey);
}
