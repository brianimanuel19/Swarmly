import {
  AgentRole,
  ConversationHistory,
  DetectedStack,
  Sprint,
  Task,
  TaskStatus,
  ProjectState,
  SampledRepo,
  RepoAnalysis,
} from '../types/index.js';
import { BaseAgent } from './base-agent.js';
import { stateStore } from '../memory/state-store.js';
import { longTermMemory } from '../memory/long-term-memory.js';
import { selectModel } from '../cost-control/model-router.js';
import { config } from '../config/config.js';

export class PMAgent extends BaseAgent {
  constructor() {
    super(AgentRole.PM, config.anthropic.models.pm);
  }

  async chatInLobby(
    message: string,
    history: ConversationHistory,
    workspaceId: string,
  ): Promise<{ type: 'REPLY' | 'READY_TO_RUN'; text: string }> {
    const lobbyModel = selectModel({ agent: AgentRole.PM, taskType: 'lobby' });
    const originalModel = this.model;
    // Temporarily swap model for lobby
    (this as unknown as { model: string }).model = lobbyModel;

    const systemPrompt = `You are Swarmly's PM Agent running in the project lobby. Your ONLY job is to gather requirements from the user, then hand off to the Swarmly pipeline which will automatically handle all code access, cloning, analysis, and development using sub-agents.

IMPORTANT — YOUR ROLE AND LIMITS:
- You are a requirements gatherer, NOT a developer or code reader.
- You CANNOT and should NOT access files, clone repos, or read code yourself.
- NEVER ask the user to clone a repo, share code, or set up their environment.
- NEVER ask about file paths, local machine state, or terminal commands.
- The Swarmly pipeline will handle all of that automatically after you signal READY_TO_RUN.

TWO TYPES OF REQUESTS:

1. NEW PROJECT — user wants to build something new:
   - Ask: project name, purpose, main features, target users.
   - Signal READY_TO_RUN when you have those 4 things.

2. EXISTING REPO IMPROVEMENT — user mentions an existing project or GitHub URL:
   - If no GitHub URL provided: ask for it (one question).
   - Accept any stated goal as valid: "analyze and suggest features", "add auth", "fix bugs", etc.
   - If user says "analyze my project and suggest features" → that IS a valid goal, accept it.
   - Do NOT ask for more detail than necessary. One GitHub URL + one goal = enough.
   - Signal READY_TO_RUN immediately once you have URL + goal.

LANGUAGE: Always reply in the same language the user used.

When ready, output this JSON on its own line (no other text after it):
{"signal":"READY_TO_RUN","summary":"<2-3 sentence summary of the request>"}

Otherwise reply naturally with ONE focused question.`;

    const messages = this.buildMessages(history, message);
    const output = await this.call({
      systemPrompt,
      messages,
      projectId: workspaceId,
      maxTokens: 1024,
    });

    // Restore model
    (this as unknown as { model: string }).model = originalModel;

    if (!output.success) {
      return { type: 'REPLY', text: 'Sorry, I encountered an error. Could you repeat that?' };
    }

    const content = output.content.trim();

    // Check for READY_TO_RUN signal in the response
    const jsonLineMatch = content.match(/\{"signal"\s*:\s*"READY_TO_RUN"[^}]*\}/);
    if (jsonLineMatch) {
      try {
        const parsed = JSON.parse(jsonLineMatch[0]) as { signal: string; summary: string };
        if (parsed.signal === 'READY_TO_RUN') {
          const summary = parsed.summary ?? 'I have enough information to get started.';
          return {
            type: 'READY_TO_RUN',
            text: `Great! I have enough info. Here's what I understand: ${summary} Ready to build?`,
          };
        }
      } catch {
        // fall through to REPLY
      }
    }

    return { type: 'REPLY', text: content };
  }

  async summarizeRequirement(history: ConversationHistory): Promise<string> {
    const systemPrompt = `You are Swarmly's PM Agent. Summarize a lobby conversation into a clear, structured project requirement.

Output a single paragraph in this format:
"Build a [type] application that [main purpose]. Key features: [comma-separated list]. Target users: [who]. Tech preferences: [any mentioned or 'None specified']."

Be concise and specific. Do not output JSON, just the summary paragraph.`;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Summarize the following conversation into a project requirement:\n\n${history
          .map((m) => `${m.role === 'user' ? 'User' : 'PM'}: ${m.content}`)
          .join('\n')}`,
        timestamp: new Date(),
      },
    ];

    const output = await this.call({
      systemPrompt,
      messages,
      projectId: 'summarize',
      maxTokens: 512,
    });

    if (!output.success || !output.content.trim()) {
      throw new Error(`PM summarizeRequirement failed: ${output.error ?? 'empty response'}`);
    }

    return output.content.trim();
  }

  async detectStack(requirement: string): Promise<DetectedStack> {
    const systemPrompt = `You are Swarmly's PM Agent. Detect the technology stack from a project requirement.

Output valid JSON matching this exact schema:
{
  "domains": ["<StackDomain values>"],
  "primaryDomain": "<single StackDomain value>",
  "languages": ["<programming language names>"],
  "frameworks": ["<framework names>"],
  "ambiguities": [
    { "question": "<clarifying question>", "options": ["<option1>", "<option2>"] }
  ],
  "confidence": <number 0.0-1.0>
}

Valid StackDomain values: web_saas, mobile_rn, mobile_flutter, blockchain_evm, blockchain_solana, iot_embedded, ai_ml, desktop, data_platform

Rules:
- Set confidence < 0.7 only if significant tech choices are ambiguous
- Add ambiguities entries for any unclear tech decisions when confidence < 0.7
- languages and frameworks must be non-empty arrays
- domains must contain at least one entry
- primaryDomain must be one of the domains entries`;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Detect the technology stack for this project requirement:\n\n${requirement}`,
        timestamp: new Date(),
      },
    ];

    return await this.callWithValidation<DetectedStack>({
      systemPrompt,
      messages,
      projectId: 'detect-stack',
      validate: (output) => {
        if (!output.domains || output.domains.length === 0) {
          return { valid: false, reason: 'domains array must be non-empty' };
        }
        if (!output.primaryDomain) {
          return { valid: false, reason: 'primaryDomain is required' };
        }
        if (!output.domains.includes(output.primaryDomain)) {
          return { valid: false, reason: 'primaryDomain must be one of the domains values' };
        }
        if (!output.languages || output.languages.length === 0) {
          return { valid: false, reason: 'languages array must be non-empty' };
        }
        if (!output.frameworks || output.frameworks.length === 0) {
          return { valid: false, reason: 'frameworks array must be non-empty' };
        }
        if (
          typeof output.confidence !== 'number' ||
          output.confidence < 0 ||
          output.confidence > 1
        ) {
          return { valid: false, reason: 'confidence must be a number between 0.0 and 1.0' };
        }
        if (!Array.isArray(output.ambiguities)) {
          return { valid: false, reason: 'ambiguities must be an array' };
        }
        return { valid: true };
      },
      maxAttempts: 3,
    });
  }

  async createPRD(requirement: string, stack: DetectedStack, projectId: string): Promise<string> {
    const pastMemory = await longTermMemory.recallForAgent({
      projectId,
      agentRole: AgentRole.PM,
      query: 'PRD product requirements document',
    });

    const systemPrompt = `You are Swarmly's PM Agent. Write a complete Product Requirements Document (PRD).

${pastMemory ? `Relevant past context:\n${pastMemory}\n` : ''}

Format the PRD exactly as follows (use real project name, not placeholder):

# [Project Name]

## Overview
[2-3 sentences describing the product, its purpose, and its value proposition]

## User Stories
- As a [user type], I want to [action] so that [benefit]
  - Acceptance Criteria:
    - [testable condition 1]
    - [testable condition 2]
    - [testable condition 3]
(Include at least 5 user stories, each with 2-4 acceptance criteria)

## Technical Constraints
- [constraint 1]
- [constraint 2]
(List tech stack, platform requirements, performance targets)

## Out of Scope
- [item 1]
- [item 2]
(List features explicitly excluded from this sprint)

## Success Metrics
- [metric 1]
- [metric 2]
(List 3-5 measurable success criteria)

Write every section fully. No placeholders or TODOs.`;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Create a full PRD for:\n\nRequirement: ${requirement}\n\nDetected Stack:\n- Primary Domain: ${stack.primaryDomain}\n- Languages: ${stack.languages.join(', ')}\n- Frameworks: ${stack.frameworks.join(', ')}`,
        timestamp: new Date(),
      },
    ];

    const output = await this.call({
      systemPrompt,
      messages,
      projectId,
      maxTokens: 4096,
      useCache: true,
    });

    if (!output.success || !output.content.trim()) {
      throw new Error(`PM createPRD failed: ${output.error ?? 'empty response'}`);
    }

    const prd = output.content.trim();

    // Persist PRD to state store and long-term memory
    await stateStore.saveProject({
      id: projectId,
      prd,
    } as unknown as import('../types/index.js').ProjectState);

    await longTermMemory.remember({
      projectId,
      workspaceId: projectId,
      agentRole: AgentRole.PM,
      content: `PRD created: ${prd.substring(0, 500)}`,
    });

    return prd;
  }

  async createSprintPlan(prd: string, projectId: string): Promise<Sprint> {
    const systemPrompt = `You are Swarmly's PM Agent. Break down a PRD into a sprint plan with granular tasks.

Output valid JSON matching this exact schema:
{
  "id": "<uuid string>",
  "goal": "<one-sentence sprint goal>",
  "tasks": [
    {
      "id": "<uuid string>",
      "jiraId": "",
      "title": "<task title>",
      "description": "<detailed description of what to implement>",
      "type": "<BE|FE|TEST|INFRA|DESIGN>",
      "status": "TODO",
      "assignee": "<PM|DEV|TESTER>",
      "priority": "<HIGH|MEDIUM|LOW>",
      "estimateHours": <number 2-4>,
      "acceptanceCriteria": ["<testable condition>", "<testable condition>"],
      "dependsOn": ["<task id of dependency>"],
      "attempts": 0
    }
  ],
  "startDate": "<ISO date string>",
  "endDate": "<ISO date string 2 weeks from startDate>"
}

Rules:
- Every task estimateHours must be between 2 and 4 (inclusive)
- Every task must have at least 2 acceptanceCriteria
- Order tasks by dependencies (tasks with no dependsOn first)
- dependsOn must reference IDs of other tasks in the same sprint
- INFRA/DESIGN tasks come before BE tasks; BE tasks come before FE tasks; TEST tasks come last
- Use realistic UUIDs (e.g., "task-001", "task-002", etc.)
- Include at least 6 tasks covering infrastructure, backend, frontend, and testing`;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Create a sprint plan for the following PRD:\n\n${prd}`,
        timestamp: new Date(),
      },
    ];

    const sprint = await this.callWithValidation<Sprint>({
      systemPrompt,
      messages,
      projectId,
      validate: (output) => {
        if (!output.id || typeof output.id !== 'string') {
          return { valid: false, reason: 'sprint id is required' };
        }
        if (!output.goal || typeof output.goal !== 'string') {
          return { valid: false, reason: 'sprint goal is required' };
        }
        if (!Array.isArray(output.tasks) || output.tasks.length < 1) {
          return { valid: false, reason: 'tasks must be a non-empty array' };
        }
        for (const task of output.tasks) {
          if (
            typeof task.estimateHours !== 'number' ||
            task.estimateHours < 2 ||
            task.estimateHours > 4
          ) {
            return {
              valid: false,
              reason: `Task "${task.title}" estimateHours must be between 2 and 4`,
            };
          }
          if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length < 2) {
            return {
              valid: false,
              reason: `Task "${task.title}" must have at least 2 acceptanceCriteria`,
            };
          }
          if (!['BE', 'FE', 'TEST', 'INFRA', 'DESIGN'].includes(task.type)) {
            return { valid: false, reason: `Task "${task.title}" has invalid type "${task.type}"` };
          }
          if (!['PM', 'DEV', 'TESTER'].includes(task.assignee)) {
            return {
              valid: false,
              reason: `Task "${task.title}" has invalid assignee "${task.assignee}"`,
            };
          }
          if (!Array.isArray(task.dependsOn)) {
            return { valid: false, reason: `Task "${task.title}" dependsOn must be an array` };
          }
        }
        return { valid: true };
      },
      maxAttempts: 3,
    });

    // Normalize task statuses to TaskStatus enum values
    sprint.tasks = sprint.tasks.map((task) => ({
      ...task,
      status: TaskStatus.TODO,
      attempts: 0,
      jiraId: task.jiraId ?? '',
    }));

    // Persist sprint
    await stateStore.updateSprint(projectId, sprint);

    return sprint;
  }

  async reviewOutput(
    taskId: string,
    output: string,
    prd: string,
  ): Promise<{ approved: boolean; feedback: string; specificIssues: string[] }> {
    const systemPrompt = `You are Swarmly's PM Agent. Review developer output against the PRD acceptance criteria.

Output valid JSON:
{
  "approved": <true|false>,
  "feedback": "<brief positive confirmation if approved, or specific actionable feedback if not>",
  "specificIssues": ["<issue 1>", "<issue 2>"]
}

Rules:
- approved: true only if the output clearly satisfies all relevant acceptance criteria
- If approved: feedback should be a brief positive confirmation (1 sentence), specificIssues should be []
- If not approved: feedback must be specific and actionable (developer must be able to act on it)
- specificIssues: list each individual criterion that is not met (empty array if approved)
- Do not approve output that is clearly incomplete or missing required functionality`;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Review the following output for task ${taskId} against the PRD.

PRD:
${prd}

Developer Output:
${output}`,
        timestamp: new Date(),
      },
    ];

    return await this.callWithValidation<{
      approved: boolean;
      feedback: string;
      specificIssues: string[];
    }>({
      systemPrompt,
      messages,
      projectId: taskId,
      validate: (result) => {
        if (typeof result.approved !== 'boolean') {
          return { valid: false, reason: 'approved must be a boolean' };
        }
        if (typeof result.feedback !== 'string' || result.feedback.trim() === '') {
          return { valid: false, reason: 'feedback must be a non-empty string' };
        }
        if (!Array.isArray(result.specificIssues)) {
          return { valid: false, reason: 'specificIssues must be an array' };
        }
        return { valid: true };
      },
      maxAttempts: 3,
    });
  }

  async generateStatusReport(project: ProjectState): Promise<string> {
    const systemPrompt = `You are Swarmly's PM Agent. Generate a concise Slack status update for a software project.

Write a human-readable Slack message (use Slack mrkdwn formatting: *bold*, _italic_, bullet points with •).
Include:
- Current phase and what it means
- Progress (tasks done vs total, percentages)
- Budget used so far (USD and token counts)
- What's next

Keep it under 400 words. Be upbeat and informative. No code blocks needed.`;

    const completedTasks =
      project.sprint?.tasks.filter((t) => t.status === TaskStatus.DONE).length ?? 0;
    const totalTasks = project.sprint?.tasks.length ?? 0;
    const progressPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Generate a Slack status report for this project:

Project: ${project.name}
Phase: ${project.phase}
Sprint Goal: ${project.sprint?.goal ?? 'Not set'}
Tasks: ${completedTasks}/${totalTasks} done (${progressPct}%)
Budget Used: $${project.budget?.usedUsd?.toFixed(4) ?? '0.0000'} / $${project.budget?.allocatedUsd?.toFixed(2) ?? '0.00'} allocated
Tokens Used: ${project.budget?.usedTokens?.toLocaleString() ?? 0} / ${project.budget?.allocatedTokens?.toLocaleString() ?? 0}
Over Budget: ${project.budget?.isOverBudget ? 'YES' : 'No'}
Approaching Limit: ${project.budget?.isApproachingLimit ? 'YES' : 'No'}`,
        timestamp: new Date(),
      },
    ];

    const output = await this.call({
      systemPrompt,
      messages,
      projectId: project.id,
      maxTokens: 1024,
    });

    if (!output.success || !output.content.trim()) {
      throw new Error(`PM generateStatusReport failed: ${output.error ?? 'empty response'}`);
    }

    return output.content.trim();
  }

  async generatePRDescription(sprint: Sprint): Promise<string> {
    const systemPrompt = `You are Swarmly's PM Agent. Generate a GitHub Pull Request description for a completed sprint.

Format:
## Sprint Goal
[one sentence sprint goal]

## Completed Tasks
- [task title] — [brief what was done]
(list all completed tasks)

## Changes Made
[bullet list of key code changes and new files]

## Testing Done
- [ ] [test type and what was verified]
- [ ] [another test]
(checklist of testing completed)

## Notes for Reviewer
[any context needed for code review]

Be specific and technical. No placeholders.`;

    const completedTasks = sprint.tasks.filter((t) => t.status === TaskStatus.DONE);
    const allTasks = sprint.tasks;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Generate a GitHub PR description for this sprint:

Sprint Goal: ${sprint.goal}
Sprint ID: ${sprint.id}

All Tasks (${allTasks.length} total, ${completedTasks.length} done):
${allTasks.map((t) => `- [${t.status}] ${t.title} (${t.type}, ${t.estimateHours}h)`).join('\n')}`,
        timestamp: new Date(),
      },
    ];

    const output = await this.call({
      systemPrompt,
      messages,
      projectId: sprint.id,
      maxTokens: 1024,
    });

    if (!output.success || !output.content.trim()) {
      throw new Error(`PM generatePRDescription failed: ${output.error ?? 'empty response'}`);
    }

    return output.content.trim();
  }

  async respondToMention(text: string, project: ProjectState): Promise<string> {
    const pastMemory = await longTermMemory.recallForAgent({
      projectId: project.id,
      agentRole: AgentRole.PM,
      query: text,
    });

    const systemPrompt = `You are Swarmly's PM Agent for the project "${project.name}".
You are being directly @mentioned in the project's Slack channel.

Project context:
- Phase: ${project.phase}
- Sprint Goal: ${project.sprint?.goal ?? 'Not started'}
- Tasks: ${project.sprint?.tasks.filter((t) => t.status === TaskStatus.DONE).length ?? 0}/${project.sprint?.tasks.length ?? 0} done

${pastMemory ? `Relevant memory:\n${pastMemory}\n` : ''}

Respond helpfully and concisely as the PM Agent. You can:
- Provide status updates
- Clarify requirements or acceptance criteria
- Explain project decisions
- Escalate blockers
- Adjust priorities if asked

Keep your response under 200 words. Use plain text (Slack mrkdwn ok).`;

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
      throw new Error(`PM respondToMention failed: ${output.error ?? 'empty response'}`);
    }

    return output.content.trim();
  }

  // ─── Chunked repo analysis — progressive spec building ───────────────────

  async analyzeRepoChunk(params: {
    chunkFiles: Array<{ path: string; content: string }>;
    existingSpec: string;
    chunkIndex: number;
    totalChunks: number;
    fileTree: string[];
    userIntent: string;
    projectId: string;
  }): Promise<string> {
    const { chunkFiles, existingSpec, chunkIndex, totalChunks, fileTree, userIntent, projectId } = params;

    const isFirst = chunkIndex === 1;
    const filesSummary = chunkFiles
      .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
      .join('\n\n');

    const systemPrompt = `You are a senior software architect performing a progressive codebase audit.

You receive the repo in chunks. After each chunk, you update a running Markdown spec document.

Rules:
- NEVER remove existing findings — only add or refine
- Keep the spec concise but complete; summarize repetitive patterns rather than listing every file
- Sections to maintain:
  ## Architecture Overview
  ## Tech Stack
  ## Key Modules (one bullet per significant module/directory)
  ## Technical Debt (severity: CRITICAL/HIGH/MEDIUM/LOW)
  ## Security Concerns (severity: CRITICAL/HIGH/MEDIUM/LOW)
  ## Improvement Areas (priority: MUST/SHOULD/COULD/WONT, estimate hours)
- If the spec grows beyond 8,000 words, compress older sections while keeping all findings
- Output ONLY the updated spec markdown — no commentary`;

    const userContent = isFirst
      ? `User's improvement goals: ${userIntent || 'General code quality improvement'}

Full file tree (${fileTree.length} files total, processing in ${totalChunks} chunk(s)):
${fileTree.slice(0, 200).join('\n')}

--- CHUNK ${chunkIndex}/${totalChunks} ---
${filesSummary}

Write the initial spec document based on this first chunk.`
      : `User's improvement goals: ${userIntent || 'General code quality improvement'}

--- CURRENT SPEC (update this, do not lose findings) ---
${existingSpec}

--- CHUNK ${chunkIndex}/${totalChunks} — new files to analyze ---
${filesSummary}

Update the spec with findings from this chunk.`;

    const messages: ConversationHistory = [
      { role: 'user', content: userContent, timestamp: new Date() },
    ];

    const output = await this.call({ systemPrompt, messages, projectId, maxTokens: 8192 });

    if (!output.success) {
      console.warn(`[PMAgent] analyzeRepoChunk ${chunkIndex}/${totalChunks} failed — keeping existing spec`);
      return existingSpec;
    }

    return output.content;
  }

  async finalizeRepoSpec(params: {
    spec: string;
    repoUrl: string;
    repoName: string;
    fileCount: number;
    projectId: string;
  }): Promise<RepoAnalysis> {
    const { spec, repoUrl, repoName, fileCount, projectId } = params;

    const systemPrompt = `You are converting a Markdown analysis spec into structured JSON.

Extract all findings from the spec and return a JSON object matching this exact schema:
{
  "repoUrl": string,
  "repoName": string,
  "detectedStack": string[],
  "existingFeatures": string[],
  "technicalDebt": [{ "severity": "CRITICAL|HIGH|MEDIUM|LOW", "description": string, "file"?: string }],
  "securityConcerns": [{ "severity": "CRITICAL|HIGH|MEDIUM|LOW", "description": string, "file"?: string }],
  "improvementAreas": [{ "title": string, "priority": "MUST|SHOULD|COULD|WONT", "estimateHours": number, "description": string }],
  "summary": string,
  "fileCount": number,
  "sampledFiles": []
}

Return ONLY the JSON object — no markdown, no commentary.`;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Convert this spec to JSON. repoUrl="${repoUrl}", repoName="${repoName}", fileCount=${fileCount}.\n\nSpec:\n${spec}`,
        timestamp: new Date(),
      },
    ];

    const output = await this.call({ systemPrompt, messages, projectId, maxTokens: 4096 });

    if (!output.success) throw new Error(`PMAgent.finalizeRepoSpec failed: ${output.error}`);

    try {
      return this.parseJSON<RepoAnalysis>(output.content);
    } catch {
      throw new Error('PMAgent.finalizeRepoSpec: failed to parse JSON');
    }
  }

  // ─── Analyze an existing repo ─────────────────────────────────────────────

  async analyzeRepo(params: {
    sampledRepo: SampledRepo;
    userIntent: string;
    projectId: string;
  }): Promise<RepoAnalysis> {
    const { sampledRepo, userIntent, projectId } = params;

    const filesSummary = sampledRepo.sampledFiles
      .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 1500)}\n\`\`\``)
      .join('\n\n');

    const treeStr = sampledRepo.fileTree.slice(0, 80).join('\n');

    const systemPrompt = `You are a senior software architect and PM performing a codebase audit.

Analyze the provided code files and return a JSON object with this exact schema:
{
  "repoUrl": "<string>",
  "repoName": "<owner/repo>",
  "detectedStack": ["<language/framework names>"],
  "existingFeatures": ["<feature description>"],
  "technicalDebt": [{ "severity": "CRITICAL|HIGH|MEDIUM|LOW", "description": "<issue>", "file": "<optional path>" }],
  "securityConcerns": [{ "severity": "CRITICAL|HIGH|MEDIUM|LOW", "description": "<concern>", "file": "<optional path>" }],
  "improvementAreas": [{ "title": "<area>", "priority": "MUST|SHOULD|COULD|WONT", "estimateHours": <number>, "description": "<detail>" }],
  "summary": "<2-3 sentence executive summary>",
  "fileCount": <number>,
  "sampledFiles": ["<relative paths of files analyzed>"]
}

Be specific and actionable. Focus on the user's stated intent when prioritising improvements.`;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `User's improvement goals: ${userIntent || 'General code quality and best practices improvement'}

Total files in repo: ${sampledRepo.fileCount}
Files analyzed: ${sampledRepo.sampledFiles.length}

File tree (top 80):
${treeStr}

---
Sampled file contents:
${filesSummary}`,
        timestamp: new Date(),
      },
    ];

    const output = await this.call({ systemPrompt, messages, projectId, maxTokens: 4096 });

    if (!output.success) {
      throw new Error(`PMAgent.analyzeRepo failed: ${output.error ?? 'unknown'}`);
    }

    try {
      return this.parseJSON<RepoAnalysis>(output.content);
    } catch {
      throw new Error(`PMAgent.analyzeRepo: failed to parse JSON response`);
    }
  }
}

export const pmAgent = new PMAgent();
