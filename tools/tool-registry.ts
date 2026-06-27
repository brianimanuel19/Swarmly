import type { StackDomain } from '../types/index.js';

interface NpmPackageInfo {
  description: string;
  readme: string;
}

interface PypiPackageInfo {
  description: string;
}

const DOMAIN_DOC_URLS: Record<string, string> = {
  web_saas: 'https://developer.mozilla.org/en-US/docs/Web',
  mobile_rn: 'https://reactnative.dev/docs/getting-started',
  mobile_flutter: 'https://docs.flutter.dev',
  blockchain_evm: 'https://docs.soliditylang.org',
  blockchain_solana: 'https://docs.solana.com',
  iot_embedded: 'https://docs.zephyrproject.org',
  ai_ml: 'https://huggingface.co/docs',
  desktop: 'https://www.electronjs.org/docs/latest',
  data_platform: 'https://docs.apache.org/spark',
};

const DOMAIN_GUIDANCE: Record<string, string> = {
  web_saas:
    'React/Next.js for frontend, Node.js/Express for backend APIs, PostgreSQL for persistence, Tailwind CSS for styling.',
  mobile_rn:
    'React Native with Expo for cross-platform mobile, React Navigation for routing, Redux Toolkit for state.',
  mobile_flutter:
    'Flutter with Dart, Provider or Riverpod for state management, Dio for HTTP, SQLite for local storage.',
  blockchain_evm:
    'Solidity smart contracts, Hardhat for testing and deployment, ethers.js for client interaction, OpenZeppelin for security.',
  blockchain_solana:
    'Rust programs via Anchor framework, web3.js for client, SPL tokens for fungible assets.',
  iot_embedded:
    'C/C++ with RTOS (Zephyr/FreeRTOS), MQTT for messaging, protobuf for serialisation, OTA for updates.',
  ai_ml:
    'Python with PyTorch or TensorFlow, FastAPI for model serving, Hugging Face Transformers, MLflow for experiment tracking.',
  desktop:
    'Electron with React renderer, IPC for main/renderer communication, electron-builder for packaging.',
  data_platform:
    'Apache Spark or dbt for transformations, Airflow for orchestration, Delta Lake for storage, dbt for modelling.',
};

export class ToolRegistry {
  /**
   * Fetch a URL and return its stripped text content, truncated to 10 000 chars.
   */
  async fetchUrl(url: string): Promise<string> {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Swarmly-Agent/1.0 (+https://github.com/swarmly/swarmly)',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${url}`);
      }

      const html = await response.text();
      // Strip HTML tags
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();

      return text.substring(0, 10_000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`fetchUrl failed for ${url}: ${msg}`);
    }
  }

  /**
   * Return structured guidance for a given domain.
   */
  async searchDocs(query: string, domain: StackDomain): Promise<string> {
    try {
      const domainKey = domain.toString();
      const docUrl = DOMAIN_DOC_URLS[domainKey] ?? 'https://developer.mozilla.org';
      const guidance =
        DOMAIN_GUIDANCE[domainKey] ?? 'Refer to official documentation for best practices.';

      return (
        `Documentation search results for "${query}" in ${domainKey} domain:\n\n` +
        `Primary documentation: ${docUrl}\n\n` +
        `Recommended stack & guidance:\n${guidance}\n\n` +
        `Search query "${query}" — consult the above documentation URL for detailed API references, ` +
        `tutorials, and examples relevant to your use case.`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`searchDocs failed for query "${query}": ${msg}`);
    }
  }

  /**
   * Fetch package metadata from the npm registry.
   */
  async searchNpm(packageName: string): Promise<NpmPackageInfo> {
    try {
      const response = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
        {
          headers: {
            'User-Agent': 'Swarmly-Agent/1.0',
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from npm registry`);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const description = typeof data.description === 'string' ? data.description : '';
      const readme = typeof data.readme === 'string' ? data.readme.substring(0, 5_000) : '';

      return { description, readme };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`searchNpm failed for package "${packageName}": ${msg}`);
    }
  }

  /**
   * Fetch package metadata from PyPI.
   */
  async searchPypi(packageName: string): Promise<PypiPackageInfo> {
    try {
      const response = await fetch(
        `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`,
        {
          headers: {
            'User-Agent': 'Swarmly-Agent/1.0',
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from PyPI`);
      }

      const data = (await response.json()) as {
        info?: { summary?: string; description?: string };
      };
      const description = data.info?.summary ?? data.info?.description?.substring(0, 1_000) ?? '';

      return { description };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`searchPypi failed for package "${packageName}": ${msg}`);
    }
  }

  /**
   * Read an uploaded file by URL.
   * For text files, fetches and returns content.
   * For PDF/image, returns a placeholder description.
   */
  async readUploadedFile(fileUrl: string, type: 'pdf' | 'image' | 'text'): Promise<string> {
    try {
      if (type === 'text') {
        const response = await fetch(fileUrl, {
          headers: { 'User-Agent': 'Swarmly-Agent/1.0' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} fetching file`);
        }
        const text = await response.text();
        return text.substring(0, 10_000);
      }

      return `File content analysis: ${type} file processed from ${fileUrl}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`readUploadedFile failed (${type}) for ${fileUrl}: ${msg}`);
    }
  }

  /**
   * Returns a formatted string listing all available tools and their signatures.
   */
  getToolDescriptions(): string {
    return `Available Tools:

1. fetchUrl(url: string) -> string
   Fetches a URL and returns the stripped text content (max 10,000 chars).

2. searchDocs(query: string, domain: StackDomain) -> string
   Returns structured documentation guidance for the given technology domain.
   Supported domains: web_saas, mobile_rn, mobile_flutter, blockchain_evm,
   blockchain_solana, iot_embedded, ai_ml, desktop, data_platform.

3. searchNpm(packageName: string) -> { description: string; readme: string }
   Fetches npm package metadata including description and README excerpt.

4. searchPypi(packageName: string) -> { description: string }
   Fetches PyPI package metadata including the package summary.

5. readUploadedFile(fileUrl: string, type: "pdf" | "image" | "text") -> string
   Reads an uploaded file. Returns text content for text files, or a
   placeholder description for PDF and image files.

6. getToolDescriptions() -> string
   Returns this formatted list of available tools.`;
  }
}

export const toolRegistry = new ToolRegistry();
