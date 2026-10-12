# Marketing assets

Static assets served from `vaubaan.com/marketing/...`. Used by OAuth
marketplaces (GitHub App, Vercel, Supabase Partner) and the press kit.

See [`docs/handbook/legacy/integrations-submission-kit.md`](../../../../docs/handbook/legacy/integrations-submission-kit.md)
for the field-by-field checklist.

## Contents

- `screenshots/` — product screenshots, 1440×900, light theme.
- `social/` — Open Graph cards, 1200×630.
- `brand/` — square and wordmark exports of the Vaubaan mark.

## How to capture screenshots

1. `npm --workspace @vaubaan/gateway-app run dev` (with `.env.test` providers wired).
2. Devtools → device toolbar → set viewport to **1440 × 900**.
3. Visit the listed routes.
4. Take a full-viewport screenshot (Cmd-Shift-P → "Capture full size screenshot"
   in Chrome devtools).
5. Replace email/secrets in DOM before capture using devtools edit (data
   only — no real credentials in screenshots).
