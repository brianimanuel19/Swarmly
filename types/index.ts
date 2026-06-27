export enum StackDomain {
  WEB_SAAS = 'web_saas',
  MOBILE_RN = 'mobile_rn',
  MOBILE_FLUTTER = 'mobile_flutter',
  BLOCKCHAIN_EVM = 'blockchain_evm',
  BLOCKCHAIN_SOL = 'blockchain_solana',
  IOT_EMBEDDED = 'iot_embedded',
  AI_ML = 'ai_ml',
  DESKTOP = 'desktop',
  DATA_PLATFORM = 'data_platform',
  CLI_TOOL = 'cli_tool',
  BROWSER_EXT = 'browser_ext',
  GAME = 'game',
  SERVERLESS = 'serverless',
  DEVOPS = 'devops',
}

export enum AgentRole {
  PM = 'PM',
  DEV = 'DEV',
  TESTER = 'TESTER',
  DEVOPS = 'DEVOPS',
  PO = 'PO',
}

export enum TaskStatus {
  TODO = 'TODO',
  IN_PROGRESS = 'IN_PROGRESS',
  IN_REVIEW = 'IN_REVIEW',
  DONE = 'DONE',
  BLOCKED = 'BLOCKED',
}

export enum ProjectPhase {
  LOBBY = 'LOBBY',
  CLONING = 'CLONING',
  ANALYZING = 'ANALYZING',
  DETECTING = 'DETECTING',
  PLANNING = 'PLANNING',
  DEVELOPING = 'DEVELOPING',
  TESTING = 'TESTING',
  DONE = 'DONE',
  PAUSED = 'PAUSED',
  FAILED = 'FAILED',
}

export interface ProjectRequirement {
  raw: string;
  summary: string;
  workspaceId: string;
  slackChannelId: string;
  userId: string;
  createdAt: Date;
}

export interface DetectedStack {
  domains: StackDomain[];
  primaryDomain: StackDomain;
  languages: string[];
  frameworks: string[];
  ambiguities: Array<{ question: string; options: string[] }>;
  confidence: number;
}

export interface SprintBudget {
  allocatedTokens: number;
  usedTokens: number;
  remainingTokens: number;
  allocatedUsd: number;
  usedUsd: number;
  isOverBudget: boolean;
  isApproachingLimit: boolean;
}

export interface Task {
  id: string;
  jiraId: string;
  title: string;
  description: string;
  type: 'BE' | 'FE' | 'TEST' | 'INFRA' | 'DESIGN' | 'DEVOPS';
  status: TaskStatus;
  assignee: AgentRole;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  estimateHours: number;
  acceptanceCriteria: string[];
  dependsOn: string[];
  attempts: number;
}

export interface Sprint {
  id: string;
  goal: string;
  tasks: Task[];
  startDate: Date;
  endDate: Date;
}

export interface ProjectState {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  phase: ProjectPhase;
  requirement: ProjectRequirement;
  stack: DetectedStack;
  sprint: Sprint;
  codebase: Record<string, string>;
  prd: string;
  slackProjectChannelId: string;
  jiraProjectKey: string | null; // per-project Jira project key, e.g. "TASKAPP"
  jiraSprintId: string;
  githubRepo: string | null; // per-project GitHub repo, e.g. "owner/swarmly-task-app"
  githubBranch: string;
  budget: SprintBudget;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  sourceRepo?: string;
  repoAnalysis?: RepoAnalysis;
  targetBranch?: string;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  agentRole?: AgentRole;
  timestamp: Date;
  tokenCount?: number;
}

export type ConversationHistory = AgentMessage[];

export interface AgentOutput {
  success: boolean;
  content: string;
  tokenUsage: TokenUsage;
  error?: string;
  retryCount?: number;
}

export interface FileChange {
  path: string;
  content: string;
  action: 'create' | 'modify' | 'delete';
}

export interface CodeOutput {
  approach: string;
  files: FileChange[];
  explanation: string;
  testInstructions: string;
  dependencies: string[];
}

export interface TestCase {
  name: string;
  type: 'unit' | 'integration' | 'e2e';
  targetFile: string;
  scenario: string;
}

export interface TestPlan {
  unitTests: TestCase[];
  integrationTests: TestCase[];
  e2eTests: TestCase[];
}

export interface TestOutput {
  files: FileChange[];
  runCommand: string;
}

export interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  failures: Array<{ test: string; error: string }>;
}

export interface RepoIssue {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  description: string;
  file?: string;
}

export interface ImprovementArea {
  title: string;
  priority: 'MUST' | 'SHOULD' | 'COULD' | 'WONT';
  estimateHours: number;
  description: string;
}

export interface RepoAnalysis {
  repoUrl: string;
  repoName: string;
  detectedStack: string[];
  existingFeatures: string[];
  technicalDebt: RepoIssue[];
  securityConcerns: RepoIssue[];
  improvementAreas: ImprovementArea[];
  summary: string;
  fileCount: number;
  sampledFiles: string[];
}

export interface SampledRepo {
  repoPath: string;
  fileCount: number;
  sampledFiles: Array<{ path: string; content: string }>;
  fileTree: string[];
}

export interface BugReport {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  steps: string[];
  expected: string;
  actual: string;
  affectedFile: string;
  suggestedFix: string;
  jiraId: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheHits: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface CostReport {
  period: 'task' | 'sprint' | 'daily';
  byAgent: Record<AgentRole, TokenUsage>;
  total: TokenUsage;
  generatedAt: Date;
}

export interface LobbyMessage {
  text: string;
  userId: string;
  channelId: string;
  ts: string;
  history: ConversationHistory;
  workspaceId: string;
}

export interface AgentMention {
  targetAgent: AgentRole;
  text: string;
  userId: string;
  channelId: string;
  ts: string;
  projectId: string;
}

export interface CheckpointRequest {
  projectId: string;
  phase: ProjectPhase;
  summary: string;
  questions: string[];
  showCostSoFar: boolean;
  slackChannelId: string;
}

export interface CheckpointResponse {
  approved: boolean;
  feedback: string;
  userId: string;
  timestamp: Date;
}

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
}

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
}

export interface WorkspaceBudget {
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
  usedTodayUsd: number;
  usedThisMonthUsd: number;
}

export interface Workspace {
  id: string;
  name: string;
  slackTeamId: string;
  anthropicApiKey: string;
  jiraConfig: JiraConfig;
  githubConfig: GitHubConfig;
  budget: WorkspaceBudget;
  createdAt: Date;
}

export interface SandboxInfo {
  containerId: string;
  projectId: string;
  workDir: string;
  status: 'running' | 'stopped' | 'error';
  createdAt: Date;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  success: boolean;
}

export interface MemoryEntry {
  id: string;
  projectId: string;
  workspaceId: string;
  agentRole: AgentRole;
  content: string;
  embedding?: number[];
  createdAt: Date;
}
