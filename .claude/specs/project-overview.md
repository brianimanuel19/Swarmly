# Swarmly — Project Overview

## What It Is

Swarmly is an AI agent team that autonomously builds software. A user describes a project in Slack, and three AI agents (PM, Dev, Tester) collaborate to plan, implement, and test it — with Jira tracking, GitHub commits, and a live dashboard.

---

## Architecture at a Glance

```
User (Slack)
    │
    ▼
Orchestrator ──── Slack Listener (Socket Mode)
    │
    ▼
Pipeline ─────────────────────────────────────────┐
    │                                              │
    ├─ PM Agent (Sonnet)     → PRD + sprint plan   │
    ├─ Dev Agent (Sonnet)    → code implementation  │
    └─ Tester Agent (Haiku/Sonnet) → tests + bugs  │
                                                   │
    ┌──────────────────────────────────────────────┘
    │
    ├─ MySQL          (state, memory, token logs)
    ├─ Jira           (per-project: sprints, tasks, bugs)
    ├─ GitHub         (per-project: repo, branches, PRs)
    ├─ Docker Sandbox (isolated code execution)
    └─ Dashboard      (Express REST + SSE, JWT auth)
```

---

## Directory Structure

```
swarmly/
├── agents/                  # AI agent implementations
│   ├── base-agent.ts        # Shared Claude call logic, retry, token tracking
│   ├── pm-agent.ts          # Lobby chat, PRD, sprint planning, output review
│   ├── dev-agent.ts         # Code implementation, bug fixing
│   └── tester-agent.ts      # Test plans, test generation, bug reports
│
├── orchestrator/            # Main coordination layer
│   ├── index.ts             # Entry point, Slack handlers, cron standup
│   ├── pipeline.ts          # Phase-by-phase execution (DETECTING → DONE)
│   ├── stack-detector.ts    # Detects stack domain from requirement text
│   ├── context-loader.ts    # Loads system prompts + stack profile per domain
│   ├── human-checkpoint.ts  # Approval gates with Slack prompts + timeout
│   └── task-queue.ts        # Concurrent task execution with rate limiting
│
├── agents/                  # (see above)
│
├── integrations/
│   ├── slack-listener.ts    # Bolt app, socket mode, all event handlers
│   ├── slack-channels.ts    # Channel creation and membership management
│   ├── slack-messages.ts    # Block Kit message builders
│   ├── jira.ts              # Jira REST: projects, sprints, tasks, bugs
│   └── github.ts            # Octokit: repos, branches, commits, PRs
│
├── memory/
│   ├── state-store.ts       # ProjectState CRUD + token usage logging (MySQL)
│   ├── long-term-memory.ts  # Agent memory with JS cosine similarity recall
│   └── migrations/
│       └── 001_initial.sql  # Full MySQL schema (workspaces → sandboxes)
│
├── auth/
│   ├── workspace.ts         # Workspace get-or-create, budget tracking
│   ├── api-keys.ts          # API key creation, validation, revocation
│   └── middleware.ts        # JWT middleware for dashboard routes
│
├── cost-control/
│   ├── model-router.ts      # Selects model (Sonnet/Haiku) by agent + domain
│   ├── budget-guard.ts      # Enforces token/cost limits per sprint
│   └── token-tracker.ts    # Accumulates usage across agents
│
├── sandbox/
│   ├── sandbox-manager.ts   # Docker container lifecycle (create/destroy)
│   ├── executor.ts          # Run commands in container, parse test output
│   └── workspace-manager.ts # File sync between DB codebase and container FS
│
├── dashboard/
│   └── server.ts            # Express: /api/projects, /api/costs, /api/workspaces, SSE logs
│
├── context/
│   ├── prompt-templates/    # System prompts: pm-system.md, dev-system.md, tester-system.md
│   └── stack-profiles/      # Per-domain context: web-saas.md, ai-ml.md, blockchain-evm.md …
│
├── tools/
│   ├── tool-registry.ts     # Agent tool definitions (file read, search, web fetch)
│   ├── file-reader.ts
│   ├── search.ts
│   └── web-fetcher.ts
│
├── types/index.ts           # All enums and interfaces
├── config/config.ts         # Typed config + env var validation at boot
├── docker-compose.yml       # Production: joins existing mysql network
├── docker-compose.sample.yml# Standalone: includes own mysql container
└── .env.example
```

---

## Project Lifecycle

```
1. LOBBY       User describes project in Slack → PM agent (Haiku) clarifies
2. DETECTING   Stack auto-detected from requirement text
3. PLANNING    PM creates PRD → sprint plan → Jira project + tasks created
               Human checkpoint (optional, configurable)
4. DEVELOPING  Dev agent implements tasks → commits to GitHub → updates Jira
               Human checkpoint after design (optional)
5. TESTING     Tester generates tests → runs in Docker sandbox → files bugs
               Human checkpoint after testing
6. DONE / FAILED
```

Each phase persists state to MySQL so the pipeline can resume after restarts.

---

## Key Types

| Type | Description |
|---|---|
| `ProjectState` | Central object: id, phase, stack, sprint, codebase, budget, jira/github refs |
| `DetectedStack` | domains[], primaryDomain, languages[], frameworks[], confidence |
| `Task` | id, jiraId, title, type (BE/FE/TEST/INFRA/DESIGN), status, assignee, priority |
| `Sprint` | id, goal, tasks[], startDate, endDate |
| `SprintBudget` | allocated/used tokens + USD, isOverBudget, isApproachingLimit |
| `MemoryEntry` | Agent decision stored with embedding for future recall |
| `TokenUsage` | inputTokens, outputTokens, cacheHits, estimatedCostUsd |

---

## Stack Domains (14 total)

`WEB_SAAS` · `MOBILE_RN` · `MOBILE_FLUTTER` · `BLOCKCHAIN_EVM` · `BLOCKCHAIN_SOL` · `IOT_EMBEDDED` · `AI_ML` · `DESKTOP` · `DATA_PLATFORM` · `CLI_TOOL` · `BROWSER_EXT` · `GAME` · `SERVERLESS` · `DEVOPS`

Each domain maps to:
- A Docker image for sandbox execution
- A stack profile markdown file loaded into agent context
- An estimated cost range and time range
- A testing framework selection

---

## Model Routing

| Scenario | Model |
|---|---|
| PM agent (all tasks) | `claude-sonnet-4-6` |
| Dev agent (all tasks) | `claude-sonnet-4-6` |
| Tester — complex domain (blockchain, AI/ML, game) | `claude-sonnet-4-6` |
| Tester — simple domain | `claude-haiku-4-5-20251001` |
| Lobby chat | `claude-haiku-4-5-20251001` |

---

## Per-Project Isolation

When a project is confirmed in the lobby:
- A **Jira project** is auto-created with a unique key derived from the project name (e.g. `TASKAPP`)
- A **GitHub repo** is auto-created named `swarmly-{slug}-{shortId}` (private by default)
- A **Slack channel** `project-{slug}` is created for that project
- All resources are stored in `ProjectState` and persisted to MySQL

---

## Database Schema (MySQL 8.0)

| Table | Purpose |
|---|---|
| `workspaces` | Slack team → API keys, budget limits |
| `projects` | Full ProjectState as JSON columns |
| `agent_memories` | Per-project memories with embedding (LONGTEXT JSON) |
| `token_usage_log` | Every Claude API call: tokens, cost, agent, model |
| `sandboxes` | Active Docker container references |

Single migration file: `memory/migrations/001_initial.sql`

---

## Cost Controls

- **Per-sprint token budget**: 5M tokens / $50 USD (configurable)
- **Per-task cap**: 500K tokens
- **Daily workspace cap**: $50 USD
- **Warning threshold**: 80% of budget triggers alert
- **Max retries per task**: 3

Token usage is logged to `token_usage_log` after every Claude call and viewable on the dashboard at `/api/costs/summary`.

---

## Human Checkpoints

Checkpoints pause the pipeline and post a Slack approval block. Configurable in `config.ts`:

| Checkpoint | Default |
|---|---|
| After PRD | enabled |
| After design | enabled |
| After coding | disabled |
| After testing | enabled |
| Timeout | 1 hour |
| Reminder interval | 30 min |

---

## Environment Variables

**Required:**
```
ANTHROPIC_API_KEY
DB_USER, DB_PASSWORD
SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN
SLACK_LOBBY_CHANNEL, SLACK_BOT_USER_ID
JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
GITHUB_TOKEN, GITHUB_OWNER
JWT_SECRET
```

**Optional:**
```
DB_HOST (default: localhost)
DB_PORT (default: 3306)
DB_NAME (default: swarmly)
DASHBOARD_PORT (default: 3001)
JIRA_PROJECT_KEY   # fallback default; each project auto-creates its own
GITHUB_REPO        # fallback default; each project auto-creates its own
```

---

## Running the Project

```bash
# Install
pnpm install

# Configure
cp .env.example .env   # fill in API keys

# Database (first time)
pnpm db:migrate

# Development
pnpm dev               # tsx watch — hot reload

# Production
pnpm start

# Dashboard only
pnpm dashboard

# Type check
pnpm typecheck

# Lint / format
pnpm lint
pnpm format
```

**Docker (standalone):**
```bash
docker compose -f docker-compose.sample.yml up -d
```

**Docker (join existing MySQL on server):**
```bash
# Edit docker-compose.yml: set networks.mysql_net.name to your existing network
docker compose up -d
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+, TypeScript ESM (`"type": "module"`) |
| AI | `@anthropic-ai/sdk` (claude-sonnet-4-6, claude-haiku) |
| Slack | `@slack/bolt` Socket Mode |
| GitHub | `@octokit/rest` |
| Database | MySQL 8.0 via `mysql2/promise` |
| Sandbox | Docker via `dockerode` |
| Web server | Express 4 |
| Auth | JWT (`jsonwebtoken`) |
| Scheduling | `node-cron` (daily standup 9 AM Asia/Ho_Chi_Minh) |
| Validation | `zod` |
| Package manager | pnpm |
| Process manager | PM2 (production) |
