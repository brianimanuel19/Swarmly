import { DetectedStack, StackDomain } from '../types/index.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── LoadedContext ────────────────────────────────────────────────────────────

export interface LoadedContext {
  /** Raw content of the domain-specific stack profile markdown */
  stackProfile: string;
  /** System prompt for the PM agent */
  pmSystemPrompt: string;
  /** System prompt for the PO agent */
  poSystemPrompt: string;
  /** System prompt for the Dev agent, with [STACK_PROFILE] replaced */
  devSystemPrompt: string;
  /** System prompt for the DevOps agent, with [STACK_PROFILE] replaced */
  devopsSystemPrompt: string;
  /** System prompt for the Tester agent, with [STACK_PROFILE] replaced */
  testerSystemPrompt: string;
}

// ─── ContextLoader ────────────────────────────────────────────────────────────

export class ContextLoader {
  private readonly profilesDir: string;
  private readonly templatesDir: string;

  constructor() {
    this.profilesDir = join(__dirname, '..', 'context', 'stack-profiles');
    this.templatesDir = join(__dirname, '..', 'context', 'prompt-templates');
  }

  /**
   * Load all context needed for a sprint given the detected stack.
   * Reads markdown files from disk, injects the stack profile into
   * the Dev and Tester system prompts where the placeholder [STACK_PROFILE]
   * appears, and returns a fully assembled LoadedContext.
   */
  async load(stack: DetectedStack): Promise<LoadedContext> {
    const profilePath = join(this.profilesDir, this.getStackProfilePath(stack.primaryDomain));

    let stackProfile: string;
    try {
      stackProfile = readFileSync(profilePath, 'utf-8');
    } catch (err: unknown) {
      // Graceful fallback: use a minimal inline description so the pipeline
      // never hard-crashes when a profile file is missing during development.
      console.warn(
        `[ContextLoader] Stack profile not found at "${profilePath}", using fallback. ` +
          `Error: ${(err as Error).message}`,
      );
      stackProfile = this._buildFallbackProfile(stack);
    }

    const pmSystemPrompt = this._readTemplate('pm-system.md');
    const poSystemPrompt = this._readTemplate('po-system.md');
    const devTemplate = this._readTemplate('dev-system.md');
    const devopsTemplate = this._readTemplate('devops-system.md');
    const testerTemplate = this._readTemplate('tester-system.md');

    const devSystemPrompt = devTemplate.replace(/\[STACK_PROFILE\]/g, stackProfile);
    const devopsSystemPrompt = devopsTemplate.replace(/\[STACK_PROFILE\]/g, stackProfile);
    const testerSystemPrompt = testerTemplate.replace(/\[STACK_PROFILE\]/g, stackProfile);

    return {
      stackProfile,
      pmSystemPrompt,
      poSystemPrompt,
      devSystemPrompt,
      devopsSystemPrompt,
      testerSystemPrompt,
    };
  }

  /**
   * Map a StackDomain enum value to the corresponding markdown filename in the
   * stack-profiles directory.
   */
  getStackProfilePath(domain: StackDomain): string {
    switch (domain) {
      case StackDomain.WEB_SAAS:
        return 'web-saas.md';

      case StackDomain.MOBILE_RN:
        return 'mobile-rn.md';

      case StackDomain.MOBILE_FLUTTER:
        return 'mobile-flutter.md';

      case StackDomain.BLOCKCHAIN_EVM:
        return 'blockchain-evm.md';

      case StackDomain.BLOCKCHAIN_SOL:
        return 'blockchain-solana.md';

      case StackDomain.IOT_EMBEDDED:
        return 'iot-embedded.md';

      case StackDomain.AI_ML:
        return 'ai-ml.md';

      case StackDomain.DESKTOP:
        return 'desktop.md';

      case StackDomain.DATA_PLATFORM:
        return 'data-platform.md';

      case StackDomain.CLI_TOOL:
        return 'cli-tool.md';

      case StackDomain.BROWSER_EXT:
        return 'browser-ext.md';

      case StackDomain.GAME:
        return 'game.md';

      case StackDomain.SERVERLESS:
        return 'serverless.md';

      case StackDomain.DEVOPS:
        return 'devops.md';

      default:
        return 'web-saas.md';
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Read a template file from the prompt-templates directory.
   * Falls back to an empty string with a console warning so that the pipeline
   * can continue even when templates are not yet on disk.
   */
  private _readTemplate(filename: string): string {
    const fullPath = join(this.templatesDir, filename);
    try {
      return readFileSync(fullPath, 'utf-8');
    } catch (err: unknown) {
      console.warn(
        `[ContextLoader] Template not found at "${fullPath}", using empty string. ` +
          `Error: ${(err as Error).message}`,
      );
      return '';
    }
  }

  /**
   * Build a minimal in-memory stack profile when the markdown file is absent.
   * This allows development to proceed without a full context/ directory.
   */
  private _buildFallbackProfile(stack: DetectedStack): string {
    return [
      `# ${stack.primaryDomain} Stack Profile (auto-generated fallback)`,
      '',
      `**Primary Domain:** ${stack.primaryDomain}`,
      `**All Domains:** ${(stack.domains ?? []).join(', ')}`,
      `**Languages:** ${(stack.languages ?? []).join(', ') || 'Not specified'}`,
      `**Frameworks:** ${(stack.frameworks ?? []).join(', ') || 'Not specified'}`,
      `**Detection Confidence:** ${Math.round(stack.confidence * 100)}%`,
      '',
      'No stack-specific profile file was found for this domain. Agents should',
      'apply general best practices appropriate for the detected stack.',
    ].join('\n');
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const contextLoader = new ContextLoader();
