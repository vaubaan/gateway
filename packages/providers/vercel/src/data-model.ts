/**
 * Vercel data-model — declarative entity graph for the v4 risk-based engine.
 *
 * Spec : docs/spec/gateway-risk-model.md §2.4.
 * Research : .vaubaan/research/providers/vercel.md §1.
 *
 * Vercel exposes a single plane (`runtime`). Every entity lives under a
 * `team` (which is under an `account`), and almost everything is project-
 * scoped. The triad `env ∈ {prod, preview, development}` is closed (no
 * custom "stage" environments). `deployment` is the only entity Vercel
 * keeps unbounded history of ; everything else is bounded by quota or by
 * containment.
 *
 * This data-model is the canonical source for :
 *   - the mermaid diagram auto-rendered into the handbook (spec §2),
 *   - the catalog's `matches` patterns (each pattern must refer to entity
 *     slugs declared here — lint at CI),
 *   - the lint that every MCP tool exposed by this provider classifies
 *     into at least one slice rooted at a declared entity.
 *
 * Side-effect note : `bypass-token` is the one entity created by an HTTP
 * GET on the upstream API (`get_access_to_vercel_url`) — but Vaubaan
 * classifies the call as a `W` because it *mints* a credential.
 */

import type { DataModel } from '@vaubaan/shared';

export const dataModel: DataModel = {
  provider: 'vercel',
  planes: [
    {
      slug: 'runtime',
      description:
        'The only Vercel plane Vaubaan exposes — covers projects, deployments, env vars, ' +
        'domains, and the toolbar comment surface.',
      entities: [
        {
          name: 'account',
          parent: null,
          cardinalities: ['one'],
          description:
            'The Vercel account / Integration installation backing the bearer used by Vaubaan. ' +
            'Singleton per ProviderAdmin row.',
        },
        {
          name: 'team',
          parent: 'account',
          cardinalities: ['bounded'],
          description:
            'A Vercel team. The PAT/Integration is team-scoped (usually one, sometimes listed via ' +
            '`list_teams`).',
        },
        {
          name: 'project',
          parent: 'team',
          cardinalities: ['bounded'],
          description:
            'A Vercel project. The Vaubaan binding pins which project ids the access token can reach.',
        },
        {
          name: 'project-settings',
          parent: 'project',
          cardinalities: ['one'],
          description:
            'Singleton bag of build pipeline configuration : framework, build/dev/install command, ' +
            'node version, root directory. Affects all 3 envs at the next deploy.',
        },
        {
          name: 'domain',
          parent: 'project',
          cardinalities: ['bounded'],
          description:
            'A custom domain attached to the project. Couples Vercel routing to external DNS — ' +
            'attach / detach is a posture-shift visible publicly.',
        },
        {
          name: 'env',
          parent: 'project',
          cardinalities: ['bounded'],
          envScopable: true,
          description:
            'The triad of Vercel environments `{prod, preview, development}`. Closed set — ' +
            'Vercel does not accept custom env slugs at this layer.',
        },
        {
          name: 'deployment',
          parent: 'env',
          cardinalities: ['unbounded'],
          description:
            'A built + served instance of the project for a given env. Historical, can be very long.',
        },
        {
          name: 'env-var',
          parent: 'env',
          cardinalities: ['bounded'],
          description:
            'A `(key, value)` env variable scoped to one env. Quota ~1000 per project. Values are ' +
            'encrypted at rest ; the `decrypt=true` read leaks plaintext.',
        },
        {
          name: 'env-var-fan-out',
          parent: 'project',
          cardinalities: ['one'],
          description:
            'Synthetic marker entity emitted by the classifier when a single env-var write touches ' +
            'more than one env in the same call (`upsert_env_var target=[…]` with >1 envs or omitted, ' +
            'or `delete_env_var` which the upstream API applies to every env regardless of the hint).',
        },
        {
          name: 'build-log',
          parent: 'deployment',
          cardinalities: ['one'],
          description: 'Per-deployment build log (single stream/blob).',
        },
        {
          name: 'runtime-log',
          parent: 'deployment',
          cardinalities: ['unbounded'],
          description:
            'Per-deployment runtime log stream. Filterable by `since/until/level/source/requestId`. ' +
            'May contain PII if the app logs by accident — read carries a non-trivial leak surface.',
        },
        {
          name: 'bypass-token',
          parent: 'deployment',
          cardinalities: ['bounded'],
          description:
            'Short-TTL credential that bypasses deployment-protection on a single deployment URL. ' +
            'Minted by `get_access_to_vercel_url` — classified as `W` even though the upstream API ' +
            'is a GET (semantically a credential creation).',
        },
        {
          name: 'toolbar-thread',
          parent: 'deployment',
          cardinalities: ['bounded'],
          description:
            'A feedback / comment thread anchored on a deployment preview (Vercel toolbar UI).',
        },
        {
          name: 'toolbar-message',
          parent: 'toolbar-thread',
          cardinalities: ['bounded'],
          description: 'A reply (and its reactions) inside a toolbar thread.',
        },
      ],
    },
  ],
};
