const DEFAULT_MAX_CHARS = 8_000;
const USER_AGENT = 'Swarmly-Agent/1.0 (+https://github.com/swarmly/swarmly)';

interface FetchResult {
  content: string;
  title: string;
  url: string;
}

interface FetchResultWithError extends FetchResult {
  error?: string;
}

export class WebFetcher {
  /**
   * Fetch a URL, strip HTML, extract title, and truncate content.
   */
  async fetch(url: string, maxChars?: number): Promise<FetchResult> {
    const limit = maxChars ?? DEFAULT_MAX_CHARS;

    try {
      const response = await globalThis.fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        },
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const html = await response.text();

      // Extract title
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? (titleMatch[1] ?? '').replace(/\s+/g, ' ').trim() || url : url;

      // Strip script and style blocks first, then all remaining tags
      const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s{2,}/g, ' ')
        .trim();

      const content = stripped.substring(0, limit);

      return { content, title, url };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`WebFetcher.fetch failed for ${url}: ${msg}`);
    }
  }

  /**
   * Fetch multiple URLs in parallel, capturing individual errors.
   */
  async fetchMultiple(urls: string[]): Promise<FetchResultWithError[]> {
    const results = await Promise.allSettled(urls.map((url) => this.fetch(url)));

    return results.map((result, index) => {
      const url = urls[index] ?? '';
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const errorMsg =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      return {
        content: '',
        title: '',
        url,
        error: errorMsg,
      };
    });
  }
}

export const webFetcher = new WebFetcher();
