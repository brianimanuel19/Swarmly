CREATE TABLE IF NOT EXISTS pending_projects (
  pending_key  VARCHAR(255) NOT NULL,
  data         JSON         NOT NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (pending_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
