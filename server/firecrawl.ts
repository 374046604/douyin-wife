import type { WebSnapshot } from '../src/types';

type FirecrawlResponse = {
  success?: boolean;
  error?: string;
  data?: {
    markdown?: unknown;
    metadata?: { title?: unknown; sourceURL?: unknown };
  };
};

export class FirecrawlError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'FirecrawlError';
  }
}

export type WebScraper = {
  isConfigured(): boolean;
  scrape(url: string): Promise<Omit<WebSnapshot, 'id'>>;
};

export class FirecrawlScraper implements WebScraper {
  constructor(private readonly apiKey = process.env.FIRECRAWL_API_KEY, private readonly request: typeof fetch = fetch) {}

  isConfigured(): boolean { return Boolean(this.apiKey); }

  async scrape(url: string): Promise<Omit<WebSnapshot, 'id'>> {
    if (!this.apiKey) throw new FirecrawlError('尚未配置 FIRECRAWL_API_KEY。请在项目根目录的 .env.local 中设置后重启服务。', 503);
    let response: Response;
    try {
      response = await this.request('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: ['markdown'] }),
      });
    } catch {
      throw new FirecrawlError('无法连接 Firecrawl，请检查网络后重试。', 502);
    }
    const payload = await response.json().catch(() => ({})) as FirecrawlResponse;
    if (!response.ok || payload.success === false) throw new FirecrawlError(payload.error || `Firecrawl 请求失败（${response.status}）。`, response.status >= 400 ? response.status : 502);
    const content = typeof payload.data?.markdown === 'string' ? payload.data.markdown.trim() : '';
    if (!content) throw new FirecrawlError('Firecrawl 未返回可用正文；页面可能需要登录、验证码或不支持公开抓取。', 422);
    const metadata = payload.data?.metadata;
    const sourceUrl = typeof metadata?.sourceURL === 'string' ? metadata.sourceURL : url;
    const title = typeof metadata?.title === 'string' && metadata.title.trim() ? metadata.title.trim() : new URL(sourceUrl).hostname;
    return { url, sourceUrl, title, content: content.slice(0, 100_000), fetchedAt: new Date().toISOString(), provider: 'firecrawl' };
  }
}
