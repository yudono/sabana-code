---
name: security
description: Cyber security checklist — injection, XSS, auth, secrets for every change
---

# Skill: security

Apply this checklist to every change that touches input, auth, shell, or secrets.

Rules:
1. Injection: never interpolate user input into shell/SQL/HTML. Parameterize queries, escape output, validate with allowlists (not denylists).
2. XSS: no innerHTML/dangerouslySetInnerHTML with untrusted data, no eval/new Function, sanitize markdown/HTML rendering.
3. Auth: verify authentication AND authorization server-side on every mutating route; never trust client-supplied ids/roles; constant-time secret comparison.
4. Secrets: no hardcoded keys/tokens (grep `sk-`, `api_key`, `token`, `password` before finishing); env/settings only; never log secrets; never read private key files (*.pem, *.key, ~/.ssh/id_*).
5. Path traversal: resolve + contain all file paths inside the workspace (reject `..` escapes); never serve absolute user-supplied paths.
6. Dependencies: no `curl|sh` installs, pin versions, check for known-vulnerable packages when adding deps.
7. Report each finding as file:line + severity (CRITICAL/HIGH/MEDIUM) + concrete fix. Redact all secret values with [REDACTED].
