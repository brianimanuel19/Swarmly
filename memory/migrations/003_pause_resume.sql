-- Migration 003: Add pause/resume columns to projects table
DROP PROCEDURE IF EXISTS migrate_003;

DELIMITER $
CREATE PROCEDURE migrate_003()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projects' AND column_name = 'pause_reason'
  ) THEN
    ALTER TABLE projects ADD COLUMN pause_reason VARCHAR(50) DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projects' AND column_name = 'paused_at_task_id'
  ) THEN
    ALTER TABLE projects ADD COLUMN paused_at_task_id VARCHAR(100) DEFAULT NULL;
  END IF;
END$
DELIMITER ;

CALL migrate_003();
DROP PROCEDURE IF EXISTS migrate_003;
