/**
 * Data model of the `vercel` service.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/services/vercel.md.
 *
 * Vercel exposes a single plane, `runtime`. Every entity lives under a
 * `team` (itself under the `account` the credential belongs to) and almost
 * everything is project-scoped. The **project** is the resource an account
 * exposes and a mission selects. The environment axis is the closed Vercel
 * triad `env ∈ {prod, preview, development}` : it is not a separate resource
 * but a segment of the slice, derived from the call arguments (`target`).
 * `deployment` is the only entity Vercel keeps an unbounded history of ;
 * everything else is bounded by quota or by containment.
 *
 * Every slice the classifier emits walks this graph ; every `matches` pattern
 * of the catalog names entities declared here (`assertSlicesOnDataModel` and
 * `catalogPathIssues` in `tests/unit/plugin.test.ts`). A deployment or an env
 * var is reached through its environment : a call that does not name one is
 * classified under `env[*]`. The cardinalities are documentary (how many
 * instances exist), not how a slice names them : `project` and `team` are
 * `bounded` though a slice names one.
 *
 * Side-effect note : `bypass-token` is created by an HTTP GET on the upstream
 * API (`get_access_to_vercel_url`) — the classifier emits a `W` because the
 * call *mints* a credential.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { SERVICE_ID } from './identity.ts';

export const vercelDataModel: DataModel = {
  service: SERVICE_ID,
  planes: [
    {
      slug: 'runtime',
      description:
        'The only Vercel plane the gateway exposes — projects, deployments, env vars, ' +
        'domains, firewall, and the toolbar comment surface.',
      entities: [
        {
          name: 'account',
          parent: null,
          cardinalities: ['one'],
          description: 'The Vercel account behind the access token of an account. One per account.',
        },
        {
          name: 'team',
          parent: 'account',
          cardinalities: ['bounded'],
          description:
            'A Vercel team. An account is pinned to one team (`team_id` credential field) ; ' +
            '`list_teams` may still enumerate the others the token can see.',
        },
        {
          name: 'project',
          parent: 'team',
          cardinalities: ['bounded'],
          description:
            'A Vercel project — the resource discovered when the account is connected (`prj_xxx` ref) and ' +
            'selected by a mission.',
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
            'attach / detach is a posture shift visible publicly.',
        },
        {
          name: 'firewall',
          parent: 'project',
          cardinalities: ['one'],
          description:
            'Singleton WAF / Firewall configuration per project. Controls the top-level ' +
            'firewallEnabled toggle, managed rulesets, and OWASP CRS settings.',
        },
        {
          name: 'firewall-rule',
          parent: 'firewall',
          cardinalities: ['bounded'],
          description:
            'A custom firewall rule within the project WAF. Each rule has a condition group, ' +
            'an action (deny, challenge, rate_limit, log, bypass), and an active/inactive toggle.',
        },
        {
          name: 'ip-rule',
          parent: 'firewall',
          cardinalities: ['bounded'],
          description:
            'An IP-based blocking / challenge / bypass / log rule within the project WAF. ' +
            'Each entry targets a single IP or CIDR with a configurable action.',
        },
        {
          name: 'env',
          parent: 'project',
          cardinalities: ['bounded'],
          envScopable: true,
          description:
            'The triad of Vercel environments `{prod, preview, development}`. Closed set — ' +
            'Vercel does not accept custom env slugs at this layer. The ident of this segment ' +
            'IS the environment label the runtime qualifies env-scoped risks with.',
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
            'Short-TTL credential that bypasses deployment protection on a single deployment URL. ' +
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
