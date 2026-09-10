---
name: commit
description: Tulis commit message ala Conventional Commits dari git diff
---

# Skill: commit

Dipakai saat user minta buatkan commit message atau commit otomatis.

Aturan:
1. Jalankan `git status --short` dan `git diff --stat` dulu untuk memahami perubahan.
2. Tulis SATU commit message format: `<type>(<scope>): <ringkasan>`.
3. Type: feat, fix, docs, refactor, test, chore.
4. Ringkasan ≤ 72 karakter, bahasa Inggris, tanpa tubuh panjang kecuali diminta.
5. Jangan commit bila ada file secrets (.env, *.pem, credentials.json) di status.
