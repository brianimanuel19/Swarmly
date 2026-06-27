import { AsyncLocalStorage } from 'async_hooks';
import { TaskQueue } from './task-queue.js';
import { TokenTracker } from '../cost-control/token-tracker.js';

export interface ProjectContext {
  projectId: string;
  taskQueue: TaskQueue;
  tokenTracker: TokenTracker;
}

/**
 * AsyncLocalStorage that propagates per-project resources (rate limiter, cost
 * tracker) to every async call within a pipeline run — no parameter threading
 * required. Falls back gracefully when called outside a project context.
 */
export const projectStorage = new AsyncLocalStorage<ProjectContext>();

export function getProjectContext(): ProjectContext | undefined {
  return projectStorage.getStore();
}
