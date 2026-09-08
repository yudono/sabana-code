# sabana-code

Coding agent CLI + TUI ala claude-code / opencode: **single agent loop** dengan tool calling
filesystem, terminal, dan pencarian internet. Bisa dijalankan dari direktori mana pun —
session, kredensial, log, dan database tersimpan global di `~/sabana-code/`.

## Fitur

- **Single agent process** — satu loop otonom: pahami perintah → panggil tools → verifikasi → selesai.
- **Tool calling** — `read_file`, `write_file`, `edit_file`, `list_directory`, `glob`, `grep`
  (filesystem), `shell` (terminal), `web_search`, `web_fetch` (internet via Tavily + fallback).
- **TUI interaktif** (`sabana-code-tui`) — chat, input prompt, live tool-calling, ganti model/provider,
  resume session, sub-agent.
- **Session per project** — tiap folder proyek otomatis terdaftar di `~/sabana-code/projects/`,
  tiap sesi tersimpan sebagai UUID di `~/sabana-code/sessions/` dan bisa di-resume.
- **Sub-agent kustom** — profil AI di `~/sabana-code/agents/*.md` (mis. reviewer, security auditor).
- **Multi-provider** — OpenAI-compatible, Anthropic, Google Gemini, Ollama lokal, URL kustom.
- **Guardrails** — blokir prompt injection, XSS, private key, prompt raksasa; secret di output
  tool disensor sebelum masuk konteks LLM.
- **Rate limiting** — batas request LLM per menit (default 60, bisa diubah) + retry backoff 429/5xx.

## Prasyarat

- Node.js 22+ (direkomendasikan 24)
- API key salah satu provider (atau Ollama lokal — gratis, tanpa key)

## Cara menjalankan

```bash
# 1. Install & build
git clone https://github.com/yudono/sabana-code
cd sabana-code
npm install
npm run build

# 2. Pasang perintah global (sekali saja)
npm link
# → tersedia `sabana-code` dan `sabana-code-tui` di PATH

# 3. Setup pertama (membuat ~/sabana-code/ + settings.json + pilih provider)
sabana-code setup
```

Saat pertama dijalankan, `sabana-code` menginisialisasi home global:

```
~/sabana-code/
  settings.json        konfigurasi + kredensial provider utama
  sessions/<uuid>.json riwayat chat + konteks tiap sesi
  projects/<hash>/     metadata tiap folder proyek (satu proyek bisa banyak sesi)
  agents/*.md          profil sub-agent kustom (reviewer, security, …)
  sabana.db            sqlite: index sesi, pemakaian token
  logs/YYYY-MM-DD.log  log aktivitas harian
```

### Tanpa install global

```bash
npx tsx src/index.ts "buatkan file hello.py" -C ./demo --auto-approve
npx tsx src/tui/main.tsx -C ./demo --provider ollama
```

## Penggunaan CLI

```bash
sabana-code "buatkan web hello world dengan vite + tailwind"
sabana-code "perbaiki bug login di src/auth.ts" -C ./my-project --auto-approve
sabana-code --provider ollama --model qwen2.5-coder "refactor fungsi ini"

sabana-code setup                  # ulang setup provider
sabana-code auth login openai      # simpan key provider tambahan
sabana-code auth list              # lihat sumber kredensial (env/global/-)
sabana-code auth logout openai
```

Opsi: `-C/--workspace`, `--model`, `--provider openai|anthropic|google|ollama|custom|mock`,
`--max-steps` (default 40), `--auto-approve`.

## Penggunaan TUI

```bash
sabana-code-tui -C ./my-project
sabana-code-tui --continue         # lanjutkan sesi terakhir
sabana-code-tui --resume 3fa4ea9f # lanjutkan sesi (boleh prefix UUID)
```

Perintah dalam TUI:

| Perintah | Fungsi |
|---|---|
| `/help` | daftar perintah |
| `/new`, `/sessions`, `/resume <id\|nomor>` | kelola sesi |
| `/projects` | daftar proyek + sesi per proyek |
| `/model [nama]`, `/provider [nama]` | lihat/ganti model & provider (+ uji koneksi) |
| `/models [filter\|nomor]` | daftar model live dari provider + pilih (atau manual via `/model`) |
| `/providers [use\|login ...]` | kelola multi-provider yang terkonek |
| `/compact` | padatkan konteks sekarang (otomatis saat >80% window) |
| `/login <provider> <key>`, `/logout` | kelola kredensial global |
| `/agents`, `/agent <nama> <tugas>` | lihat & delegasikan ke sub-agent |
| `/context` | pemakaian context-window model aktif |
| `/tools`, `/clear`, `/quit` | daftar tools, bersihkan layar, keluar |

`Ctrl+C` membatalkan turn yang berjalan; `Ctrl+C` lagi untuk keluar (sesi otomatis tersimpan).
`↑`/`↓` scroll riwayat chat (3 baris), `PgUp`/`PgDn` satu layar; kirim pesan baru untuk kembali ke bawah.

### Multi-provider & multi-model

Provider yang didukung: `openai`, `anthropic`, `google`, `groq`, `together`,
`openrouter`, `perplexity`, `ollama`, `custom`, `mock`.

```text
/providers                 # daftar + status koneksi tiap provider
/providers login groq <key>
/providers use groq        # pindah provider (atau /provider groq)
/models                    # daftar model live dari /v1/models provider aktif
/models llama              # saring
/models 2                  # pilih nomor 2 (atau /model <nama> manual)
```

`/models` mengambil langsung dari endpoint provider (`GET {baseUrl}/models`,
`GET /api/tags` untuk Ollama), menyaring ID non-chat (audio/gambar/embedding),
dan menampilkan maksimal 40. Anthropic tak punya daftar publik → dipakai katalog
bawaan. Daftar yang tampil bisa langsung dipilih pakai nomor.

### Compact konteks

- `/compact` — ringkas riwayat jadi satu pesan (N pesan terakhir dipertahankan utuh).
- **Auto-compact (default)**: tiap turn yang menyentuh **>80% context window**
  otomatis dipadatkan sekali sebelum lanjut, jadi sesi panjang tidak mentok.

## Konfigurasi (`~/sabana-code/settings.json`)

```json
{
  "env": {
    "SABANA_PROVIDER": "openai",
    "SABANA_BASE_URL": "https://providerkamu.com",
    "SABANA_API_KEY": "sk-...",
    "SABANA_MODEL": "gpt-4o-mini",
    "SABANA_MAX_TOKEN": "8192",
    "SABANA_RPM": "60",
    "TAVILY_API_KEY": "..."
  }
}
```

| Key | Fungsi |
|---|---|
| `SABANA_PROVIDER` | `openai` \| `anthropic` \| `google` \| `ollama` \| `custom` \| `mock` |
| `SABANA_BASE_URL` | base URL OpenAI-compatible (wajib diisi untuk `custom`) |
| `SABANA_API_KEY` | API key provider utama |
| `SABANA_MODEL` | model default |
| `SABANA_MAX_TOKEN` | batas token output per request |
| `SABANA_RPM` | **rate limit**: maks request LLM per menit (`<=0` = tanpa batas) |
| `TAVILY_API_KEY` | opsional, untuk `web_search` berkualitas (tanpanya pakai DuckDuckGo) |

Environment variable asli selalu menang atas `settings.json`, jadi nilai di atas bisa
di-override per-perintah, mis. `SABANA_MODEL=gpt-4o sabana-code-tui`.

## Keamanan: guardrails & rate limiting

- **Input**: prompt yang mengandung upaya *ignore instructions*, *reveal system prompt*,
  private key, tag `<script>`, atau melebihi 50.000 karakter langsung diblokir.
- **Output**: API key/token/private key yang terbaca tool dari file/log disensor
  (`[REDACTED_*]`) sebelum diteruskan ke LLM.
- **Rate limit**: tiap turn menunggu slot (default 60 req/menit, diatur via `SABANA_RPM`);
  error 429/kuota/5xx/timeout di-retry otomatis dengan backoff eksponensial.
- **Sandbox path**: tool filesystem hanya boleh mengakses workspace (`safePath`);
  perintah `shell` yang menggantung loop (dev server, `sleep`, background `&`) diblokir.
- Izin tool: file (baca/tulis/edit/list) dan shell read-only (`ls`, `cd`,
  `cat`, `echo`, …) bebas izin. Hanya eksekusi berpotensi berbahaya (`rm`,
  `mkdir`, `npm`, `git`, …) yang meminta persetujuan inline — `[y]` sekali,
  `[a]` semua perintah serupa (satu entity, mis. semua `npm …`), `[n]` tolak.
  Keputusan `allow all`/`deny` tersimpan di file session
  (`~/sabana-code/sessions/<uuid>.json`), jadi berlaku selama session itu saja;
  session baru mengulang persetujuan dari nol.

## Untuk developer

```bash
npm test          # 139 unit test (node:test, tanpa framework tambahan)
npm run benchmark # benchmark ala SWE-bench/Terminal-Bench, mock deterministik
npm run typecheck # tsc --noEmit
```

Struktur kode:

```
src/
  agent.ts        loop single-agent (chatTurn multi-turn + event stream)
  index.ts        CLI  •  tui/  TUI (Ink)
  llm/            provider OpenAI/Anthropic/Google/Ollama/mock + katalog model
  tools/          filesystem, terminal, web, registry, executor, sandbox, summary
  session/        store sesi + estimasi/trim context-window per model
  projects.ts     registry ~/sabana-code/projects
  subagents.ts    loader + runner ~/sabana-code/agents
  settings.ts     settings.json  •  setup.ts  wizard  •  auth.ts  kredensial
  home.ts         path ~/sabana-code  •  db.ts  sqlite
  utils/          guardrails, ratelimit, loop-detector, permissions, logger
agents/           template profil sub-agent bawaan
benchmark/        harness + tasks (create-config, fix-bug, rename-refactor, …)
tests/            unit test per modul
```

Logika agent diadaptasi dari `sabana-dev` (`apps/api/src/agents/`): orchestrator loop,
tool registry/executor, provider SSE/tool-call parsing, loop-detector, permission engine,
dan guardrails — disederhanakan tanpa Redis/compactor/billing.
