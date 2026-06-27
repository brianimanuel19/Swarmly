-- Migration 001: Initial Schema (MySQL 8.0)
-- No extensions required. App generates UUIDs. No triggers; updated_at uses ON UPDATE.

-- ============================================================
-- workspaces
-- ============================================================
CREATE TABLE IF NOT EXISTS workspaces (
  id                    VARCHAR(36)    NOT NULL,
  slack_team_id         VARCHAR(255)   NOT NULL,
  team_name             VARCHAR(500)   NOT NULL,
  anthropic_api_key     VARCHAR(500)   NOT NULL,
  jira_config           JSON           DEFAULT NULL,
  github_config         JSON           DEFAULT NULL,
  daily_budget_usd      DECIMAL(10, 2) NOT NULL DEFAULT 50.00,
  monthly_budget_usd    DECIMAL(10, 2) NOT NULL DEFAULT 500.00,
  used_today_usd        DECIMAL(10, 6) NOT NULL DEFAULT 0.000000,
  used_this_month_usd   DECIMAL(10, 6) NOT NULL DEFAULT 0.000000,
  created_at            DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_workspaces_slack_team_id (slack_team_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- projects
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id                    VARCHAR(36)    NOT NULL,
  workspace_id          VARCHAR(36)    NOT NULL,
  slug                  VARCHAR(500)   NOT NULL,
  name                  VARCHAR(500)   NOT NULL,
  phase                 VARCHAR(100)   NOT NULL DEFAULT 'LOBBY',
  requirement           JSON           DEFAULT NULL,
  stack                 JSON           DEFAULT NULL,
  prd                   LONGTEXT       DEFAULT NULL,
  sprint                JSON           DEFAULT NULL,
  slack_project_channel VARCHAR(255)   DEFAULT NULL,
  jira_sprint_id        VARCHAR(255)   DEFAULT NULL,
  github_branch         VARCHAR(500)   DEFAULT NULL,
  budget                JSON           DEFAULT NULL,
  jira_project_key      VARCHAR(50)    DEFAULT NULL,
  github_repo           VARCHAR(500)   DEFAULT NULL,
  created_at            DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  completed_at          DATETIME(3)    DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_projects_workspace_slug (workspace_id, slug),
  CONSTRAINT fk_projects_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- project_files — one row per file, replaces JSON codebase blob
-- ============================================================
CREATE TABLE IF NOT EXISTS project_files (
  id          VARCHAR(36)    NOT NULL,
  project_id  VARCHAR(36)    NOT NULL,
  file_path   VARCHAR(1000)  NOT NULL,
  content     LONGTEXT       NOT NULL,
  updated_at  DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_project_files (project_id, file_path(500)),
  CONSTRAINT fk_project_files_project
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- agent_memories
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_memories (
  id           VARCHAR(36)  NOT NULL,
  project_id   VARCHAR(36)  NOT NULL,
  workspace_id VARCHAR(36)  NOT NULL,
  agent_role   VARCHAR(100) NOT NULL,
  content      TEXT         NOT NULL,
  embedding    LONGTEXT     DEFAULT NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_agent_memories_project
    FOREIGN KEY (project_id)   REFERENCES projects   (id) ON DELETE CASCADE,
  CONSTRAINT fk_agent_memories_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- token_usage_log
-- ============================================================
CREATE TABLE IF NOT EXISTS token_usage_log (
  id            VARCHAR(36)    NOT NULL,
  project_id    VARCHAR(36)    NOT NULL,
  workspace_id  VARCHAR(36)    NOT NULL,
  agent_role    VARCHAR(100)   NOT NULL,
  model         VARCHAR(255)   NOT NULL,
  input_tokens  INT            NOT NULL DEFAULT 0,
  output_tokens INT            NOT NULL DEFAULT 0,
  cache_hits    INT            NOT NULL DEFAULT 0,
  cost_usd      DECIMAL(10, 6) NOT NULL DEFAULT 0.000000,
  created_at    DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_token_usage_project
    FOREIGN KEY (project_id)   REFERENCES projects   (id) ON DELETE CASCADE,
  CONSTRAINT fk_token_usage_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- sandboxes
-- ============================================================
CREATE TABLE IF NOT EXISTS sandboxes (
  id           VARCHAR(36)  NOT NULL,
  project_id   VARCHAR(36)  NOT NULL,
  container_id VARCHAR(255) NOT NULL,
  work_dir     VARCHAR(500) NOT NULL,
  status       VARCHAR(50)  NOT NULL DEFAULT 'running',
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sandboxes_container_id (container_id),
  CONSTRAINT fk_sandboxes_project
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- Indexes (run once; no IF NOT EXISTS on CREATE INDEX in MySQL 8.0)
-- ============================================================
CREATE INDEX idx_projects_workspace_id       ON projects       (workspace_id);
CREATE INDEX idx_agent_memories_project_id   ON agent_memories (project_id);
CREATE INDEX idx_agent_memories_workspace_id ON agent_memories (workspace_id);
CREATE INDEX idx_agent_memories_agent_role   ON agent_memories (agent_role);
CREATE INDEX idx_token_usage_project_id      ON token_usage_log (project_id);
CREATE INDEX idx_token_usage_workspace_id    ON token_usage_log (workspace_id);
CREATE INDEX idx_token_usage_created_at      ON token_usage_log (created_at);
CREATE INDEX idx_sandboxes_project_id        ON sandboxes       (project_id);
CREATE INDEX idx_project_files_project_id    ON project_files   (project_id);
