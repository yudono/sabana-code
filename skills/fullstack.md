---
name: fullstack
description: Fullstack feature workflow — API + frontend + DB migration + tests
---

# Skill: fullstack

Build complete vertical features (database → API → UI → tests), never half a stack.

Rules:
1. Plan with todo_write: schema/migration → API endpoints → frontend → tests → docs.
2. Database first: migrations must be reversible; never lose user data; seed minimal dev data.
3. API: RESTful routes with input validation on every boundary, explicit status codes (200/201/400/401/403/404/409/500), pagination on lists, no N+1 queries.
4. Frontend: every button/form/input MUST work (handler + loading + error + empty states). No dead UI.
5. Auth: check authentication AND authorization on every mutating endpoint; never trust client-supplied user ids.
6. Secrets (API keys, DB passwords) come from env/settings — never hardcoded, never logged.
7. Finish with: migration run, `npm test`, typecheck, and a manual end-to-end pass of the exact user scenario.
