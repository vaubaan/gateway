/**
 * Railway — data-model for the `runtime` plane.
 *
 * Source of truth : `.vaubaan/research/providers/railway-ssh.md` §1.2.
 * Spec           : `docs/spec/gateway-risk-model.md` §2.
 *
 * Railway exposes a single plane `runtime` covering the deployment,
 * configuration and account surface. The containment graph is :
 *
 *   account → project → environment → service → deployment → {logs, status}
 *                                            └→ service-var
 *                          └────────────────→ service-var (project-shared)
 *                   └─→ project-var
 *   account → agent-session (opaque meta-tool — no containment)
 *
 * Notes (cf. research §1.2) :
 *  - `environment` is a Railway-native node (production, staging…). A
 *    Vaubaan binding pins one Railway *project*, and the env slug (Vaubaan
 *    side) lives on `binding.environment`.
 *  - `service-var` covers both service-scoped vars (Railway `serviceId`
 *    non-null) and project-shared vars (`serviceId` null). Catalog
 *    qualification is by env (staging vs prod), not by service-vs-project.
 *  - `agent-session` represents one invocation of `railway__railway-agent`.
 *    Deliberately opaque (no containment) — the call may mutate anything
 *    in the graph, so we glue it to `account` to signal account-wide blast
 *    radius.
 *
 * The mermaid diagram is auto-rendered from this declaration by the
 * handbook tooling — keep entity slugs human-readable, kebab-case, and
 * stable (changing a slug is a breaking change for the catalog).
 */

import type { DataModel } from '@vaubaan/shared';

export const railwayDataModel: DataModel = {
  provider: 'railway',
  planes: [
    {
      slug: 'runtime',
      description:
        'Railway runtime plane — deployment, configuration, and account ' +
        'surface. One Vaubaan binding maps to one Railway project ; the ' +
        'env slug is carried on `binding.environment`.',
      entities: [
        {
          name: 'account',
          parent: null,
          cardinalities: ['one'],
          description:
            'The authenticated Railway workspace / user. Top-level root ' +
            'of the graph ; env-less.',
        },
        {
          name: 'project',
          parent: 'account',
          cardinalities: ['one', 'bounded'],
          description:
            'A Railway project. One project per Vaubaan binding ; the ' +
            'binding `environment` field qualifies which env this project ' +
            'represents (staging, prod…) on the Vaubaan side.',
        },
        {
          name: 'environment',
          parent: 'project',
          cardinalities: ['one'],
          envScopable: true,
          description:
            'A Railway-native environment (production, staging…). Distinct ' +
            'from the Vaubaan env slug : Railway names may differ (e.g. ' +
            'Railway `production` ↔ Vaubaan `prod`).',
        },
        {
          name: 'service',
          parent: 'environment',
          cardinalities: ['one', 'bounded'],
          description:
            'A deployable unit inside an environment (web, worker, ' +
            'cron…). Tools usually take an explicit `serviceId` ; some ' +
            '(`list-services`, `get-status`) span all services.',
        },
        {
          name: 'deployment',
          parent: 'service',
          cardinalities: ['one'],
          description:
            'The current (or most recent) deployment of a service. Railway ' +
            'exposes a single "current" deployment per service ; deployment ' +
            'ids are not nameable from the MCP surface in v4 except via ' +
            '`deploymentId` in `get-logs`. Cardinality = `one` per service.',
        },
        {
          name: 'logs',
          parent: 'deployment',
          cardinalities: ['one'],
          description:
            'Build / deploy / http log streams of a deployment. Read-only ; ' +
            'may leak application secrets via printed values (DSN, JWT).',
        },
        {
          name: 'status',
          parent: 'deployment',
          cardinalities: ['one'],
          description:
            'Deployment status snapshot (build status, replica count, ' +
            'cron schedule). Read-only metadata.',
        },
        {
          name: 'service-var',
          parent: 'service',
          cardinalities: ['one', 'bounded', 'unbounded'],
          description:
            'An environment variable scoped to a service or shared at the ' +
            'project level (Railway distinguishes the two by `serviceId` ' +
            'null/non-null ; we model both under a single entity). ' +
            '`unbounded` cardinality emerges on `upsert-variables ' +
            'replace=true` (destructive wildcard).',
        },
        {
          name: 'agent-session',
          parent: 'account',
          cardinalities: ['unbounded'],
          description:
            'One invocation of the `railway__railway-agent` meta-tool. ' +
            'Opaque — the upstream Railway agent may decide to mutate ' +
            'anything in the graph based on a natural-language prompt, so ' +
            'the classifier emits a wildcard pessimistic slice in addition ' +
            'to the `agent-session.W` slice (cf. risk-classifier.ts).',
        },
      ],
    },
  ],
};
