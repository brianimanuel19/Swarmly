import {
  AgentRole,
  Task,
  CodeOutput,
  FileChange,
  BugReport,
  ProjectState,
  ConversationHistory,
  TaskStatus,
} from '../types/index.js';
import { BaseAgent } from './base-agent.js';
import { longTermMemory } from '../memory/long-term-memory.js';
import { config } from '../config/config.js';

/** Max characters per file included in codebase context before truncation */
const MAX_FILE_CHARS = 3000;
/** Max total codebase chars to include in prompt */
const MAX_CODEBASE_CHARS = 40_000;

function buildCodebaseContext(codebase: Record<string, string>): string {
  if (Object.keys(codebase).length === 0) {
    return 'No existing codebase files.';
  }

  let total = 0;
  const lines: string[] = [];

  for (const [path, content] of Object.entries(codebase)) {
    const truncated =
      content.length > MAX_FILE_CHARS
        ? content.substring(0, MAX_FILE_CHARS) + '\n... [truncated]'
        : content;
    const entry = `### ${path}\n\`\`\`\n${truncated}\n\`\`\``;
    if (total + entry.length > MAX_CODEBASE_CHARS) {
      lines.push(`### ${path}\n[File omitted to stay within context limit]`);
    } else {
      lines.push(entry);
      total += entry.length;
    }
  }

  return lines.join('\n\n');
}

export class DevAgent extends BaseAgent {
  constructor() {
    super(AgentRole.DEV, config.anthropic.models.dev);
  }

  async implementTask(
    task: Task,
    context: {
      prd: string;
      codebase: Record<string, string>;
      stackProfile: string;
      devSystemPrompt: string;
    },
    projectId: string,
  ): Promise<CodeOutput> {
    const pastMemory = await longTermMemory.recallForAgent({
      projectId,
      agentRole: AgentRole.DEV,
      query: task.title,
    });

    const codebaseContext = buildCodebaseContext(context.codebase);

    const systemPrompt = `${context.devSystemPrompt}

Stack Profile: ${context.stackProfile}

${pastMemory ? `Relevant past memory:\n${pastMemory}\n` : ''}

You must output valid JSON matching this exact schema — no other text before or after:
{
  "approach": "<1-2 sentence description of your implementation strategy>",
  "files": [
    {
      "path": "<relative file path>",
      "content": "<complete file content — no placeholders>",
      "action": "<create|modify|delete>"
    }
  ],
  "explanation": "<paragraph explaining the key design decisions>",
  "testInstructions": "<step-by-step instructions to manually test this implementation>",
  "dependencies": ["<package-name@version>"]
}

Rules:
- Every file content must be complete and non-empty (no TODOs, no placeholders)
- approach must be a non-empty string
- dependencies must be an array (empty array if no new dependencies)
- Implement ALL acceptance criteria listed in the task
- Follow existing code conventions from the codebase`;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Implement the following task completely.

## Task
Title: ${task.title}
Type: ${task.type}
Priority: ${task.priority}
Description: ${task.description}

Acceptance Criteria:
${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## PRD
${context.prd}

## Current Codebase
${codebaseContext}`,
        timestamp: new Date(),
      },
    ];

    const result = await this.callWithValidation<CodeOutput>({
      systemPrompt,
      messages,
      projectId,
      validate: (output) => {
        if (!output.approach || output.approach.trim() === '') {
          return { valid: false, reason: 'approach must be a non-empty string' };
        }
        if (!Array.isArray(output.files) || output.files.length === 0) {
          return { valid: false, reason: 'files must be a non-empty array' };
        }
        for (const file of output.files) {
          if (!file.path || file.path.trim() === '') {
            return { valid: false, reason: 'each file must have a non-empty path' };
          }
          if (file.action !== 'delete' && (!file.content || file.content.trim() === '')) {
            return { valid: false, reason: `file "${file.path}" has empty content` };
          }
          if (!['create', 'modify', 'delete'].includes(file.action)) {
            return {
              valid: false,
              reason: `file "${file.path}" has invalid action "${file.action}"`,
            };
          }
        }
        if (!Array.isArray(output.dependencies)) {
          return { valid: false, reason: 'dependencies must be an array' };
        }
        return { valid: true };
      },
      maxAttempts: 3,
    });

    await longTermMemory.remember({
      projectId,
      workspaceId: projectId,
      agentRole: AgentRole.DEV,
      content: `Implemented task "${task.title}": ${result.approach}. Files: ${result.files.map((f) => f.path).join(', ')}`,
    });

    return result;
  }

  async fixBug(
    bugReport: BugReport,
    context: {
      prd: string;
      codebase: Record<string, string>;
      stackProfile: string;
      devSystemPrompt: string;
    },
    projectId: string,
  ): Promise<CodeOutput> {
    const pastMemory = await longTermMemory.recallForAgent({
      projectId,
      agentRole: AgentRole.DEV,
      query: bugReport.title,
    });

    // Only include the affected file and its immediate context
    const affectedContent = context.codebase[bugReport.affectedFile] ?? '';
    const otherFiles = buildCodebaseContext(
      Object.fromEntries(
        Object.entries(context.codebase).filter(([p]) => p !== bugReport.affectedFile),
      ),
    );

    const systemPrompt = `${context.devSystemPrompt}

Stack Profile: ${context.stackProfile}

${pastMemory ? `Relevant past memory:\n${pastMemory}\n` : ''}

You are fixing a bug. Apply a minimal, targeted fix — only modify files that are directly involved in the bug.

Output valid JSON:
{
  "approach": "<root cause analysis and fix strategy in 1-2 sentences>",
  "files": [
    {
      "path": "<relative file path>",
      "content": "<complete corrected file content>",
      "action": "<create|modify|delete>"
    }
  ],
  "explanation": "<explanation of what caused the bug and why this fix resolves it>",
  "testInstructions": "<steps to verify the bug is fixed>",
  "dependencies": []
}

Rules:
- Minimize the number of files changed — fix only what is broken
- Every modified file must have complete content (no truncation)
- approach must describe the root cause, not just the symptom`;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Fix the following bug.

## Bug Report
ID: ${bugReport.id}
Severity: ${bugReport.severity}
Title: ${bugReport.title}
Affected File: ${bugReport.affectedFile}

Steps to Reproduce:
${bugReport.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Expected: ${bugReport.expected}
Actual: ${bugReport.actual}
Suggested Fix: ${bugReport.suggestedFix}

## Affected File
### ${bugReport.affectedFile}
\`\`\`
${affectedContent.length > MAX_FILE_CHARS ? affectedContent.substring(0, MAX_FILE_CHARS) + '\n... [truncated]' : affectedContent}
\`\`\`

## Other Codebase Files (for context)
${otherFiles}`,
        timestamp: new Date(),
      },
    ];

    const result = await this.callWithValidation<CodeOutput>({
      systemPrompt,
      messages,
      projectId,
      validate: (output) => {
        if (!output.approach || output.approach.trim() === '') {
          return { valid: false, reason: 'approach must be a non-empty string' };
        }
        if (!Array.isArray(output.files) || output.files.length === 0) {
          return { valid: false, reason: 'files must be a non-empty array' };
        }
        for (const file of output.files) {
          if (!file.path || file.path.trim() === '') {
            return { valid: false, reason: 'each file must have a non-empty path' };
          }
          if (file.action !== 'delete' && (!file.content || file.content.trim() === '')) {
            return { valid: false, reason: `file "${file.path}" has empty content` };
          }
        }
        if (!Array.isArray(output.dependencies)) {
          return { valid: false, reason: 'dependencies must be an array' };
        }
        return { valid: true };
      },
      maxAttempts: 3,
    });

    await longTermMemory.remember({
      projectId,
      workspaceId: projectId,
      agentRole: AgentRole.DEV,
      content: `Fixed bug "${bugReport.title}" (${bugReport.severity}) in ${bugReport.affectedFile}: ${result.approach}`,
    });

    return result;
  }

  async refactor(
    files: string[],
    feedback: string,
    context: {
      codebase: Record<string, string>;
      devSystemPrompt: string;
    },
    projectId: string,
  ): Promise<CodeOutput> {
    const targetFiles = Object.fromEntries(
      Object.entries(context.codebase).filter(([p]) => files.includes(p)),
    );
    const otherFiles = buildCodebaseContext(
      Object.fromEntries(Object.entries(context.codebase).filter(([p]) => !files.includes(p))),
    );

    const systemPrompt = `${context.devSystemPrompt}

You are refactoring specific files based on PM/Tester feedback. Only modify the specified target files. Do not break any interfaces used by other files in the codebase.

Output valid JSON:
{
  "approach": "<description of refactoring strategy>",
  "files": [
    {
      "path": "<file path>",
      "content": "<complete refactored file content>",
      "action": "modify"
    }
  ],
  "explanation": "<what changed and why>",
  "testInstructions": "<how to verify the refactored code still works>",
  "dependencies": []
}

Rules:
- Only return files that were actually changed
- Every returned file must have complete, non-empty content
- Do not modify files outside the target list unless absolutely required for compatibility`;

    const targetFilesContext = Object.entries(targetFiles)
      .map(
        ([path, content]) =>
          `### ${path}\n\`\`\`\n${content.length > MAX_FILE_CHARS ? content.substring(0, MAX_FILE_CHARS) + '\n... [truncated]' : content}\n\`\`\``,
      )
      .join('\n\n');

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Refactor the following files based on this feedback.

## Feedback
${feedback}

## Files to Refactor
${targetFilesContext}

## Other Codebase Files (do not break these)
${otherFiles}`,
        timestamp: new Date(),
      },
    ];

    return await this.callWithValidation<CodeOutput>({
      systemPrompt,
      messages,
      projectId,
      validate: (output) => {
        if (!output.approach || output.approach.trim() === '') {
          return { valid: false, reason: 'approach must be a non-empty string' };
        }
        if (!Array.isArray(output.files) || output.files.length === 0) {
          return { valid: false, reason: 'files must be a non-empty array' };
        }
        for (const file of output.files) {
          if (!file.path || file.path.trim() === '') {
            return { valid: false, reason: 'each file must have a non-empty path' };
          }
          if (!file.content || file.content.trim() === '') {
            return { valid: false, reason: `file "${file.path}" has empty content` };
          }
        }
        if (!Array.isArray(output.dependencies)) {
          return { valid: false, reason: 'dependencies must be an array' };
        }
        return { valid: true };
      },
      maxAttempts: 3,
    });
  }

  async fixCompileError(
    error: string,
    files: FileChange[],
    context: { devSystemPrompt: string },
    projectId: string,
  ): Promise<CodeOutput> {
    const systemPrompt = `${context.devSystemPrompt}

You are fixing a compile error. Return only the minimal set of files needed to fix the error.

Output valid JSON:
{
  "approach": "<which file(s) caused the error and why>",
  "files": [
    {
      "path": "<file path>",
      "content": "<complete corrected file content>",
      "action": "<create|modify>"
    }
  ],
  "explanation": "<technical explanation of the fix>",
  "testInstructions": "Rerun the compiler to verify the error is resolved.",
  "dependencies": []
}

Rules:
- Only include files that need to change to fix the compile error
- Every file must have complete, compilable content
- Do not introduce new compile errors while fixing this one`;

    const filesContext = files
      .map(
        (f) =>
          `### ${f.path}\n\`\`\`\n${f.content.length > MAX_FILE_CHARS ? f.content.substring(0, MAX_FILE_CHARS) + '\n... [truncated]' : f.content}\n\`\`\``,
      )
      .join('\n\n');

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Fix the following compile error.

## Compile Error
\`\`\`
${error}
\`\`\`

## Current Files
${filesContext}`,
        timestamp: new Date(),
      },
    ];

    return await this.callWithValidation<CodeOutput>({
      systemPrompt,
      messages,
      projectId,
      validate: (output) => {
        if (!output.approach || output.approach.trim() === '') {
          return { valid: false, reason: 'approach must be a non-empty string' };
        }
        if (!Array.isArray(output.files) || output.files.length === 0) {
          return {
            valid: false,
            reason: 'files must be a non-empty array — at least one file must be fixed',
          };
        }
        for (const file of output.files) {
          if (!file.path || file.path.trim() === '') {
            return { valid: false, reason: 'each file must have a non-empty path' };
          }
          if (!file.content || file.content.trim() === '') {
            return { valid: false, reason: `file "${file.path}" has empty content` };
          }
        }
        if (!Array.isArray(output.dependencies)) {
          return { valid: false, reason: 'dependencies must be an array' };
        }
        return { valid: true };
      },
      maxAttempts: 3,
    });
  }

  async respondToMention(text: string, project: ProjectState): Promise<string> {
    const pastMemory = await longTermMemory.recallForAgent({
      projectId: project.id,
      agentRole: AgentRole.DEV,
      query: text,
    });

    const completedTasks =
      project.sprint?.tasks.filter((t) => t.status === TaskStatus.DONE).length ?? 0;
    const totalTasks = project.sprint?.tasks.length ?? 0;
    const inProgressTasks =
      project.sprint?.tasks.filter((t) => t.status === TaskStatus.IN_PROGRESS) ?? [];

    const systemPrompt = `You are Swarmly's Dev Agent for the project "${project.name}".
You are being directly @mentioned in the project's Slack channel.

Project context:
- Phase: ${project.phase}
- Sprint Goal: ${project.sprint?.goal ?? 'Not started'}
- Tasks: ${completedTasks}/${totalTasks} done
- Currently working on: ${inProgressTasks.map((t) => t.title).join(', ') || 'Nothing in progress'}
- Codebase files: ${Object.keys(project.codebase ?? {}).length} files

${pastMemory ? `Relevant memory:\n${pastMemory}\n` : ''}

Respond helpfully as the Dev Agent. You can:
- Explain implementation decisions
- Describe what code was written
- Discuss technical blockers
- Suggest solutions to technical problems
- Clarify what files were changed

Keep your response under 200 words. Use plain text (Slack mrkdwn ok). Be technical and precise.`;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: text,
        timestamp: new Date(),
      },
    ];

    const output = await this.call({
      systemPrompt,
      messages,
      projectId: project.id,
      maxTokens: 512,
    });

    if (!output.success || !output.content.trim()) {
      throw new Error(`DEV respondToMention failed: ${output.error ?? 'empty response'}`);
    }

    return output.content.trim();
  }
}

export const devAgent = new DevAgent();
