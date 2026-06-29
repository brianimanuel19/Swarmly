import { BaseAgent } from './base-agent.js';
import { AgentRole } from '../types/index.js';
import type { FileChange } from '../types/index.js';

export interface ReviewFinding {
  severity: 'critical' | 'warning' | 'info';
  file: string;
  line?: string;
  message: string;
  suggestion?: string;
}

export interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
  fixes?: FileChange[];
}

export class CodeReviewAgent extends BaseAgent {
  constructor() {
    super(AgentRole.TESTER, 'claude-sonnet-4-6');
  }

  async review(params: {
    diff: string;
    projectId: string;
    mode: 'standard' | 'security';
    fix?: boolean;
  }): Promise<ReviewResult> {
    const { diff, projectId, mode, fix } = params;

    const focusArea = mode === 'security'
      ? 'security vulnerabilities: OWASP Top 10, injection flaws, auth/authz issues, sensitive data exposure, secrets in code, XSS, CSRF, broken access control'
      : 'bugs, logic errors, performance issues, missing error handling, type safety, code quality, maintainability';

    const systemPrompt = `You are a senior ${mode === 'security' ? 'security engineer' : 'software engineer'} performing a thorough code review.
Focus on: ${focusArea}.
${fix ? 'For fixable findings, include a "fixes" array with corrected file content.' : ''}
Return ONLY a JSON object, no explanation outside the JSON block.`;

    const userContent = `Review the following diff and return findings as JSON:

\`\`\`diff
${diff.slice(0, 10000)}
\`\`\`

Return exactly:
\`\`\`json
{
  "summary": "one paragraph summary of the review",
  "findings": [
    {
      "severity": "critical|warning|info",
      "file": "path/to/file.ts",
      "line": "42",
      "message": "what the issue is",
      "suggestion": "how to fix it"
    }
  ]${fix ? `,
  "fixes": [
    { "action": "modify", "path": "path/to/file.ts", "content": "full corrected file content" }
  ]` : ''}
}
\`\`\``;

    const output = await this.call({
      systemPrompt,
      messages: [{ role: 'user', content: userContent, timestamp: new Date() }],
      projectId,
      maxTokens: 5000,
    });

    if (!output.success) throw new Error(output.error ?? 'Review failed');

    const jsonMatch = output.content.match(/```json\s*([\s\S]*?)\s*```/);
    const raw = jsonMatch?.[1] ?? output.content.match(/\{[\s\S]*\}/)?.[0] ?? '{}';
    try {
      return JSON.parse(raw) as ReviewResult;
    } catch {
      return { summary: output.content.slice(0, 300), findings: [] };
    }
  }
}

export const codeReviewAgent = new CodeReviewAgent();
