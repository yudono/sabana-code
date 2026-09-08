import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../src/db.js";
import { listProjects, projectIdFor, projectSessions, registerProject } from "../src/projects.js";
import { createSession, saveSession } from "../src/session/store.js";
import { listAgents, loadAgent, runSubAgent } from "../src/subagents.js";
import { setMockPlan } from "../src/llm/mock.js";

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sc-proj-"));
  process.env.SABANA_HOME = home;
  for (const k of ["SABANA_API_KEY", "OPENAI_KEY"]) delete process.env[k];
  closeDb();
  return home;
}

describe("projects registry", () => {
  it("ID stabil untuk path yang sama, beda untuk path lain", () => {
    isolatedHome();
    const a = mkdtempSync(join(tmpdir(), "proj-a-"));
    assert.equal(projectIdFor(a), projectIdFor(a + "/"));
    assert.notEqual(projectIdFor(a), projectIdFor(mkdtempSync(join(tmpdir(), "proj-b-"))));
    assert.match(projectIdFor(a), /^[0-9a-f]{16}$/);
  });

  it("register membuat info.json + session ter-link ke project", () => {
    const home = isolatedHome();
    const cwd = mkdtempSync(join(tmpdir(), "myapp-"));
    const info = registerProject(cwd);
    assert.ok(existsSync(join(home, "projects", info.id, "info.json")));
    assert.equal(info.name, cwd.split("/").pop());

    const s = createSession("m", "mock", cwd);
    assert.equal(s.projectId, info.id);
    s.messages.push({ role: "user", content: "halo" });
    saveSession(s);

    const mine = projectSessions(info.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].id, s.id);
    const list = listProjects();
    assert.equal(list[0].id, info.id);
    assert.equal(list[0].sessions, 1);
  });

  it("satu project bisa punya banyak session", () => {
    isolatedHome();
    const cwd = mkdtempSync(join(tmpdir(), "multi-"));
    const a = createSession("m", "mock", cwd);
    const b = createSession("m", "mock", cwd);
    assert.equal(a.projectId, b.projectId);
    saveSession(a);
    saveSession(b);
    assert.equal(projectSessions(a.projectId).length, 2);
  });
});

describe("sub-agents", () => {
  it("memuat profil dari ~/sabana-code/agents", () => {
    const home = isolatedHome();
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(
      join(home, "agents", "audit.md"),
      "---\nname: audit\ndescription: Audit cepat\nmodel: gpt-4o\n---\n\nCari bug.\n",
    );
    const list = listAgents();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "audit");
    assert.equal(list[0].model, "gpt-4o");
    assert.ok(list[0].instructions.includes("Cari bug"));
    assert.ok(loadAgent("AUDIT"));
    assert.equal(loadAgent("tidak-ada"), null);
  });

  it("runSubAgent jalan terisolasi dan mengembalikan teks", async () => {
    isolatedHome();
    const ws = mkdtempSync(join(tmpdir(), "sc-sub-"));
    setMockPlan([{ name: "write_file", args: { path: "sub.txt", content: "dari-sub" } }]);
    const r = await runSubAgent(
      { name: "t", description: "d", instructions: "Kerjakan.", file: "t.md" },
      "buat sub.txt",
      ws,
      { provider: "mock", apiKey: "mock", baseUrl: "", model: "mock", maxTokens: 256, maxSteps: 5 },
    );
    assert.equal(r.success, true);
    assert.deepEqual(r.files, ["sub.txt"]);
    assert.ok(r.text.length > 0);
  });
});
