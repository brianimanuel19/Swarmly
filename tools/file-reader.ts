const USER_AGENT = 'Swarmly-Agent/1.0 (+https://github.com/swarmly/swarmly)';
const FETCH_TIMEOUT_MS = 20_000;
const PDF_CONTENT_LIMIT = 5_000;

export class FileReader {
  /**
   * Fetch a URL and return its raw text content.
   */
  async readText(url: string): Promise<string> {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/plain,text/*;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return await response.text();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`FileReader.readText failed for ${url}: ${msg}`);
    }
  }

  /**
   * Fetch a PDF by URL.
   * Attempts to extract readable text from the raw bytes; if the content is
   * binary (non-printable), returns a placeholder noting the file is binary.
   */
  async readPDF(url: string): Promise<string> {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/pdf,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const rawText = await response.text();

      // Determine whether we got printable text or binary content
      const printableChars = rawText.split('').filter((c) => {
        const code = c.charCodeAt(0);
        return (code >= 32 && code < 127) || code === 9 || code === 10 || code === 13;
      }).length;

      const printableRatio = printableChars / Math.max(rawText.length, 1);

      if (printableRatio > 0.7) {
        // Mostly text — return first 5,000 printable characters
        const readable = rawText
          .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .substring(0, PDF_CONTENT_LIMIT);
        return `PDF content extracted: ${readable}`;
      }

      return `PDF content extracted: [binary PDF content — text extraction requires a dedicated PDF parser. File URL: ${url}]`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`FileReader.readPDF failed for ${url}: ${msg}`);
    }
  }

  /**
   * Return a description for an image file.
   * Binary image content cannot be directly read as text; use a vision model
   * by passing the URL to the Anthropic messages API with an image block instead.
   */
  async readImage(url: string): Promise<string> {
    return (
      `Image file from ${url} - binary content not directly readable, ` +
      `use vision model (e.g. pass image URL to Anthropic API image block for analysis)`
    );
  }

  /**
   * Dispatch to the appropriate reader based on file type.
   */
  async read(fileUrl: string, type: 'pdf' | 'image' | 'text'): Promise<string> {
    switch (type) {
      case 'text':
        return this.readText(fileUrl);
      case 'pdf':
        return this.readPDF(fileUrl);
      case 'image':
        return this.readImage(fileUrl);
      default: {
        // Exhaustiveness guard — TypeScript will narrow `type` to `never` here
        const _exhaustive: never = type;
        throw new Error(`Unsupported file type: ${String(_exhaustive)}`);
      }
    }
  }
}

export const fileReader = new FileReader();
