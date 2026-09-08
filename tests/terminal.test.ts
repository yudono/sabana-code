import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellHandler, shellTool } from "../src/tools/terminal.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { PermissionEngine } from "../src/utils/permissions.js";

function executor(ws: string): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(shellTool);
  const ex = new ToolExecutor(registry, new PermissionEngine(true));
  ex.registerHandler("shell", shellHandler(ws));
  return ex;
}

describe("terminal shell", () => {
  it("perintah sukses mengembalikan exitCode 0 + stdout", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sc-sh-"));
    const r = (await shellHandler(ws)({ command: "echo hello-shell" })) as {
      exitCode: number;
      stdout: string;
    };
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello-shell"));
  });

  it("perintah gagal mengembalikan exitCode != 0", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sc-sh-"));
    const r = (await shellHandler(ws)({ command: "exit 3" })) as {
      exitCode: number;
    };
    assert.equal(r.exitCode, 3);
  });

  it("executor memblokir dev server agar loop tidak gantung", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sc-sh-"));
    const ex = executor(ws);
    const blocked = await ex.execute({ id: "1", name: "shell", args: { command: "npm run dev" } });
    assert.equal(blocked.status, "error");
    assert.ok(JSON.stringify(blocked.output).includes("BLOCKED"));
  });

  it("executor mengizinkan perintah biasa", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sc-sh-"));
    const ex = executor(ws);
    const r = await ex.execute({ id: "2", name: "shell", args: { command: "echo ok" } });
    assert.equal(r.status, "success");
  });

  it("executor menolak tool tak dikenal", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sc-sh-"));
    const ex = executor(ws);
    const r = await ex.execute({ id: "3", name: "nope_tool", args: {} });
    assert.equal(r.status, "error");
    assert.ok(JSON.stringify(r.output).includes("Unknown tool"));
  });
});
