import { FileChange, DetectedStack, AgentRole } from '../types/index.js';
import { stateStore } from '../memory/state-store.js';

/**
 * SharedContextStore
 *
 * Provides a unified interface for reading and writing shared project context
 * (PRD, codebase, detected stack, decisions) used by all agents in the swarm.
 *
 * - In-memory cache: system prompts keyed by role + stack (avoids repeated
 *   prompt-building overhead per agent invocation).
 * - Persistence: all project-level data is delegated to stateStore (Postgres).
 */
export class SharedContextStore {
  /** Cache for built system prompts: key = `${role}::${stackKey}` */
  private systemPromptCache: Map<string, string> = new Map();

  // ---------------------------------------------------------------------------
  // PRD
  // ---------------------------------------------------------------------------

  /**
   * Persists the Product Requirements Document for a project.
   * @param projectId - Unique project ID
   * @param content   - Full PRD markdown text
   */
  async setPRD(projectId: string, content: string): Promise<void> {
    const project = await stateStore.loadProject(projectId);
    if (!project) {
      throw new Error(`SharedContextStore.setPRD: project ${projectId} not found`);
    }
    project.prd = content;
    project.updatedAt = new Date();
    await stateStore.saveProject(project);
  }

  /**
   * Retrieves the PRD for a project. Returns null if the project doesn't exist
   * or the PRD has not been written yet.
   * @param projectId - Unique project ID
   */
  async getPRD(projectId: string): Promise<string | null> {
    const project = await stateStore.loadProject(projectId);
    if (!project) return null;
    return project.prd || null;
  }

  // ---------------------------------------------------------------------------
  // Codebase
  // ---------------------------------------------------------------------------

  /**
   * Applies a list of file changes (create / modify / delete) to the persisted
   * codebase snapshot for the given project.
   * @param projectId - Unique project ID
   * @param files     - Array of FileChange objects describing what changed
   */
  async addFiles(projectId: string, files: FileChange[]): Promise<void> {
    await stateStore.updateCodebase(projectId, files);
  }

  /**
   * Returns the full codebase snapshot (path → content map) for a project.
   * Returns an empty object when the project or codebase doesn't exist.
   * @param projectId - Unique project ID
   */
  async getCodebase(projectId: string): Promise<Record<string, string>> {
    const project = await stateStore.loadProject(projectId);
    if (!project) return {};
    return project.codebase ?? {};
  }

  // ---------------------------------------------------------------------------
  // Stack
  // ---------------------------------------------------------------------------

  /**
   * Persists the detected technology stack for a project.
   * @param projectId - Unique project ID
   * @param stack     - DetectedStack value produced by the PM agent
   */
  async setStack(projectId: string, stack: DetectedStack): Promise<void> {
    const project = await stateStore.loadProject(projectId);
    if (!project) {
      throw new Error(`SharedContextStore.setStack: project ${projectId} not found`);
    }
    project.stack = stack;
    project.updatedAt = new Date();
    await stateStore.saveProject(project);
  }

  /**
   * Returns the detected stack for a project, or null if not yet set.
   * @param projectId - Unique project ID
   */
  async getStack(projectId: string): Promise<DetectedStack | null> {
    const project = await stateStore.loadProject(projectId);
    if (!project) return null;
    // stack is always present on a loaded project but may be an empty object
    const { domains } = project.stack ?? {};
    if (!domains || domains.length === 0) return null;
    return project.stack;
  }

  // ---------------------------------------------------------------------------
  // Decision Log
  // ---------------------------------------------------------------------------

  /**
   * Logs an agent decision for observability. The entry is written to the
   * console and — when the project can be loaded — appended to the PRD as a
   * decision audit trail section so it travels with the project state.
   *
   * @param projectId - Unique project ID
   * @param agent     - The AgentRole that made the decision
   * @param decision  - Short description of the decision taken
   * @param reasoning - Rationale behind the decision
   */
  async logDecision(
    projectId: string,
    agent: AgentRole,
    decision: string,
    reasoning: string,
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${agent}] ${decision} | Reasoning: ${reasoning}`;

    // Always emit to stdout for structured log aggregation
    console.log(`[SharedContextStore] Decision logged — ${logLine}`);

    // Best-effort persistence: append to project PRD as an audit section
    try {
      const project = await stateStore.loadProject(projectId);
      if (project) {
        const auditEntry = `\n\n---\n**Decision [${agent}] @ ${timestamp}**\n- **Decision:** ${decision}\n- **Reasoning:** ${reasoning}`;
        project.prd = (project.prd ?? '') + auditEntry;
        project.updatedAt = new Date();
        await stateStore.saveProject(project);
      }
    } catch (err) {
      // Non-fatal — decision was already logged to console
      console.warn(
        `[SharedContextStore] logDecision persistence skipped: ${(err as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // System Prompt Cache
  // ---------------------------------------------------------------------------

  /**
   * Returns a cached system prompt string, or null if not yet cached.
   * @param role     - The AgentRole this prompt was built for
   * @param stackKey - A stable string identifying the detected stack (e.g. "web_saas")
   */
  getCachedSystemPrompt(role: AgentRole, stackKey: string): string | null {
    const key = `${role}::${stackKey}`;
    return this.systemPromptCache.get(key) ?? null;
  }

  /**
   * Stores a built system prompt in the in-memory cache.
   * @param role     - The AgentRole this prompt was built for
   * @param stackKey - A stable string identifying the detected stack (e.g. "web_saas")
   * @param prompt   - The fully assembled system prompt string
   */
  setCachedSystemPrompt(role: AgentRole, stackKey: string, prompt: string): void {
    const key = `${role}::${stackKey}`;
    this.systemPromptCache.set(key, prompt);
  }
}

/** Singleton instance shared across the process. */
export const sharedContextStore = new SharedContextStore();
