// ─── Guardrails — versi ringkas dari sabana-dev packages/utils/src/guardrails.ts ───
export interface GuardrailResult {
  passed: boolean;
  reason?: string;
  code?: string;
}

const BLOCK_PATTERNS: Array<{ re: RegExp; code: string; message: string }> = [
  {
    re: /\b(ignore|disregard|forget|override|bypass)\s+(previous|prior|above|system|initial)\s+(instruction|prompt|rule)/i,
    code: "PROMPT_INJECTION_IGNORE",
    message: "Terdeteksi upaya mengabaikan instruksi sistem. Prompt diblokir.",
  },
  {
    re: /\b(show|reveal|print|display)\s+(your|the)\s+(system|initial|hidden|secret)\s+(prompt|instruction)/i,
    code: "PROMPT_INJECTION_REVEAL",
    message: "Terdeteksi upaya mengekspos system prompt. Prompt diblokir.",
  },
  {
    re: /-----BEGIN (RSA|EC|DSA|OPENSSH|PRIVATE) KEY-----/i,
    code: "SECRET_PRIVATE_KEY",
    message: "Jangan tempel private key ke prompt.",
  },
  {
    re: /<script\b[^>]*>[\s\S]*?<\/script>|javascript:\s*[^"'\s>]+/i,
    code: "XSS",
    message: "Terdeteksi script injection. Prompt diblokir.",
  },
];

export function runGuardrails(prompt: string, maxLength = 50_000): GuardrailResult {
  if (prompt.length > maxLength) {
    return { passed: false, code: "EXCESSIVE_LENGTH", reason: `Prompt terlalu panjang (${prompt.length} > ${maxLength}).` };
  }
  for (const p of BLOCK_PATTERNS) {
    if (p.re.test(prompt)) return { passed: false, code: p.code, reason: p.message };
  }
  return { passed: true };
}

// ─── Redaksi secret pada output tool sebelum masuk konteks LLM ───
// Mencegah API key/token yang kebaca dari file/log bocor ke provider LLM.
const REDACT_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  { re: /-----BEGIN [A-Z ]*KEY-----[\s\S]*?-----END [A-Z ]*KEY-----/gi, replace: "[REDACTED_PRIVATE_KEY]" },
  { re: /\bsk-[A-Za-z0-9-_]{16,}/g, replace: "[REDACTED_API_KEY]" },
  { re: /\bAIza[A-Za-z0-9-_]{20,}/g, replace: "[REDACTED_API_KEY]" },
  { re: /\bgh[pousr]_[A-Za-z0-9_]{20,}/g, replace: "[REDACTED_TOKEN]" },
  { re: /\bxox[bap]-[A-Za-z0-9-]{10,}/g, replace: "[REDACTED_TOKEN]" },
  { re: /\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/g, replace: "Bearer [REDACTED]" },
  { re: /\b(api[_-]?key|auth[_-]?token|access[_-]?token|secret|password)\s*[:=]\s*['"]?[^\s'";,]{8,}['"]?/gi, replace: "$1=[REDACTED]" },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of REDACT_PATTERNS) out = out.replace(p.re, p.replace);
  return out;
}
