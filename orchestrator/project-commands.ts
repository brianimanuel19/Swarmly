import type { WebClient } from '@slack/web-api';
import type { ProjectState, FileChange } from '../types/index.js';
import { stateStore } from '../memory/state-store.js';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/config.js';

export type ConvMessage = { role: 'user' | 'assistant'; content: string };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingPlan {
  id: string;
  projectId: string;
  channelId: string;
  threadTs: string;
  thinkingTs: string;
  files: FileChange[];
  description: string;
}

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: Date;
  files: Record<string, string>;
}

export interface ChannelSettings {
  mode: 'default' | 'plan' | 'auto';
  model: string;
  thinking: boolean;
}

export type CommandResult = { handled: false } | { handled: true };

// ── ProjectCommands ───────────────────────────────────────────────────────────

export class ProjectCommands {
  private channelSettings = new Map<string, ChannelSettings>();
  private pendingPlans = new Map<string, PendingPlan>();
  private checkpoints = new Map<string, Checkpoint[]>();

  // ── Settings ───────────────────────────────────────────────────────────────

  getSettings(channelId: string): ChannelSettings {
    return this.channelSettings.get(channelId) ?? { mode: 'auto', model: 'claude-sonnet-4-6', thinking: false };
  }

  // ── Plan management ────────────────────────────────────────────────────────

  getPendingPlan(planId: string): PendingPlan | undefined {
    return this.pendingPlans.get(planId);
  }

  deletePendingPlan(planId: string): void {
    this.pendingPlans.delete(planId);
  }

  async storePendingPlan(params: {
    project: ProjectState;
    channelId: string;
    threadTs: string;
    thinkingTs: string;
    description: string;
    files: FileChange[];
    webClient: WebClient;
  }): Promise<void> {
    const { project, channelId, threadTs, thinkingTs, description, files, webClient } = params;
    const planId = `plan_${project.id}_${Date.now()}`;
    this.pendingPlans.set(planId, { id: planId, projectId: project.id, channelId, threadTs, thinkingTs, files, description });

    const fileList = files.map((f) => `• \`${f.path}\` _(${f.action})_`).join('\n');
    const planText = `${description}\n\n*Files to change (${files.length}):*\n${fileList}`;

    await webClient.chat.update({
      channel: channelId,
      ts: thinkingTs,
      text: planText,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `📋 *Plan ready — review before applying*\n\n${planText}` } },
        {
          type: 'actions',
          elements: [
            { type: 'button', style: 'primary', text: { type: 'plain_text', text: '✅ Apply changes' }, action_id: `plan_approve_${planId}`, value: planId },
            { type: 'button', style: 'danger', text: { type: 'plain_text', text: '❌ Cancel' }, action_id: `plan_cancel_${planId}`, value: planId },
          ],
        },
      ],
    });
  }

  // ── Checkpoint management ──────────────────────────────────────────────────

  saveCheckpoint(projectId: string, label: string, files: Record<string, string>): string {
    const id = `ckpt_${Date.now()}`;
    const list = this.checkpoints.get(projectId) ?? [];
    list.unshift({ id, label, createdAt: new Date(), files });
    this.checkpoints.set(projectId, list.slice(0, 10));
    return id;
  }

  getCheckpointById(projectId: string, checkpointId: string): Checkpoint | undefined {
    return (this.checkpoints.get(projectId) ?? []).find((c) => c.id === checkpointId);
  }

  getCheckpoints(projectId: string): Checkpoint[] {
    return this.checkpoints.get(projectId) ?? [];
  }

  // ── Command detection ──────────────────────────────────────────────────────

  isCommand(text: string): boolean {
    const lower = text.trim().toLowerCase();
    return (
      lower.startsWith('/') ||
      /^(review|diff|commit\s|pr\s|model\s|mode\s|thinking|rewind|checkpoint|run\s|help|commands)/.test(lower) ||
      lower.startsWith('!')
    );
  }

  // Omit thread_ts when empty (slash commands have no thread context)
  private th(threadTs: string): { thread_ts: string } | Record<string, never> {
    return threadTs ? { thread_ts: threadTs } : {};
  }

  // ── Main command router ────────────────────────────────────────────────────

  async handle(params: {
    text: string;
    project: ProjectState;
    channelId: string;
    threadTs: string;
    webClient: WebClient;
    userId?: string;
  }): Promise<CommandResult> {
    const { text, project, channelId, threadTs, webClient, userId } = params;
    const raw = text.trim();
    const lower = raw.toLowerCase();
    const parts = raw.split(/\s+/);
    const cmd = (parts[0]?.replace(/^\//, '') ?? '').toLowerCase();
    const args = parts.slice(1).join(' ');

    if (cmd === 'help' || cmd === 'commands') {
      await this._postHelp(channelId, threadTs, webClient);
      return { handled: true };
    }

    if (cmd === 'mode') {
      const val = args.trim().toLowerCase();
      if (!['plan', 'auto', 'default'].includes(val)) {
        await webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: '❌ Usage: `/mode plan`, `/mode auto`, `/mode default`' });
        return { handled: true };
      }
      const s = this.getSettings(channelId);
      this.channelSettings.set(channelId, { ...s, mode: val as ChannelSettings['mode'] });
      const descs: Record<string, string> = {
        plan: '📋 *plan* — Claude proposes changes and waits for your approval before applying (like Claude Code plan mode).',
        auto: '⚡ *auto* — Claude applies changes immediately without asking.',
        default: '🔒 *default* — Claude applies file changes, asks before risky operations.',
      };
      await webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `Mode set to ${descs[val]}` });
      return { handled: true };
    }

    if (cmd === 'model') {
      const modelMap: Record<string, string> = {
        opus: 'claude-opus-4-8',
        sonnet: 'claude-sonnet-4-6',
        haiku: 'claude-haiku-4-5-20251001',
        fable: 'claude-fable-5',
      };
      const key = args.trim().toLowerCase().split(/\s+/)[0] ?? '';
      const model = modelMap[key] ?? (args.trim() || 'claude-sonnet-4-6');
      const s = this.getSettings(channelId);
      this.channelSettings.set(channelId, { ...s, model });
      await webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `🤖 Model switched to *${key || args.trim()}* (\`${model}\`)` });
      return { handled: true };
    }

    if (cmd === 'thinking') {
      const on = !args || ['on', '1', 'true', 'enable'].includes(args.trim().toLowerCase());
      const s = this.getSettings(channelId);
      this.channelSettings.set(channelId, { ...s, thinking: on });
      await webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: on ? '🧠 Extended thinking *enabled*. Claude will reason more deeply (slower, uses more tokens).' : '💨 Extended thinking *disabled*.' });
      return { handled: true };
    }

    if (cmd === 'diff') {
      await this._runDiff(project, channelId, threadTs, webClient);
      return { handled: true };
    }

    if (cmd === 'commit') {
      if (!args.trim()) {
        await webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: '❌ Usage: `/commit <message>`' });
        return { handled: true };
      }
      await this._runCommit(project, args.trim(), channelId, threadTs, webClient);
      return { handled: true };
    }

    if (cmd === 'pr') {
      await this._runCreatePR(project, args.trim() || `[Swarmly] ${project.name}`, channelId, threadTs, webClient);
      return { handled: true };
    }

    if (cmd === 'review') {
      const security = lower.includes('--security') || lower.includes('security');
      const fix = lower.includes('--fix');
      await this._runReview(project, channelId, threadTs, webClient, { security, fix });
      return { handled: true };
    }

    if (cmd === 'rewind') {
      await this._showCheckpoints(project, channelId, threadTs, webClient);
      return { handled: true };
    }

    if (cmd === 'checkpoint') {
      await this._saveManualCheckpoint(project, args.trim() || 'Manual checkpoint', channelId, threadTs, webClient);
      return { handled: true };
    }

    if (cmd === 'run' || raw.startsWith('!')) {
      const shellCmd = raw.startsWith('!') ? raw.slice(1).trim() : args.trim();
      await this._runTerminal(project, shellCmd, channelId, threadTs, webClient);
      return { handled: true };
    }

    if (cmd === 'compact') {
      // Compact is handled by the orchestrator which has the history — signal it
      return { handled: false, compactRequested: true } as unknown as CommandResult;
    }

    if (cmd === 'branch') {
      await this._runBranch(project, args.trim(), channelId, threadTs, webClient);
      return { handled: true };
    }

    // ── /swarmly-* auth commands — routed here when triggered from index.ts ──
    // (Bolt routes them directly to handlers via slash command registration;
    //  index.ts also calls projectCommands.handle() to post into the project channel)
    if (cmd === 'swarmly-account' || cmd === 'swarmly-usage') {
      await this.runAccountUsage(channelId, threadTs, webClient, userId);
      return { handled: true };
    }

    if (cmd === 'swarmly-login') {
      await this.runLogin(channelId, threadTs, webClient, userId);
      return { handled: true };
    }

    if (cmd === 'swarmly-switch') {
      await this.runSwitchAccount(channelId, threadTs, webClient, userId);
      return { handled: true };
    }

    if (cmd === 'swarmly-logout') {
      await this.runLogout(channelId, threadTs, webClient, userId);
      return { handled: true };
    }

    return { handled: false };
  }

  // Called by orchestrator when /compact is intercepted
  async compactHistory(history: ConvMessage[]): Promise<ConvMessage[]> {
    if (history.length < 4) return history;
    try {
      const client = new Anthropic({ apiKey: config.anthropic.apiKey, baseURL: config.anthropic.baseUrl });
      const transcript = history.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 400)}`).join('\n\n');
      const res = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: 'Summarize this conversation concisely in 3-5 bullet points. Focus on decisions made, code changes applied, and open questions.',
        messages: [{ role: 'user', content: transcript }],
      });
      const summary = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
      return [{ role: 'assistant', content: `[Context compacted]\n${summary}` }];
    } catch {
      // If summarization fails, keep last 4 messages
      return history.slice(-4);
    }
  }

  // ── Command implementations ────────────────────────────────────────────────

  private async _runDiff(project: ProjectState, channelId: string, threadTs: string, webClient: WebClient): Promise<void> {
    const msg = await webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: '⏳ Getting diff…' });
    try {
      const { executor } = await import('../sandbox/executor.js');
      const result = await executor.exec(project.id, 'git diff HEAD');
      const diff = (result.stdout || result.stderr || '').trim();
      if (!diff) {
        await webClient.chat.update({ channel: channelId, ts: msg.ts as string, text: '✅ No uncommitted changes.' });
        return;
      }
      const truncated = diff.length > 2800 ? diff.slice(0, 2800) + '\n… _(truncated)_' : diff;
      await webClient.chat.update({ channel: channelId, ts: msg.ts as string, text: `*Git diff HEAD:*\n\`\`\`\n${truncated}\n\`\`\`` });
    } catch (err) {
      await webClient.chat.update({ channel: channelId, ts: msg.ts as string, text: `❌ Diff failed: ${(err as Error).message}` });
    }
  }

  private async _runCommit(project: ProjectState, message: string, channelId: string, threadTs: string, webClient: WebClient): Promise<void> {
    const msg = await webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: '⏳ Committing…' });
    try {
      const { executor } = await import('../sandbox/executor.js');
      // Get list of changed files
      const statusResult = await executor.exec(project.id, 'git status --porcelain');
      const changedPaths = (statusResult.stdout || '')
        .split('\n')
        .map((l) => l.trim().replace(/^[A-Z?]+\s+/, ''))
        .filter(Boolean);

      if (changedPaths.length === 0) {
        await webClient.chat.update({ channel: channelId, ts: msg.ts as string, text: '⚠️ Nothing to commit.' });
        return;
      }

      // Read changed files from workspace
      const { workspaceManager } = await import('../sandbox/workspace-manager.js');
      const files: FileChange[] = [];
      for (const path of changedPaths.slice(0, 50)) {
        try {
          const content = await workspaceManager.readFile(project.id, path);
          files.push({ action: 'modify', path, content });
        } catch { /* skip unreadable files */ }
      }

      const { githubIntegration } = await import('../integrations/github.js');
      const commitUrl = await githubIntegration.commitFiles(files, message, project.githubBranch ?? 'main');
      await webClient.chat.update({ channel: channelId, ts: msg.ts as string, text: `✅ Committed ${files.length} file(s): <${commitUrl}|${message}>` });
    } catch (err) {
      await webClient.chat.update({ channel: channelId, ts: msg.ts as string, text: `❌ Commit failed: ${(err as Error).message}` });
    }
  }

  private async _runCreatePR(project: ProjectState, title: string, channelId: string, threadTs: string, webClient: WebClient): Promise<void> {
    const msg = await webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: '⏳ Creating pull request…' });
    try {
      const tasks = (project.sprint?.tasks ?? []).map((t) => `- [${t.status === 'DONE' ? 'x' : ' '}] ${t.title}`).join('\n');
      const body = `## ${project.name}\n\n${project.prd?.slice(0, 500) ?? ''}\n\n### Tasks\n${tasks || '_No tasks_'}\n\n_Created via Swarmly_`;
      const { githubIntegration } = await import('../integrations/github.js');
      const prUrl = await githubIntegration.createPR(title, body, project.githubBranch ?? 'main');
      await webClient.chat.update({ channel: channelId, ts: msg.ts as string, text: `✅ PR created: <${prUrl}|${title}>` });
    } catch (err) {
      await webClient.chat.update({ channel: channelId, ts: msg.ts as string, text: `❌ PR creation failed: ${(err as Error).message}` });
    }
  }

  private async _runReview(
    project: ProjectState,
    channelId: string,
    threadTs: string,
    webClient: WebClient,
    opts: { security: boolean; fix: boolean },
  ): Promise<void> {
    const label = opts.security ? '🔐 Security review' : '🔍 Code review';
    const msg = await webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `⏳ Running ${label.toLowerCase()}…` });

    try {
      let diff = '';
      try {
        const { executor } = await import('../sandbox/executor.js');
        const result = await executor.exec(project.id, 'git diff HEAD');
        diff = (result.stdout || '').trim();
      } catch { /* no container */ }

      if (!diff) {
        // Fall back: synthesize a pseudo-diff from the codebase
        diff = Object.entries(project.codebase ?? {})
          .slice(0, 15)
          .map(([p, c]) => `--- /dev/null\n+++ b/${p}\n${c.split('\n').map((l) => `+${l}`).slice(0, 40).join('\n')}`)
          .join('\n\n');
      }

      if (!diff) {
        await webClient.chat.update({ channel: channelId, ts: msg.ts as string, text: '⚠️ No code changes found to review.' });
        return;
      }

      const { codeReviewAgent } = await import('../agents/code-review-agent.js');
      const result = await codeReviewAgent.review({ diff, projectId: project.id, mode: opts.security ? 'security' : 'standard', fix: opts.fix });

      const icons: Record<string, string> = { critical: '🔴', warning: '🟡', info: '🟢' };
      const findingLines = result.findings
        .map((f) => `${icons[f.severity] ?? '⚪'} *${f.file}*${f.line ? `:${f.line}` : ''}\n  ${f.message}\n  _${f.suggestion ?? ''}_`)
        .join('\n\n');

      const totalText = `*${label} — ${project.name}*\n\n${result.summary}\n\n${findingLines || '_No findings. Code looks good!_'}`;
      await webClient.chat.update({ channel: channelId, ts: msg.ts as string, text: totalText });

      if (opts.fix && result.fixes && result.fixes.length > 0) {
        try {
          const { workspaceManager } = await import('../sandbox/workspace-manager.js');
          await workspaceManager.applyChanges(project.id, result.fixes);
          await stateStore.updateCodebase(project.id, result.fixes);
        } catch { /* workspace may not be running */ }
        await webClient.chat.postMessage({
          channel: channelId, thread_ts: threadTs,
          text: `🔧 Applied ${result.fixes.length} fix(es): ${result.fixes.map((f) => `\`${f.path}\``).join(', ')}`,
        });
      }
    } catch (err) {
      await webClient.chat.update({ channel: channelId, ts: msg.ts as string, text: `❌ Review failed: ${(err as Error).message}` });
    }
  }

  private async _runTerminal(project: ProjectState, command: string, channelId: string, threadTs: string, webClient: WebClient): Promise<void> {
    if (!command) {
      await webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: '❌ Usage: `run <command>` or `!<command>`' });
      return;
    }
    const msg = await webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `⏳ Running: \`${command}\`` });
    try {
      const { executor } = await import('../sandbox/executor.js');
      const result = await executor.exec(project.id, command);
      const output = [result.stdout, result.stderr ? `[stderr] ${result.stderr}` : ''].filter(Boolean).join('\n').trim();
      const truncated = output.length > 2500 ? output.slice(0, 2500) + '\n… _(truncated)_' : output;
      const icon = result.exitCode === 0 ? '✅' : '❌';
      await webClient.chat.update({
        channel: channelId, ts: msg.ts as string,
        text: `${icon} \`${command}\` (exit ${result.exitCode})\n\`\`\`\n${truncated || '(no output)'}\n\`\`\``,
      });
    } catch (err) {
      await webClient.chat.update({ channel: channelId, ts: msg.ts as string, text: `❌ Command failed: ${(err as Error).message}` });
    }
  }

  private async _showCheckpoints(project: ProjectState, channelId: string, threadTs: string, webClient: WebClient): Promise<void> {
    const list = this.getCheckpoints(project.id);
    if (list.length === 0) {
      await webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: '📭 No checkpoints saved yet. Checkpoints are created automatically before each code change. You can also create one with `/checkpoint <label>`.' });
      return;
    }
    const elements = list.slice(0, 5).map((ck) => ({
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: `${ck.label.slice(0, 18)} (${ck.createdAt.toLocaleTimeString()})` },
      action_id: `checkpoint_restore_${ck.id}`,
      value: JSON.stringify({ projectId: project.id, checkpointId: ck.id }),
    }));
    await webClient.chat.postMessage({
      channel: channelId, thread_ts: threadTs, text: '🔄 Select a checkpoint to restore:',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `🔄 *Restore a checkpoint* (${list.length} saved):` } },
        { type: 'actions', elements },
      ],
    });
  }

  private async _saveManualCheckpoint(project: ProjectState, label: string, channelId: string, threadTs: string, webClient: WebClient): Promise<void> {
    let files: Record<string, string> = project.codebase ?? {};
    try {
      const { workspaceManager } = await import('../sandbox/workspace-manager.js');
      const wsCb = await workspaceManager.readCodebase(project.id);
      if (Object.keys(wsCb).length > 0) files = wsCb;
    } catch { /* use DB codebase */ }
    const id = this.saveCheckpoint(project.id, label, files);
    await webClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `💾 Checkpoint saved: *${label}* — ${Object.keys(files).length} files (\`${id}\`)` });
  }

  private async _runBranch(project: ProjectState, label: string, channelId: string, threadTs: string, webClient: WebClient): Promise<void> {
    // Post a new top-level message in the channel — new ts = new branch conversation
    const branchLabel = label || `Branch from ${new Date().toLocaleTimeString()}`;
    const newMsg = await webClient.chat.postMessage({
      channel: channelId,
      text: `🌿 *${branchLabel}* — branched from <#${channelId}>`,
    });
    if (!newMsg.ts) return;

    // Copy current thread history to the new branch thread key
    const sourceKey = `${channelId}:${threadTs}`;
    const newKey = `${channelId}:${newMsg.ts}`;
    this._branchSourceHistory = this._branchSourceHistory ?? new Map();
    this._branchSourceHistory.set(newKey, sourceKey);

    // Notify in both threads
    await webClient.chat.postMessage({
      channel: channelId,
      thread_ts: newMsg.ts,
      text: `🌿 New branch: *${branchLabel}*\nConversation history from the source thread is available here. Continue working in this thread independently.`,
    });
    await webClient.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `🌿 Branch created: *${branchLabel}* — <slack://channel?team=&id=${channelId}&message=${newMsg.ts}|Go to branch>`,
    });
  }

  // Map of branchThreadKey → sourceThreadKey for history copying
  private _branchSourceHistory?: Map<string, string>;

  getBranchSource(threadKey: string): string | undefined {
    return this._branchSourceHistory?.get(threadKey);
  }

  // ── Account & Usage panel (mirrors Claude Code for VSCode) ───────────────

  async runAccountUsage(channelId: string, threadTs: string, webClient: WebClient, userId?: string): Promise<void> {
    if (!userId) {
      await webClient.chat.postMessage({ channel: channelId, ...this.th(threadTs), text: '❌ Cannot identify user.' });
      return;
    }

    const { userAuthStore } = await import('../auth/user-auth-store.js');
    const { userSessionTracker, formatDuration, progressBar } = await import('../auth/user-session-tracker.js');

    const status = await userAuthStore.getStatus(userId);
    const stats = userSessionTracker.getStats(userId);

    // Try to fetch user profile from OAuth if authenticated
    let profile: { email?: string; name?: string; organizationName?: string; plan?: string } = {};
    if (status.type === 'oauth') {
      try {
        const token = await userAuthStore.getEffectiveKey(userId);
        if (token) {
          const { fetchUserInfo } = await import('../auth/claude-oauth.js');
          profile = await fetchUserInfo(token);
          if (profile.plan) userSessionTracker.updatePlan(userId, profile.plan);
        }
      } catch { /* profile optional */ }
    }

    // Build display
    const authMethod = status.type === 'oauth' ? 'Claude AI (OAuth)' : status.type === 'api_key' ? 'API Key' : 'Workspace default';
    const sessionBar = progressBar(stats.sessionPercent, 24);
    const weeklyBar  = progressBar(stats.weeklyPercent,  24);
    const sessionReset = formatDuration(stats.sessionResetsInMs);
    const weeklyReset  = formatDuration(stats.weeklyResetsInMs);

    const lines = [
      '━━━━━━━━━━━━━━━━━━━━━━━━',
      '*ACCOUNT*',
      `Auth method    ${authMethod}`,
      ...(profile.email ? [`Email          ${profile.email}`] : []),
      ...(profile.organizationName ? [`Organization   ${profile.organizationName}`] : []),
      ...(profile.plan ? [`Plan           ${profile.plan}`] : []),
      '',
      '*USAGE*',
      `Session (5hr)  ${stats.sessionPercent}%`,
      `\`${sessionBar}\``,
      `_Resets in ${sessionReset}_`,
      '',
      `Weekly (7 day) ${stats.weeklyPercent}%`,
      `\`${weeklyBar}\``,
      `_Resets in ${weeklyReset}_`,
      '',
      '_Approximate — based on this Swarmly instance only._',
      `<https://claude.ai/settings/usage|Manage usage on claude.ai>`,
    ];

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: 'Account & Usage' } },
      { type: 'divider' },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Auth method*\n${authMethod}` },
          ...(profile.email ? [{ type: 'mrkdwn', text: `*Email*\n${profile.email}` }] : []),
          ...(profile.organizationName ? [{ type: 'mrkdwn', text: `*Organization*\n${profile.organizationName}` }] : []),
          ...(profile.plan ? [{ type: 'mrkdwn', text: `*Plan*\n${profile.plan}` }] : []),
        ],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*Session (5hr)*   ${stats.sessionPercent}%`,
            `\`${sessionBar}\``,
            `_Resets in ${sessionReset}_ · ${stats.sessionTokens.toLocaleString()} tokens`,
          ].join('\n'),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*Weekly (7 day)*   ${stats.weeklyPercent}%`,
            `\`${weeklyBar}\``,
            `_Resets in ${weeklyReset}_ · ${stats.weeklyTokens.toLocaleString()} tokens`,
          ].join('\n'),
        },
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: '_Approximate — based on this Swarmly instance only, does not include other devices or claude.ai._' },
        ],
      },
      {
        type: 'actions',
        elements: [
          { type: 'button' as const, text: { type: 'plain_text' as const, text: 'Manage usage on claude.ai' }, url: 'https://claude.ai/settings/usage', action_id: 'open_usage_link' },
          { type: 'button' as const, text: { type: 'plain_text' as const, text: '↺ Switch Account' }, action_id: 'switch_to_oauth', value: `${userId}::${channelId}::${threadTs}` },
        ],
      },
    ];

    await webClient.chat.postMessage({
      channel: channelId, ...this.th(threadTs),
      text: lines.join('\n'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blocks: blocks as any,
    });
  }

  // ── Auth commands ──────────────────────────────────────────────────────────

  async runLogin(channelId: string, threadTs: string, webClient: WebClient, userId?: string): Promise<void> {
    if (!userId) {
      await webClient.chat.postMessage({ channel: channelId, ...this.th(threadTs), text: '❌ Cannot identify user. Please try again.' });
      return;
    }

    const { isOAuthConfigured, generatePKCE, generateState, buildAuthUrl } = await import('../auth/claude-oauth.js');
    const { userAuthStore } = await import('../auth/user-auth-store.js');

    // Show current status first
    const status = await userAuthStore.getStatus(userId);
    const statusLine = status.type === 'oauth'
      ? '🟢 You are already signed in via *OAuth*.'
      : status.type === 'api_key'
      ? '🔑 You are signed in with a *personal API key*.'
      : '⚪ You are *not signed in*. Using the workspace default key.';

    if (!isOAuthConfigured()) {
      await webClient.chat.postMessage({
        channel: channelId, ...this.th(threadTs),
        text: [
          statusLine,
          '',
          '🔑 *Option 1 — Subscription token (dùng plan Claude Pro/Max/Team của bạn):*',
          '```',
          'claude setup-token   # chạy lệnh này trên máy của bạn',
          '```',
          'Copy token `sk-ant-oat01-...` → DM bot: `apikey sk-ant-oat01-...`',
          '',
          '🔐 *Option 2 — API key (bill by token):*',
          'Lấy key tại <https://console.anthropic.com|console.anthropic.com> → DM bot: `apikey sk-ant-api03-...`',
        ].join('\n'),
      });
      return;
    }

    // Generate PKCE and store pending OAuth state
    const { verifier, challenge } = generatePKCE();
    const state = generateState();
    const oauthExpiry = Date.now() + 10 * 60 * 1000;
    await Promise.all([
      stateStore.savePendingProject(`oauth_state_${state}`, {
        slackUserId: userId,
        codeVerifier: verifier,
        channelId,
        expiresAt: oauthExpiry,
      }),
      // Keyed by userId so tryHandleOAuthCode can find it when user pastes the code
      stateStore.savePendingProject(`oauth_user_${userId}`, {
        codeVerifier: verifier,
        expiresAt: oauthExpiry,
      }),
    ]);

    const authUrl = buildAuthUrl(state, challenge);
    await webClient.chat.postMessage({
      channel: channelId, ...this.th(threadTs),
      text: `${statusLine}\n\n🔐 *Sign in with Claude*\n<${authUrl}|→ Click here to authenticate>\n\nSau khi sign in, bạn sẽ thấy trang *"Authentication Code"* — copy code đó và paste thẳng vào đây.\n\n_Link hết hạn sau 10 phút._`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${statusLine}\n\n🔐 *Sign in with Claude*\nClick bên dưới để xác thực tài khoản Claude của bạn.` } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button' as const,
              text: { type: 'plain_text' as const, text: '→ Sign in with Claude' },
              url: authUrl,
              style: 'primary' as const,
              action_id: 'oauth_login_link',
            },
          ],
        },
        { type: 'section', text: { type: 'mrkdwn', text: '📋 Sau khi authorize xong, bạn sẽ thấy trang *"Authentication Code"*.\nCopy code đó và *paste thẳng vào chat này* — Swarmly sẽ tự nhận diện.' } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: '_Hoặc DM bot: `apikey sk-ant-...` nếu dùng API key. Link hết hạn sau 10 phút._' }] },
      ],
    });
  }

  async runSwitchAccount(channelId: string, threadTs: string, webClient: WebClient, userId?: string): Promise<void> {
    if (!userId) {
      await webClient.chat.postMessage({ channel: channelId, ...this.th(threadTs), text: '❌ Cannot identify user. Please try again.' });
      return;
    }

    const { userAuthStore } = await import('../auth/user-auth-store.js');
    const { isOAuthConfigured } = await import('../auth/claude-oauth.js');
    const status = await userAuthStore.getStatus(userId);

    const currentAuth =
      status.type === 'oauth' ? `🟢 *OAuth* (token expires: ${status.expiry?.toLocaleString() ?? 'unknown'})`
      : status.type === 'api_key' ? '🔑 *Personal API key*'
      : '⚪ *None* (using workspace default key)';

    const blocks: object[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `*Account — <@${userId}>*\n\nCurrent auth: ${currentAuth}` } },
      { type: 'divider' },
    ];

    if (isOAuthConfigured()) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '🔐 *Sign in with Claude OAuth*\nUse your personal Claude subscription for AI calls in this workspace.' },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: status.type === 'oauth' ? '↺ Re-authenticate' : '→ Sign in with OAuth' },
          action_id: 'switch_to_oauth',
          value: `${userId}::${channelId}::${threadTs}`,
          ...(status.type !== 'oauth' ? { style: 'primary' } : {}),
        },
      });
    }

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '🔑 *Use personal API key*\nDM the bot: `apikey sk-ant-...` to set a key directly.' },
    });

    if (status.type !== 'none') {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '🚪 *Sign out*\nRemove your credentials and revert to the workspace default key.' },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Sign out' },
          action_id: 'switch_logout',
          value: `${userId}::${channelId}::${threadTs}`,
          style: 'danger',
        },
      });
    }

    await webClient.chat.postMessage({
      channel: channelId, ...this.th(threadTs),
      text: `Current auth: ${currentAuth}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blocks: blocks as any,
    });
  }

  async runLogout(channelId: string, threadTs: string, webClient: WebClient, userId?: string): Promise<void> {
    if (!userId) {
      await webClient.chat.postMessage({ channel: channelId, ...this.th(threadTs), text: '❌ Cannot identify user.' });
      return;
    }
    const { userAuthStore } = await import('../auth/user-auth-store.js');
    await userAuthStore.deleteAuth(userId);
    await webClient.chat.postMessage({ channel: channelId, ...this.th(threadTs), text: '✅ Signed out. Your credentials have been removed. The workspace default key will be used.' });
  }

  private async _postHelp(channelId: string, threadTs: string, webClient: WebClient): Promise<void> {
    await webClient.chat.postMessage({
      channel: channelId, thread_ts: threadTs,
      text: [
        '🤖 *Swarmly AI — Commands*',
        '',
        '*Permission modes (like Claude Code):*',
        '`/mode plan` — Propose changes first, wait for approval',
        '`/mode auto` — Apply changes immediately without asking',
        '`/mode default` — Apply file edits, ask for risky ops _(default)_',
        '',
        '*Model & reasoning:*',
        '`/model opus|sonnet|haiku|fable` — Switch AI model',
        '`/thinking on|off` — Toggle extended thinking (deeper, slower)',
        '',
        '*Code review:*',
        '`/review` — Review recent code changes',
        '`/review --security` — Security-focused review (OWASP Top 10)',
        '`/review --fix` — Review + auto-apply fixes',
        '',
        '*Git & GitHub:*',
        '`/diff` — Show uncommitted changes (`git diff HEAD`)',
        '`/commit <message>` — Commit changed files to GitHub',
        '`/pr <title>` — Create a GitHub pull request',
        '',
        '*Terminal:*',
        '`run <command>` or `!<command>` — Run a shell command in the workspace',
        '',
        '*Checkpoints (like rewind in Claude Code):*',
        '`/checkpoint [label]` — Save a snapshot of the current codebase',
        '`/rewind` — Browse checkpoints and restore one',
        '',
        '*Conversation:*',
        '`/compact` — Summarize & compress conversation history (free up context)',
        '`/branch [name]` — Fork this conversation into a new thread (parallel exploration)',
        '',
        '*Pipeline control:*',
        '`status` / `tiến độ` — Show project phase and task statuses',
        '`re-run coding phase` — Reset blocked tasks and resume development',
        '`re-run testing` — Re-run the testing phase',
        '`re-run planning` — Re-generate PRD and sprint plan',
        '`reset` — Clear conversation history for this thread',
        '',
        '*Account:*',
        '`/swarmly-account` — Account & Usage panel (session 5hr %, weekly %, plan info)',
        '`/swarmly-login` — Sign in with Claude OAuth or API key',
        '`/swarmly-switch` — View current account and switch auth method',
        '`/swarmly-logout` — Sign out and remove stored credentials',
      ].join('\n'),
    });
  }
}

export const projectCommands = new ProjectCommands();
