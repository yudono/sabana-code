import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTodos, loadTodos, todoListHandler, todoWriteHandler } from "../src/todo.js";
import { closeDb } from "../src/db.js";

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sc-todo-"));
  process.env.SABANA_HOME = home;
  closeDb();
  return home;
}

function ws(): string {
  return mkdtempSync(join(tmpdir(), "sc-todows-"));
}

describe("todo queue", () => {
  it("starts empty", () => {
    isolatedHome();
    const l = loadTodos(ws());
    assert.deepEqual(l.items, []);
    assert.equal(formatTodos([]), "(no todos yet)");
  });

  it("todo_write saves + todo_list reads", async () => {
    isolatedHome();
    const w = ws();
    const wr = todoWriteHandler(w);
    const r = (await wr({
      todos: [
        { content: "Setup repo", status: "completed", priority: "high" },
        { content: "Tulis kode", status: "in_progress", priority: "high" },
        { content: "Test", status: "pending" },
      ],
    })) as { updated: boolean; total: number; completed: number };
    assert.equal(r.updated, true);
    assert.equal(r.total, 3);
    assert.equal(r.completed, 1);
    const lr = todoListHandler(w);
    const back = (await lr({})) as { total: number; completed: number };
    assert.equal(back.total, 3);
    assert.equal(back.completed, 1);
    const fmt = formatTodos(loadTodos(w).items);
    assert.ok(fmt.includes("◐"));
    assert.ok(fmt.includes("●"));
    assert.ok(fmt.includes("○"));
  });

  it("rejects 2 in_progress at once", async () => {
    isolatedHome();
    const r = (await todoWriteHandler(ws())({
      todos: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ],
    })) as { error?: string };
    assert.ok(r.error?.includes("in_progress"));
  });

  it("rejects empty content & duplicate ids", async () => {
    isolatedHome();
    const h = todoWriteHandler(ws());
    assert.ok(((await h({ todos: [{ content: "  " }] })) as { error?: string }).error);
    assert.ok(
      ((await h({ todos: [{ id: "x", content: "a" }, { id: "x", content: "b" }] })) as { error?: string }).error?.includes("duplicate"),
    );
  });

  it("separated per project", async () => {
    isolatedHome();
    const a = ws();
    const b = ws();
    await todoWriteHandler(a)({ todos: [{ content: "milik A" }] });
    assert.equal(loadTodos(a).items.length, 1);
    assert.equal(loadTodos(b).items.length, 0);
  });
});
