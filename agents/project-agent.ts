import { BaseAgent } from './base-agent.js';
import { AgentRole, FileChange, ProjectState } from '../types/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProjectAgentResponse {
  type: 'answer' | 'changes';
  text: string;
  files?: FileChange[];
}

export type ConvMessage = { role: 'user' | 'assistant'; content: string };

// ─── ProjectAgent ─────────────────────────────────────────────────────────────

export class ProjectAgent extends BaseAgent {
  constructor() {
    super(AgentRole.PM, 'claude-sonnet-4-6');
  }

  async handleMessage(params: {
    message: string;
    history: ConvMessage[];
    codebase: Record<string, string>;
    project: ProjectState;
    projectId: string;
  }): Promise<ProjectAgentResponse> {
    const { message, history, codebase, project, projectId } = params;

    const filePaths = Object.keys(codebase).sort();

    // Select relevant files: keyword-match user message + always include key files
    const keywords = message.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const keyFiles = ['package.json', 'tsconfig.json', 'README.md', 'docker-compose.yml'];

    const scored = filePaths.map((p) => {
      const lower = p.toLowerCase();
      const score =
        keywords.filter((kw) => lower.includes(kw)).length * 3 +
        (keyFiles.some((k) => p.endsWith(k)) ? 2 : 0);
      return { path: p, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const selected = scored.slice(0, 25).map((s) => s.path);

    const MAX_FILE_CHARS = 3000;
    const fileContext = selected
      .map((p) => {
        const content = codebase[p] ?? '';
        const truncated = content.length > MAX_FILE_CHARS
          ? content.slice(0, MAX_FILE_CHARS) + '\n... [truncated]'
          : content;
        return `### ${p}\n\`\`\`\n${truncated}\n\`\`\``;
      })
      .join('\n\n');

    const fileTree = filePaths.slice(0, 300).join('\n');

    const systemPrompt = `You are the AI engineering assistant for project **${project.name}** (phase: ${project.phase}).
You have full visibility into the codebase and can answer questions, diagnose bugs, explain architecture, and implement code changes — exactly like Claude in VSCode.

## Project Info
- GitHub: ${project.githubRepo ?? 'N/A'} (branch: ${project.githubBranch ?? 'main'})
- Jira: ${project.jiraProjectKey ?? 'N/A'}
- Sprint: ${project.sprint?.goal ?? 'N/A'}
- Tasks: ${(project.sprint?.tasks ?? []).map((t) => `[${t.status}] ${t.title}`).join(' | ') || 'none'}
${project.prd ? `\n## PRD (excerpt)\n${project.prd.slice(0, 800)}` : ''}

## File tree (${filePaths.length} files)
\`\`\`
${fileTree}
\`\`\`

## Code context (${selected.length} most relevant files)
${fileContext}

---
## Your capabilities
1. **Answer questions** about code, architecture, bugs, Jira/GitHub links, sprint status — cite actual file paths and line content.
2. **Implement changes** when the user asks you to fix a bug, add a feature, refactor, etc.

## Response format
- For **answers**: reply in clear markdown. Reference real file names.
- For **code changes**: write a short explanation, then output a fenced JSON block:
\`\`\`json
{
  "changes": [
    { "action": "modify", "path": "src/foo.ts", "content": "full new file content here" },
    { "action": "create", "path": "src/bar.ts", "content": "..." },
    { "action": "delete", "path": "src/old.ts", "content": "" }
  ]
}
\`\`\`
Only include the JSON block when you are actually writing file changes. Do NOT include it for answers.`;

    const messages = [
      ...history.map((h) => ({
        role: h.role,
        content: h.content,
        timestamp: new Date(),
      })),
      { role: 'user' as const, content: message, timestamp: new Date() },
    ];

    const output = await this.call({
      systemPrompt,
      messages,
      projectId,
      maxTokens: 6000,
      useCache: true,
    });

    if (!output.success) {
      return { type: 'answer', text: `Sorry, I ran into an error: ${output.error ?? 'unknown'}` };
    }

    const content = output.content.trim();

    // Detect if response contains file changes JSON
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]) as { changes: FileChange[] };
        if (Array.isArray(parsed.changes) && parsed.changes.length > 0) {
          const textPart = content.replace(/```json[\s\S]*?```/, '').trim();
          return { type: 'changes', text: textPart, files: parsed.changes };
        }
      } catch {
        // not a valid changes block — fall through to answer
      }
    }

    return { type: 'answer', text: content };
  }
}

export const projectAgent = new ProjectAgent();
