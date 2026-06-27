import { config } from '../config/config.js';

// ─── Internal types ───────────────────────────────────────────────────────────

interface QueueItem<T> {
  fn: () => Promise<T>;
  priority: number;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface QueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

// ─── TaskQueue ────────────────────────────────────────────────────────────────

/**
 * Rate-limited, priority-ordered async task queue backed by a token-bucket
 * algorithm.
 *
 * - Up to `requestsPerMinute` tokens are replenished per minute.
 * - Each dequeued task consumes one token; if the bucket is empty the runner
 *   waits until a token becomes available.
 * - Items with a higher `priority` number are processed first.
 */
export class TaskQueue {
  // ─── Token bucket state ─────────────────────────────────────────────────────

  /** Maximum tokens (= requests) allowed per minute */
  private readonly maxTokens: number;
  /** Current available tokens */
  private tokens: number;
  /** Timestamp of last refill (ms) */
  private lastRefillAt: number;

  // ─── Queue state ────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queue: QueueItem<any>[] = [];
  private runningCount: number = 0;
  private completedCount: number = 0;
  private failedCount: number = 0;
  private isPaused: boolean = false;

  /** Handle for the periodic draining loop */
  private drainHandle: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.maxTokens = config.rateLimit.requestsPerMinute;
    this.tokens = this.maxTokens;
    this.lastRefillAt = Date.now();

    // Start the drain loop — fires frequently so the queue empties quickly
    // when capacity is available without busy-waiting
    this._startDrainLoop();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Add a task to the queue. Returns a Promise that resolves/rejects with the
   * result of `fn` once it has been executed.
   *
   * @param fn       - Async function to execute when a slot is available
   * @param priority - Higher number = higher priority (default 0)
   */
  enqueue<T>(fn: () => Promise<T>, priority: number = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = { fn, priority, resolve, reject };

      // Insert in priority order (highest first)
      let inserted = false;
      for (let i = 0; i < this.queue.length; i++) {
        if ((this.queue[i]?.priority ?? 0) < priority) {
          this.queue.splice(i, 0, item);
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        this.queue.push(item);
      }

      // Immediately attempt to drain — avoids latency when capacity exists
      this._drain();
    });
  }

  /** Stop processing items. Items already running are not interrupted. */
  pause(): void {
    this.isPaused = true;
    console.log('[TaskQueue] Paused.');
  }

  /** Resume processing items. */
  resume(): void {
    this.isPaused = false;
    console.log('[TaskQueue] Resumed.');
    this._drain();
  }

  /** Return a snapshot of queue statistics. */
  getStats(): QueueStats {
    return {
      pending: this.queue.length,
      running: this.runningCount,
      completed: this.completedCount,
      failed: this.failedCount,
    };
  }

  /**
   * Discard all pending (not yet started) queue items. Already-running tasks
   * complete normally. Each discarded item's Promise is rejected.
   */
  clear(): void {
    const discarded = this.queue.splice(0);
    for (const item of discarded) {
      item.reject(new Error('TaskQueue cleared — item cancelled before execution.'));
    }
    console.log(`[TaskQueue] Cleared ${discarded.length} pending item(s).`);
  }

  /**
   * Stop the internal drain loop and reject all pending items.
   * Call this during graceful shutdown.
   */
  destroy(): void {
    if (this.drainHandle !== null) {
      clearInterval(this.drainHandle);
      this.drainHandle = null;
    }
    this.clear();
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private _startDrainLoop(): void {
    // Drain every 500 ms so rate-limited items are picked up quickly
    this.drainHandle = setInterval(() => {
      this._refillTokens();
      this._drain();
    }, 500);
  }

  /**
   * Refill the token bucket based on elapsed time since the last refill.
   * Tokens accumulate up to `maxTokens`.
   */
  private _refillTokens(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillAt;
    const refillRate = this.maxTokens / 60_000; // tokens per ms

    const newTokens = elapsedMs * refillRate;
    if (newTokens >= 1) {
      this.tokens = Math.min(this.maxTokens, this.tokens + Math.floor(newTokens));
      this.lastRefillAt = now;
    }
  }

  /**
   * Attempt to dequeue and run as many items as the token bucket allows.
   */
  private _drain(): void {
    if (this.isPaused) return;

    while (this.queue.length > 0 && this.tokens > 0) {
      const item = this.queue.shift();
      if (!item) break;

      this.tokens -= 1;
      this.runningCount += 1;

      // Execute the task and settle the caller's promise
      item
        .fn()
        .then((result: unknown) => {
          this.runningCount -= 1;
          this.completedCount += 1;
          item.resolve(result);
        })
        .catch((err: unknown) => {
          this.runningCount -= 1;
          this.failedCount += 1;
          item.reject(err);
        });
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const taskQueue = new TaskQueue();
