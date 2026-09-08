import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PermissionEngine, emptyApprovals, permissionKey, type AskerVerdict } from "../src/utils/permissions.js";

describe("permission engine", () => {
  it("tool safe selalu allow", async () => {
    const p = new PermissionEngine(false);
    assert.equal(await p.check("read_file", { path: "a.txt" }, "safe"), "allow");
  });

  it("autoApprove mengizinkan tool moderate tanpa prompt", async () => {
    const p = new PermissionEngine(true);
    assert.equal(await p.check("write_file", { path: "a.txt" }, "moderate"), "allow");
    assert.equal(await p.check("shell", {}, "moderate", "echo hi"), "allow");
  });

  it("shell dikelompokkan per perintah dasar", () => {
    assert.deepEqual(permissionKey("shell", { command: "npm test" }, "npm test"), {
      key: "shell:npm",
      base: "npm",
    });
    const fk = permissionKey("edit_file", { path: "App.tsx" }, undefined);
    assert.equal(fk.key, "edit_file:App.tsx");
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

  it("cancel (Ctrl+C) ditolak tanpa disimpan", async () => {
    const p = new PermissionEngine(false, { asker: async () => "cancel" as AskerVerdict });
    assert.equal(await p.check("shell", { command: "npm test" }, "moderate", "npm test"), "deny");
    assert.deepEqual(p.getState(), emptyApprovals());
  });

  it("abort saat menunggu → deny", async () => {
    const p = new PermissionEngine(false, { asker: () => new Promise(() => {}) as Promise<AskerVerdict> });
    const c = new AbortController();
    const pending = p.check("shell", { command: "npm test" }, "moderate", "npm test", c.signal);
    c.abort();
    assert.equal(await pending, "deny");
  });
});
