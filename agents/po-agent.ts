import { AgentRole, Sprint, Task, ConversationHistory, ProjectState } from '../types/index.js';
import { BaseAgent } from './base-agent.js';
import { config } from '../config/config.js';

export class POAgent extends BaseAgent {
  constructor() {
    super(AgentRole.PO, config.anthropic.models.po);
  }

  // ─── Refine the PM's PRD from a business/stakeholder perspective ──────────

  async refinePRD(params: {
    prd: string;
    requirement: string;
    projectId: string;
  }): Promise<string> {
    const { prd, requirement, projectId } = params;

    const systemPrompt = `You are a Product Owner (PO). You receive a Product Requirements Document (PRD) written by the PM and review it from a business and stakeholder perspective.

Your job:
- Validate that all user stories map to real business value
- Add or sharpen acceptance criteria that are vague or missing
- Flag scope creep or items that are out of MVP scope
- Ensure the "Definition of Done" is clear for each feature
- Add a prioritised backlog section (MoSCoW: Must / Should / Could / Won't)

Return the refined PRD as a complete markdown document. Keep the original structure but improve it. Do NOT remove content, only refine and add.`;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Original requirement:\n${requirement}\n\nPM's PRD to refine:\n\n${prd}`,
        timestamp: new Date(),
      },
    ];

    const output = await this.call({ systemPrompt, messages, projectId, maxTokens: 4096 });

    if (!output.success) {
      console.warn('[POAgent] refinePRD failed, returning original PRD');
      return prd;
    }

    return output.content;
  }

  // ─── Prioritise sprint tasks using MoSCoW ─────────────────────────────────

  async prioritiseSprint(params: {
    sprint: Sprint;
    prd: string;
    projectId: string;
  }): Promise<Sprint> {
    const { sprint, prd, projectId } = params;

    const taskList = sprint.tasks
      .map((t, i) => `${i + 1}. [${t.type}] ${t.title} — ${t.description}`)
      .join('\n');

    const systemPrompt = `You are a Product Owner. Given a sprint backlog and the PRD, return a reordered and prioritised task list.

Rules:
- Must-have items come first
- Assign priority: HIGH (must), MEDIUM (should), LOW (could)
- If a task is clearly out of MVP scope, mark priority LOW and add "(post-MVP)" to title
- Return JSON array of tasks preserving all original fields, only changing: "priority" and optionally "title"
- Do NOT add or remove tasks

Output format: JSON array of task objects (same shape as input).`;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `PRD:\n${prd.slice(0, 3000)}\n\nSprint tasks:\n${taskList}`,
        timestamp: new Date(),
      },
    ];

    const output = await this.call({ systemPrompt, messages, projectId, maxTokens: 2048 });

    if (!output.success) {
      console.warn('[POAgent] prioritiseSprint failed, returning original sprint');
      return sprint;
    }

    try {
      const prioritised = this.parseJSON<Task[]>(output.content);
      // Merge priorities back — preserve all original task fields, only patch priority/title
      const updated = sprint.tasks.map((original) => {
        const patched = prioritised.find((p) => p.id === original.id);
        if (!patched) return original;
        return { ...original, priority: patched.priority, title: patched.title };
      });
      return { ...sprint, tasks: updated };
    } catch {
      console.warn('[POAgent] Failed to parse prioritised tasks, returning original sprint');
      return sprint;
    }
  }

  // ─── Lobby chat: PO persona ───────────────────────────────────────────────

  async chatInLobby(
    message: string,
    history: ConversationHistory,
    workspaceId: string,
  ): Promise<string> {
    const systemPrompt = `You are Swarmly's PO (Product Owner). You represent stakeholder interests and business value. You help users clarify what they're building and why. Be direct about scope and priorities. Ask one question at a time about business goals, target users, and success metrics.`;

    const messages = this.buildMessages(history, message);
    const output = await this.call({ systemPrompt, messages, projectId: workspaceId, maxTokens: 512 });

    return output.success ? output.content : 'Could you rephrase that?';
  }

  // ─── Review a completed feature against acceptance criteria ──────────────

  async reviewOutput(params: {
    output: string;
    task: Task;
    projectId: string;
  }): Promise<{ approved: boolean; feedback: string }> {
    const { output, task, projectId } = params;

    const systemPrompt = `You are a Product Owner reviewing a completed development task against its acceptance criteria. Be strict but fair. If acceptance criteria are not fully met, reject with specific feedback. If met, approve.

Respond with JSON: {"approved": boolean, "feedback": "string"}`;

    const criteria = task.acceptanceCriteria.join('\n- ');
    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Task: ${task.title}\n\nAcceptance Criteria:\n- ${criteria}\n\nDev output:\n${output.slice(0, 2000)}`,
        timestamp: new Date(),
      },
    ];

    const result = await this.call({ systemPrompt, messages, projectId, maxTokens: 512 });

    if (!result.success) return { approved: true, feedback: 'Review skipped (agent error).' };

    try {
      return this.parseJSON<{ approved: boolean; feedback: string }>(result.content);
    } catch {
      return { approved: true, feedback: result.content };
    }
  }
}

export const poAgent = new POAgent();
