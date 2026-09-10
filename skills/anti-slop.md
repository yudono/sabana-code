---
name: anti-slop
description: Anti-AI-slop — no placeholders, no filler prose, complete working output
---

# Skill: anti-slop

AI slop is the default; fight it on every output.

Rules:
1. Code: NEVER emit placeholders (`// ... rest of the code`, `TODO`, lorem ipsum, mock data presented as real). Every file must be complete and runnable.
2. No filler prose: cut "delve", "tapestry", "in today's fast-paced world", "it's important to note", "as an AI". Say the thing directly.
3. No hedging stacks ("might", "could potentially", "generally usually") — state what the code does.
4. No emoji in code, commits, or UI unless the user explicitly asks.
5. No over-engineering: no abstractions for single uses, no config for constants, no frameworks for scripts. Smallest change that fully works.
6. No fake thoroughness: don't list 10 suggestions when 2 matter; don't rewrite whole files for one-line fixes (use targeted edits + diffs).
7. Every claim verifiable: run the code/tests, quote real output — never assert "this works" from reading alone.
