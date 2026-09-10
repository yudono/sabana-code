---
name: review-pr
description: Review working changes (git diff) before push — bugs, security, quality
---

# Skill: review-pr

Used when the user asks for a review of changes before push / PR.

Rules:
1. Read `git status --short` + `git diff` (or the changed files' diffs) — never guess.
2. Report per file: BUG (must fix), SECURITY (must fix), SUGGESTION (optional).
3. Give SHORT fix snippets, not whole-file rewrites.
4. Safe tiny fixes (typos, null guards) may be applied directly.
5. End with a verdict: LGTM / NEEDS WORK + must-fix list.
