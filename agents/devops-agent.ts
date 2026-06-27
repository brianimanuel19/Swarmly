import { AgentRole, Task, CodeOutput, FileChange, DetectedStack, ProjectState, ConversationHistory } from '../types/index.js';
import { BaseAgent } from './base-agent.js';
import { config } from '../config/config.js';

export class DevOpsAgent extends BaseAgent {
  constructor() {
    super(AgentRole.DEVOPS, config.anthropic.models.devops);
  }

  // ─── Generate infra config (Dockerfile, CI/CD, compose, etc.) ────────────

  async generateInfraConfig(params: {
    stack: DetectedStack;
    projectName: string;
    projectId: string;
  }): Promise<CodeOutput> {
    const { stack, projectName, projectId } = params;

    const systemPrompt = `You are a DevOps engineer. Generate production-ready infrastructure configuration for the given tech stack.

Generate as many of the following as are appropriate for the stack:
- Dockerfile (multi-stage where applicable)
- docker-compose.yml (with health checks)
- .github/workflows/ci.yml (lint + test + build)
- .github/workflows/deploy.yml (deploy on merge to main)
- nginx.conf (if it's a web app)
- .env.example (all required env vars with comments)

Rules:
- Use specific pinned versions (not "latest")
- Add health checks to docker-compose services
- CI pipeline must run tests before build
- Output as JSON matching the CodeOutput schema

CodeOutput schema:
{
  "approach": "string — brief infra strategy",
  "files": [{ "path": "string", "content": "string", "action": "create" }],
  "explanation": "string",
  "testInstructions": "string — how to verify infra works locally",
  "dependencies": []
}`;

    const stackDesc = `Stack: ${stack.primaryDomain}
Languages: ${stack.languages.join(', ')}
Frameworks: ${stack.frameworks.join(', ')}
Project: ${projectName}`;

    const messages: ConversationHistory = [
      { role: 'user', content: stackDesc, timestamp: new Date() },
    ];

    const output = await this.call({ systemPrompt, messages, projectId, maxTokens: 6144 });

    if (!output.success) {
      throw new Error(`DevOpsAgent.generateInfraConfig failed: ${output.error}`);
    }

    return this.parseJSON<CodeOutput>(output.content);
  }

  // ─── Implement a specific INFRA/DEVOPS task from the sprint ──────────────

  async implementTask(params: {
    task: Task;
    codebase: Record<string, string>;
    stackProfile: string;
    projectId: string;
  }): Promise<CodeOutput> {
    const { task, codebase, stackProfile, projectId } = params;

    const systemPrompt = `You are a DevOps engineer implementing an infrastructure task. Write production-ready configuration and scripts.

Output JSON matching CodeOutput schema:
{
  "approach": "string",
  "files": [{ "path": "string", "content": "string", "action": "create|modify|delete" }],
  "explanation": "string",
  "testInstructions": "string",
  "dependencies": ["string"]
}`;

    const existingFiles = Object.keys(codebase)
      .filter((f) => f.includes('docker') || f.includes('github') || f.includes('.yml') || f.includes('nginx'))
      .map((f) => `- ${f}`)
      .join('\n') || 'None';

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Task: ${task.title}\nDescription: ${task.description}\nAcceptance criteria:\n- ${task.acceptanceCriteria.join('\n- ')}\n\nStack: ${stackProfile}\n\nExisting infra files:\n${existingFiles}`,
        timestamp: new Date(),
      },
    ];

    const output = await this.call({ systemPrompt, messages, projectId, maxTokens: 4096 });

    if (!output.success) {
      throw new Error(`DevOpsAgent.implementTask failed: ${output.error}`);
    }

    return this.parseJSON<CodeOutput>(output.content);
  }

  // ─── Review CI/CD output and deployment readiness ─────────────────────────

  async reviewDeploymentReadiness(params: {
    codebase: Record<string, string>;
    projectState: ProjectState;
  }): Promise<{ ready: boolean; blockers: string[]; recommendations: string[] }> {
    const { codebase, projectState } = params;

    const systemPrompt = `You are a DevOps engineer doing a pre-deployment readiness check.

Check for:
- Dockerfile presence and correctness
- Environment variables documented in .env.example
- CI/CD pipeline configured
- Health check endpoints
- No hardcoded secrets

Respond with JSON:
{
  "ready": boolean,
  "blockers": ["critical issues that must be fixed before deploy"],
  "recommendations": ["non-blocking improvements"]
}`;

    const infraFiles = Object.entries(codebase)
      .filter(([path]) => path.includes('docker') || path.includes('.github') || path.includes('nginx') || path.includes('.env'))
      .map(([path, content]) => `### ${path}\n${content.slice(0, 1000)}`)
      .join('\n\n') || 'No infra files found.';

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Project: ${projectState.name}\nStack: ${projectState.stack.primaryDomain}\n\nInfra files:\n${infraFiles}`,
        timestamp: new Date(),
      },
    ];

    const output = await this.call({
      systemPrompt,
      messages,
      projectId: projectState.id,
      maxTokens: 1024,
    });

    if (!output.success) {
      return { ready: true, blockers: [], recommendations: ['DevOps review skipped (agent error)'] };
    }

    try {
      return this.parseJSON<{ ready: boolean; blockers: string[]; recommendations: string[] }>(output.content);
    } catch {
      return { ready: true, blockers: [], recommendations: [output.content] };
    }
  }
}

export const devOpsAgent = new DevOpsAgent();
