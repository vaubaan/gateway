---
title: GitHub SSO setup
status: current
date: 2026-05-26
tracks:
  - packages/web/src/app/(public)/login/page.tsx
  - packages/web/src/app/auth/callback/route.ts
  - scripts/configure-supabase-github-provider.sh
---

# GitHub SSO setup

The login page calls `supabase.auth.signInWithOAuth({ provider: 'github' })`.
Supabase redirects to GitHub, GitHub redirects back to Supabase's
`/auth/v1/callback`, which then redirects to our `/auth/callback?code=…`
where we `exchangeCodeForSession`.

Two pieces of configuration must exist for that flow to work:

1. A **GitHub OAuth App** (different from the GitHub App we use for repo
   access — OAuth Apps mint user tokens, GitHub Apps mint installation
   tokens).
2. **Supabase Auth** must have GitHub external provider enabled, with the
   OAuth App's `client_id` and `client_secret` pasted in.

## 1. Create the GitHub OAuth App (one-time, manual)

GitHub does **not** expose an API to create OAuth Apps. This step must
be done in the GitHub UI.

URL: <https://github.com/organizations/sbw-vaubaan/settings/applications/new>

> If you prefer a personal OAuth App, the URL is
> <https://github.com/settings/applications/new> — but org-scoped is
> cleaner for a SaaS and survives owner changes.

Fill in:

| Field                      | Value                                                       |
| -------------------------- | ----------------------------------------------------------- |
| Application name           | `Vaubaan`                                                   |
| Homepage URL               | `https://vaubaan.com`                                       |
| Application description    | `Policy-enforcing MCP gateway for coding agents.`           |
| Authorization callback URL | `https://ynxfyklzqdumtixkdrco.supabase.co/auth/v1/callback` |
| Enable Device Flow         | leave unchecked                                             |

After **Register application**:

1. Copy the **Client ID**.
2. Click **Generate a new client secret**, copy the **Client secret**.
3. (Optional) upload the Vaubaan mark from `packages/web/public/logo-vaubaan.png`.

Paste both into `.env` at the repo root:

```env
SUPABASE_AUTH_GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx
SUPABASE_AUTH_GITHUB_CLIENT_SECRET=ghs_xxxxxxxxxxxxxxxx
```

> `.env` is gitignored. Add the same two vars in the Vercel project env
> for the deployed app.

## 2. Configure Supabase Auth

Run from the repo root:

```bash
bash scripts/configure-supabase-github-provider.sh
```

The script reads `SUPABASE_MGMT_TOKEN`, `SUPABASE_AUTH_GITHUB_CLIENT_ID`
and `SUPABASE_AUTH_GITHUB_CLIENT_SECRET` from `.env` and PATCHes:

```
PATCH https://api.supabase.com/v1/projects/ynxfyklzqdumtixkdrco/config/auth
{
  "external_github_enabled": true,
  "external_github_client_id": "...",
  "external_github_secret": "..."
}
```

After the script returns 200, the GitHub button on `/login` works
immediately — no redeploy needed.

## 3. Smoke test

1. Open <https://vaubaan.com/login>.
2. Click **Continue with GitHub**.
3. GitHub consent screen → Authorize.
4. Redirect lands on `/dashboard` with the new session.

The first-time user lands without an org. The dashboard renders the
empty-state CTA pointing at `/orgs/new`.

## Troubleshooting

- **`redirect_uri_mismatch`** on GitHub — the callback URL in the OAuth
  App doesn't match `https://ynxfyklzqdumtixkdrco.supabase.co/auth/v1/callback`.
  Update it on GitHub side.
- **`Email not confirmed`** — Supabase Auth has email confirmation on
  by default. Either disable it (Auth → Settings) or finish the email
  flow.
- **`Provider is not enabled`** — the Supabase PATCH didn't take. Re-run
  the script, or open Auth → Providers in the Supabase dashboard and
  toggle GitHub on manually with the same `client_id`/`secret`.
