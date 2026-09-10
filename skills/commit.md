---
name: commit
description: Write a Conventional Commits message from git diff
---

# Skill: commit

Used when the user asks for a commit message or an automatic commit.

Rules:
1. Run `git status --short` and `git diff --stat` first to understand the changes.
2. Write ONE commit message in the format: `<type>(<scope>): <summary>`.
3. Type: feat, fix, docs, refactor, test, chore.
4. Summary ≤ 72 chars, English, no long body unless asked.
5. Never commit when secret files (.env, *.pem, credentials.json) are in status.
