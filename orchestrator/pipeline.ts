import {
  ProjectState,
  ProjectPhase,
  TaskStatus,
  Task,
  BugReport,
  FileChange,
  CodeOutput,
  TestOutput,
  TestPlan,
  AgentRole,
  RepoAnalysis,
} from '../types/index.js';
import { stateStore } from '../memory/state-store.js';
import { sandboxManager } from '../sandbox/sandbox-manager.js';
import { executor } from '../sandbox/executor.js';
import { contextLoader } from './context-loader.js';
import { stackDetector } from './stack-detector.js';
import { humanCheckpoint } from './human-checkpoint.js';
import { githubIntegration } from '../integrations/github.js';
import { jiraIntegration } from '../integrations/jira.js';
import { config } from '../config/config.js';
import {
  buildSprintSummaryBlock,
  buildSprintPlanBlock,
  buildBugAlertBlock,
  buildTaskCompleteBlock,
  buildAgentMessage,
  buildRepoAnalysisBlock,
  buildCreditExhaustedBlock,
} from '../integrations/slack-messages.js';
import { SlackListener } from '../integrations/slack-listener.js';
import { projectStorage, ProjectContext } from './project-context.js';
import { TaskQueue } from './task-queue.js';
import { TokenTracker } from '../cost-control/token-tracker.js';
import { CreditExhaustedError, CreditExhaustedType } from '../cost-control/credit-error.js';
import { BudgetExceededError } from '../cost-control/budget-guard.js';
import { ProgressWriter } from './progress-writer.js';
import Anthropic from '@anthropic-ai/sdk';

// ─── Inline agent interfaces (stubs for missing agent files) ──────────────────
// These interfaces describe the contracts the Pipeline expects from each agent.
// The real implementations live in agents/pm-agent.ts, agents/dev-agent.ts,
// and agents/tester-agent.ts — which are not yet generated.

interface PMAgentInterface {
  createPRD(requirement: string, systemPrompt: string, projectId: string): Promise<string>;
  createSprintPlan(
    prd: string,
    stack: ProjectState['stack'],
    systemPrompt: string,
    projectId: string,
  ): Promise<ProjectState['sprint']>;
  reviewOutput(
    output: string,
    task: Task,
    systemPrompt: string,
    projectId: string,
  ): Promise<{ approved: boolean; feedback: string }>;
}

interface DevAgentInterface {
  implementTask(params: {
    task: Task;
    codebase: Record<string, string>;
    systemPrompt: string;
    projectId: string;
    feedbackHistory?: string[];
  }): Promise<CodeOutput>;
  fixBug(params: {
    bug: BugReport;
    codebase: Record<string, string>;
    systemPrompt: string;
    projectId: string;
  }): Promise<CodeOutput>;
}

interface TesterAgentInterface {
  generateTestPlan(params: {
    sprint: ProjectState['sprint'];
    systemPrompt: string;
    projectId: string;
  }): Promise<TestPlan>;
  writeTests(params: {
    task: Task;
    codebase: Record<string, string>;
    systemPrompt: string;
    projectId: string;
  }): Promise<TestOutput>;
  parseBugReports(
    testOutput: string,
    codebase: Record<string, string>,
    systemPrompt: string,
    projectId: string,
  ): Promise<BugReport[]>;
}

interface WorkspaceManagerInterface {
  applyChanges(projectId: string, files: FileChange[]): Promise<void>;
  readFiles(projectId: string): Promise<Record<string, string>>;
}

// ─── Dynamic imports for agents (lazy to avoid circular deps at module load) ──

async function loadPMAgent(): Promise<PMAgentInterface> {
  const mod = await import('../agents/pm-agent.js');
  return mod.pmAgent as unknown as PMAgentInterface;
}

async function loadDevAgent(): Promise<DevAgentInterface> {
  const mod = await import('../agents/dev-agent.js');
  return mod.devAgent as unknown as DevAgentInterface;
}

async function loadTesterAgent(): Promise<TesterAgentInterface> {
  const mod = await import('../agents/tester-agent.js');
  return mod.testerAgent as unknown as TesterAgentInterface;
}

async function loadWorkspaceManager(): Promise<WorkspaceManagerInterface> {
  const mod = await import('../sandbox/workspace-manager.js');
  return mod.workspaceManager as unknown as WorkspaceManagerInterface;
}

async function loadPOAgent() {
  const mod = await import('../agents/po-agent.js');
  return mod.poAgent;
}

async function loadDevOpsAgent() {
  const mod = await import('../agents/devops-agent.js');
  return mod.devOpsAgent;
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export class Pipeline {
  // ─── run ───────────────────────────────────────────────────────────────────

  /**
   * Execute the full project lifecycle for `projectId`. This is the top-level
   * orchestrator method; all phase transitions and inter-agent communication
   * flow through here.
   *
   * @param projectId    - UUID of the project already persisted in the DB
   * @param slackListener - Active SlackListener instance for posting messages
   */
  async run(projectId: string, slackListener: SlackListener): Promise<void> {
    const ctx: ProjectContext = {
      projectId,
      taskQueue: new TaskQueue(),
      tokenTracker: new TokenTracker(),
    };

    return projectStorage.run(ctx, () => this._run(projectId, slackListener, ctx));
  }

  private async _run(
    projectId: string,
    slackListener: SlackListener,
    ctx: ProjectContext,
  ): Promise<void> {
    // Expose the Slack client to the human-checkpoint singleton
    humanCheckpoint.setSlackClient(
      (slackListener as unknown as { app: { client: unknown } }).app.client as Parameters<
        typeof humanCheckpoint.setSlackClient
      >[0],
    );

    // ── 0. Probe API credit before doing any work ────────────────────────────
    await this._probeApiCredit();

    // ── 0. Load project ──────────────────────────────────────────────────────
    let project = await this._requireProject(projectId);
    const channelId = project.slackProjectChannelId;

    console.log(`[Pipeline] Starting project "${project.name}" (${projectId})`);

    try {
      // ── 0.5. CLONING + ANALYZING (repo improvement mode) ─────────────────
      if (project.sourceRepo) {
        await this._runRepoAnalysisPhase(project, projectId, channelId, slackListener);
        // Reload project — repoAnalysis and targetBranch may have been set
        project = await this._requireProject(projectId);
      }

      // ── 1. DETECTING ───────────────────────────────────────────────────────
      await this.handlePhase(projectId, ProjectPhase.DETECTING);
      await this.postToChannel(
        slackListener,
        channelId,
        `Detecting technology stack for *${project.name}*…`,
      );

      let stack = project.stack;
      const stackIsEmpty = !stack?.domains || stack.domains.length === 0;

      if (stackIsEmpty) {
        stack = await stackDetector.detect(project.requirement.raw);
        project.stack = stack;
        project.updatedAt = new Date();
        await stateStore.saveProject(project);
      }

      // Handle ambiguities via human clarification
      if (stack.ambiguities && stack.ambiguities.length > 0) {
        await this.postToChannel(
          slackListener,
          channelId,
          `Stack detection found ${stack.ambiguities.length} ambiguity(-ies). Asking for clarification…`,
        );
        const clarification = await humanCheckpoint.askClarification(
          stack.ambiguities,
          projectId,
          channelId,
        );
        console.log(`[Pipeline] Clarification received:\n${clarification}`);
      }

      const costRange = stackDetector.estimateCost(stack);
      const timeRange = stackDetector.estimateTime(stack);

      await this.postToChannel(
        slackListener,
        channelId,
        `Stack detected: *${stack.primaryDomain}* | Confidence: ${Math.round(stack.confidence * 100)}% | Est. cost: ${costRange} | Est. time: ${timeRange}`,
      );

      // ── 2. PLANNING ────────────────────────────────────────────────────────
      // isResuming = true when sprint already exists (resume after credit pause)
      const isResuming = (project.sprint?.tasks?.length ?? 0) > 0;
      await this.handlePhase(projectId, ProjectPhase.PLANNING);
      await this.postToChannel(
        slackListener,
        channelId,
        isResuming
          ? `Resuming *${project.name}* — sprint already planned, skipping to development…`
          : 'Loading context and planning sprint…',
      );

      const context = await contextLoader.load(stack);

      // Lazy-load agents (needed for both new and resume flows)
      const pmAgent = await loadPMAgent();
      const poAgent = await loadPOAgent();

      if (!isResuming) {

      // Create PRD — for repo improvement mode, include analysis context
      const prdInput = project.repoAnalysis
        ? `Existing repo: ${project.repoAnalysis.repoName}\n\n` +
          `Stack: ${project.repoAnalysis.detectedStack.join(', ')}\n\n` +
          `Current features: ${project.repoAnalysis.existingFeatures.join(', ')}\n\n` +
          `Improvement areas (prioritised):\n${project.repoAnalysis.improvementAreas
            .map((a) => `- [${a.priority}] ${a.title}: ${a.description}`)
            .join('\n')}\n\n` +
          `User goals: ${project.requirement.raw}`
        : project.requirement.raw;

      const rawPrd = await pmAgent.createPRD(prdInput, context.pmSystemPrompt, projectId);

      // PO refines the PRD: adds MoSCoW backlog and sharpens acceptance criteria
      await this.postAgentMessage(slackListener, channelId, AgentRole.PO, 'Reviewing and refining the PRD…');
      const prd = await poAgent.refinePRD({
        prd: rawPrd,
        requirement: project.requirement.raw,
        projectId,
      });

      project.prd = prd;
      project.updatedAt = new Date();
      await stateStore.saveProject(project);

      await this.postToChannel(
        slackListener,
        channelId,
        `PRD created (${prd.length} chars). Waiting for human review…`,
      );

      // Human checkpoint: PRD review
      if (config.checkpoints.requireAfterPRD) {
        const prdCheckpoint = await humanCheckpoint.request({
          projectId,
          phase: ProjectPhase.PLANNING,
          summary: `PRD for *${project.name}* is ready for review.\n\n${prd.slice(0, 800)}${prd.length > 800 ? '…' : ''}`,
          questions: [
            'Does the PRD accurately capture the project requirements?',
            'Are there any missing features or scope changes?',
          ],
          showCostSoFar: true,
          slackChannelId: channelId,
        });

        if (!prdCheckpoint.approved) {
          await this.postToChannel(
            slackListener,
            channelId,
            `PRD rejected by <@${prdCheckpoint.userId}>. Feedback: ${prdCheckpoint.feedback || 'None provided.'}. Regenerating…`,
          );
          const revisedPrd = await pmAgent.createPRD(
            `${project.requirement.raw}\n\nFeedback from review: ${prdCheckpoint.feedback}`,
            context.pmSystemPrompt,
            projectId,
          );
          project.prd = revisedPrd;
          project.updatedAt = new Date();
          await stateStore.saveProject(project);
        }
      }

      // Create sprint plan (PM)
      const rawSprint = await pmAgent.createSprintPlan(
        project.prd,
        stack,
        context.pmSystemPrompt,
        projectId,
      );

      // PO prioritises the backlog using MoSCoW
      const sprint = await poAgent.prioritiseSprint({
        sprint: rawSprint,
        prd: project.prd,
        projectId,
      });

      project.sprint = sprint;
      project.updatedAt = new Date();
      await stateStore.saveProject(project);

      await this.postToChannel(
        slackListener,
        channelId,
        `Sprint planned: *${sprint.goal}* — ${sprint.tasks.length} task(s) (PO-prioritised)`,
      );

      // Create Jira sprint and tasks
      let jiraSprintId = project.jiraSprintId;
      try {
        if (!jiraSprintId) {
          jiraSprintId = await jiraIntegration.createSprint(sprint);
          project.jiraSprintId = jiraSprintId;
          project.updatedAt = new Date();
          await stateStore.saveProject(project);
        }

        for (const task of sprint.tasks) {
          if (!task.jiraId) {
            task.jiraId = await jiraIntegration.createTask(task, jiraSprintId);
          }
        }
        await stateStore.updateSprint(projectId, sprint);
      } catch (err: unknown) {
        console.warn(`[Pipeline] Jira integration error (non-fatal): ${(err as Error).message}`);
      }

      // Create GitHub branch for this sprint
      let githubBranch = project.githubBranch;
      try {
        if (!githubBranch) {
          githubBranch = `swarmly/${project.slug}`;
          const branchExists = await githubIntegration.branchExists(githubBranch);
          if (!branchExists) {
            await githubIntegration.createBranch(githubBranch);
          }
          project.githubBranch = githubBranch;
          project.updatedAt = new Date();
          await stateStore.saveProject(project);
        }
      } catch (err: unknown) {
        console.warn(
          `[Pipeline] GitHub branch creation error (non-fatal): ${(err as Error).message}`,
        );
      }

      // Create sandbox
      await this.postToChannel(slackListener, channelId, 'Provisioning sandbox environment…');
      try {
        await sandboxManager.create(projectId, stack.primaryDomain);
        await this.postToChannel(slackListener, channelId, 'Sandbox ready.');
      } catch (err: unknown) {
        console.warn(`[Pipeline] Sandbox creation error (non-fatal): ${(err as Error).message}`);
      }

      // ── Sprint plan checkpoint — human must approve before coding starts ──
      if (config.checkpoints.requireAfterSprintPlan) {
        await this.postBlocksToChannel(
          slackListener,
          channelId,
          `Sprint plan ready for *${project.name}* — ${sprint.tasks.length} task(s)`,
          buildSprintPlanBlock({
            sprint,
            projectId,
            ...(project.jiraSprintId ? { jiraSprintId: project.jiraSprintId } : {}),
            ...(project.jiraProjectKey ? { jiraProjectKey: project.jiraProjectKey } : {}),
            jiraBaseUrl: config.jira.baseUrl,
          }),
        );

        const sprintCheckpoint = await humanCheckpoint.request({
          projectId,
          phase: ProjectPhase.PLANNING,
          summary:
            `Sprint plan for *${project.name}* is ready.\n` +
            `*Goal:* ${sprint.goal}\n` +
            `*Tasks:* ${sprint.tasks.length} (${sprint.tasks.reduce((s, t) => s + t.estimateHours, 0)}h estimated)`,
          questions: [
            'Does the task breakdown look correct?',
            'Are the priorities aligned with business goals?',
          ],
          showCostSoFar: true,
          slackChannelId: channelId,
        });

        if (!sprintCheckpoint.approved) {
          await this.postAgentMessage(
            slackListener,
            channelId,
            AgentRole.PM,
            `Re-planning sprint based on feedback: ${sprintCheckpoint.feedback || 'No feedback provided.'}`,
          );

          // PM re-creates sprint plan with feedback
          const revisedSprint = await pmAgent.createSprintPlan(
            project.prd +
              `\n\nFeedback on sprint plan: ${sprintCheckpoint.feedback}`,
            stack,
            context.pmSystemPrompt,
            projectId,
          );
          sprint.tasks = revisedSprint.tasks;
          sprint.goal = revisedSprint.goal;
          await stateStore.updateSprint(projectId, sprint);

          // Update Jira tasks for revised plan
          try {
            for (const task of sprint.tasks.filter((t) => !t.jiraId)) {
              task.jiraId = await jiraIntegration.createTask(task, project.jiraSprintId ?? '');
            }
            await stateStore.updateSprint(projectId, sprint);
          } catch (err: unknown) {
            console.warn(`[Pipeline] Jira re-plan update failed: ${(err as Error).message}`);
          }

          await this.postToChannel(
            slackListener,
            channelId,
            `Sprint re-planned: *${sprint.goal}* — ${sprint.tasks.length} task(s). Starting development…`,
          );
        }
      }
      } // end !isResuming

      // ── 3. DEVELOPING ─────────────────────────────────────────────────────
      if (!isResuming) {
        await this.handlePhase(projectId, ProjectPhase.DEVELOPING);
      }

      // Reload sprint in case we skipped planning (resume path)
      const currentProject = await this._requireProject(projectId);
      const sprint = currentProject.sprint;
      const jiraSprintId = currentProject.jiraSprintId || undefined;
      const githubBranch = currentProject.githubBranch || '';

      const progressWriter = new ProgressWriter(
        `${config.sandbox.workspaceBase}/${projectId}`,
      );

      const devAgent = await loadDevAgent();
      const devOpsAgent = await loadDevOpsAgent();
      const workspaceManager = await loadWorkspaceManager();
      const feedbackHistoryByTask: Map<string, string[]> = new Map();

      // Write initial progress snapshot before development starts
      progressWriter.write(currentProject);

      for (const task of sprint.tasks) {
        // Skip tasks that are already done or still paused (should have been reset to TODO on resume)
        if (task.status === TaskStatus.DONE) continue;

        const feedbackHistory: string[] = feedbackHistoryByTask.get(task.id) ?? [];

        // Update Jira to IN_PROGRESS
        try {
          if (task.jiraId) {
            await jiraIntegration.updateTaskStatus(task.jiraId, TaskStatus.IN_PROGRESS);
          }
        } catch (err: unknown) {
          console.warn(`[Pipeline] Jira IN_PROGRESS update failed: ${(err as Error).message}`);
        }

        task.status = TaskStatus.IN_PROGRESS;
        await stateStore.updateSprint(projectId, sprint);

        const isInfraTask = task.type === 'INFRA' || task.type === 'DEVOPS';
        await this.postAgentMessage(
          slackListener,
          channelId,
          isInfraTask ? AgentRole.DEVOPS : AgentRole.DEV,
          `Working on: *${task.title}* (${task.type} | ${task.priority})`,
        );

        let taskDone = false;
        const maxRetries = config.budget.maxRetriesPerTask;

        for (let attempt = 0; attempt < maxRetries && !taskDone; attempt++) {
          task.attempts = attempt + 1;

          // Read current codebase from workspace
          let codebase: Record<string, string> = {};
          try {
            codebase = await workspaceManager.readFiles(projectId);
          } catch (err: unknown) {
            // Fallback to in-memory codebase
            const currentProject = await stateStore.loadProject(projectId);
            codebase = currentProject?.codebase ?? {};
          }

          // Route INFRA/DEVOPS tasks to DevOps agent, rest to Dev agent
          let codeOutput: CodeOutput;
          try {
            if (isInfraTask) {
              codeOutput = await devOpsAgent.implementTask({
                task,
                codebase,
                stackProfile: context.stackProfile,
                projectId,
              });
            } else {
              codeOutput = await devAgent.implementTask({
                task,
                codebase,
                systemPrompt: context.devSystemPrompt,
                projectId,
                feedbackHistory,
              });
            }
          } catch (err: unknown) {
            // Credit exhausted — pause the project and stop
            if (err instanceof CreditExhaustedError || err instanceof BudgetExceededError) {
              await this._handleCreditExhausted({
                err: err as CreditExhaustedError | BudgetExceededError,
                task,
                sprint,
                project: currentProject,
                projectId,
                channelId,
                slackListener,
                progressWriter,
                ctx,
              });
              throw err; // propagate to outer catch → marks pipeline as failed (already PAUSED in DB)
            }
            console.error(
              `[Pipeline] ${isInfraTask ? 'DevOps' : 'Dev'} agent error on attempt ${attempt + 1}: ${(err as Error).message}`,
            );
            feedbackHistory.push(
              `Attempt ${attempt + 1} failed with error: ${(err as Error).message}`,
            );
            continue;
          }

          // Apply changes to workspace and in-memory codebase
          try {
            await workspaceManager.applyChanges(projectId, codeOutput.files);
          } catch (err: unknown) {
            console.warn(`[Pipeline] Workspace apply error: ${(err as Error).message}`);
          }
          await stateStore.updateCodebase(projectId, codeOutput.files);

          // Run build
          let buildSuccess = true;
          let buildError = '';
          try {
            const buildResult = await executor.buildProject(projectId);
            if (!buildResult.success) {
              buildSuccess = false;
              buildError = `${buildResult.stderr}\n${buildResult.stdout}`.trim().slice(0, 1000);
              console.warn(`[Pipeline] Build failed on attempt ${attempt + 1}: ${buildError}`);
              feedbackHistory.push(`Build failed (attempt ${attempt + 1}): ${buildError}`);
              continue;
            }
          } catch (err: unknown) {
            buildSuccess = false;
            buildError = (err as Error).message;
            feedbackHistory.push(`Build threw exception (attempt ${attempt + 1}): ${buildError}`);
            continue;
          }

          if (!buildSuccess) continue;

          // PM review
          let pmApproved = true;
          let pmFeedback = '';
          try {
            const review = await pmAgent.reviewOutput(
              JSON.stringify({
                approach: codeOutput.approach,
                explanation: codeOutput.explanation,
                files: codeOutput.files.map((f) => f.path),
              }),
              task,
              context.pmSystemPrompt,
              projectId,
            );
            pmApproved = review.approved;
            pmFeedback = review.feedback;
          } catch (err: unknown) {
            console.warn(`[Pipeline] PM review error: ${(err as Error).message}`);
            // If PM agent is unavailable, approve to avoid blocking
            pmApproved = true;
          }

          if (pmApproved) {
            // Commit to GitHub
            let commitUrl = '#';
            try {
              if (githubBranch) {
                commitUrl = await githubIntegration.commitFiles(
                  codeOutput.files,
                  `feat(${task.id}): ${task.title}`,
                  githubBranch,
                );
              }
            } catch (err: unknown) {
              console.warn(`[Pipeline] GitHub commit error: ${(err as Error).message}`);
            }

            // Update task status to DONE, record files written
            task.status = TaskStatus.DONE;
            task.filesWritten = codeOutput.files.map((f) => f.path);
            await stateStore.updateSprint(projectId, sprint);
            progressWriter.write({ ...currentProject, sprint });

            // Update Jira
            try {
              if (task.jiraId) {
                await jiraIntegration.updateTaskStatus(task.jiraId, TaskStatus.DONE);
              }
            } catch (err: unknown) {
              console.warn(`[Pipeline] Jira DONE update failed: ${(err as Error).message}`);
            }

            // Post task complete Block Kit message
            await this.postBlocksToChannel(
              slackListener,
              channelId,
              `Task complete: ${task.title}`,
              buildTaskCompleteBlock(task, commitUrl),
            );

            taskDone = true;
          } else {
            feedbackHistory.push(`PM review (attempt ${attempt + 1}): ${pmFeedback}`);
            await this.postAgentMessage(
              slackListener,
              channelId,
              AgentRole.PM,
              `Changes requested on *${task.title}* (attempt ${attempt + 1}): ${pmFeedback}`,
            );
          }
        }

        // All retries exhausted without success
        if (!taskDone) {
          task.status = TaskStatus.BLOCKED;
          await stateStore.updateSprint(projectId, sprint);

          try {
            if (task.jiraId) {
              await jiraIntegration.updateTaskStatus(task.jiraId, TaskStatus.BLOCKED);
            }
          } catch (err: unknown) {
            console.warn(`[Pipeline] Jira BLOCKED update failed: ${(err as Error).message}`);
          }

          await this.postToChannel(
            slackListener,
            channelId,
            `:sos: *Task blocked after ${maxRetries} attempts:* ${task.title}\nManual intervention required.`,
          );
        }
      }

      // ── 4. TESTING ────────────────────────────────────────────────────────
      await this.handlePhase(projectId, ProjectPhase.TESTING);
      await this.postToChannel(slackListener, channelId, 'Starting test phase…');

      const testerAgent = await loadTesterAgent();

      // Generate test plan
      let testPlan: TestPlan;
      try {
        testPlan = await testerAgent.generateTestPlan({
          sprint,
          systemPrompt: context.testerSystemPrompt,
          projectId,
        });
      } catch (err: unknown) {
        console.warn(`[Pipeline] Test plan generation failed: ${(err as Error).message}`);
        testPlan = { unitTests: [], integrationTests: [], e2eTests: [] };
      }

      // Reload project to get the latest codebase snapshot
      project = await this._requireProject(projectId);

      // Write tests for each DONE task
      const doneTasks = sprint.tasks.filter((t) => t.status === TaskStatus.DONE);
      let totalTestFilesWritten = 0;

      for (const task of doneTasks) {
        try {
          const testOutput = await testerAgent.writeTests({
            task,
            codebase: project.codebase,
            systemPrompt: context.testerSystemPrompt,
            projectId,
          });
          await stateStore.updateCodebase(projectId, testOutput.files);
          try {
            await workspaceManager.applyChanges(projectId, testOutput.files);
          } catch (err: unknown) {
            console.warn(`[Pipeline] Workspace test apply error: ${(err as Error).message}`);
          }
          totalTestFilesWritten += testOutput.files.length;
        } catch (err: unknown) {
          console.warn(
            `[Pipeline] Test writing failed for "${task.title}": ${(err as Error).message}`,
          );
        }
      }

      await this.postToChannel(
        slackListener,
        channelId,
        `Tests written: ${totalTestFilesWritten} file(s). Running test suite…`,
      );

      // Run tests
      let testRun = { stdout: '', stderr: '', exitCode: 0, durationMs: 0, success: true };
      try {
        testRun = await executor.runTests(projectId);
      } catch (err: unknown) {
        console.warn(`[Pipeline] Test run error: ${(err as Error).message}`);
        testRun = {
          stdout: '',
          stderr: (err as Error).message,
          exitCode: 1,
          durationMs: 0,
          success: false,
        };
      }

      const testResult = executor.parseTestOutput(testRun, stack.primaryDomain);
      await this.postToChannel(
        slackListener,
        channelId,
        `Test results: ${testResult.passed} passed | ${testResult.failed} failed | ${testResult.skipped} skipped (${(testResult.duration / 1000).toFixed(1)}s)`,
      );

      // Parse bugs from failing tests
      let bugs: BugReport[] = [];
      if (testResult.failed > 0) {
        try {
          project = await this._requireProject(projectId);
          bugs = await testerAgent.parseBugReports(
            `${testRun.stdout}\n${testRun.stderr}`,
            project.codebase,
            context.testerSystemPrompt,
            projectId,
          );
        } catch (err: unknown) {
          console.warn(`[Pipeline] Bug report parsing failed: ${(err as Error).message}`);
        }
      }

      // Handle critical/high bugs
      const actionableBugs = bugs.filter((b) => b.severity === 'CRITICAL' || b.severity === 'HIGH');

      if (actionableBugs.length > 0) {
        await this.postBlocksToChannel(
          slackListener,
          channelId,
          `${actionableBugs.length} critical/high bug(s) found`,
          buildBugAlertBlock(actionableBugs),
        );

        // Create Jira bug tickets
        for (const bug of actionableBugs) {
          try {
            bug.jiraId = await jiraIntegration.createBug(bug);
          } catch (err: unknown) {
            console.warn(`[Pipeline] Jira bug creation failed: ${(err as Error).message}`);
          }
        }

        // Dev fixes each bug
        for (const bug of actionableBugs) {
          await this.postAgentMessage(
            slackListener,
            channelId,
            AgentRole.DEV,
            `Fixing bug: *${bug.title}* (${bug.severity})`,
          );
          try {
            project = await this._requireProject(projectId);
            const fixOutput = await devAgent.fixBug({
              bug,
              codebase: project.codebase,
              systemPrompt: context.devSystemPrompt,
              projectId,
            });
            await stateStore.updateCodebase(projectId, fixOutput.files);
            try {
              await workspaceManager.applyChanges(projectId, fixOutput.files);
            } catch (err: unknown) {
              console.warn(`[Pipeline] Workspace bug fix apply error: ${(err as Error).message}`);
            }
            if (githubBranch) {
              try {
                await githubIntegration.commitFiles(
                  fixOutput.files,
                  `fix(${bug.id}): ${bug.title}`,
                  githubBranch,
                );
              } catch (err: unknown) {
                console.warn(`[Pipeline] GitHub bug fix commit error: ${(err as Error).message}`);
              }
            }
          } catch (err: unknown) {
            console.warn(
              `[Pipeline] Dev bug fix error for "${bug.title}": ${(err as Error).message}`,
            );
          }
        }

        // Re-run tests after fixes
        try {
          const reTestRun = await executor.runTests(projectId);
          const reTestResult = executor.parseTestOutput(reTestRun, stack.primaryDomain);
          await this.postToChannel(
            slackListener,
            channelId,
            `Post-fix test results: ${reTestResult.passed} passed | ${reTestResult.failed} failed`,
          );
        } catch (err: unknown) {
          console.warn(`[Pipeline] Re-test run error: ${(err as Error).message}`);
        }
      }

      // Human checkpoint: testing complete
      if (config.checkpoints.requireAfterTesting) {
        await humanCheckpoint.request({
          projectId,
          phase: ProjectPhase.TESTING,
          summary:
            `Testing phase complete for *${project.name}*.\n` +
            `${testResult.passed} tests passed, ${testResult.failed} failed.\n` +
            `${actionableBugs.length} high/critical bug(s) were auto-fixed.`,
          questions: [
            'Are you satisfied with the test coverage?',
            'Should the PR be opened and the sprint closed?',
          ],
          showCostSoFar: true,
          slackChannelId: channelId,
        });
      }

      // ── 5. CREATE PR ──────────────────────────────────────────────────────
      let prUrl = '#';
      try {
        if (githubBranch) {
          prUrl = await githubIntegration.createPR(
            `[Swarmly] ${project.name} — Sprint: ${sprint.goal}`,
            [
              `## Summary`,
              `Automated sprint by Swarmly AI agent team.`,
              ``,
              `### Sprint Goal`,
              sprint.goal,
              ``,
              `### Tasks Completed`,
              sprint.tasks
                .filter((t) => t.status === TaskStatus.DONE)
                .map((t) => `- [x] ${t.title}`)
                .join('\n'),
              ``,
              `### Tasks Blocked`,
              sprint.tasks
                .filter((t) => t.status === TaskStatus.BLOCKED)
                .map((t) => `- [ ] ${t.title} (BLOCKED)`)
                .join('\n') || '_None_',
              ``,
              `### Test Results`,
              `${testResult.passed} passed | ${testResult.failed} failed | ${testResult.skipped} skipped`,
              ``,
              `> Generated by [Swarmly](https://github.com/swarmly) — AI agent team`,
            ].join('\n'),
            githubBranch,
          );
          await this.postToChannel(slackListener, channelId, `Pull request created: ${prUrl}`);
        }
      } catch (err: unknown) {
        console.warn(`[Pipeline] PR creation error: ${(err as Error).message}`);
      }

      // ── 6. CLOSE SPRINT ───────────────────────────────────────────────────
      try {
        if (jiraSprintId) {
          await jiraIntegration.closeSprint(jiraSprintId);
        }
      } catch (err: unknown) {
        console.warn(`[Pipeline] Jira sprint close error: ${(err as Error).message}`);
      }

      // ── 7. POST SPRINT SUMMARY ────────────────────────────────────────────
      const sprintStartMs = new Date(sprint.startDate).getTime();
      const durationMs = Date.now() - sprintStartMs;
      const durationHours = (durationMs / 3_600_000).toFixed(1);

      const doneFinalCount = sprint.tasks.filter((t) => t.status === TaskStatus.DONE).length;
      project = await this._requireProject(projectId);
      const totalCostUsd = project.budget?.usedUsd ?? 0;

      await this.postBlocksToChannel(
        slackListener,
        channelId,
        `Sprint complete: ${sprint.goal}`,
        buildSprintSummaryBlock({
          sprint,
          totalCost: `$${totalCostUsd.toFixed(4)}`,
          duration: `${durationHours}h`,
          prUrl,
          stats: {
            tasksCompleted: doneFinalCount,
            bugsFixed: actionableBugs.length,
            testsWritten: totalTestFilesWritten,
          },
        }),
      );

      // ── 8. DESTROY SANDBOX ────────────────────────────────────────────────
      try {
        await sandboxManager.destroy(projectId);
      } catch (err: unknown) {
        console.warn(`[Pipeline] Sandbox destroy error: ${(err as Error).message}`);
      }

      // ── 9. DONE ───────────────────────────────────────────────────────────
      await this.handlePhase(projectId, ProjectPhase.DONE);
      project = await this._requireProject(projectId);
      project.completedAt = new Date();
      project.updatedAt = new Date();
      await stateStore.saveProject(project);

      await this.postToChannel(
        slackListener,
        channelId,
        `:tada: Project *${project.name}* is complete!`,
      );
      console.log(`[Pipeline] Project "${project.name}" (${projectId}) completed successfully.`);
    } catch (err: unknown) {
      const errorMessage = (err as Error).message;
      console.error(`[Pipeline] Fatal error for project ${projectId}: ${errorMessage}`);
      await stateStore.updatePhase(projectId, ProjectPhase.FAILED);
      await this.postToChannel(
        slackListener,
        channelId,
        `:x: Pipeline failed for *${project.name}*: ${errorMessage}`,
      );
      throw err;
    } finally {
      ctx.taskQueue.destroy();
    }
  }

  // ─── _probeApiCredit ──────────────────────────────────────────────────────

  async _probeApiCredit(): Promise<void> {
    const client = new Anthropic({
      apiKey: config.anthropic.apiKey,
      baseURL: config.anthropic.baseUrl,
    });
    try {
      await client.messages.create({
        model: config.anthropic.models.lobby,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError && err.status === 402) {
        throw new CreditExhaustedError('API_402', 'Insufficient Anthropic credits to start pipeline');
      }
      // Network errors etc. — don't block the pipeline
    }
  }

  // ─── _handleCreditExhausted ───────────────────────────────────────────────

  private async _handleCreditExhausted(params: {
    err: CreditExhaustedError | BudgetExceededError;
    task: Task;
    sprint: import('../types/index.js').Sprint;
    project: ProjectState;
    projectId: string;
    channelId: string;
    slackListener: SlackListener;
    progressWriter: ProgressWriter;
    ctx: ProjectContext;
  }): Promise<void> {
    const { err, task, sprint, project, projectId, channelId, slackListener, progressWriter, ctx } = params;

    const creditType: CreditExhaustedType =
      err instanceof CreditExhaustedError
        ? err.creditType
        : (err as BudgetExceededError).reason.includes('daily')
          ? 'BUDGET_DAILY'
          : 'BUDGET_SPRINT';

    // Mark current task as PAUSED (not FAILED — will be retried on resume)
    task.status = TaskStatus.PAUSED;
    await stateStore.updateSprint(projectId, sprint);

    // Persist pause metadata
    project.phase = ProjectPhase.PAUSED;
    project.pauseReason = 'CREDIT_EXHAUSTED';
    project.pausedAtTaskId = task.id;
    project.updatedAt = new Date();
    await stateStore.saveProject(project);
    await stateStore.updatePhase(projectId, ProjectPhase.PAUSED);

    // Write progress file with current state
    progressWriter.write(project);

    // Build cost summary for Slack card
    const report = ctx.tokenTracker.getSprintReport();
    const costSoFar = `$${report.total.estimatedCostUsd.toFixed(4)}`;
    const doneTasks = sprint.tasks.filter((t) => t.status === 'DONE').length;

    await this.postBlocksToChannel(
      slackListener,
      channelId,
      `Project paused — credits exhausted`,
      buildCreditExhaustedBlock({
        projectId,
        projectName: project.name,
        pausedTaskTitle: task.title,
        doneTasks,
        totalTasks: sprint.tasks.length,
        costSoFar,
        creditType,
      }),
    );

    console.log(`[Pipeline] Project ${projectId} paused at task "${task.title}" — credit exhausted (${creditType})`);
  }

  // ─── _runRepoAnalysisPhase ─────────────────────────────────────────────────

  private async _runRepoAnalysisPhase(
    project: ProjectState,
    projectId: string,
    channelId: string,
    slackListener: SlackListener,
  ): Promise<void> {
    const { cloneRepo, getAllRepoFilePaths, readFilesChunk, parseGithubUrl } = await import(
      '../integrations/repo-cloner.js'
    );
    const { pmAgent } = await import('../agents/pm-agent.js');
    const poAgent = await loadPOAgent();
    const fs = await import('fs');
    const path = await import('path');

    const sourceRepo = project.sourceRepo!;
    const { fullName } = parseGithubUrl(sourceRepo);
    const workspaceDir = `${config.sandbox.workspaceBase}/${projectId}`;
    const specPath = path.join(workspaceDir, 'swarmly-spec.md');

    // ── CLONING ─────────────────────────────────────────────────────────────
    await this.handlePhase(projectId, ProjectPhase.CLONING);
    await this.postToChannel(slackListener, channelId, `Cloning *${fullName}*…`);

    try {
      await cloneRepo(sourceRepo, workspaceDir, config.github.token);
      await this.postToChannel(slackListener, channelId, `Repo cloned. Scanning files…`);
    } catch (err) {
      const msg = (err as Error).message;
      await this.postToChannel(
        slackListener,
        channelId,
        `:x: Failed to clone *${fullName}*: ${msg}\n` +
        `If this is a private repo, ensure your GitHub token has read access.`,
      );
      throw new Error(`[Pipeline] Clone failed for ${sourceRepo}: ${msg}`);
    }

    // ── ANALYZING — progressive chunked spec build ───────────────────────────
    await this.handlePhase(projectId, ProjectPhase.ANALYZING);

    const allFilePaths = getAllRepoFilePaths(workspaceDir);
    const fileTree = allFilePaths.slice(0, 300);
    const CHUNK_SIZE = config.repoAnalysis.maxFiles;
    const chunks: string[][] = [];
    for (let i = 0; i < allFilePaths.length; i += CHUNK_SIZE) {
      chunks.push(allFilePaths.slice(i, i + CHUNK_SIZE));
    }

    await this.postAgentMessage(
      slackListener,
      channelId,
      AgentRole.PM,
      `Analyzing *${fullName}* — ${allFilePaths.length} files across ${chunks.length} chunk(s)…`,
    );

    const userIntent = project.requirement.raw;
    let spec = '';

    for (let i = 0; i < chunks.length; i++) {
      const chunkFiles = readFilesChunk(
        chunks[i]!,
        workspaceDir,
        config.repoAnalysis.maxFileSizeBytes,
      );

      await this.postToChannel(
        slackListener,
        channelId,
        `Analyzing chunk ${i + 1}/${chunks.length} (${chunkFiles.length} files)…`,
      );

      try {
        spec = await pmAgent.analyzeRepoChunk({
          chunkFiles,
          existingSpec: spec,
          chunkIndex: i + 1,
          totalChunks: chunks.length,
          fileTree,
          userIntent,
          projectId,
        });

        // Persist spec to workspace file after each chunk
        fs.writeFileSync(specPath, spec, 'utf8');
      } catch (err) {
        console.warn(`[Pipeline] Chunk ${i + 1} analysis failed: ${(err as Error).message}`);
      }
    }

    await this.postAgentMessage(
      slackListener,
      channelId,
      AgentRole.PM,
      `All ${chunks.length} chunk(s) analyzed. Finalizing structured report…`,
    );

    // Convert accumulated spec → structured RepoAnalysis JSON
    let analysis: RepoAnalysis;
    try {
      analysis = await pmAgent.finalizeRepoSpec({
        spec,
        repoUrl: sourceRepo,
        repoName: fullName,
        fileCount: allFilePaths.length,
        projectId,
      });
    } catch (err) {
      await this.postToChannel(
        slackListener,
        channelId,
        `:warning: Failed to finalize analysis: ${(err as Error).message}. Continuing with spec only.`,
      );
      analysis = {
        repoUrl: sourceRepo,
        repoName: fullName,
        detectedStack: [],
        existingFeatures: [],
        technicalDebt: [],
        securityConcerns: [],
        improvementAreas: [],
        summary: spec.slice(0, 500),
        fileCount: allFilePaths.length,
        sampledFiles: [],
      };
    }

    // PO refines the backlog
    await this.postAgentMessage(slackListener, channelId, AgentRole.PO, 'Prioritising improvement backlog…');
    try {
      const refined = await poAgent.buildImprovementBacklog({ analysis, userIntent, projectId });
      analysis.improvementAreas = refined;
    } catch {
      // keep PM analysis as-is
    }

    // Persist analysis
    project.repoAnalysis = analysis;
    project.updatedAt = new Date();
    await stateStore.saveProject(project);

    // Post analysis card + ask PR target question
    await this.postBlocksToChannel(
      slackListener,
      channelId,
      `Repo analysis complete for *${fullName}*`,
      buildRepoAnalysisBlock(analysis, projectId),
    );

    // ── Clarification: where to push the final PR? ──────────────────────────
    const prTargetAnswers = await humanCheckpoint.askClarification(
      [
        {
          question: `Where should Swarmly push the improvements?`,
          options: [
            `New branch on ${fullName} (swarmly/improvements-${projectId.slice(0, 6)})`,
            'I will specify a different branch in Slack after the sprint',
          ],
        },
      ],
      projectId,
      channelId,
    );

    // Parse the answer — default to new branch on source repo
    const targetBranch = prTargetAnswers.includes('swarmly/')
      ? `swarmly/improvements-${projectId.slice(0, 6)}`
      : `swarmly/improvements-${projectId.slice(0, 6)}`;

    // ── Checkpoint: human approves analysis before sprint ───────────────────
    if (config.repoAnalysis.requireCheckpoint) {
      const checkpoint = await humanCheckpoint.request({
        projectId,
        phase: ProjectPhase.ANALYZING,
        summary:
          `Analysis of *${fullName}* complete.\n` +
          `${analysis.improvementAreas.length} improvement area(s) identified.\n` +
          `${analysis.technicalDebt.length} tech debt item(s), ` +
          `${analysis.securityConcerns.length} security concern(s).`,
        questions: [
          'Do the improvement areas match your goals?',
          'Should Swarmly proceed with the sprint plan?',
        ],
        showCostSoFar: false,
        slackChannelId: channelId,
      });

      if (!checkpoint.approved) {
        throw new Error(
          `[Pipeline] Repo analysis rejected by <@${checkpoint.userId}>. Aborting.`,
        );
      }
    }

    // Persist target branch
    project.targetBranch = targetBranch;
    project.githubBranch = targetBranch;
    project.updatedAt = new Date();
    await stateStore.saveProject(project);

    // Create Jira project now that analysis is approved
    try {
      const jira = await import('../integrations/jira.js');
      const jiraProjectKey = await jira.jiraIntegration.createProject({
        name: project.name,
        description: `Repo improvement sprint for ${fullName}.\n${analysis.summary}`,
      });
      project.jiraProjectKey = jiraProjectKey;
      await stateStore.saveProject(project);
      await this.postToChannel(slackListener, channelId, `Jira project created: \`${jiraProjectKey}\``);
    } catch (err) {
      console.warn(`[Pipeline] Jira project creation failed (non-fatal): ${(err as Error).message}`);
    }

    await this.postToChannel(
      slackListener,
      channelId,
      `Analysis approved. Planning improvement sprint…`,
    );
  }

  // ─── handlePhase ───────────────────────────────────────────────────────────

  /**
   * Transition the project to the given phase and log the transition.
   */
  async handlePhase(projectId: string, phase: ProjectPhase): Promise<void> {
    await stateStore.updatePhase(projectId, phase);
    console.log(`[Pipeline] Project ${projectId} → Phase: ${phase}`);
  }

  // ─── postToChannel ─────────────────────────────────────────────────────────

  /**
   * Post a plain-text message to the project Slack channel.
   */
  private async postToChannel(
    slackListener: SlackListener,
    channelId: string,
    text: string,
  ): Promise<void> {
    try {
      await slackListener.postMessage(channelId, text);
    } catch (err: unknown) {
      console.warn(`[Pipeline] postToChannel failed: ${(err as Error).message}`);
    }
  }

  /**
   * Post a message attributed to a specific agent role (Block Kit context header).
   * Works in every Slack channel — no webhook or scope required.
   */
  private async postAgentMessage(
    slackListener: SlackListener,
    channelId: string,
    role: AgentRole,
    text: string,
  ): Promise<void> {
    try {
      await slackListener.postMessage(
        channelId,
        text,
        buildAgentMessage(text, role) as Parameters<typeof slackListener.postMessage>[2],
      );
    } catch (err: unknown) {
      console.warn(`[Pipeline] postAgentMessage failed: ${(err as Error).message}`);
    }
  }

  /**
   * Post a Block Kit message to the project Slack channel.
   */
  private async postBlocksToChannel(
    slackListener: SlackListener,
    channelId: string,
    text: string,
    blocks: unknown[],
  ): Promise<void> {
    try {
      // SlackListener.postMessage accepts KnownBlock[]; we cast here because the
      // block builders return KnownBlock[] already — the unknown[] type is just
      // to avoid importing @slack/types in the Pipeline.
      await slackListener.postMessage(
        channelId,
        text,
        blocks as Parameters<typeof slackListener.postMessage>[2],
      );
    } catch (err: unknown) {
      console.warn(`[Pipeline] postBlocksToChannel failed: ${(err as Error).message}`);
    }
  }

  // ─── _requireProject ───────────────────────────────────────────────────────

  /** Load a project or throw if not found. */
  private async _requireProject(projectId: string): Promise<ProjectState> {
    const project = await stateStore.loadProject(projectId);
    if (!project) {
      throw new Error(`[Pipeline] Project not found: ${projectId}`);
    }
    return project;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const pipeline = new Pipeline();
