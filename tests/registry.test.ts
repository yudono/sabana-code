import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/registry.js";
import { readFileTool } from "../src/tools/filesystem.js";

describe("tool registry", () => {
  it("register + get + toModelTools", () => {
    const r = new ToolRegistry();
    r.register(readFileTool);
    assert.equal(r.get("read_file")?.name, "read_file");
    const model = r.toModelTools();
    assert.equal(model.length, 1);
    assert.equal(model[0].type, "function");
    assert.equal(model[0].function.name, "read_file");
  });

  it("validate menolak field wajib yang hilang", () => {
    const r = new ToolRegistry();
    r.register(readFileTool);
    assert.equal(r.validate("read_file", {}).valid, false);
    assert.equal(r.validate("read_file", { path: "a.txt" }).valid, true);
  });

  it("validate menolak tool tak dikenal", () => {
    const r = new ToolRegistry();
    assert.equal(r.validate("ghost", {}).valid, false);
  });
});
