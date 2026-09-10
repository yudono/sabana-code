import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PermissionEngine, emptyApprovals, permissionKey, type AskerVerdict } from "../src/utils/permissions.js";

describe("permission engine", () => {
  it("safe tools always allow", async () => {
    const p = new PermissionEngine(false);
    assert.equal(await p.check("read_file", { path: "a.txt" }, "safe"), "allow");
  });

  it("autoApprove allows moderate tools without prompting", async () => {
    const p = new PermissionEngine(true);
    assert.equal(await p.check("write_file", { path: "a.txt" }, "moderate"), "allow");
    assert.equal(await p.check("shell", {}, "moderate", "echo hi"), "allow");
  });

  it("shell groups by base command", () => {
    assert.deepEqual(permissionKey("shell", { command: "npm test" }, "npm test"), {
      key: "shell:npm",
      base: "npm",
    });
    const fk = permissionKey("modified_file", { path: "App.tsx" }, undefined);
    assert.equal(fk.key, "modified_file:App.tsx");
    assert.equal(fk.base, undefined);
  });

  it("asker: once/all/deny", async () => {
    let verdict: AskerVerdict = "once";
    const p = new PermissionEngine(false, { asker: async () => verdict });
    assert.equal(await p.check("shell", { command: "npm test" }, "moderate", "npm test"), "allow");
    assert.deepEqual(p.getState(), emptyApprovals()); // once tidak disimpan

    verdict = "all";
    assert.equal(await p.check("shell", { command: "npm test" }, "moderate", "npm test"), "allow");
    assert.deepEqual(p.getState(), { allowAll: ["shell:npm"], denied: [] });
    // panggilan serupa berikutnya lolos tanpa bertanya
    let asked = false;
    const p2 = new PermissionEngine(false, {
      initial: p.getState(),
      asker: async () => {
        asked = true;
        return "deny";
      },
    });
    assert.equal(await p2.check("shell", { command: "npm run build" }, "moderate", "npm run build"), "allow");
    assert.equal(asked, false);

    verdict = "deny";
    const p3 = new PermissionEngine(false, { asker: async () => verdict });
    assert.equal(await p3.check("shell", { command: "rm -rf x" }, "moderate", "rm -rf x"), "deny");
    assert.deepEqual(p3.getState(), { allowAll: [], denied: ["shell:rm"] });
    assert.equal(await p3.check("shell", { command: "rm -rf y" }, "moderate", "rm -rf y"), "deny");
  });

  it("cancel (Ctrl+C) refused without saving", async () => {
    const p = new PermissionEngine(false, { asker: async () => "cancel" as AskerVerdict });
    assert.equal(await p.check("shell", { command: "npm test" }, "moderate", "npm test"), "deny");
    assert.deepEqual(p.getState(), emptyApprovals());
  });

  it("abort while waiting → deny", async () => {
    const p = new PermissionEngine(false, { asker: () => new Promise(() => {}) as Promise<AskerVerdict> });
    const c = new AbortController();
    const pending = p.check("shell", { command: "npm test" }, "moderate", "npm test", c.signal);
    c.abort();
    assert.equal(await pending, "deny");
  });

  it("safe shell (ls/cd) needs no approval, never asks", async () => {
    let asked = 0;
    const p = new PermissionEngine(false, {
      asker: async () => {
        asked++;
        return "deny";
      },
    });
    assert.equal(await p.check("shell", { command: "ls -la" }, "moderate", "ls -la"), "allow");
    assert.equal(await p.check("shell", { command: "cd /tmp && ls" }, "moderate", "cd /tmp && ls"), "allow");
    assert.equal(asked, 0);
  });

  it("dangerous shell still asks (once per entity)", async () => {
    const asked: string[] = [];
    const p = new PermissionEngine(false, {
      asker: async (req) => {
        asked.push(req.command as string);
        return "all";
      },
    });
    assert.equal(await p.check("shell", { command: "npm install" }, "moderate", "npm install"), "allow");
    // Satu entity npm → berikutnya lolos tanpa bertanya lagi
    assert.equal(await p.check("shell", { command: "npm run build" }, "moderate", "npm run build"), "allow");
    assert.equal(await p.check("shell", { command: "npm test" }, "moderate", "npm test"), "allow");
    assert.deepEqual(asked, ["npm install"]);
    // Entity lain tetap ditanya
    assert.equal(await p.check("shell", { command: "rm -rf x" }, "moderate", "rm -rf x"), "allow");
    assert.deepEqual(asked, ["npm install", "rm -rf x"]);
  });

  it("file write/edit needs no approval (risk safe)", async () => {
    let asked = 0;
    const p = new PermissionEngine(false, {
      asker: async () => {
        asked++;
        return "deny";
      },
    });
    assert.equal(await p.check("write_file", { path: "a.txt" }, "safe"), "allow");
    assert.equal(await p.check("modified_file", { path: "a.txt" }, "safe"), "allow");
    assert.equal(asked, 0);
  });
});
