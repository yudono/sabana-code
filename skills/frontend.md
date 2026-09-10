---
name: frontend
description: Frontend UI implementation — accessible, responsive, fully working interactions
---

# Skill: frontend

Build interfaces that actually work for real users, not screenshots.

Rules:
1. Every interactive element MUST function: buttons dispatch actions, forms validate + submit, inputs show loading/error/success feedback. Zero dead controls.
2. States for everything: loading, empty, error, and success — no blank screens, no silent failures.
3. Accessibility: semantic HTML, labels on inputs, keyboard navigation (Tab/Enter/Escape), visible focus, sufficient contrast, no div-soup clickables.
4. Responsive: usable at 360px wide and 1440px wide; no horizontal overflow; touch targets ≥ 44px.
5. No layout shift: reserve space for async content (skeletons or fixed heights).
6. Copy matters: short labels, plain language, no lorem ipsum, no TODO text — every string final.
7. Verify by reading the rendered output (tests or screenshots), not by re-reading JSX.
