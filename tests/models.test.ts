import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  estimateTokens,
  findModel,
  getContextWindow,
  listModels,
  resolveProvider,
} from "../src/llm/models.js";

beforeEach(() => {
  // Isolasi dari ~/sabana-code/ asli (resolveProvider membaca settings)
  process.env.SABANA_HOME = mkdtempSync(join(tmpdir(), "sc-models-"));
  delete process.env.OPENAI_KEY;
  delete process.env.SABANA_API_KEY;
});

describe("model catalog", () => {
  it("menemukan model di katalog + window-nya", () => {
    assert.equal(findModel("gpt-4o-mini", "openai")?.contextWindow, 128_000);
    assert.equal(getContextWindow("gpt-4o-mini", "openai"), 128_000);
    assert.equal(getContextWindow("claude-sonnet-4-5", "anthropic"), 200_000);
  });

  it("mendukung format provider/model", () => {
    assert.ok(findModel("openai/gpt-4o"));
  });

  it("fallback ke default provider untuk model tak dikenal", () => {
    assert.equal(getContextWindow("model-aneh", "openai"), 128_000);
    assert.equal(getContextWindow("model-aneh", "ollama"), 32_768);
    assert.equal(getContextWindow("model-aneh", "provider-aneh"), 32_768);
  });

  it("window berbeda antar model", () => {
    assert.ok(getContextWindow("gpt-4.1", "openai") > getContextWindow("gpt-4o-mini", "openai"));
  });

  it("listModels bisa difilter provider", () => {
    assert.ok(listModels("ollama").length > 0);
    assert.ok(listModels("ollama").every((m) => m.provider === "ollama"));
  });

  it("estimasi token ~4 char", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("a".repeat(400)), 100);
  });

  it("resolveProvider mock/ollama tak butuh key", () => {
    assert.equal(resolveProvider("mock").needsKey, false);
    assert.equal(resolveProvider("ollama").needsKey, false);
    assert.equal(resolveProvider("openai").needsKey, true);
  });
});
