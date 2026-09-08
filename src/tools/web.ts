// ─── Web tools — search internet + fetch ───
// search diadaptasi dari sabana-dev apps/web/app/lib/tavily.server.ts
// dengan fallback DuckDuckGo bila TAVILY_API_KEY kosong.
import type { ToolDefinition } from "./types.js";

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description: "Cari internet. Pakai Tavily bila ada API key, fallback DuckDuckGo.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Kueri pencarian" },
      maxResults: { type: "number", description: "Maks hasil (default 5)" },
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
    // pola sederhana; bila gagal, kembalikan html terpotong agar agent tetap dapat konteks
    let m: RegExpExecArray | null;
    const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&[^;]+;/g, " ").trim();
    while ((m = re.exec(html)) && results.length < maxResults) {
      results.push({ title: strip(m[2]), url: m[1], content: "" });
    }
    if (results.length === 0) {
      return {
        query,
        provider: "duckduckgo",
        note: "Set TAVILY_API_KEY untuk hasil lebih baik.",
        results: [],
        rawHint: html.slice(0, 2000).replace(/<[^>]+>/g, " ").slice(0, 1000),
      };
    }
    return { query, provider: "duckduckgo", results };
  };
}

export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description: "Ambil konten URL sebagai teks (dipotong 15k char). Untuk baca docs / artikel.",
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
    if (!/^https?:\/\//i.test(url)) return { error: `URL tidak valid: ${url}` };
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
