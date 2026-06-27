-- Migration 002: Add repo analysis fields to projects (MySQL 8.0)
-- Run after 001_initial.sql
-- Note: MySQL 8.0 does not support ADD COLUMN IF NOT EXISTS.
-- Use the procedure below or run each ALTER only if the column is absent.

DROP PROCEDURE IF EXISTS migrate_002;

DELIMITER $$
CREATE PROCEDURE migrate_002()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projects' AND column_name = 'source_repo'
  ) THEN
    ALTER TABLE projects ADD COLUMN source_repo VARCHAR(500) DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projects' AND column_name = 'repo_analysis'
  ) THEN
    ALTER TABLE projects ADD COLUMN repo_analysis JSON DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projects' AND column_name = 'target_branch'
  ) THEN
    ALTER TABLE projects ADD COLUMN target_branch VARCHAR(500) DEFAULT NULL;
  END IF;
END$$
DELIMITER ;

CALL migrate_002();
DROP PROCEDURE IF EXISTS migrate_002;
