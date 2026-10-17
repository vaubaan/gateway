---
title: Self resources — the instance's own hosting is never reachable by a mission, and no read returns a secret under a non-secret risk
status: accepted
date: 2026-10-13
extends:
  - railway-deployment-and-privilege-dropping-entrypoint
---

# Self resources — the instance's own hosting is never reachable by a mission, and no read returns a secret under a non-secret risk

> Fixes C1 and H1 of the 2026-10-15 security review ("mission escape").
> Handbooks: [configuration](../handbook/configuration.md) ("Self
> resources"), [missions](../handbook/missions.md),
> [threat model](../handbook/threat-model.md),
> [supabase](../handbook/providers/supabase.md),
> [vercel](../handbook/providers/vercel.md). Dated with the v5 decisions it
> belongs to; written on 2026-10-15.

> **Amendment of 2026-10-16 — an instance on Fly counts its own app
> (product owner, Fly research Q7).** Fly sets `FLY_APP_NAME` in every
> machine (Fly docs, "Runtime environment"). With the `fly` plugin, whose
> resources are apps by name, the host now adds `fly:$FLY_APP_NAME` to the
> self resources exactly as it adds `railway:$RAILWAY_PROJECT_ID` (source
> `fly`; the configuration cannot remove it). The Fly organization that
> hosts a gateway is **never connected to that gateway**: resource binding
> does not cover organization-level calls (creating an app names no
> resource), the same reason the deploy guide gives a separate Railway
> workspace. Any other app of the connected organization that must stay out
> of reach is listed in `self_resources` as `fly:<app name>`. Handbooks: [configuration](../handbook/configuration.md),
> [fly](../handbook/providers/fly.md) §5.10.

## Context

Two findings of the review share one cause: what an accepted risk is worth
depends on facts the plugin does not see.

- **H1.** Each instance runs on Railway, and a Railway connection lists the
  project that hosts the gateway. To the Railway plugin that project is a
  resource like any other. A mission with `railway.read-variables` on it reads
  `VAUBAAN_MASTER_KEY`; `railway.upsert-variable` rewrites
  `VAUBAAN_ADMIN_EMAILS`; `railway.deploy` replaces the instance. Only the host
  knows which project it runs in (Railway sets `RAILWAY_PROJECT_ID` in the
  container).
- **C1.** `supabase__list_function_secrets` and `supabase__get_auth_config`
  are priced as `supabase.read-data` (every preset) and returned the
  project's secret values: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`
  (database password), OAuth client secrets, SMTP password, hook secrets. The
  sweep of the other plugins found the same pattern, milder, in Vercel's
  `list_env_vars` without `decrypt` (`read-env-var`, `data: metadata`): `plain`
  variables come back in clear.

## Decision

1. **A host-level set of self resources.** `InstanceConfig.selfResources` is
   a list of `{ provider, ref, source }`. It holds `railway:$RAILWAY_PROJECT_ID`
   whenever Railway sets that variable — the configuration cannot remove it —
   plus every `<provider>:<ref>` of the `self_resources` key
   (`VAUBAAN_SELF_RESOURCES`) for other hosts. No plugin, connection, preset or
   policy can add or remove an entry.
2. **Enforced at each place a resource becomes reachable**, through one
   predicate (`isSelfResource`):
   - issuance: `IssuanceResource.self`; out of "all resources"; an explicit
     selection is refused with the preview issue `resource-self`; the
     management door does not list it; a duplicated mission drops it;
   - execution: `loadMissionContext` leaves it out of the mission's resources
     whatever the stored selection says, so a mission issued before the
     instance knew it (or a row written by hand) still cannot reach it — the
     plugin binds no call to it, and the resource stage answers
     `resource-not-in-mission`;
   - display: the mission detail and the kit do not list it; the account page
     tags it "this instance's own project: never reachable by a mission" and
     does not count it as reachable.
3. **No read returns a secret value under a risk that is not a secret read.**
   An answer that may carry secrets goes through an **allow-list** of
   non-secret fields in the plugin's `execute`; every other field holding a
   value becomes the fixed marker `[redacted by Vaubaan]`; an empty value stays
   (it says "not set"). An allow-list, not a deny-list, so that a secret field
   the provider adds later is redacted by default. Applied to Supabase
   (`list_function_secrets`, `get_auth_config`, the answer of
   `update_auth_config`) and Vercel (`list_env_vars` without `decrypt`). Reading
   such a value, if ever wanted, is a dedicated `data: secret` risk in no preset
   — as `vercel.read-env-var-plaintext` and `railway.read-variables` already
   are.

## Consequences

- An instance on Railway is protected without any configuration step; an
  instance elsewhere names its hosting in `self_resources`.
- The protection is about the resource as a mission resource. What a
  credential reaches outside resource binding (Railway's free-text agent tool,
  account-level tools) is not covered: the deploy guide still recommends a
  separate Railway workspace for the gateway, never connected to itself.
- A self resource stays visible on the account page (with its tag): the owner
  sees why a mission cannot select it rather than wondering where it went.
- An allow-list goes stale the other way: a non-secret field Supabase or Vercel
  adds shows as redacted until it is added to the list. That is the intended
  failure direction.
- `loadMissionContext` takes the self resources as an explicit argument; every
  caller passes `config.selfResources` (tests pass `[]`).

## Rejected alternatives

- **Let the Railway plugin exclude the project at discovery.** The plugin has
  no access to the environment by contract (no `process.env` in a plugin), and
  dropping the row would hide the fact from the owner and leave a policy that
  already names it working.
- **Refuse only at issuance.** A mission issued before the fix, or a database
  edited by hand, would keep reaching the project. The execution door is where
  the guarantee must hold.
- **A deny-list of secret field names** (as Upstash's `REDACTED_DATABASE_FIELDS`
  was). Misses the next secret field the provider adds. Upstash's answer keeps
  its explicit list and now also strips any credential-like field name; its
  database object has many limit fields and no published schema to build an
  allow-list from.
- **Re-price the two Supabase reads as a new `data: secret` risk.** Would make
  listing secret _names_ and reading the auth _settings_ — what agents need —
  impossible under the presets, to protect values nobody needs to read.
