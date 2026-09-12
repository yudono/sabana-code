# sabana-code

![sabana-code TUI](https://raw.githubusercontent.com/yudono/sabana-code/6f7cb1f82763930ee65f1eaf894a3d53c0ab73e0/Screenshot.png)

A coding agent with TUI (terminal UI) inspired by claude-code and opencode — a **single agent loop** with tool calling for filesystem, terminal, and internet search. Runs from any directory — sessions, credentials, logs, and database are stored globally in `~/sabana-code/`.

## Features

- **Single agent process** — one autonomous loop: understand request → call tools → verify → done.
  No complex multi-agent orchestration; one agent handles one task from start to finish.
- **Filesystem tools** — `read_file` (read with line numbers), `write_file` (write/overwrite),
  `modified_file` (targeted edits + unified diff output `+`/`-`), `delete_file` (remove file/empty dir),
  plus `list_directory`, `glob`, `grep` for exploration. All paths are sandboxed to the workspace.
- **Terminal tools** — `shell` for build/test/git commands, with hanging process protection
  (dev servers, `sleep`, background `&` are automatically blocked).
- **Internet tools** — `web_search` (via Tavily, fallback DuckDuckGo) and `web_fetch`
  for reading documentation and APIs while coding.
- **Interactive fullscreen TUI** — chat, prompt input, live tool-calling with step-by-step summaries
  (`read_file App.tsx`, `edit_file App.tsx (+11, -2)`, `$ npm test → exit 0`).
  Click a tool call to open a **fullscreen preview** (syntax highlighting) —
  `Esc`/`q` to close. Type `/` for command autocomplete, `↑`/`↓` for prompt
  history, wheel/trackpad gestures or `PgUp`/`PgDn` to scroll chat, mouse clicks supported.
- **Per-session shell approval** — risky commands (`rm`, `mkdir`, `npm`, …) require
  inline confirmation: `[y]` once, `[a]` all similar commands at once
  (e.g., approve `npm` once → `npm install`/`npm run build`/`npm test` all pass),
  `[n]` deny. Safe commands (`cd`, `ls`, `cat`, …) and all file operations
  run without prompts. Decisions are saved per session.
- **Session per project** — each project folder is automatically registered in `~/sabana-code/projects/`,
  each session is stored as a UUID in `~/sabana-code/sessions/` and can be resumed
  anytime (`sabana-code -r <id>`).
- **Custom sub-agents** — AI profiles in `~/sabana-code/agents/*.md` (e.g., reviewer, security auditor)
  for delegating specific tasks.
- **Skills** — reusable work instructions in `~/sabana-code/skills/*.md` or
  `<project>/.sabana/skills/*.md` (project overrides global). The agent auto-loads
  matching skills via the `skill` tool (`/skills`, `/skill <name>`).
  Built in: `commit`, `review-pr`, `qa`, `fullstack`, `frontend`, `security`,
  `anti-slop`, `copywriter`.
- **MCP servers** — connect any Model Context Protocol server via `~/sabana-code/mcp.json`;
  their tools appear as `mcp__<server>__<tool>` and work like built-in tools (`/mcp`, `/mcp reload`).
- **Todo queue** — the agent plans multi-step work with `todo_write`/`todo_list`,
  stored per project in `~/sabana-code/todos/` so the queue survives session switches.
  Completions render as a live numbered panel (`/todo` to view).
- **Checkpoint & rewind** — every turn auto-saves a snapshot; right-click any
  prompt for a popup (`↩ Rewind to here` restores files + history and reloads
  the prompt for editing, `⧉ Save checkpoint here`), or use
  (`/checkpoint [label]`, `/checkpoints`, `/rewind <id>`) manually.
- **Multi-provider & multi-model** — OpenAI, Anthropic, Google Gemini, Groq, Together,
  OpenRouter, Perplexity, local Ollama, or any OpenAI-compatible custom URL.
  Switch anytime without losing history; model list is fetched live from `/v1/models`.
- **Auto-compact context** — when context hits >80% of the window, older messages
  are automatically summarized into one; can also be triggered manually via `/compact`.
- **Effort presets** — `/effort [low|medium|high]` trades thinking budget for speed
  per session (shown in the status bar).
- **Live TUI extras** — model thinking streams into dim `◉` blocks, the input shows
  live `step N/M` progress, and sub-agent runs report steps, tools, time, and files.
- **Guardrails** — blocks prompt injection (ignore/reveal/role-hijack/context-dump),
  XSS, pasted private keys, sensitive-file references, and literal destructive shell;
  `read_file`/`grep` refuse private key material (`~/.ssh/id_*`, `/etc/shadow`,
  `*.pem`, `*.key`); secrets in tool output are redacted (OpenAI, Gemini, AWS,
  Stripe, GitHub, npm, Slack, Bearer) before reaching the LLM context.
- **Rate limiting** — LLM requests per minute cap (default 60, configurable) with
  sliding window; exponential backoff + jitter on 429/5xx; per-call LLM timeout
  (default 120s, hung providers fail fast instead of hanging the turn).

## Requirements

- Node.js 22+ (24 recommended)
- API key for one provider (or local Ollama — free, no key needed)

## Getting Started

```bash
# Install globally from npm (recommended)
npm install -g sabana-code

# First-time setup (creates ~/sabana-code/ + settings.json + pick provider)
sabana-code setup

# Start coding, e.g. in your project folder
cd ./my-project
sabana-code
```

On first run, `sabana-code` initializes the global home:

```
~/sabana-code/
  settings.json        config + provider credentials
  sessions/<uuid>.json chat history + context per session
  projects/<hash>/     metadata per project folder (one project can have many sessions)
  agents/*.md          custom sub-agent profiles (reviewer, security, …)
  skills/*.md          reusable work instructions (commit, review-pr, qa, …)
  mcp.json             MCP server configs (stdio)
  todos/<hash>.json    todo queue per project
  checkpoints/<uuid>/  file + history snapshots per session
  sabana.db            sqlite: session index, token usage
  logs/YYYY-MM-DD.log  daily activity logs
```

### Without global install

```bash
npx -y sabana-code@latest --provider ollama
```

## CLI Usage

```bash
sabana-code "create a hello world web app with vite + tailwind"
sabana-code "fix the login bug in src/auth.ts" -C ./my-project --auto-approve
sabana-code --provider ollama --model qwen2.5-coder "refactor this function"

sabana-code setup                  # re-run provider setup
sabana-code auth login openai      # save additional provider key
sabana-code auth list              # view credential sources (env/global/-)
sabana-code auth logout openai
```

Options: `-C/--workspace`, `--model`, `--provider openai|anthropic|google|ollama|custom|mock`,
`--max-steps` (default 40), `--auto-approve`, `-V/--version`.

## TUI Usage

```bash
sabana-code -C ./my-project
sabana-code --continue         # continue last session
sabana-code -r 3fa4ea9f        # resume session (UUID prefix OK)
```

When exiting TUI (`Ctrl+C` while idle or `/quit`), the terminal displays
the resume command, e.g. `sabana-code -r 3fa4ea9f -C ./my-project`.

TUI commands:

| Command | Description |
|---|---|
| `/help` | list commands |
| `/new`, `/sessions`, `/resume <id\|number>` | manage sessions |
| `/projects` | list projects + sessions per project |
| `/model [name]`, `/provider [name]` | view/switch model & provider (+ connection test) |
| `/models [filter\|number]` | live model list from provider + select (or manual via `/model`) |
| `/providers [use\|login ...]` | manage connected multi-providers |
| `/compact` | compact current context (auto at >80% window) |
| `/effort [low\|medium\|high]` | show/set thinking budget for this session |
| `/login <provider> <key>`, `/logout` | manage global credentials |
| `/agents`, `/agent <name> <task>` | view & delegate to sub-agent |
| `/skills`, `/skill <name>` | list skills & view one skill's instructions |
| `/todo` | view project todo queue |
| `/mcp [reload]` | MCP server status + tools |
| `/checkpoint [label]`, `/checkpoints`, `/rewind <id>` | snapshot & restore files + history |
| `/context` | active model context window usage |
| `/tools`, `/clear`, `/quit` | list tools, clear screen, exit |

Click any tool row to open a **fullscreen preview** (auto-detected syntax highlighting
for code, unified diff for edits, full stdout/stderr for shell) — `Esc`/`q` to close,
`↑↓`/`PgUp`/`PgDn` to scroll inside it.

Typing `/` opens a **command autocomplete dropdown** — `↑↓` to pick, `Enter` to
run an exact match or complete the command first, `Esc` to dismiss.

`Ctrl+C` cancels the running turn; `Ctrl+C` again to exit (session auto-saved).
`↑`/`↓` walks shell-style prompt history, `PgUp`/`PgDn` or mouse-wheel/trackpad
gesture scrolls the chat; send a new message to jump back to bottom.

### Multi-provider & multi-model

Supported providers: `openai`, `anthropic`, `google`, `groq`, `together`,
`openrouter`, `perplexity`, `ollama`, `custom`, `mock`.

```text
/providers                 # list + connection status per provider
/providers login groq <key>
/providers use groq        # switch provider (or /provider groq)
/models                    # live model list from active provider's /v1/models
/models llama              # filter
/models 2                  # select number 2 (or manual via /model <name>)
```

`/models` fetches directly from the provider endpoint (`GET {baseUrl}/models`,
`GET /api/tags` for Ollama), filters out non-chat IDs (audio/image/embedding),
and displays up to 40. Anthropic has no public list → uses built-in catalog.
The displayed list can be selected directly by number.

### Context compaction

- `/compact` — summarize history into one message (last N messages preserved intact).
- **Auto-compact (default)**: any turn that hits **>80% context window**
  is automatically compacted once before continuing, so long sessions don't hit the limit.

## Configuration (`~/sabana-code/settings.json`)

```json
{
  "env": {
    "SABANA_PROVIDER": "openai",
    "SABANA_BASE_URL": "https://your-provider.com",
    "SABANA_API_KEY": "sk-...",
    "SABANA_MODEL": "gpt-4o-mini",
    "SABANA_MAX_TOKEN": "8192",
    "SABANA_RPM": "60",
    "TAVILY_API_KEY": "..."
  }
}
```

| Key | Description |
|---|---|
| `SABANA_PROVIDER` | `openai` \| `anthropic` \| `google` \| `ollama` \| `custom` \| `mock` |
| `SABANA_BASE_URL` | OpenAI-compatible base URL (required for `custom`) |
| `SABANA_API_KEY` | main provider API key |
| `SABANA_MODEL` | default model |
| `SABANA_MAX_TOKEN` | max output tokens per request |
| `SABANA_RPM` | **rate limit**: max LLM requests per minute (`<=0` = unlimited) |
| `TAVILY_API_KEY` | optional, for high-quality `web_search` (falls back to DuckDuckGo without it) |

Original environment variables always take precedence over `settings.json`, so values above can
be overridden per-command, e.g. `SABANA_MODEL=gpt-4o sabana-code`.

### MCP servers (`~/sabana-code/mcp.json`)

```json
{
  "servers": {
    "fetch": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-fetch"] }
  }
}
```

Each running server contributes its tools as `mcp__<server>__<tool>`. Check status with
`/mcp`, reload after editing the file with `/mcp reload`. A server that fails to
start is marked down and the agent keeps working without its tools.

## Security: guardrails, sandbox & limits

- **Input**: prompts attempting *prompt injection* (ignore/reveal/role-hijack/DAN),
  *conversation dumps*, pasted *private keys*, *sensitive key-file references*
  (`~/.ssh/id_*`, `/etc/shadow`), *literal destructive shell* (`rm -rf /`, `mkfs`,
  fork bombs), `<script>` tags, or exceeding 50,000 characters are blocked immediately.
- **Output**: secrets found by tools in files/logs are redacted before reaching the LLM —
  OpenAI, Gemini, AWS (AKIA + secret key), Stripe, GitHub, npm, Slack, Bearer tokens,
  generic `key=`/`secret=` assignments, and whole private-key blocks (`[REDACTED_*]`).
- **Sensitive files**: `read_file`/`grep` refuse SSH private keys, `/etc/shadow`,
  `*.pem`, `*.key` — private key material can never enter LLM context.
- **Timeouts**: every LLM call has a 120s timeout (hung providers fail the turn fast
  instead of hanging forever); tool calls have per-tool timeouts (shell 180s);
  MCP servers have per-server timeouts. Timeouts are never retried blindly.
- **Rate limit**: each turn waits for a slot (default 60 req/min, configurable via `SABANA_RPM`);
  429/quota/5xx/network errors are retried automatically with exponential backoff + jitter.
- **Sandbox path**: filesystem tools can only access the workspace (`safePath`);
  `shell` commands that hang the loop (dev servers, `sleep`, background `&`) are blocked.
- **sabana-sandbox** (`src/sabana-sandbox.ts`): every `shell` command runs through a
  double filter — your inline approval (`y`/`a`/`n`) PLUS a static policy + workspace
  containment that approval cannot override. Always blocked: `rm -rf /` (or `~`,
  `$HOME`), paths outside the workspace (including `cd / && rm -rf .` escapes),
  `sudo`/`su`, `mkfs`/`dd`-to-device, fork bombs, `curl … | sh`, heredocs into a
  shell, and redirects outside the workspace. Legal in-workspace work
  (`rm -rf .next`, `npm install`, `> out.log`, `2>&1`) still runs. A block shows
  `SANDBOX BLOCKED` and never executes — rewrite the command to stay inside
  the workspace.
- Tool permissions: file (read/write/edit/list) and read-only shell (`ls`, `cd`,
  `cat`, `echo`, …) run without prompts. Only potentially dangerous execution (`rm`,
  `mkdir`, `npm`, `git`, …) requires inline approval — `[y]` once,
  `[a]` all similar commands (e.g., approve `npm` once → all `npm …` pass),
  `[n]` deny. `allow all`/`deny` decisions are saved in the session file
  (`~/sabana-code/sessions/<uuid>.json`), so they persist for that session only;
  new sessions start with fresh approvals. If you denied something by mistake,
  start a new session (`/new`) — denials are never carried over.

## For Developers

```bash
npm test          # 168 unit tests (node:test, no additional framework)
npm run benchmark # SWE-bench / Terminal-Bench style benchmark, deterministic mock
npm run typecheck # tsc --noEmit
```

Code structure:

```
src/
  agent.ts        single-agent loop (chatTurn multi-turn + event stream)
  index.ts        CLI  •  tui/  TUI (Ink)
  llm/            OpenAI/Anthropic/Google/Ollama/mock provider + model catalog
  tools/          filesystem, terminal, web, registry, executor, sandbox, summary
  session/        session store + context-window estimation/trimming per model
  projects.ts     ~/sabana-code/projects registry
  subagents.ts    ~/sabana-code/agents loader + runner
  settings.ts     settings.json  •  setup.ts  wizard  •  auth.ts  credentials
  home.ts         ~/sabana-code path  •  db.ts  sqlite
  utils/          guardrails, ratelimit, loop-detector, permissions, logger
agents/           default sub-agent profile templates
benchmark/        harness + tasks (create-config, fix-bug, rename-refactor, …)
tests/            per-module unit tests
```

Agent logic adapted from `sabana-dev` (`apps/api/src/agents/`): orchestrator loop,
tool registry/executor, provider SSE/tool-call parsing, loop-detector, permission engine,
and guardrails — simplified without Redis/compactor/billing.
