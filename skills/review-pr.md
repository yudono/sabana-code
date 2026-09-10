---
name: review-pr
description: Review perubahan kerja (git diff) sebelum push — bug, keamanan, kualitas
---

# Skill: review-pr

Dipakai saat user minta review perubahan sebelum push / buat PR.

Aturan:
1. Baca `git status --short` + `git diff` (atau diff file yang diubah) — jangan menebak.
2. Laporkan per file: BUG (wajib perbaiki), KEAMANAN (wajib perbaiki), SARAN (opsional).
3. Beri snippet perbaikan singkat, bukan rewrite seluruh file.
4. Perbaikan kecil yang aman (typo, guard null) boleh langsung diterapkan.
5. Akhiri dengan verdict: LGTM / PERLU PERBAIKAN + daftar wajib.
