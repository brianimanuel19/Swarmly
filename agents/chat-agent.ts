import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/config.js';
import type { ConversationHistory } from '../types/index.js';

// ---------------------------------------------------------------------------
// Cost-optimised chat agent — Haiku only, no project flow, no DB writes
// ---------------------------------------------------------------------------

const client = new Anthropic({ apiKey: config.anthropic.apiKey, baseURL: config.anthropic.baseUrl });

const LANGUAGE_RULE = `IMPORTANT: Always reply in the same language the user wrote in. If they write in Vietnamese, reply in Vietnamese. If English, reply in English. Never switch languages unless the user does first.`;

const PERSONAS: Record<string, string> = {
  pm: `You are a PM — sharp, opinionated, product-minded. You think in outcomes, not features. Talk like a peer: direct, no fluff, occasionally push back if something doesn't make sense. You're a collaborator, not an assistant. You can also answer general questions naturally when asked.

${LANGUAGE_RULE}`,

  po: `You are a Product Owner (PO). You represent the business and stakeholders. You think in user stories, acceptance criteria, and business value. You're ruthless about scope — if it's not MVP, say so. You can also answer general questions naturally when asked.

${LANGUAGE_RULE}`,

  dev: `You are a senior dev — pragmatic, technical, a bit blunt. You prefer simple solutions over clever ones. Talk like you're pair programming with a teammate. You can also answer general questions naturally when asked.

${LANGUAGE_RULE}`,

  devops: `You are a DevOps engineer — you live in terminals, YAML files, and dashboards. You care about reliability, automation, and not getting paged at 3am. Straight to the point. You can also answer general questions naturally when asked.

${LANGUAGE_RULE}`,

  tester: `You are a QA engineer who genuinely cares about quality. You spot edge cases others miss. Talk casually but precisely. You can also answer general questions naturally when asked.

${LANGUAGE_RULE}`,

  default: `You are Swarmly, a helpful AI assistant embedded in a dev team's Slack workspace. You can answer any question — general knowledge, tech, coding, life advice, current events (up to your training cutoff), anything. You're like a smart, friendly colleague.

For dev/tech topics you're especially strong: architecture, code reviews, planning, infrastructure, debugging. Users can tag @pm, @po, @dev, @devops, or @tester to talk to a specialist agent. To start a project, they go to the lobby channel.

Be concise, direct, and natural. No corporate speak, no unnecessary caveats. If you don't have real-time data (live weather, stock prices), say so briefly and give the most useful answer you can from what you know — don't just redirect them elsewhere.

${LANGUAGE_RULE}`,
};

// Keep only the last N messages per thread to minimise token spend
const MAX_HISTORY = 10;
const MAX_TOKENS = 1024;

// In-memory thread history: threadKey → messages
const threadHistories = new Map<string, ConversationHistory>();

const ROLE_KEYWORDS: Array<{ role: string; patterns: RegExp[] }> = [
  {
    role: 'devops',
    patterns: [
      // EN
      /\b(deploy|deployment|ci\/cd|pipeline|docker|container|kubernetes|k8s|nginx|server|infrastructure|infra|cloud|aws|gcp|azure|hosting|ssl|certificate|domain|dns|port|env(ironment)?|devops|helm|terraform|ansible|monitoring|uptime|downtime|crash(ed)?|restart(ing)?|log(s)?)\b/,
      // VN
      /\b(triển khai|máy chủ|hạ tầng|môi trường|cài đặt server|cấu hình server|lên server|deploy lên|chạy production|prod)\b/,
    ],
  },
  {
    role: 'tester',
    patterns: [
      // EN
      /\b(test(s|ing|case|suite|coverage|plan)?|bug(s)?|qa|quality|regression|edge case|assert|expect|mock|e2e|unit test|integration test|playwright|jest|cypress|broken|not working|doesn'?t work|fail(ing|ed)?|error)\b/,
      // VN
      /\b(kiểm thử|test case|báo lỗi|lỗi|bug|không hoạt động|bị lỗi|chạy không được|sai|hỏng|crash)\b/,
    ],
  },
  {
    role: 'po',
    patterns: [
      // EN
      /\b(prioriti(ze|se|ty|es)|backlog|moscow|must.have|should.have|mvp|scope|stakeholder|business value|user story|stories|acceptance criteria|what to build|roadmap|release|v\d+\.\d+|milestone|feature request|product)\b/,
      // VN
      /\b(ưu tiên|tính năng nào|nên làm gì trước|làm cái nào trước|scope|phạm vi|yêu cầu nghiệp vụ|nghiệp vụ|product|sản phẩm|khách hàng muốn)\b/,
    ],
  },
  {
    role: 'pm',
    patterns: [
      // EN
      /\b(sprint|planning|plan|timeline|deadline|schedule|milestone|task(s)?|ticket|jira|project|kickoff|standup|retrospective|requirement(s)?|prd|spec(ification)?|estimate|story point)\b/,
      // VN
      /\b(kế hoạch|lên kế hoạch|sprint|tiến độ|deadline|dự án|yêu cầu|đặc tả|phân tích|thiết kế tính năng|tạo task|phân task|tính năng)\b/,
    ],
  },
  {
    role: 'dev',
    patterns: [
      // EN
      /\b(code|coding|implement(ation)?|function|method|class|api|endpoint|database|db|query|sql|refactor|logic|algorithm|library|package|module|typescript|javascript|python|node|react|build|compile|syntax|import|export|async|await|null|undefined|type(script)?)\b/,
      // VN
      /\b(code|viết code|lập trình|hàm|api|database|query|xử lý logic|implement|làm sao để|cách viết|cách dùng|sửa code|đoạn code|fix code)\b/,
    ],
  },
];

export function detectRole(text: string): string {
  const lower = text.toLowerCase();

  // Hard mention — highest priority
  if (/@pm\b|^pm[,:\s]/i.test(lower)) return 'pm';
  if (/@po\b|^po[,:\s]/i.test(lower)) return 'po';
  if (/@devops\b|^devops[,:\s]/i.test(lower)) return 'devops';
  if (/@dev\b|^dev[,:\s]/i.test(lower)) return 'dev';
  if (/@tester\b|^tester[,:\s]/i.test(lower)) return 'tester';

  // Keyword-based auto-detect — score each role
  const scores: Record<string, number> = {};
  for (const { role, patterns } of ROLE_KEYWORDS) {
    scores[role] = patterns.reduce((acc, re) => {
      const matches = lower.match(new RegExp(re.source, 'gi'));
      return acc + (matches ? matches.length : 0);
    }, 0);
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] > 0) return best[0];

  return 'default';
}

// label: display name | slackEmoji: Slack :code: (for webhooks) | textEmoji: unicode (for fallback text)
export const ROLE_IDENTITY: Record<string, { label: string; slackEmoji: string; textEmoji: string }> = {
  pm:      { label: 'PM Agent',     slackEmoji: 'memo',          textEmoji: '📋' },
  po:      { label: 'PO Agent',     slackEmoji: 'briefcase',     textEmoji: '💼' },
  dev:     { label: 'Dev Agent',    slackEmoji: 'computer',      textEmoji: '💻' },
  devops:  { label: 'DevOps Agent', slackEmoji: 'gear',          textEmoji: '⚙️' },
  tester:  { label: 'Tester Agent', slackEmoji: 'microscope',    textEmoji: '🔬' },
  default: { label: '',             slackEmoji: 'robot_face',    textEmoji: '🤖' },
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
