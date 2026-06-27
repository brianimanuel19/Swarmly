const USER_AGENT = 'Swarmly-Agent/1.0 (+https://github.com/swarmly/swarmly)';
const FETCH_TIMEOUT_MS = 12_000;

interface StackOverflowResult {
  title: string;
  link: string;
  score: number;
}

interface NpmPackageResult {
  name: string;
  description: string;
  version: string;
}

interface GitHubRepoResult {
  name: string;
  description: string;
  stars: number;
  url: string;
}

export class SearchTool {
  /**
   * Search Stack Overflow via the public StackExchange API.
   * Returns the top 5 matching questions ordered by activity.
   */
  async searchStackOverflow(query: string): Promise<StackOverflowResult[]> {
    try {
      const encoded = encodeURIComponent(query);
      const apiUrl =
        `https://api.stackexchange.com/2.3/search` +
        `?order=desc&sort=activity&intitle=${encoded}&site=stackoverflow&pagesize=5`;

      const response = await fetch(apiUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.warn(`[SearchTool] Stack Overflow API returned ${response.status}`);
        return [];
      }

      const data = (await response.json()) as {
        items?: Array<{
          title?: string;
          link?: string;
          score?: number;
        }>;
      };

      if (!Array.isArray(data.items)) {
        return [];
      }

      return data.items.slice(0, 5).map((item) => ({
        title: typeof item.title === 'string' ? item.title : '',
        link: typeof item.link === 'string' ? item.link : '',
        score: typeof item.score === 'number' ? item.score : 0,
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SearchTool] searchStackOverflow error: ${msg}`);
      return [];
    }
  }

  /**
   * Search npm packages via the registry search endpoint.
   * Returns up to 5 matching packages.
   */
  async searchNpmPackages(query: string): Promise<NpmPackageResult[]> {
    try {
      const encoded = encodeURIComponent(query);
      const apiUrl = `https://registry.npmjs.org/-/v1/search?text=${encoded}&size=5`;

      const response = await fetch(apiUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.warn(`[SearchTool] npm registry returned ${response.status}`);
        return [];
      }

      const data = (await response.json()) as {
        objects?: Array<{
          package?: {
            name?: string;
            description?: string;
            version?: string;
          };
        }>;
      };

      if (!Array.isArray(data.objects)) {
        return [];
      }

      return data.objects.slice(0, 5).map((obj) => ({
        name: typeof obj.package?.name === 'string' ? obj.package.name : '',
        description: typeof obj.package?.description === 'string' ? obj.package.description : '',
        version: typeof obj.package?.version === 'string' ? obj.package.version : '',
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SearchTool] searchNpmPackages error: ${msg}`);
      return [];
    }
  }

  /**
   * Search GitHub repositories via the GitHub REST API.
   * Optionally filter by programming language.
   * Returns up to 5 results.
   */
  async searchGitHub(query: string, language?: string): Promise<GitHubRepoResult[]> {
    try {
      const queryString = language ? `${query} language:${language}` : query;
      const encoded = encodeURIComponent(queryString);
      const apiUrl = `https://api.github.com/search/repositories?q=${encoded}&sort=stars&order=desc&per_page=5`;

      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };

      const response = await fetch(apiUrl, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.warn(`[SearchTool] GitHub API returned ${response.status}`);
        return [];
      }

      const data = (await response.json()) as {
        items?: Array<{
          name?: string;
          description?: string | null;
          stargazers_count?: number;
          html_url?: string;
        }>;
      };

      if (!Array.isArray(data.items)) {
        return [];
      }

      return data.items.slice(0, 5).map((item) => ({
        name: typeof item.name === 'string' ? item.name : '',
        description: typeof item.description === 'string' ? item.description : '',
        stars: typeof item.stargazers_count === 'number' ? item.stargazers_count : 0,
        url: typeof item.html_url === 'string' ? item.html_url : '',
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SearchTool] searchGitHub error: ${msg}`);
      return [];
    }
  }
}

export const searchTool = new SearchTool();
