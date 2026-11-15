---
title: Service modeler — modelling a new plugin
tracks:
  - plugins/README.md
  - plugins/_template/
  - packages/plugin-sdk/src/define-plugin.ts
  - packages/plugin-sdk/src/catalog-loader.ts
  - apps/gateway/src/server/compose/shipped-plugins.ts
last_reviewed: 2026-10-27
---

# Service modeler

> **How to use.** Not loaded automatically. Tell the agent: "Read `docs/skills/service-modeler.md`,
> then model the service `<vendor>`."

You model a new service as a plugin on `@vaubaan/plugin-sdk`. **The procedure is
[`plugins/README.md`](../../plugins/README.md)**, steps 0 to 11, each with its files, rules and
check command; `definePlugin`, the catalog loader and the test kit refuse what breaks them. This
file adds only what to ask, where to stop for a human, and what to hand back. Where they disagree,
the kit wins; report it.

## Ask before starting

1. The service id: a lowercase slug (`cloudflare-dns`); the tool prefix turns `-` into `_`.
2. The API surface: upstream docs, the tools wanted, or an MCP server to rewrap.
3. The operational use case, which bounds the risks worth modelling.
4. How the service authenticates, if known: pasted key, the service's own sign-in, SSH key.

## Read first

- [`plugins/README.md`](../../plugins/README.md) whole,
  [`plugins/_template`](../../plugins/_template/README.md), the
  [plugin-sdk handbook](../handbook/plugin-sdk.md), and
  [`gateway-risk-model`](../spec/gateway-risk-model.md) §2, §3, §4, §7.
- The closest plugin and its handbook under
  [`docs/handbook/services/`](../handbook/services/README.md): `cloudflare-dns` (one resource per
  zone, layered write risks), `vercel` (environment in the call), `supabase` (several planes),
  `github` (the git remote), `ssh` (commands classified from their text), `miro` (rewrapped remote
  MCP server, self-registered OAuth client), `gmail` (app password over IMAP).
- Service docs come from Context7 through the gateway's `context7` plugin
  ([handbook](../handbook/services/context7.md)), never from memory or ad-hoc fetches; the pull
  request names the pages the classifier was written from.

## The one stop

Step 0, **research, is validated by a human before any code**: draft
`docs/handbook/services/<vendor>.md` in the kit's six sections, with its open questions. It must
answer what a resource is and where its environment comes from; the risks, each with its six-axis
vector and why it deserves its own decision; the presets (at least read-only and daily work) and
which risks are deliberately in none; the narrowest credential that works. **Stop and submit it.**
Then steps 1 to 11 in order.

## Guard rails

- Specs are read-only from here; report a gap, do not work around it.
- Fail closed: what the classifier cannot tell is `{ denied }` or every slice it could touch, never
  a guess.
- Register the plugin in `shipped-plugins.ts` only: it is the single service list.
- No pull request, no commit unless asked. Hand back the file list, the test output
  (`npx vitest run plugins/<vendor>`, then `npm run ci`), the service docs used, what you decided
  alone, and the open questions.
