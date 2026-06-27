import {
  AgentRole,
  Task,
  CodeOutput,
  TestPlan,
  TestOutput,
  TestResult,
  BugReport,
  DetectedStack,
  StackDomain,
  ProjectState,
  ConversationHistory,
  TaskStatus,
} from '../types/index.js';
import { BaseAgent } from './base-agent.js';
import { selectModel } from '../cost-control/model-router.js';
import { config } from '../config/config.js';

const COMPLEX_DOMAINS: StackDomain[] = [
  StackDomain.BLOCKCHAIN_EVM,
  StackDomain.BLOCKCHAIN_SOL,
  StackDomain.AI_ML,
  StackDomain.GAME,
];

/** Return the appropriate testing framework based on stack domain */
function getTestingFramework(domain: StackDomain): string {
  switch (domain) {
    case StackDomain.WEB_SAAS:
      return 'Jest + React Testing Library + Playwright for e2e';
    case StackDomain.MOBILE_RN:
      return 'Jest + @testing-library/react-native + Detox for e2e';
    case StackDomain.MOBILE_FLUTTER:
      return 'flutter_test + integration_test';
    case StackDomain.BLOCKCHAIN_EVM:
      return 'Hardhat + Chai + Waffle for smart contracts';
    case StackDomain.BLOCKCHAIN_SOL:
      return 'Anchor test framework + Mocha';
    case StackDomain.IOT_EMBEDDED:
      return 'Unity Test Framework + CMock';
    case StackDomain.AI_ML:
      return 'pytest + hypothesis + mlflow for model testing';
    case StackDomain.DESKTOP:
      return 'Jest + Spectron/Playwright for Electron';
    case StackDomain.DATA_PLATFORM:
      return 'pytest + Great Expectations + dbt test';
    case StackDomain.CLI_TOOL:
      return 'Jest + @oclif/test for CLI commands';
    case StackDomain.BROWSER_EXT:
      return 'Jest + webextension-polyfill-ts + Playwright for e2e';
    case StackDomain.GAME:
      return 'Jest + Phaser test utils / Unity Test Framework';
    case StackDomain.SERVERLESS:
      return 'Jest + aws-lambda-mock-context / Vitest for edge functions';
    case StackDomain.DEVOPS:
      return 'Terratest + InSpec / Kitchen-Terraform';
    default:
      return 'Jest';
  }
}

/** Temporarily swap the model on the agent instance (protected model via cast) */
function withModel(agent: unknown, model: string, fn: () => Promise<unknown>): Promise<unknown> {
  const a = agent as { model: string };
  const original = a.model;
  a.model = model;
  return fn().finally(() => {
    a.model = original;
  });
}

export class TesterAgent extends BaseAgent {
  constructor() {
    super(AgentRole.TESTER, config.anthropic.models.tester);
  }

  async generateTestPlan(prd: string, stack: DetectedStack, projectId: string): Promise<TestPlan> {
    const isComplex = COMPLEX_DOMAINS.includes(stack.primaryDomain);
    const chosenModel = isComplex
      ? selectModel({ agent: AgentRole.TESTER, domain: stack.primaryDomain })
      : selectModel({ agent: AgentRole.TESTER, isSimple: true });

    const testingFramework = getTestingFramework(stack.primaryDomain);

    const systemPrompt = `You are Swarmly's Tester Agent. Generate a comprehensive test plan from a PRD.

Testing framework: ${testingFramework}
Stack: ${stack.languages.join(', ')} / ${stack.frameworks.join(', ')}

Output valid JSON matching this exact schema:
{
  "unitTests": [
    {
      "name": "<test name>",
      "type": "unit",
      "targetFile": "<file path to test>",
      "scenario": "<what this test verifies>"
    }
  ],
  "integrationTests": [
    {
      "name": "<test name>",
      "type": "integration",
      "targetFile": "<file or endpoint being tested>",
      "scenario": "<what this test verifies>"
    }
  ],
  "e2eTests": [
    {
      "name": "<test name>",
      "type": "e2e",
      "targetFile": "<user flow or feature>",
      "scenario": "<what this e2e flow covers>"
    }
  ]
}

Rules:
- unitTests, integrationTests, and e2eTests must all be non-empty arrays
- Include at least 5 unit tests, 3 integration tests, and 2 e2e tests
- Each test name must be unique and descriptive
- Derive tests directly from acceptance criteria and user stories in the PRD
- For blockchain domains: include security/reentrancy tests in unit tests
- For AI/ML domains: include model accuracy and edge case tests`;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Generate a test plan for the following PRD:\n\n${prd}`,
        timestamp: new Date(),
      },
    ];

    return (await withModel(this, chosenModel, () =>
      this.callWithValidation<TestPlan>({
        systemPrompt,
        messages,
        projectId,
        validate: (output) => {
          if (!Array.isArray(output.unitTests) || output.unitTests.length === 0) {
            return { valid: false, reason: 'unitTests must be a non-empty array' };
          }
          if (!Array.isArray(output.integrationTests) || output.integrationTests.length === 0) {
            return { valid: false, reason: 'integrationTests must be a non-empty array' };
          }
          if (!Array.isArray(output.e2eTests) || output.e2eTests.length === 0) {
            return { valid: false, reason: 'e2eTests must be a non-empty array' };
          }
          const allTests = [...output.unitTests, ...output.integrationTests, ...output.e2eTests];
          for (const tc of allTests) {
            if (!tc.name || !tc.type || !tc.targetFile || !tc.scenario) {
              return {
                valid: false,
                reason: `Test case missing required fields: ${JSON.stringify(tc)}`,
              };
            }
          }
          return { valid: true };
        },
        maxAttempts: 3,
      }),
    )) as TestPlan;
  }

  async writeTests(
    task: Task,
    implementation: CodeOutput,
    stack: DetectedStack,
    projectId: string,
  ): Promise<TestOutput> {
    const isComplex = COMPLEX_DOMAINS.includes(stack.primaryDomain);
    const chosenModel = isComplex
      ? selectModel({ agent: AgentRole.TESTER, domain: stack.primaryDomain })
      : selectModel({ agent: AgentRole.TESTER, isSimple: true });

    const testingFramework = getTestingFramework(stack.primaryDomain);

    const systemPrompt = `You are Swarmly's Tester Agent. Write comprehensive tests for a completed implementation.

Testing framework: ${testingFramework}
Stack: ${stack.languages.join(', ')} / ${stack.frameworks.join(', ')}

Output valid JSON:
{
  "files": [
    {
      "path": "<test file path>",
      "content": "<complete test file content>",
      "action": "create"
    }
  ],
  "runCommand": "<command to run these tests>"
}

Rules:
- Write at least 1 happy path test AND 1 edge case test per acceptance criterion
- Tests must be complete and runnable — no placeholders or TODOs
- Use the correct import paths based on the implementation files
- runCommand must be a valid CLI command (e.g., "npx jest --testPathPattern=tests/")
- Test file paths should follow the convention for the stack (e.g., *.test.ts, *.spec.ts, test_*.py)
- For blockchain: test with hardhat network fork where appropriate
- For AI/ML: test model outputs with tolerance thresholds`;

    const implementedFiles = implementation.files
      .filter((f) => f.action !== 'delete')
      .map(
        (f) =>
          `### ${f.path}\n\`\`\`\n${f.content.substring(0, 2000)}${f.content.length > 2000 ? '\n... [truncated]' : ''}\n\`\`\``,
      )
      .join('\n\n');

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Write tests for the following task implementation.

## Task
Title: ${task.title}
Description: ${task.description}

Acceptance Criteria:
${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Implementation
Approach: ${implementation.approach}

Files:
${implementedFiles}

Test Instructions from Dev: ${implementation.testInstructions}`,
        timestamp: new Date(),
      },
    ];

    return (await withModel(this, chosenModel, () =>
      this.callWithValidation<TestOutput>({
        systemPrompt,
        messages,
        projectId,
        validate: (output) => {
          if (!Array.isArray(output.files) || output.files.length === 0) {
            return { valid: false, reason: 'files must be a non-empty array' };
          }
          for (const file of output.files) {
            if (!file.path || file.path.trim() === '') {
              return { valid: false, reason: 'each file must have a non-empty path' };
            }
            if (!file.content || file.content.trim() === '') {
              return { valid: false, reason: `test file "${file.path}" has empty content` };
            }
          }
          if (!output.runCommand || output.runCommand.trim() === '') {
            return { valid: false, reason: 'runCommand must be a non-empty string' };
          }
          return { valid: true };
        },
        maxAttempts: 3,
      }),
    )) as TestOutput;
  }

  async runAndReport(
    projectId: string,
    stack: DetectedStack,
    testResult: TestResult,
  ): Promise<BugReport[]> {
    if (testResult.failures.length === 0) {
      return [];
    }

    const bugReports: BugReport[] = await Promise.all(
      testResult.failures.map((failure, index) =>
        this.analyzeBug(failure, stack, projectId).catch((err: unknown) => {
          // Return a fallback BugReport if analysis fails for one test
          const errorMsg = err instanceof Error ? err.message : String(err);
          return {
            id: `bug-${projectId}-${index}`,
            severity: 'HIGH' as const,
            title: `Test failure: ${failure.test}`,
            steps: ['Run the test suite', `Observe failure in test: ${failure.test}`],
            expected: 'Test passes successfully',
            actual: failure.error,
            affectedFile: 'unknown',
            suggestedFix: `Investigate the test failure: ${errorMsg}`,
            jiraId: '',
          };
        }),
      ),
    );

    return bugReports;
  }

  async analyzeBug(
    failure: { test: string; error: string },
    stack: DetectedStack,
    projectId: string,
  ): Promise<BugReport> {
    const isComplex = COMPLEX_DOMAINS.includes(stack.primaryDomain);
    const chosenModel = isComplex
      ? selectModel({ agent: AgentRole.TESTER, domain: stack.primaryDomain })
      : selectModel({ agent: AgentRole.TESTER, isSimple: true });

    const systemPrompt = `You are Swarmly's Tester Agent. Analyze a test failure and produce a detailed bug report.

Stack: ${stack.languages.join(', ')} / ${stack.frameworks.join(', ')}

Output valid JSON matching this exact schema:
{
  "id": "<unique bug id, e.g. bug-001>",
  "severity": "<CRITICAL|HIGH|MEDIUM|LOW>",
  "title": "<concise bug title>",
  "steps": ["<step 1 to reproduce>", "<step 2>", "<step 3>"],
  "expected": "<what should have happened>",
  "actual": "<what actually happened>",
  "affectedFile": "<most likely source file path>",
  "suggestedFix": "<specific actionable fix — code change or approach>",
  "jiraId": ""
}

Severity guidelines:
- CRITICAL: data loss, security vulnerability, crash, complete feature failure
- HIGH: major feature broken, significant UX degradation
- MEDIUM: partial feature failure, workaround exists
- LOW: minor visual or non-critical issue

Rules:
- steps must have at least 2 entries
- suggestedFix must be specific and actionable (not vague like "fix the bug")
- affectedFile should be a real file path deduced from the error stack trace
- jiraId must be empty string (will be filled by orchestrator)`;

    const messages: ConversationHistory = [
      {
        role: 'user',
        content: `Analyze this test failure and produce a bug report.

Test: ${failure.test}

Error:
\`\`\`
${failure.error}
\`\`\``,
        timestamp: new Date(),
      },
    ];

    return (await withModel(this, chosenModel, () =>
      this.callWithValidation<BugReport>({
        systemPrompt,
        messages,
        projectId,
        validate: (output) => {
          if (!output.id || output.id.trim() === '') {
            return { valid: false, reason: 'id must be a non-empty string' };
          }
          if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(output.severity)) {
            return { valid: false, reason: `severity "${output.severity}" is invalid` };
          }
          if (!output.title || output.title.trim() === '') {
            return { valid: false, reason: 'title must be a non-empty string' };
          }
          if (!Array.isArray(output.steps) || output.steps.length < 2) {
            return { valid: false, reason: 'steps must be an array with at least 2 entries' };
          }
          if (!output.expected || output.expected.trim() === '') {
            return { valid: false, reason: 'expected must be a non-empty string' };
          }
          if (!output.actual || output.actual.trim() === '') {
            return { valid: false, reason: 'actual must be a non-empty string' };
          }
          if (!output.affectedFile || output.affectedFile.trim() === '') {
            return { valid: false, reason: 'affectedFile must be a non-empty string' };
          }
          if (!output.suggestedFix || output.suggestedFix.trim() === '') {
            return { valid: false, reason: 'suggestedFix must be a non-empty string' };
          }
          return { valid: true };
        },
        maxAttempts: 3,
      }),
    )) as BugReport;
  }

  async respondToMention(text: string, project: ProjectState): Promise<string> {
    const completedTasks =
      project.sprint?.tasks.filter((t) => t.status === TaskStatus.DONE).length ?? 0;
    const totalTasks = project.sprint?.tasks.length ?? 0;
    const testTasks = project.sprint?.tasks.filter((t) => t.type === 'TEST') ?? [];

    const systemPrompt = `You are Swarmly's Tester Agent for the project "${project.name}".
You are being directly @mentioned in the project's Slack channel.

Project context:
- Phase: ${project.phase}
- Sprint Goal: ${project.sprint?.goal ?? 'Not started'}
- Tasks: ${completedTasks}/${totalTasks} done
- Test tasks: ${testTasks.length} (${testTasks.filter((t) => t.status === TaskStatus.DONE).length} completed)
- Primary stack: ${project.stack?.primaryDomain ?? 'unknown'}
- Testing framework: ${project.stack ? getTestingFramework(project.stack.primaryDomain) : 'unknown'}

Respond helpfully as the Tester Agent. You can:
- Report on test coverage and results
- Explain bug reports and their severity
- Describe what tests were written
- Suggest additional test scenarios
- Clarify testing strategy decisions

Keep your response under 200 words. Use plain text (Slack mrkdwn ok). Be precise about test coverage and quality.`;

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
      throw new Error(`TESTER respondToMention failed: ${output.error ?? 'empty response'}`);
    }

    return output.content.trim();
  }
}

export const testerAgent = new TesterAgent();
