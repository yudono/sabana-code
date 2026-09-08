import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PermissionEngine } from "../src/utils/permissions.js";

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
});
