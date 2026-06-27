# Swarmly — Your AI dev team, always on.

Swarmly turns a single Slack message into a production-ready codebase. Three AI agents — PM, Dev, and Tester — collaborate autonomously, then ask you to review at every checkpoint. You get working code, Jira tickets, and a GitHub PR without writing a single line yourself.

---

## What is Swarmly?

| Agent | Role | Model |
|-------|------|-------|
| **PM** | Clarifies requirements, writes the PRD, creates Jira tickets, runs daily standups | Claude Sonnet |
| **Dev** | Detects stack, implements features, commits code, creates GitHub branches | Claude Sonnet |
| **Tester** | Writes unit/integration/e2e tests, runs them in Docker sandbox, files bug reports | Claude Haiku / Sonnet |

The three agents share a **persistent project state** stored in MySQL and communicate through structured handoffs. Each phase (Planning → Developing → Testing) gates on your Slack approval, so you stay in control without babysitting the work.

---

## Quick Start

### Option A — Docker (recommended)

```bash
# 1. Clone the repository
git clone https://github.com/your-username/swarmly.git
cd swarmly

# 2. Copy and fill in environment variables
cp .env.example .env

# 3. Start (includes MySQL)
docker compose -f docker-compose.sample.yml up -d
```

### Option B — Local (join existing MySQL)

```bash
# 1. Clone and configure
git clone https://github.com/your-username/swarmly.git
cd swarmly
cp .env.example .env   # fill in all keys

# 2. Install dependencies
pnpm install

# 3. Create database and run migration
mysql -u root -p -e "CREATE DATABASE swarmly CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
pnpm db:migrate

# 4. Start Swarmly
pnpm start
```

### Invite the bot to Slack

After the app starts, **invite the bot to your lobby channel** — without this step the bot cannot see or respond to messages:

1. Open your **#lobby** channel in Slack
2. Type `/invite @swarmly` and send
3. The bot will appear as a member and start listening

> The bot only needs to be invited to **#lobby**. Project channels (`#project-xxx`) are created and joined by the bot automatically when a project starts.

---

## How It Works

```
User message in #lobby
        │
        ▼
  PM Agent clarifies requirements
  (multi-turn conversation)
        │
        ▼
  "Ready to build?" confirmation block
        │  [Confirm]
        ▼
  Auto-creates Jira project + GitHub repo
        │
        ▼
  PM writes PRD + creates sprint tasks    ◄── Checkpoint #1: you approve the PRD
        │
        ▼
  Dev implements features task-by-task   ◄── Git commits per task
        │
        ▼
  Tester writes + runs tests in Docker   ◄── Checkpoint #2: you review test results
        │
        ▼
  GitHub PR created, Jira tickets closed
  Summary posted in #project-{slug}
```

All activity is streamed to the **web dashboard** at `http://localhost:3001` — live logs, token usage, cost tracking, pause/resume controls.

---

## Supported Stacks

| Domain | Frameworks | Testing |
|--------|-----------|---------|
| Web SaaS | Next.js, React, Express, Fastify | Vitest, Playwright, Supertest |
| Mobile (React Native) | Expo, React Native | Jest, Detox |
| Mobile (Flutter) | Flutter, Dart | flutter_test, integration_test |
| Blockchain (EVM) | Hardhat, Solidity, ethers.js | Hardhat tests, Foundry |
| Blockchain (Solana) | Anchor, Rust | Anchor tests |
| AI / ML | Python, FastAPI, LangChain | pytest, pytest-asyncio |
| Desktop | Electron, Tauri | Playwright Electron |
| Data Platform | dbt, Airflow, Spark | Great Expectations, pytest |
| IoT / Embedded | C/C++, MicroPython, Rust | Unity Test Framework |
| CLI Tool | Node.js, Go, Rust | Jest / Vitest |
| Browser Extension | Chrome Extension API | Jest / Vitest |
| Game | Phaser, Unity (WebGL) | Jest / Vitest |
| Serverless | AWS Lambda, Vercel Functions | Jest / Vitest |
| DevOps | Terraform, Ansible, Docker | Jest / Vitest |

---

## Cost Estimation

| Project Type | Estimated Cost |
|---|---|
| Simple CRUD API | ~$0.50 |
| Full-stack SaaS (MVP) | ~$3–5 |
| Mobile app with tests | ~$6–10 |
| Complex multi-service | ~$15–25 |

You can set daily and monthly budget caps per workspace. Swarmly stops automatically if a limit is reached.

---

## Architecture

```
swarmly/
├── agents/              # AI agent implementations
│   ├── base-agent.ts    # Anthropic SDK wrapper with retry + caching
│   ├── pm-agent.ts      # PM: PRD, sprint planning, lobby chat, standups
│   ├── dev-agent.ts     # Dev: code generation, file writing, git commits
│   └── tester-agent.ts  # Tester: test generation + sandbox execution
│
├── orchestrator/        # Coordination layer
│   ├── index.ts         # Entry point — Slack event routing, cron jobs
│   ├── pipeline.ts      # Sequential phase runner (Planning→Dev→Testing)
│   ├── stack-detector.ts
│   ├── human-checkpoint.ts
│   └── task-queue.ts
│
├── integrations/
│   ├── slack-listener.ts   # Bolt App (Socket Mode): messages, actions, commands
│   ├── slack-channels.ts
│   ├── slack-messages.ts   # Block Kit builders
│   ├── jira.ts             # Per-project Jira projects + sprints + tickets
│   └── github.ts           # Per-project GitHub repos + branches + PRs
│
├── memory/
│   ├── state-store.ts      # ProjectState CRUD (MySQL)
│   ├── long-term-memory.ts # Semantic memory with JS cosine similarity
│   └── migrations/
│       └── 001_initial.sql # Full MySQL schema
│
├── auth/
│   ├── workspace.ts
│   ├── middleware.ts
│   └── api-keys.ts
│
├── cost-control/
│   ├── token-tracker.ts
│   ├── budget-guard.ts
│   └── model-router.ts
│
├── dashboard/
│   └── server.ts        # Express REST API + SSE log streaming
│
├── sandbox/             # Docker execution environment
├── tools/               # Agent tool definitions
├── config/config.ts
├── types/index.ts
├── Dockerfile
├── docker-compose.yml         # Production: joins existing MySQL network
├── docker-compose.sample.yml  # Standalone: includes own MySQL container
└── .env.example
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key (`sk-ant-...`) |
| `DB_HOST` | No | MySQL host (default: `localhost`) |
| `DB_PORT` | No | MySQL port (default: `3306`) |
| `DB_USER` | Yes | MySQL username |
| `DB_PASSWORD` | Yes | MySQL password |
| `DB_NAME` | No | MySQL database name (default: `swarmly`) |
| `SLACK_BOT_TOKEN` | Yes | Bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Yes | Slack signing secret |
| `SLACK_APP_TOKEN` | Yes | Socket Mode app token (`xapp-...`) |
| `SLACK_LOBBY_CHANNEL` | Yes | Channel ID where users start projects (`C...`) |
| `SLACK_BOT_USER_ID` | Yes | Bot's own user ID — prevents self-reply loops (`U...`) |
| `JIRA_BASE_URL` | Yes | Atlassian instance URL |
| `JIRA_EMAIL` | Yes | Email for Jira API auth |
| `JIRA_API_TOKEN` | Yes | Jira API token |
| `JIRA_PROJECT_KEY` | No | Optional fallback Jira project key — Swarmly auto-creates one per project |
| `GITHUB_TOKEN` | Yes | Personal access token with `repo` scope |
| `GITHUB_OWNER` | Yes | GitHub username or org |
| `GITHUB_REPO` | No | Optional fallback repo — Swarmly auto-creates one per project |
| `DASHBOARD_PORT` | No | Dashboard port (default: `3001`) |
| `JWT_SECRET` | Yes | Secret for dashboard JWT tokens |

---

## Slash Commands

| Command | Description |
|---------|-------------|
| `/swarmly-status` | Current phase, sprint goal, and cost |
| `/swarmly-cost` | Token + cost breakdown by agent |
| `/swarmly-pause` | Pause the pipeline |
| `/swarmly-resume` | Resume a paused project |
| `/swarmly-help` | List all commands |

---

## Contributing

1. Fork the repo and create a feature branch
2. Make your changes: `pnpm test`
3. Typecheck: `pnpm typecheck`
4. Lint: `pnpm lint`
5. Open a PR

---

## License

MIT
