import Anthropic from '@anthropic-ai/sdk';
import type { AgentRole, AgentOutput, ConversationHistory, TokenUsage } from '../types/index.js';
import { config } from '../config/config.js';
import { getProjectContext } from '../orchestrator/project-context.js';
import { CreditExhaustedError } from '../cost-control/credit-error.js';

export abstract class BaseAgent {
  protected role: AgentRole;
  protected client: Anthropic;
  protected model: string;

  constructor(role: AgentRole, model: string) {
    this.role = role;
    this.model = model;
    this.client = new Anthropic({ apiKey: config.anthropic.apiKey, baseURL: config.anthropic.baseUrl });
  }

  protected async call(params: {
    systemPrompt: string;
    messages: ConversationHistory;
    projectId: string;
    maxTokens?: number;
    useCache?: boolean;
    toolsEnabled?: boolean;
  }): Promise<AgentOutput> {
    const { systemPrompt, messages, maxTokens, useCache } = params;
    const maxRetriesVal = config.rateLimit.maxRetries;
    const retryDelayMs = config.rateLimit.retryDelayMs;

    // Rough token estimate: sum of all message content lengths / 4
    const inputTokens = Math.ceil(
      (systemPrompt.length + messages.reduce((acc, m) => acc + m.content.length, 0)) / 4,
    );

    // Build Anthropic-formatted messages
    const anthropicMessages: Anthropic.MessageParam[] = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    // Build system parameter
    const systemParam: Anthropic.MessageCreateParamsNonStreaming['system'] = useCache
      ? [
          {
            type: 'text' as const,
            text: systemPrompt,
            // cache_control is a beta feature; cast through unknown to avoid
            // SDK TextBlockParam type mismatch until the SDK exports the type
            cache_control: { type: 'ephemeral' as const },
          } as unknown as Anthropic.Messages.TextBlockParam,
        ]
      : systemPrompt;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetriesVal; attempt++) {
      try {
        const ctx = getProjectContext();
        const doCreate = () =>
          this.client.messages.create({
            model: this.model,
            max_tokens: maxTokens ?? 8192,
            system: systemParam,
            messages: anthropicMessages,
          });

        // Route through per-project rate limiter when available
        const response = ctx
          ? await ctx.taskQueue.enqueue(doCreate, 0)
          : await doCreate();

        // Extract text content
        const textContent = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n');

        const outTokens = response.usage.output_tokens;
        const inTokens = response.usage.input_tokens;
        const cacheHits =
          ((response.usage as unknown as Record<string, number>)['cache_read_input_tokens'] as
            | number
            | undefined) ?? 0;

        // Compute cost
        const pricing =
          config.anthropic.pricing[this.model] ?? config.anthropic.pricing['claude-sonnet-4-6']!;
        const costUsd =
          (inTokens / 1_000_000) * pricing.input +
          (outTokens / 1_000_000) * pricing.output +
          (cacheHits / 1_000_000) * pricing.cacheHit;

        const tokenUsage: TokenUsage = {
          inputTokens: inTokens,
          outputTokens: outTokens,
          cacheHits,
          totalTokens: inTokens + outTokens,
          estimatedCostUsd: costUsd,
        };

        // Record into per-project tracker when inside a pipeline run
        ctx?.tokenTracker.record(this.role, this.model, inTokens, outTokens, cacheHits);

        console.log(
          `[AGENT] ${this.role} | ${inTokens}in ${outTokens}out | $${costUsd.toFixed(6)}`,
        );

        return {
          success: true,
          content: textContent,
          tokenUsage,
          retryCount: attempt,
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (err instanceof Anthropic.RateLimitError) {
          if (attempt < maxRetriesVal) {
            const waitMs = retryDelayMs * Math.pow(2, attempt);
            console.warn(
              `[AGENT] ${this.role} rate limited. Retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetriesVal})`,
            );
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
          }
          break;
        }

        if (err instanceof Anthropic.APIError) {
          const status = err.status ?? 0;

          // 402 = insufficient credits — cannot retry, propagate immediately
          if (status === 402) {
            throw new CreditExhaustedError('API_402', err.message);
          }

          if (status >= 500) {
            if (attempt < maxRetriesVal) {
              const waitMs = retryDelayMs * Math.pow(2, attempt);
              console.warn(
                `[AGENT] ${this.role} server error ${status}. Retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetriesVal})`,
              );
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              continue;
            }
            break;
          }
          // 4xx (non-429) — fail immediately
          throw new Error(`Anthropic API client error ${status}: ${err.message}`);
        }

        // Unknown error — fail immediately
        throw lastError;
      }
    }

    const errorMsg = lastError?.message ?? 'Unknown API error';
    console.error(`[AGENT] ${this.role} failed after ${maxRetriesVal} retries: ${errorMsg}`);
    return {
      success: false,
      content: '',
      tokenUsage: {
        inputTokens,
        outputTokens: 0,
        cacheHits: 0,
        totalTokens: inputTokens,
        estimatedCostUsd: 0,
      },
      error: errorMsg,
      retryCount: maxRetriesVal,
    };
  }

  protected parseJSON<T>(content: string): T {
    // Strip ```json ... ``` or ``` ... ``` fences
    let cleaned = content.trim();
    const fencedJsonMatch = cleaned.match(/^```json\s*([\s\S]*?)\s*```$/i);
    if (fencedJsonMatch) {
      cleaned = (fencedJsonMatch[1] ?? cleaned).trim();
    } else {
      const fencedMatch = cleaned.match(/^```\s*([\s\S]*?)\s*```$/);
      if (fencedMatch) {
        cleaned = (fencedMatch[1] ?? cleaned).trim();
      }
    }

    try {
      return JSON.parse(cleaned) as T;
    } catch {
      throw new Error('Failed to parse JSON: ' + content.substring(0, 200));
    }
  }

  protected buildMessages(
    history: ConversationHistory,
    newMessage: string,
    maxTokens?: number,
  ): ConversationHistory {
    void maxTokens; // not used for token estimation, char heuristic used instead
    const updated: ConversationHistory = [
      ...history,
      {
        role: 'user' as const,
        content: newMessage,
        timestamp: new Date(),
      },
    ];

    const totalChars = updated.reduce((acc, m) => acc + m.content.length, 0);
    const charLimit = 150_000;

    if (totalChars <= charLimit) {
      return updated;
    }

    // Keep first message if it is a system-like user message, trim from the middle
    const result: ConversationHistory = [];
    const first = updated[0];
    let remaining = charLimit - (first?.content.length ?? 0);

    // Always keep the last message (the one we just added)
    const last = updated[updated.length - 1];
    if (!last) return updated; // should never happen
    remaining -= last.content.length;

    // Build from oldest-skipping until we fit
    const middle = updated.slice(1, updated.length - 1);
    const kept: ConversationHistory = [];
    // Walk from the end of middle so we keep the most recent context
    for (let i = middle.length - 1; i >= 0; i--) {
      const msg = middle[i];
      if (!msg) continue;
      if (remaining - msg.content.length >= 0) {
        kept.unshift(msg);
        remaining -= msg.content.length;
      }
    }

    if (first) result.push(first);
    result.push(...kept);
    result.push(last);

    return result;
  }

  protected async callWithValidation<T>(params: {
    systemPrompt: string;
    messages: ConversationHistory;
    projectId: string;
    validate: (output: T) => { valid: boolean; reason?: string };
    maxAttempts?: number;
  }): Promise<T> {
    const { validate, maxAttempts = 3 } = params;
    let messages = [...params.messages];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const output = await this.call({ ...params, messages });

      if (!output.success) {
        throw new Error(
          `Agent call failed on attempt ${attempt + 1}: ${output.error ?? 'Unknown error'}`,
        );
      }

      let parsed: T;
      try {
        parsed = this.parseJSON<T>(output.content);
      } catch (parseErr: unknown) {
        const reason = parseErr instanceof Error ? parseErr.message : String(parseErr);
        if (attempt < maxAttempts - 1) {
          messages = [
            ...messages,
            {
              role: 'assistant' as const,
              content: output.content,
              timestamp: new Date(),
            },
            {
              role: 'user' as const,
              content: `Your output was invalid: ${reason}. Please fix and retry.`,
              timestamp: new Date(),
            },
          ];
          continue;
        }
        throw new Error(`Validation failed after ${maxAttempts} attempts: ${reason}`);
      }

      const validation = validate(parsed);
      if (validation.valid) {
        return parsed;
      }

      const reason = validation.reason ?? 'Output did not pass validation.';
      if (attempt < maxAttempts - 1) {
        messages = [
          ...messages,
          {
            role: 'assistant' as const,
            content: output.content,
            timestamp: new Date(),
          },
          {
            role: 'user' as const,
            content: `Your output was invalid: ${reason}. Please fix and retry.`,
            timestamp: new Date(),
          },
        ];
      } else {
        throw new Error(`Validation failed after ${maxAttempts} attempts`);
      }
    }

    throw new Error(`Validation failed after ${maxAttempts} attempts`);
  }
}
