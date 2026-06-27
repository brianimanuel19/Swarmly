import {
  AgentRole,
  ConversationHistory,
  DetectedStack,
  Sprint,
  Task,
  TaskStatus,
  ProjectState,
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
    // Temporarily swap model for lobby (Haiku)
    (this as unknown as { model: string }).model = lobbyModel;

    const systemPrompt = `You are Swarmly's PM Agent. Chat with users to understand their project. When you have enough info (name, purpose, main features, target users), respond with READY_TO_RUN signal. Otherwise ask clarifying questions one at a time. Be friendly and professional.

When you have gathered enough information, output a JSON object on its own line:
{"signal":"READY_TO_RUN","summary":"<2-3 sentence summary of what you understand>"}

Otherwise just respond naturally with your next clarifying question or acknowledgement.`;

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
}

export const pmAgent = new PMAgent();
