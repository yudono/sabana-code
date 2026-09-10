import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpManager,
  loadMcpConfig,
  mcpToolName,
  parseMcpToolName,
  saveMcpConfig,
} from "../src/mcp.js";
import { closeDb } from "../src/db.js";

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sc-mcp-"));
  process.env.SABANA_HOME = home;
  closeDb();
  return home;
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-echo.mjs");

describe("mcp tool names", () => {
  it("mapping server/tool ↔ nama tool", () => {
    assert.equal(mcpToolName("GitHub", "create_issue"), "mcp__github__create_issue");
    assert.deepEqual(parseMcpToolName("mcp__github__create_issue"), { server: "github", tool: "create_issue" });
    assert.equal(parseMcpToolName("read_file"), null);
    assert.equal(parseMcpToolName("mcp__saja"), null);
  });
});

describe("mcp config", () => {
  it("kosong bila belum ada file", () => {
    isolatedHome();
    assert.deepEqual(loadMcpConfig(), { servers: {} });
  });

  it("roundtrip + entri tanpa command dibuang", () => {
    isolatedHome();
    saveMcpConfig({ servers: { ok: { command: "npx", args: ["-y", "x"] }, rusak: { command: "  " } } });
    const back = loadMcpConfig();
    assert.ok(back.servers.ok);
    assert.ok(!back.servers.rusak);
  });
});

describe("mcp manager vs server asli", () => {
  it("list + call tools via stdio", async () => {
    isolatedHome();
    saveMcpConfig({ servers: { test: { command: process.execPath, args: [FIXTURE], timeoutMs: 8000 } } });
    const mgr = new McpManager();
    try {
      const { tools, errors } = await mgr.ensureLoaded();
      assert.deepEqual(errors, []);
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, "mcp__test__echo");
      const handler = mgr.handlerFor("mcp__test__echo");
      assert.ok(handler);
      const out = (await handler!({ text: "halo" })) as string;
      assert.equal(out, "echo:halo");
      assert.equal(mgr.status()[0].state, "up");
    } finally {
      mgr.stopAll();
    }
  });

  it("server gagal start → down, tanpa tools", async () => {
    isolatedHome();
    saveMcpConfig({ servers: { zonk: { command: "/tidak/ada/bin-xyz", timeoutMs: 3000 } } });
    const mgr = new McpManager();
    try {
      const { tools, errors } = await mgr.ensureLoaded();
      assert.equal(tools.length, 0);
      assert.equal(errors.length, 1);
      assert.equal(mgr.status()[0].state, "down");
      assert.equal(mgr.handlerFor("mcp__zonk__x"), null);
    } finally {
      mgr.stopAll();
    }
  });
});
