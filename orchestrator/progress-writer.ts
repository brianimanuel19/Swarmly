import fs from 'fs';
import path from 'path';
import type { ProjectState, Task, TaskStatus } from '../types/index.js';

const STATUS_LABEL: Record<string, string> = {
  DONE:        'DONE (100%)',
  PAUSED:      'PAUSED',
  IN_PROGRESS: 'IN_PROGRESS',
  IN_REVIEW:   'IN_REVIEW',
  BLOCKED:     'BLOCKED',
  TODO:        'TODO (0%)',
};

function pct(task: Task): number {
  const total = task.acceptanceCriteria?.length ?? 0;
  if (total === 0) return task.status === 'DONE' ? 100 : 0;
  const done = task.completedCriteria?.length ?? 0;
  return Math.round((done / total) * 100);
}

function formatTask(task: Task): string {
  const statusKey = task.status as string;
  let statusLine = STATUS_LABEL[statusKey] ?? statusKey;

  if ((task.status as string) === 'PAUSED' || (task.status as string) === 'IN_PROGRESS') {
    const p = pct(task);
    statusLine = `${statusKey} (${p}%)`;
  }

  const lines: string[] = [
    `### [${statusLine}] ${task.title}`,
    `Description: ${task.description}`,
    `Type: ${task.type} | Priority: ${task.priority} | Est: ${task.estimateHours}h`,
    `Acceptance criteria:`,
  ];

  for (const criterion of task.acceptanceCriteria ?? []) {
    const done = task.completedCriteria?.includes(criterion) ?? false;
    lines.push(`  - [${done ? 'x' : ' '}] ${criterion}`);
  }

  const files = task.filesWritten ?? [];
  lines.push(`Files written: ${files.length > 0 ? files.join(', ') : '—'}`);

  return lines.join('\n');
}

export class ProgressWriter {
  private filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, 'swarmly-progress.md');
  }

  write(project: ProjectState): void {
    const tasks = project.sprint?.tasks ?? [];
    const done = tasks.filter((t) => (t.status as string) === 'DONE').length;
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

    const lines: string[] = [
      `# ${project.name} — Sprint Progress`,
      `Sprint goal: ${project.sprint?.goal ?? '—'}`,
      `Progress: ${done}/${tasks.length} tasks done`,
      `Last updated: ${now}`,
      ``,
      `## Tasks`,
      ``,
    ];

    for (const task of tasks) {
      lines.push(formatTask(task));
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, lines.join('\n'), 'utf8');
    } catch (err) {
      console.warn(`[ProgressWriter] Failed to write progress file: ${(err as Error).message}`);
    }
  }

  read(): string {
    try {
      return fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return '';
    }
  }

  exists(): boolean {
    return fs.existsSync(this.filePath);
  }
}
