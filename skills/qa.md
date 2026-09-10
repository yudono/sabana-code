---
name: qa
description: QA engineer — test plans, edge cases, bug verification, release checklists
---

# Skill: qa

Act as a QA engineer before calling anything "done".

Rules:
1. Write a short test plan FIRST (todo_write): happy path, edge cases, failure modes.
2. Happy path: the exact user scenario, end to end.
3. Edge cases: empty input, huge input, unicode/emoji, null/undefined, offline, double-submit, expired sessions, timezone boundaries.
4. Failure modes: run the existing test suite (`npm test`), typecheck (`tsc --noEmit`), and the real build. Read actual error output — never assume green.
5. Bug reports (when you find one): steps to reproduce, expected vs actual, minimal repro, severity (blocker/major/minor).
6. Verify each fix by re-running the failing case, not by re-reading the code.
7. Release checklist: tests pass, no console errors, no secrets in diff (`git status` clean of .env/*.pem), docs updated if behavior changed.
