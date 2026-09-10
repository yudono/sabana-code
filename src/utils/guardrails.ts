// ─── Guardrails — slim version of sabana-dev packages/utils/src/guardrails.ts ───
export interface GuardrailResult {
  passed: boolean;
  reason?: string;
  code?: string;
}

const BLOCK_PATTERNS: Array<{ re: RegExp; code: string; message: string }> = [
  {
    re: /\b(ignore|disregard|forget|override|bypass)\s+(all\s+)?(previous|prior|above|system|initial|earlier)\s+(instruction|prompt|rule|directive)s?\b/i,
    code: "PROMPT_INJECTION_IGNORE",
    message: "Detected an attempt to override system instructions. Prompt blocked.",
  },
  {
    re: /\b(show|reveal|print|display)\s+(your|the)\s+(system|initial|hidden|secret)\s+(prompt|instruction)/i,
    code: "PROMPT_INJECTION_REVEAL",
    message: "Detected an attempt to expose the system prompt. Prompt blocked.",
  },
  {
    // "you are now X", DAN/jailbreak roles, instruction replacement.
    re: /\b(you\s+are\s+now\b|from\s+now\s+on,?\s+you\s+are\b|act\s+as\s+(a\s+)?(dan|jailbroken|unrestricted)\b|\bdan\s+mode\b|do\s+anything\s+now\b|replace\s+your\s+(system\s+)?instructions\b|new\s+system\s+prompt\b)/i,
    code: "PROMPT_INJECTION_ROLE",
    message: "Detected a role-hijack attempt. Prompt blocked.",
  },
  {
    // "repeat/print/dump everything above", "dump your context/conversation".
    re: /\b(repeat|print|dump|output)\s+(everything|all\s+(previous|prior|above|earlier)\s+(messages|prompts|instructions|context|conversation)|your\s+(full\s+)?(context|conversation))\b/i,
    code: "PROMPT_INJECTION_DUMP",
    message: "Detected a conversation-dump attempt. Prompt blocked.",
  },
  {
    re: /-----BEGIN (RSA|EC|DSA|OPENSSH|PRIVATE) KEY-----/i,
    code: "SECRET_PRIVATE_KEY",
    message: "Do not paste private keys into the prompt.",
  },
  {
    // Private-key file references: the danger is READING them; tools refuse too.
    re: /(~\/\.ssh\/(id_rsa|id_ed25519|id_ecdsa|id_dsa)|\/etc\/(shadow|gshadow))\b/,
    code: "SENSITIVE_FILE",
    message: "References private key files — agent tools refuse to read them. Prompt blocked.",
  },
  {
    // Literal destructive shell in the prompt (execution is sandbox-blocked too).
    re: /\brm\s+-[a-z]*r[a-z]*\s+(\/(\s|$|\*)|~(\/\*)?|\$HOME(\/\*)?)|\bmkfs\b|:\(\)\s*\{|\bdd\b[^;&|]*\bof=\s*\/dev\//,
    code: "DESTRUCTIVE_SHELL",
    message: "Destructive shell pattern detected. Prompt blocked.",
  },
  {
    re: /<script\b[^>]*>[\s\S]*?<\/script>|javascript:\s*[^"'\s>]+/i,
    code: "XSS",
    message: "Detected script injection. Prompt blocked.",
  },
];

export function runGuardrails(prompt: string, maxLength = 50_000): GuardrailResult {
  if (prompt.length > maxLength) {
    return { passed: false, code: "EXCESSIVE_LENGTH", reason: `Prompt too long (${prompt.length} > ${maxLength}).` };
  }
  for (const p of BLOCK_PATTERNS) {
    if (p.re.test(prompt)) return { passed: false, code: p.code, reason: p.message };
  }
  return { passed: true };
}

// ─── Secret redaction on tool output before it enters LLM context ───
// Stops API keys/tokens read from files/logs leaking to the LLM provider.
const REDACT_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  { re: /-----BEGIN [A-Z ]*KEY-----[\s\S]*?-----END [A-Z ]*KEY-----/gi, replace: "[REDACTED_PRIVATE_KEY]" },
  { re: /\bsk-[A-Za-z0-9-_]{16,}/g, replace: "[REDACTED_API_KEY]" },
  { re: /\bAIza[A-Za-z0-9-_]{20,}/g, replace: "[REDACTED_API_KEY]" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[REDACTED_API_KEY]" },
  { re: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{20,}['"]?/gi, replace: "aws_secret_access_key=[REDACTED]" },
  { re: /\b(sk_live|sk_test|rk_live|rk_test)_[A-Za-z0-9]{16,}/g, replace: "[REDACTED_API_KEY]" },
  { re: /\bgh[pousr]_[A-Za-z0-9_]{20,}/g, replace: "[REDACTED_TOKEN]" },
  { re: /\bnpm_[A-Za-z0-9]{24,}/g, replace: "[REDACTED_TOKEN]" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: "[REDACTED_TOKEN]" },
  { re: /\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/g, replace: "Bearer [REDACTED]" },
  { re: /\b(api[_-]?key|auth[_-]?token|access[_-]?token|secret|password)\s*[:=]\s*['"]?[^\s'";,]{8,}['"]?/gi, replace: "$1=[REDACTED]" },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of REDACT_PATTERNS) out = out.replace(p.re, p.replace);
  return out;
}

// ─── Sensitive paths: never let private key material enter LLM context ───
// Checked against the RAW user-supplied path (before safePath), because the
// dangerous case is a workspace rooted at $HOME where "~/.ssh/id_rsa"
// resolves inside. Listing names is harmless — only READS are refused.
const SENSITIVE_PATHS: Array<{ re: RegExp; why: string }> = [
  { re: /(^|\/|\.ssh\/)(id_rsa|id_ed25519|id_ecdsa|id_dsa)(?!\.pub$)([^a-z0-9]|$)/, why: "SSH private key" },
  { re: /(^|\/)etc\/(shadow|gshadow)$/, why: "password database" },
  { re: /\.pem$/i, why: "PEM certificate/key file" },
  { re: /\.key$/i, why: "private key file" },
];

/** Non-null when a path must never be read into context. */
export function isSensitivePath(rawPath: string): string | null {
  const p = (rawPath || "").replace(/\\/g, "/");
  for (const s of SENSITIVE_PATHS) {
    if (s.re.test(p)) return s.why;
  }
  return null;
}
