import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initEnvFromSettings } from "../src/settings.js";
import { webFetchHandler, webSearchHandler } from "../src/tools/web.js";

initEnvFromSettings();

describe("web tools", () => {
  it("web_fetch fetches a page as text", async (t) => {
    const r = (await webFetchHandler()({ url: "https://example.com", maxChars: 2000 })) as {
      content?: string;
      error?: string;
    };
    // Jaringan sandbox kadang diblokir remote (403) — bukan bug handler.
    if (!r.content) {
      t.skip(`example.com tak terjangkau: ${r.error}`);
      return;
    }
    assert.ok(r.content.includes("Example Domain"));
  });

  it("web_fetch rejects invalid URLs", async () => {
    const r = (await webFetchHandler()({ url: "bukan-url" })) as { error: string };
    assert.ok(r.error.includes("Invalid URL"));
  });

  it("web_search returns results (needs TAVILY_API_KEY)", async (t) => {
    if (!process.env.TAVILY_API_KEY) {
      t.skip("TAVILY_API_KEY kosong — skip");
      return;
    }
    const r = (await webSearchHandler()({ query: "typescript", maxResults: 2 })) as {
      query: string;
      results: unknown[];
      error?: string;
    };
    assert.equal(r.query, "typescript");
    assert.ok(!r.error, `search error: ${r.error}`);
    assert.ok(Array.isArray(r.results) && r.results.length > 0);
  });
});
