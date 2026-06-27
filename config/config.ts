import dotenv from 'dotenv';

dotenv.config();

export interface AnthropicModelPricing {
  input: number;
  output: number;
  cacheHit: number;
}

export interface AnthropicConfig {
  apiKey: string;
  models: {
    pm: string;
    dev: string;
    tester: string;
    testerComplex: string;
    lobby: string;
  };
  pricing: Record<string, AnthropicModelPricing>;
}

export interface BudgetConfig {
  maxTokensPerSprint: number;
  maxTokensPerTask: number;
  warningThreshold: number;
  maxCostUsdPerDay: number;
  maxRetriesPerTask: number;
}

export interface RateLimitConfig {
  requestsPerMinute: number;
  tokensPerMinute: number;
  retryDelayMs: number;
  maxRetries: number;
}

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  poolSize: number;
}

export interface SlackConfig {
  botToken: string;
  signingSecret: string;
  appToken: string;
  lobbyChannelId: string;
  chatChannelId: string | undefined; // optional dedicated chat/test channel
  botUserId: string;
  channelPrefix: string;
}

export interface JiraConfigEntry {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string | undefined; // optional default; each project auto-creates its own Jira project
}

export interface GitHubConfigEntry {
  token: string;
  owner: string;
  repo: string | undefined; // optional default; each project auto-creates its own GitHub repo
}

export interface SandboxConfig {
  dockerSocket: string;
  workspaceBase: string;
  maxConcurrent: number;
  timeoutMs: number;
  memoryLimitMb: number;
  cpuQuota: number;
}

export interface CheckpointsConfig {
  requireAfterPRD: boolean;
  requireAfterDesign: boolean;
  requireAfterCoding: boolean;
  requireAfterTesting: boolean;
  timeoutMs: number;
  reminderIntervalMs: number;
}

export interface DashboardConfig {
  port: number;
  jwtSecret: string;
}

export interface AppConfig {
  anthropic: AnthropicConfig;
  budget: BudgetConfig;
  rateLimit: RateLimitConfig;
  db: DbConfig;
  slack: SlackConfig;
  jira: JiraConfigEntry;
  github: GitHubConfigEntry;
  sandbox: SandboxConfig;
  checkpoints: CheckpointsConfig;
  dashboard: DashboardConfig;
}

export const config: AppConfig = {
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
    models: {
      pm: 'claude-sonnet-4-6',
      dev: 'claude-sonnet-4-6',
      tester: 'claude-haiku-4-5-20251001',
      testerComplex: 'claude-sonnet-4-6',
      lobby: 'claude-haiku-4-5-20251001',
    },
    pricing: {
      'claude-sonnet-4-6': {
        input: 3.0,
        output: 15.0,
        cacheHit: 0.3,
      },
      'claude-haiku-4-5-20251001': {
        input: 1.0,
        output: 5.0,
        cacheHit: 0.1,
      },
    },
  },

  budget: {
    maxTokensPerSprint: 5_000_000,
    maxTokensPerTask: 500_000,
    warningThreshold: 0.8,
    maxCostUsdPerDay: 50,
    maxRetriesPerTask: 3,
  },

  rateLimit: {
    requestsPerMinute: 50,
    tokensPerMinute: 100_000,
    retryDelayMs: 2_000,
    maxRetries: 3,
  },

  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '3306', 10),
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_NAME ?? 'swarmly',
    poolSize: 10,
  },

  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    appToken: process.env.SLACK_APP_TOKEN!,
    lobbyChannelId: process.env.SLACK_LOBBY_CHANNEL!,
    chatChannelId: process.env.SLACK_CHAT_CHANNEL,
    botUserId: process.env.SLACK_BOT_USER_ID!,
    channelPrefix: 'project-',
  },

  jira: {
    baseUrl: process.env.JIRA_BASE_URL!,
    email: process.env.JIRA_EMAIL!,
    apiToken: process.env.JIRA_API_TOKEN!,
    projectKey: process.env.JIRA_PROJECT_KEY, // optional — auto-created per project
  },

  github: {
    token: process.env.GITHUB_TOKEN!,
    owner: process.env.GITHUB_OWNER!,
    repo: process.env.GITHUB_REPO, // optional — auto-created per project
  },

  sandbox: {
    dockerSocket: '/var/run/docker.sock',
    workspaceBase: '/tmp/swarmly-workspaces',
    maxConcurrent: 5,
    timeoutMs: 300_000,
    memoryLimitMb: 512,
    cpuQuota: 50000,
  },

  checkpoints: {
    requireAfterPRD: true,
    requireAfterDesign: true,
    requireAfterCoding: false,
    requireAfterTesting: true,
    timeoutMs: 3_600_000,
    reminderIntervalMs: 1_800_000,
  },

  dashboard: {
    port: parseInt(process.env.DASHBOARD_PORT ?? '3000', 10),
    jwtSecret: process.env.JWT_SECRET!,
  },
};

const requiredEnvVars: string[] = [
  'ANTHROPIC_API_KEY',
  'DB_USER',
  'DB_PASSWORD',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_APP_TOKEN',
  'SLACK_LOBBY_CHANNEL',
  'SLACK_BOT_USER_ID',
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  // JIRA_PROJECT_KEY — optional; Swarmly auto-creates a Jira project per run
  'GITHUB_TOKEN',
  'GITHUB_OWNER',
  // GITHUB_REPO — optional; Swarmly auto-creates a GitHub repo per run
  'JWT_SECRET',
];

const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);

if (missingVars.length > 0) {
  throw new Error(
    `Missing required environment variables:\n${missingVars.map((v) => `  - ${v}`).join('\n')}`,
  );
}
