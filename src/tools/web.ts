// ─── Web tools — internet search + fetch ───
// search adapted from sabana-dev apps/web/app/lib/tavily.server.ts
// with DuckDuckGo fallback when TAVILY_API_KEY is empty.
import type { ToolDefinition } from "./types.js";

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description: "Search the internet. Uses Tavily when an API key exists, DuckDuckGo fallback.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      maxResults: { type: "number", description: "Max results (default 5)" },
    },
    required: ["query"],
  },
  permissions: { requiresPermission: false },
  timeout: 30_000,
  riskLevel: "safe",
};

export function webSearchHandler() {
  return async (args: Record<string, unknown>) => {
    const query = args.query as string;
    const maxResults = (args.maxResults as number) || 5;
    const tavilyKey = process.env.TAVILY_API_KEY || process.env.TAVILY_KEY;

    if (tavilyKey) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: tavilyKey,
          query,
          search_depth: "basic",
          max_results: maxResults,
          include_answer: true,
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { error: `Tavily error (${res.status}): ${t.slice(0, 300)}`, query };
      }
      const data = (await res.json()) as {
        answer?: string;
        results?: Array<{ title: string; url: string; content: string; score: number }>;
      };
      return {
        query,
        answer: data.answer,
        results: (data.results || []).slice(0, maxResults),
        provider: "tavily",
      };
    }

    // Fallback: DuckDuckGo Instant Answer + html lite scrape ringan
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 sabana-code/0.1" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { error: `Search fallback error (${res.status})`, query };
    const html = await res.text();
    const results: Array<{ title: string; url: string; content: string }> = [];
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]{0,500}?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    // simple pattern; on failure return truncated html so the agent still gets context
    let m: RegExpExecArray | null;
    const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&[^;]+;/g, " ").trim();
    while ((m = re.exec(html)) && results.length < maxResults) {
      results.push({ title: strip(m[2]), url: m[1], content: "" });
    }
    if (results.length === 0) {
      return {
        query,
        provider: "duckduckgo",
        note: "Set TAVILY_API_KEY for better results.",
        results: [],
        rawHint: html.slice(0, 2000).replace(/<[^>]+>/g, " ").slice(0, 1000),
      };
    }
    return { query, provider: "duckduckgo", results };
  };
}

export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description: "Fetch URL content as text (truncated at 15k chars). For reading docs / articles.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      maxChars: { type: "number" },
    },
    required: ["url"],
  },
  permissions: { requiresPermission: false },
  timeout: 30_000,
  riskLevel: "safe",
};

export function webFetchHandler() {
  return async (args: Record<string, unknown>) => {
    const url = args.url as string;
    if (!/^https?:\/\//i.test(url)) return { error: `Invalid URL: ${url}` };
    const maxChars = (args.maxChars as number) || 15_000;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 sabana-code/0.1" },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return { error: `Fetch error (${res.status})`, url };
    const text = await res.text();
    const clean = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { url, length: clean.length, truncated: clean.length > maxChars, content: clean.slice(0, maxChars) };
  };
}
