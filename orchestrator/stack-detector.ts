import { DetectedStack, StackDomain, AgentRole } from '../types/index.js';
import { BaseAgent } from '../agents/base-agent.js';

// ─── StackDetector ────────────────────────────────────────────────────────────

export class StackDetector extends BaseAgent {
  constructor() {
    // Use the fast Haiku model — this is a lightweight classification call
    super(AgentRole.PM, 'claude-haiku-4-5-20251001');
  }

  /**
   * Analyse a raw requirement string and return a structured DetectedStack.
   * Uses callWithValidation so the model is self-corrected up to 3 times when
   * the JSON schema is not satisfied.
   */
  async detect(requirement: string): Promise<DetectedStack> {
    const validDomains = Object.values(StackDomain);

    // Strip GitHub URLs and replace with readable context so the model does not
    // try to access them. E.g. "https://github.com/owner/my-react-app" → "[repo: my-react-app]"
    const sanitized = requirement.replace(
      /https?:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)[^\s]*/g,
      (_match, _owner, repo) => `[GitHub repo: ${(repo as string).replace(/\.git$/, '')}]`,
    );

    const systemPrompt = [
      'You are a technical stack detector for a software agency.',
      'Analyse the project description below and identify the technology stack.',
      'Return ONLY a valid JSON object — no prose, no markdown fences, no explanation.',
      '',
      'IMPORTANT RULES:',
      '- Do NOT attempt to access any URL, clone any repository, or run any commands.',
      '- Do NOT say you need more information. Make your best inference from the text.',
      '- If a GitHub repo name is mentioned (e.g. [GitHub repo: my-react-app]), infer',
      '  the stack from the name and any surrounding context.',
      '- Always output valid JSON immediately.',
      '',
      'Schema:',
      '{',
      '  "domains": string[],         // one or more StackDomain values',
      '  "primaryDomain": string,     // the single most relevant StackDomain',
      '  "confidence": number,        // 0.0 – 1.0',
      '  "languages": string[],       // e.g. ["TypeScript","Solidity"]',
      '  "frameworks": string[],      // e.g. ["React","Hardhat"]',
      '  "ambiguities": Array<{question:string, options:string[]}> // can be []',
      '}',
      '',
      `Valid StackDomain values: ${validDomains.join(', ')}`,
    ].join('\n');

    const detected = await this.callWithValidation<DetectedStack>({
      systemPrompt,
      messages: [
        {
          role: 'user',
          content: sanitized,
          timestamp: new Date(),
        },
      ],
      projectId: 'stack-detection',
      validate: (output: DetectedStack) => {
        if (!Array.isArray(output.domains) || output.domains.length === 0) {
          return { valid: false, reason: '"domains" must be a non-empty array.' };
        }

        for (const d of output.domains) {
          if (!validDomains.includes(d as StackDomain)) {
            return {
              valid: false,
              reason: `Invalid domain "${d}". Valid values: ${validDomains.join(', ')}`,
            };
          }
        }

        if (!validDomains.includes(output.primaryDomain as StackDomain)) {
          return {
            valid: false,
            reason: `"primaryDomain" must be one of: ${validDomains.join(', ')}`,
          };
        }

        if (
          typeof output.confidence !== 'number' ||
          output.confidence < 0 ||
          output.confidence > 1
        ) {
          return { valid: false, reason: '"confidence" must be a number between 0 and 1.' };
        }

        if (!Array.isArray(output.languages)) {
          return { valid: false, reason: '"languages" must be an array.' };
        }

        if (!Array.isArray(output.frameworks)) {
          return { valid: false, reason: '"frameworks" must be an array.' };
        }

        if (!Array.isArray(output.ambiguities)) {
          return { valid: false, reason: '"ambiguities" must be an array (may be empty).' };
        }

        return { valid: true };
      },
      maxAttempts: 3,
    });

    return detected;
  }

  /**
   * Return a rough USD cost range for the sprint based on detected domains.
   */
  estimateCost(stack: DetectedStack): string {
    const domain = stack.primaryDomain;

    switch (domain) {
      case StackDomain.WEB_SAAS:
        return '$15-30';

      case StackDomain.MOBILE_RN:
      case StackDomain.MOBILE_FLUTTER:
        return '$20-40';

      case StackDomain.BLOCKCHAIN_EVM:
      case StackDomain.BLOCKCHAIN_SOL:
        return '$30-60';

      case StackDomain.AI_ML:
        return '$25-50';

      case StackDomain.IOT_EMBEDDED:
        return '$20-45';

      case StackDomain.DATA_PLATFORM:
        return '$20-40';

      case StackDomain.DESKTOP:
        return '$18-35';

      case StackDomain.CLI_TOOL:
        return '$10-20';

      case StackDomain.BROWSER_EXT:
        return '$12-25';

      case StackDomain.GAME:
        return '$30-60';

      case StackDomain.SERVERLESS:
        return '$12-25';

      case StackDomain.DEVOPS:
        return '$15-30';

      default:
        return '$15-35';
    }
  }

  /**
   * Return a rough wall-clock time range for the sprint based on detected domains.
   */
  estimateTime(stack: DetectedStack): string {
    const domain = stack.primaryDomain;

    switch (domain) {
      case StackDomain.WEB_SAAS:
        return '3-5 hours';

      case StackDomain.MOBILE_RN:
      case StackDomain.MOBILE_FLUTTER:
        return '5-8 hours';

      case StackDomain.BLOCKCHAIN_EVM:
      case StackDomain.BLOCKCHAIN_SOL:
        return '8-12 hours';

      case StackDomain.AI_ML:
        return '6-10 hours';

      case StackDomain.IOT_EMBEDDED:
        return '5-9 hours';

      case StackDomain.DATA_PLATFORM:
        return '4-7 hours';

      case StackDomain.DESKTOP:
        return '4-6 hours';

      case StackDomain.CLI_TOOL:
        return '2-4 hours';

      case StackDomain.BROWSER_EXT:
        return '3-5 hours';

      case StackDomain.GAME:
        return '8-14 hours';

      case StackDomain.SERVERLESS:
        return '3-5 hours';

      case StackDomain.DEVOPS:
        return '4-7 hours';

      default:
        return '3-6 hours';
    }
  }

  /**
   * Derive a DetectedStack from an already-completed repo analysis.
   * Used for repo improvement projects so we skip the LLM stack-detection call
   * and never ask ambiguity questions — the code already tells us everything.
   */
  fromRepoAnalysis(analysis: import('../types/index.js').RepoAnalysis): DetectedStack {
    const detected = (analysis.detectedStack ?? []).map((s) => s.toLowerCase());

    // Infer primaryDomain from the detected stack strings
    let primaryDomain: StackDomain = StackDomain.WEB_SAAS;
    if (detected.some((s) => s.includes('react') || s.includes('vue') || s.includes('angular'))) {
      primaryDomain = StackDomain.WEB_SAAS;
    } else if (detected.some((s) => s.includes('solidity') || s.includes('web3'))) {
      primaryDomain = StackDomain.BLOCKCHAIN_EVM;
    } else if (detected.some((s) => s.includes('ml') || s.includes('torch') || s.includes('tensorflow'))) {
      primaryDomain = StackDomain.AI_ML;
    } else if (detected.some((s) => s.includes('flutter'))) {
      primaryDomain = StackDomain.MOBILE_FLUTTER;
    } else if (detected.some((s) => s.includes('mobile') || s.includes('react native'))) {
      primaryDomain = StackDomain.MOBILE_RN;
    }

    const knownLangs = ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Java', 'C#', 'Ruby', 'PHP'];
    const allStack = analysis.detectedStack ?? [];
    return {
      domains: [primaryDomain],
      primaryDomain,
      confidence: 0.95,
      languages: allStack.filter((s) => knownLangs.includes(s)),
      frameworks: allStack.filter((s) => !knownLangs.includes(s)),
      ambiguities: [],
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const stackDetector = new StackDetector();
