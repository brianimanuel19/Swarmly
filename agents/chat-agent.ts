import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/config.js';
import type { ConversationHistory } from '../types/index.js';

// ---------------------------------------------------------------------------
// Cost-optimised chat agent — Haiku only, no project flow, no DB writes
// ---------------------------------------------------------------------------

const client = new Anthropic({ apiKey: config.anthropic.apiKey, baseURL: config.anthropic.baseUrl });

const PERSONAS: Record<string, string> = {
  pm: `You are a PM — sharp, opinionated, product-minded. You think in outcomes, not features. Talk like a peer: direct, no fluff, occasionally push back if something doesn't make sense. You're not a assistant, you're a collaborator.`,
  dev: `You are a senior dev — pragmatic, technical, a bit blunt. You say what you think. You prefer simple solutions over clever ones. Talk like you're pair programming with a teammate, not presenting to a client.`,
  tester: `You are a QA engineer who genuinely cares about quality. You spot edge cases others miss. Talk casually but precisely — like a colleague who's seen too many production bugs to sugarcoat things.`,
  default: `You're Swarmly — part of an AI dev team (PM, Dev, Tester). Talk naturally, like a smart colleague in a Slack channel. Be concise, skip the formalities. Answer questions, discuss ideas, debate approaches. If someone wants to start a project, point them to the lobby channel. They can tag @pm, @dev, or @tester to talk to a specific agent.`,
};

// Keep only the last N messages per thread to minimise token spend
const MAX_HISTORY = 10;
const MAX_TOKENS = 512;

// In-memory thread history: threadKey → messages
const threadHistories = new Map<string, ConversationHistory>();

export function detectRole(text: string): string {
  const lower = text.toLowerCase();
  if (/@pm\b|^pm[,:\s]/i.test(lower)) return 'pm';
  if (/@dev\b|^dev[,:\s]/i.test(lower)) return 'dev';
  if (/@tester\b|^tester[,:\s]/i.test(lower)) return 'tester';
  return 'default';
}

export const ROLE_IDENTITY: Record<string, { username: string; icon_emoji: string }> = {
  pm:      { username: 'PM Agent',     icon_emoji: ':memo:' },
  dev:     { username: 'Dev Agent',    icon_emoji: ':computer:' },
  tester:  { username: 'Tester Agent', icon_emoji: ':microscope:' },
  default: { username: 'Swarmly',      icon_emoji: ':robot_face:' },
};

export async function chatReply(params: {
  threadKey: string;
  userMessage: string;
  userId: string;
}): Promise<string> {
  const { threadKey, userMessage } = params;

  const role = detectRole(userMessage);
  const systemPrompt = PERSONAS[role] ?? PERSONAS['default']!;

  // Load or init thread history
  const history: ConversationHistory = threadHistories.get(threadKey) ?? [];

  history.push({ role: 'user', content: userMessage, timestamp: new Date() });

  const trimmed = history.slice(-MAX_HISTORY);

  const messages: Anthropic.MessageParam[] = trimmed
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  try {
    const response = await client.messages.create({
      model: config.anthropic.models.lobby, // Haiku
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
    });

    const text =
      response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('') || 'Sorry, I could not generate a response.';

    trimmed.push({ role: 'assistant', content: text, timestamp: new Date() });
    threadHistories.set(threadKey, trimmed.slice(-MAX_HISTORY));

    const inTok = response.usage.input_tokens;
    const outTok = response.usage.output_tokens;
    const pricing = config.anthropic.pricing[config.anthropic.models.lobby]!;
    const cost = (inTok / 1e6) * pricing.input + (outTok / 1e6) * pricing.output;
    console.log(`[chat-agent:${role}] ${inTok}in ${outTok}out $${cost.toFixed(6)}`);

    return text;
  } catch (err) {
    console.error('[chat-agent] error:', err);
    return 'Sorry, I ran into an issue. Please try again.';
  }
}

export function clearThread(threadKey: string): void {
  threadHistories.delete(threadKey);
}
