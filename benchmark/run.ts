#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Benchmark harness ala SWE-bench / Terminal-Bench untuk sabana-code.
// Setiap task: setup workspace isolasi → jalankan agent → verify (FAIL_TO_PASS).
// Provider default "mock" (deterministik, tanpa LLM key) untuk validasi harness.
// Pakai provider real (openai/anthropic/ollama) untuk mengukur kemampuan model.
//   npx tsx benchmark/run.ts [--task <id|all>] [--provider mock|openai|...]
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SingleAgent } from "../src/agent.js";
import { setMockPlan } from "../src/llm/mock.js";
import { resolveCredentials } from "../src/auth.js";
import { initEnvFromSettings, rpmFromSettings } from "../src/settings.js";
import { err, log, ok } from "../src/utils/logger.js";
import type { BenchmarkTask } from "./types.js";
import { task as createConfig } from "./tasks/create-config.js";
import { task as fixBug } from "./tasks/fix-bug.js";
import { task as renameRefactor } from "./tasks/rename-refactor.js";
import { task as scaffoldCli } from "./tasks/scaffold-cli.js";
import { task as webFetchNote } from "./tasks/web-fetch-note.js";

config({ path: resolve(process.cwd(), ".env") });

const ALL_TASKS: BenchmarkTask[] = [createConfig, fixBug, renameRefactor, scaffoldCli, webFetchNote];

interface TaskResult {
  id: string;
  title: string;
  agentSuccess: boolean;
  steps: number;
  filesModified: string[];
  verifyOk: boolean;
  verifyError?: string;
  ms: number;
  passed: boolean;
}

async function runOne(task: BenchmarkTask, provider: string, model: string, maxSteps: number): Promise<TaskResult> {
  const ws = mkdtempSync(join(tmpdir(), `sc-bench-${task.id}-`));
  mkdirSync(join(process.cwd(), "benchmark", "workspaces"), { recursive: true });
  const started = Date.now();
  let agentSuccess = false;
  let steps = 0;
  let filesModified: string[] = [];
  let verifyOk = false;
  let verifyError: string | undefined;

  try {
    if (task.setup) await task.setup(ws);
    if (provider === "mock") setMockPlan(task.mockPlan);

    const creds = resolveCredentials(provider);
    const agent = new SingleAgent({
      model,
      provider,
      apiKey: creds.apiKey || "bench",
      baseUrl: creds.baseUrl,
      maxTokens: 4096,
      maxSteps,
      autoApprove: true,
      rpm: rpmFromSettings(),
    });
    const timeoutMs = task.timeoutMs || 120_000;
    const timeout = setTimeout(() => agent.abortRun(), timeoutMs);
    try {
      const r = await agent.run(task.prompt, ws);
      agentSuccess = r.success;
      steps = r.steps;
      filesModified = r.filesModified;
    } finally {
      clearTimeout(timeout);
    }

    try {
      await task.verify(ws);
      verifyOk = true;
    } catch (e) {
      verifyError = (e as Error).message.split("\n")[0];
    }
  } catch (e) {
    verifyError = `harness: ${(e as Error).message.split("\n")[0]}`;
  }

  return {
    id: task.id,
    title: task.title,
    agentSuccess,
    steps,
    filesModified,
    verifyOk,
    verifyError,
    ms: Date.now() - started,
    passed: agentSuccess && verifyOk,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  initEnvFromSettings();
  let only = "all";
  let provider = "mock";
  let model = process.env.SABANA_MODEL || "gpt-4o-mini";
  let maxSteps = 15;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task" && argv[i + 1]) only = argv[++i];
    else if (argv[i] === "--provider" && argv[i + 1]) provider = argv[++i];
    else if (argv[i] === "--model" && argv[i + 1]) model = argv[++i];
    else if (argv[i] === "--max-steps" && argv[i + 1]) maxSteps = parseInt(argv[++i], 10);
    else if (argv[i] === "--help" || argv[i] === "-h") {
      process.stderr.write("Usage: tsx benchmark/run.ts [--task <id|all>] [--provider mock|openai|anthropic|google|ollama|custom] [--model n] [--max-steps n]\n");
      process.exit(0);
    }
  }

  if (provider !== "mock" && provider !== "ollama" && !resolveCredentials(provider).apiKey) {
    err("Butuh API key untuk provider real (sabana-code setup). Pakai --provider mock untuk mode deterministik.");
    process.exit(1);
  }

  const tasks = only === "all" ? ALL_TASKS : ALL_TASKS.filter((t) => t.id === only);
  if (tasks.length === 0) {
    err(`Task tidak dikenal: ${only}. Pilihan: ${ALL_TASKS.map((t) => t.id).join(", ")}`);
    process.exit(1);
  }

  log(`benchmark: ${tasks.length} task, provider=${provider}, model=${model}`);
  const results: TaskResult[] = [];
  for (const t of tasks) {
    process.stderr.write(`\n▶ ${t.id} — ${t.title}\n`);
    const r = await runOne(t, provider, model, maxSteps);
    results.push(r);
    if (r.passed) ok(`${t.id} PASS (${r.ms}ms, ${r.steps} steps)`);
    else err(`${t.id} FAIL agent=${r.agentSuccess} verify=${r.verifyOk} ${r.verifyError || ""}`);
  }

  const passed = results.filter((r) => r.passed).length;
  const report = {
    at: new Date().toISOString(),
    provider,
    model,
    summary: { passed, total: results.length },
    tasks: results,
  };
  writeFileSync(join(process.cwd(), "benchmark", "results.json"), JSON.stringify(report, null, 2));

  process.stderr.write(`\n${"=".repeat(56)}\n| ${"task".padEnd(16)} | result | steps | ms       |\n${"=".repeat(56)}\n`);
  for (const r of results) {
    process.stderr.write(
      `| ${r.id.padEnd(16)} | ${r.passed ? "PASS  " : "FAIL  "} | ${String(r.steps).padEnd(5)} | ${String(r.ms).padEnd(8)} |\n`,
    );
  }
  process.stderr.write(`${"=".repeat(56)}\n${passed}/${results.length} passed → benchmark/results.json\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  err(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});
