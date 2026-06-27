import type { Sprint, Task, TaskStatus, BugReport } from '../types/index.js';
import { config } from '../config/config.js';

// ─── Jira status → transition name mapping ────────────────────────────────────

const STATUS_TRANSITION_NAMES: Record<TaskStatus, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  DONE: 'Done',
  BLOCKED: 'Blocked',
};

// ─── Jira REST response shapes (minimal) ─────────────────────────────────────

interface JiraTransition {
  id: string;
  name: string;
}

interface JiraTransitionsResponse {
  transitions: JiraTransition[];
}

interface JiraCreateIssueResponse {
  id: string;
  key: string;
  self: string;
}

interface JiraCreateSprintResponse {
  id: number;
  self: string;
  state: string;
  name: string;
}

interface JiraCreateProjectResponse {
  id: string;
  key: string;
  self: string;
}

// ─── Class ────────────────────────────────────────────────────────────────────

export class JiraIntegration {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly apiToken: string;
  private readonly projectKey: string; // fallback; '' when no default configured

  constructor() {
    this.baseUrl = config.jira.baseUrl.replace(/\/$/, ''); // strip trailing slash
    this.email = config.jira.email;
    this.apiToken = config.jira.apiToken;
    this.projectKey = config.jira.projectKey ?? '';
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  private authHeader(): string {
    const encoded = Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');
    return `Basic ${encoded}`;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Jira API error [${method} ${path}] ${response.status}: ${errorText}`);
    }

    // 204 No Content — nothing to parse
    if (response.status === 204) {
      return undefined as unknown as T;
    }

    return response.json() as Promise<T>;
  }

  // ─── Project ──────────────────────────────────────────────────────────────

  /**
   * Auto-generate a valid Jira project key from a human-readable name.
   * Jira keys: 2–10 uppercase letters only.
   * e.g. "Task Management App" → "TASKAPP", "E-Commerce Platform" → "ECOMMPL"
   */
  private generateProjectKey(name: string): string {
    const words = name
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    // Take first 2 chars of each word, join, uppercase, max 8 chars
    const raw = words
      .map((w) => w.slice(0, 2))
      .join('')
      .toUpperCase();
    const key = raw.replace(/[^A-Z]/g, '').slice(0, 8);

    // Jira requires at least 2 chars
    return key.length >= 2 ? key : key.padEnd(2, 'X');
  }

  /**
   * Check whether a project key is already in use.
   */
  private async isProjectKeyAvailable(key: string): Promise<boolean> {
    try {
      await this.request<unknown>('GET', `/rest/api/3/project/${key}`);
      return false; // project exists → key taken
    } catch {
      return true; // 404 → key available
    }
  }

  /**
   * Create a new Jira project for a Swarmly project and return the project key.
   * The key is auto-derived from the project name and made unique if needed.
   */
  async createProject(params: { name: string; description?: string }): Promise<string> {
    // Derive a unique key
    let key = this.generateProjectKey(params.name);
    let attempt = 0;
    while (!(await this.isProjectKeyAvailable(key))) {
      attempt++;
      const suffix = String(attempt);
      key = this.generateProjectKey(params.name).slice(0, 8 - suffix.length) + suffix;
    }

    const payload = {
      key,
      name: params.name.slice(0, 80),
      description: (params.description ?? '').slice(0, 500),
      projectTypeKey: 'software',
      projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-scrum-template',
      assigneeType: 'UNASSIGNED',
    };

    const result = await this.request<JiraCreateProjectResponse>(
      'POST',
      '/rest/api/3/project',
      payload,
    );

    return result.key;
  }

  // ─── Sprint ───────────────────────────────────────────────────────────────

  /**
   * Create a Jira Agile sprint and return the numeric sprint ID as a string.
   * boardId defaults to the first board found for projectKey if omitted.
   */
  async createSprint(sprint: Sprint, boardId?: number, projectKey?: string): Promise<string> {
    const resolvedBoardId = boardId ?? (await this.getDefaultBoardId(projectKey));

    const payload = {
      name: `Sprint — ${sprint.goal}`.slice(0, 255),
      startDate: sprint.startDate.toISOString(),
      endDate: sprint.endDate.toISOString(),
      originBoardId: resolvedBoardId,
      goal: sprint.goal.slice(0, 500),
    };

    const result = await this.request<JiraCreateSprintResponse>(
      'POST',
      '/rest/agile/1.0/sprint',
      payload,
    );

    return String(result.id);
  }

  private async getDefaultBoardId(projectKey?: string): Promise<number> {
    const key = projectKey ?? this.projectKey;
    if (!key)
      throw new Error('No Jira project key available — pass projectKey or set JIRA_PROJECT_KEY');
    const result = await this.request<{ values: Array<{ id: number }> }>(
      'GET',
      `/rest/agile/1.0/board?projectKeyOrId=${key}&maxResults=1`,
    );
    if (!result.values || result.values.length === 0) {
      throw new Error(`No Jira board found for project key "${key}"`);
    }
    const board = result.values[0];
    if (!board) throw new Error(`No Jira board found for project key "${key}"`);
    return board.id;
  }

  /**
   * Close (complete) a Jira sprint.
   */
  async closeSprint(sprintId: string, completeDate?: string): Promise<void> {
    await this.request<void>('POST', `/rest/agile/1.0/sprint/${sprintId}`, {
      state: 'closed',
      completeDate: completeDate ?? new Date().toISOString(),
    });
  }

  // ─── Issues ───────────────────────────────────────────────────────────────

  /**
   * Create a Jira issue for a Task, add it to the sprint, and return the Jira
   * issue key (e.g. "PROJ-42").
   */
  async createTask(task: Task, sprintId: string, projectKey?: string): Promise<string> {
    const resolvedProject = projectKey ?? this.projectKey;
    const priorityMap: Record<Task['priority'], string> = {
      HIGH: 'High',
      MEDIUM: 'Medium',
      LOW: 'Low',
    };

    const issueTypeMap: Record<Task['type'], string> = {
      BE: 'Task',
      FE: 'Task',
      TEST: 'Task',
      INFRA: 'Task',
      DESIGN: 'Task',
    };

    const acceptanceCriteriaText =
      task.acceptanceCriteria.length > 0
        ? `*Acceptance Criteria:*\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`
        : '';

    const descriptionAdf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: task.description }],
        },
        ...(acceptanceCriteriaText
          ? [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: acceptanceCriteriaText }],
              },
            ]
          : []),
      ],
    };

    const payload = {
      fields: {
        project: { key: resolvedProject },
        summary: task.title.slice(0, 255),
        description: descriptionAdf,
        issuetype: { name: issueTypeMap[task.type] },
        priority: { name: priorityMap[task.priority] },
        customfield_10020: Number(sprintId), // Sprint field (Jira Software)
        assignee: null, // Agents don't have Jira accounts; leave unassigned
        labels: [`swarmly`, `agent-${task.assignee.toLowerCase()}`, task.type.toLowerCase()],
        story_points: task.estimateHours, // may be ignored without the right field config
      },
    };

    const result = await this.request<JiraCreateIssueResponse>(
      'POST',
      '/rest/api/3/issue',
      payload,
    );

    return result.key;
  }

  /**
   * Create a Jira Bug issue and return its key.
   */
  async createBug(bug: BugReport, projectId?: string): Promise<string> {
    const resolvedProject = projectId ?? this.projectKey;

    const stepsText = bug.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');

    const descriptionAdf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: `*Steps to Reproduce:*\n${stepsText}` }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: `*Expected:* ${bug.expected}\n*Actual:* ${bug.actual}` }],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: `*Affected File:* \`${bug.affectedFile}\`\n*Suggested Fix:* ${bug.suggestedFix}`,
            },
          ],
        },
      ],
    };

    const priorityMap: Record<BugReport['severity'], string> = {
      CRITICAL: 'Highest',
      HIGH: 'High',
      MEDIUM: 'Medium',
      LOW: 'Low',
    };

    const payload = {
      fields: {
        project: { key: resolvedProject },
        summary: `[Bug] ${bug.title}`.slice(0, 255),
        description: descriptionAdf,
        issuetype: { name: 'Bug' },
        priority: { name: priorityMap[bug.severity] },
        labels: ['swarmly', 'automated-bug', bug.severity.toLowerCase()],
      },
    };

    const result = await this.request<JiraCreateIssueResponse>(
      'POST',
      '/rest/api/3/issue',
      payload,
    );

    return result.key;
  }

  // ─── Transitions ──────────────────────────────────────────────────────────

  /**
   * Retrieve all available transitions for a given issue key.
   */
  async getTransitions(jiraId: string): Promise<Array<{ id: string; name: string }>> {
    const result = await this.request<JiraTransitionsResponse>(
      'GET',
      `/rest/api/3/issue/${jiraId}/transitions`,
    );
    return result.transitions.map(({ id, name }) => ({ id, name }));
  }

  /**
   * Move a Jira issue to the transition that matches the desired TaskStatus.
   */
  async updateTaskStatus(jiraId: string, status: TaskStatus): Promise<void> {
    const targetName = STATUS_TRANSITION_NAMES[status];
    const transitions = await this.getTransitions(jiraId);

    // Find a transition whose name contains the target (case-insensitive)
    const transition = transitions.find((t) =>
      t.name.toLowerCase().includes(targetName.toLowerCase()),
    );

    if (!transition) {
      const available = transitions.map((t) => t.name).join(', ');
      throw new Error(
        `No Jira transition matching "${targetName}" for ${jiraId}. Available: ${available}`,
      );
    }

    await this.request<void>('POST', `/rest/api/3/issue/${jiraId}/transitions`, {
      transition: { id: transition.id },
    });
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const jiraIntegration = new JiraIntegration();
