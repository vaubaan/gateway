/**
 * Data model of the `railway` provider — the `runtime` plane.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/providers/railway.md.
 *
 * Railway exposes a single plane, `runtime`, covering the deployment,
 * configuration and account surface. The containment graph is :
 *
 *   account → project → environment → service → deployment → {logs, status}
 *                                            └→ service-var
 *                          └────────────────→ service-var (project-shared)
 *   account → agent-session (opaque meta-tool — no containment)
 *
 * Notes :
 *  - The *resource* a connection exposes is the Railway **project** (UUID).
 *    The owner labels it with a Vaubaan environment (`prod`, `staging`…) ;
 *    the classifier stamps that label into the `environment[...]` segment of
 *    every project-scoped slice. Railway's own environment names
 *    (`production`, `staging`, PR environments) are carried in the resource
 *    metadata for display and lookup only.
 *  - `service-var` covers both service-scoped variables (Railway `serviceId`
 *    set) and project-shared ones (`serviceId` null). Qualification is by
 *    environment, not by service-vs-project.
 *  - `agent-session` is one invocation of `railway__railway-agent`.
 *    Deliberately opaque (no containment) : the upstream agent may mutate
 *    anything in the graph, so it hangs off `account` to signal the
 *    account-wide blast radius, and the classifier emits pessimistic
 *    deployment and variable write slices next to it.
 *
 * Entity slugs are kebab-case and stable : changing one is a breaking change
 * for the catalog patterns.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

export const railwayDataModel: DataModel = {
  provider: 'railway',
  planes: [
    {
      slug: 'runtime',
      description:
        'Railway runtime plane — deployment, configuration and account surface. ' +
        'One resource is one Railway project ; its owner labels the environment.',
      entities: [
        {
          name: 'account',
          parent: null,
          cardinalities: ['one'],
          description:
            'The authenticated Railway workspace / user. Top-level root of the graph ; env-less.',
        },
        {
          name: 'project',
          parent: 'account',
          cardinalities: ['one', 'bounded'],
          description:
            'A Railway project (UUID). The resource a connection exposes and a mission selects.',
        },
        {
          name: 'environment',
          parent: 'project',
          cardinalities: ['one'],
          envScopable: true,
          description:
            'The environment segment of a slice carries the owner label of the project ' +
            '(`prod`, `staging`…), not the Railway-native environment name.',
        },
        {
          name: 'service',
          parent: 'environment',
          cardinalities: ['one', 'bounded'],
          description:
            'A deployable unit inside an environment (web, worker, cron…). Tools usually take ' +
            'an explicit `serviceId` ; some (`list-services`, `get-status`) span all services.',
        },
        {
          name: 'deployment',
          parent: 'service',
          cardinalities: ['one'],
          description:
            'The current (or most recent) deployment of a service. Deployment ids are only ' +
            'nameable through `deploymentId` in `get-logs` ; one deployment per service.',
        },
        {
          name: 'logs',
          parent: 'deployment',
          cardinalities: ['one'],
          description:
            'Build / deploy / http log streams of a deployment. Read-only ; may leak ' +
            'application secrets printed by the app (DSN, JWT).',
        },
        {
          name: 'status',
          parent: 'deployment',
          cardinalities: ['one'],
          description:
            'Deployment status snapshot (build status, replica count, cron schedule). ' +
            'Read-only metadata.',
        },
        {
          name: 'service-var',
          parent: 'service',
          cardinalities: ['one', 'bounded', 'unbounded'],
          description:
            'An environment variable, service-scoped or shared at the project level (Railway ' +
            'distinguishes the two by `serviceId` null / non-null ; one entity here). ' +
            '`unbounded` appears on `upsert-variables replace=true` (destructive wildcard).',
        },
        {
          name: 'agent-session',
          parent: 'account',
          cardinalities: ['unbounded'],
          description:
            'One invocation of the `railway__railway-agent` meta-tool. Opaque : the upstream ' +
            'agent may mutate anything in the graph from a natural-language prompt, so the ' +
            'classifier emits pessimistic write slices next to `agent-session.W`.',
        },
      ],
    },
  ],
};
