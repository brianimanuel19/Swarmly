# Swarmly 🤖 — Your AI dev team, always on.

Swarmly turns a single Slack message into a production-ready codebase. Three AI agents — PM, Dev, and Tester — collaborate autonomously, then ask you to review at every checkpoint. You get working code, Jira tickets, and a GitHub PR without writing a single line yourself.

---

## What is Swarmly?

| Agent | Role | Model |
|-------|------|-------|
| **PM** | Clarifies requirements, writes the PRD, creates Jira tickets, runs daily standups | Claude Sonnet |
| **Dev** | Detects stack, implements features, commits code, creates GitHub branches | Claude Sonnet |
| **Tester** | Writes unit/integration/e2e tests, runs them in Docker sandbox, files bug reports | Claude Haiku / Sonnet |

The three agents share a **persistent project state** stored in PostgreSQL and communicate through structured handoffs. Each phase (Planning → Developing → Testing) gates on your Slack approval, so you stay in control without babysitting the work.

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/your-username/swarmly.git
cd swarmly

# 2. Copy environment variables and fill them in
cp .env.example .env
# Edit .env with your Anthropic, Slack, GitHub, Jira keys

# 3. Start the database
docker-compose up postgres -d

# 4. Install dependencies
pnpm install

# 5. Run database migrations
pnpm db:migrate

# 6. Start Swarmly
pnpm start
```

The bot will connect to Slack via Socket Mode (no public URL required). Open your `#lobby` channel and start chatting.

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
  Stack Detector identifies technologies
        │
        ▼
  PM writes PRD + creates Jira sprint    ◄── Checkpoint #1: you approve the PRD
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

All activity is streamed to the **web dashboard** at `http://localhost:3001` — live logs, token usage bars, cost tracking, pause/resume controls.

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

---

## Cost Estimation

Costs depend on project complexity and which Claude models are used. Rough estimates:

| Project Type | Input Tokens | Output Tokens | Estimated Cost |
|--------------|-------------|---------------|----------------|
| Simple CRUD API | ~50k | ~20k | ~$0.50 |
| Full-stack SaaS (MVP) | ~300k | ~120k | ~$3–5 |
| Mobile app with tests | ~500k | ~200k | ~$6–10 |
| Complex multi-service | ~1M | ~400k | ~$15–25 |

You can set daily and monthly budget caps per workspace in the `workspaces` table. Swarmly stops automatically if a limit is reached.

---

## Architecture

```
swarmly/
├── agents/              # AI agent base class and prompt logic
│   ├── base-agent.ts    # Anthropic SDK wrapper with retry + caching
│   ├── pm-agent.ts      # PM: PRD, sprint planning, lobby chat, standups
│   ├── dev-agent.ts     # Dev: code generation, file writing, git commits
│   └── tester-agent.ts  # Tester: test generation + sandbox execution
│
├── orchestrator/        # Coordination layer
│   ├── index.ts         # Entry point — Slack event routing, cron jobs
│   ├── pipeline.ts      # Sequential phase runner (Planning→Dev→Testing)
│   ├── stack-detector.ts # LLM-powered stack classification
│   ├── human-checkpoint.ts # Async Slack approval gates
│   └── task-queue.ts    # Rate-limited priority task queue
│
├── integrations/        # External service clients
│   ├── slack-listener.ts   # Bolt App: messages, actions, slash commands
│   ├── slack-channels.ts   # Channel creation + management
│   ├── slack-messages.ts   # Block Kit message builders
│   ├── jira.ts             # Sprint + ticket management
│   └── github.ts           # Branch + PR management via Octokit
│
├── memory/              # Persistence
│   ├── state-store.ts      # ProjectState CRUD (PostgreSQL)
│   ├── long-term-memory.ts # pgvector semantic memory
│   └── migrations/         # SQL migration files
│
├── auth/                # Authentication
│   ├── workspace.ts     # Multi-tenant workspace manager
│   ├── middleware.ts    # JWT auth middleware for Express
│   └── api-keys.ts      # API key creation, validation, revocation
│
├── cost-control/        # Budget management
│   ├── token-tracker.ts # Per-agent token tallies
│   ├── budget-guard.ts  # Enforce daily/sprint token limits
│   └── model-router.ts  # Auto-select cheaper model for simple tasks
│
├── dashboard/           # Web UI
│   ├── server.ts        # Express API server + SSE log streaming
│   └── public/
│       └── index.html   # Single-page dashboard (vanilla JS, dark mode)
│
├── sandbox/             # Docker execution environment
│   └── docker-runner.ts # Spin up containers for test execution
│
├── tools/               # Agent tool definitions (file I/O, shell, git)
├── config/config.ts     # Typed config from env vars
├── types/index.ts       # Shared TypeScript interfaces and enums
├── package.json
├── tsconfig.json
├── docker-compose.yml
└── .env.example
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key (`sk-ant-api03-…`) |
| `DATABASE_URL` | Yes | PostgreSQL connection string (must have pgvector) |
| `SLACK_BOT_TOKEN` | Yes | Bot OAuth token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | Yes | Used to verify Slack request signatures |
| `SLACK_APP_TOKEN` | Yes | Socket Mode app token (`xapp-…`) |
| `SLACK_LOBBY_CHANNEL` | Yes | Channel ID where users start new projects |
| `SLACK_BOT_USER_ID` | Yes | Bot's own user ID (to avoid self-reply loops) |
| `JIRA_BASE_URL` | Yes | Your Atlassian instance URL |
| `JIRA_EMAIL` | Yes | Email for Jira API auth |
| `JIRA_API_TOKEN` | Yes | Jira API token |
| `JIRA_PROJECT_KEY` | Yes | Key for the Jira project (e.g. `SWM`) |
| `GITHUB_TOKEN` | Yes | Personal access token with `repo` scope |
| `GITHUB_OWNER` | Yes | GitHub username or org that owns the repo |
| `GITHUB_REPO` | Yes | Repository where code will be pushed |
| `DASHBOARD_PORT` | No | Dashboard HTTP port (default: `3001`) |
| `JWT_SECRET` | Yes | Secret for signing dashboard JWT tokens |
| `DOCKER_SOCKET` | No | Docker socket path (default: `/var/run/docker.sock`) |

---

## Slash Commands

Once Swarmly is running, these commands work in any project channel:

| Command | Description |
|---------|-------------|
| `/swarmly-status` | Show current phase, sprint goal, and cost |
| `/swarmly-cost` | Detailed token + cost breakdown by agent |
| `/swarmly-pause` | Pause the pipeline (agents stop at next safe point) |
| `/swarmly-resume` | Resume a paused project |
| `/swarmly-help` | List all commands |

---

## Contributing

1. Fork the repo and create a feature branch
2. Make your changes with tests: `pnpm test`
3. Typecheck: `pnpm typecheck`
4. Lint: `pnpm lint`
5. Open a PR — Swarmly will review its own PRs soon enough

---

## License

MIT — see [LICENSE](LICENSE) for details.
