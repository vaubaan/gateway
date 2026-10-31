/**
 * The output schema each management tool advertises (`tools/list`,
 * `outputSchema`): the shape of its `structuredContent` when it answers "yes".
 * A refusal is a tool error (`isError`) with `{ error: { code, message, hint } }`
 * and is not described here — the MCP SDK validates the answer of a successful
 * call only, and so does a client.
 *
 * **These schemas are checked after the tool ran.** The SDK validates
 * `structuredContent` against the advertised schema once the handler returned,
 * and answers a bare error when it does not match. For `issue_mission` and
 * `rotate_mission_token` that would lose a token shown once, after the mission
 * was written. Two rules follow, and `output-schemas.test.ts` plus the
 * integration test hold them:
 *
 * - **Loose everywhere.** Every object is `z.looseObject`: a key this file does
 *   not name never fails an answer (JSON Schema `additionalProperties: {}`), so
 *   a field added to a view, or to a shape another module owns, is not a
 *   regression here.
 * - **Thin where the shape is not ours.** What comes from the mission service
 *   or the catalog (policy lines, preview issues and notices, the summary,
 *   macro-actions, the bootstrap kit) names the keys an agent reads and leaves the
 *   rest open; values whose set is owned elsewhere (a state, a gate, a level,
 *   an orphan cause) are strings, with the set in the description.
 *
 * The TypeScript interfaces of `views.ts` and `tools.ts` remain the full
 * contract; a schema here is the part of it a client can rely on.
 */
import { z } from 'zod';

import type { ManagementToolName } from './definitions';

const riskId = z.string().describe('An explicit RiskId of the provider’s catalog.');
const riskIds = z.array(riskId);
const isoInstant = z.string().describe('ISO-8601 instant.');

const period = z
  .looseObject({ kind: z.string().describe('`one-off` or `recurring` (then `length_seconds`).') })
  .describe('The budget period of the mission.');

/** A policy line as the mission service resolves it: the id, and its budget next to it. */
const policyLine = z.looseObject({ risk_id: riskId });

/** What one macro-action at one trust level writes: lines running freely, asking first, left out. */
const trustLevelYield = z.looseObject({
  auto: z.number(),
  approval: z.number(),
  left_out: z.number(),
});

/** Per tier `1`…`4`: `auto`, `approval`, or `null` (left out); and the factor on the base budget. */
const trustLevelRule = z.looseObject({
  gates: z.looseObject({
    '1': z.string().nullable(),
    '2': z.string().nullable(),
    '3': z.string().nullable(),
    '4': z.string().nullable(),
  }),
  budget_factor: z.number(),
});

/** An issue or a notice of a preview: a code, a sentence, and what it points at. */
const finding = z.looseObject({ code: z.string(), message: z.string() });

const summary = z
  .looseObject({})
  .describe('Three lines: what the mission can do (`can`), cannot do (`cannot`), `quantities`.');

const resourceRef = z.looseObject({ ref: z.string(), env: z.string().nullable() });

const resourceScope = z
  .string()
  .describe(
    '`selected`: the resources stored at issuance (`resources`). `connection`: the whole connection — `resources` are the ones known now, and resources discovered later are reached too.',
  );

const connectionsAnswer = z.looseObject({
  connections: z.array(
    z.looseObject({
      connection_id: z.string(),
      provider: z.string(),
      provider_label: z.string(),
      display_name: z.string(),
      status: z.string().describe('`active`, or `expired`: missions on it fail until reconnected.'),
      authority: z.looseObject({
        basis: z.string().describe('`owner` or `share`.'),
        risk_ids: riskIds.describe('The exact restriction: nothing outside this list passes.'),
        whole_catalog: z.boolean(),
      }),
      resources: z.array(
        z.looseObject({
          ref: z.string(),
          display_name: z.string(),
          env: z.string().nullable(),
          hidden: z.boolean(),
        }),
      ),
      env_qualified_risks: z.looseObject({
        derives_env: z.boolean(),
        default_env: z
          .string()
          .nullable()
          .describe(
            "The owner's label for the connection's resources without one of their own; already in `env`.",
          ),
        labelled_envs: z.array(z.string()),
        unlabelled_resources: z.array(z.string()),
        usable_risk_ids: riskIds,
        unusable_risk_ids: riskIds,
      }),
      macro_actions: z.array(
        z.looseObject({
          id: z.string(),
          label: z.string(),
          description: z.string(),
          at_trust_level: z
            .looseObject({
              careful: trustLevelYield,
              trusting: trustLevelYield,
              autonomous: trustLevelYield,
            })
            .describe(
              'Per trust level (`careful`, `trusting`, `autonomous`): what `trust_levels: { [id]: trust_level }` writes here with every resource known now.',
            ),
          unavailable: riskIds.describe(
            'Risks of the macro-action outside the authority here, or that no resource can reach.',
          ),
        }),
      ),
      everything_i_hold: z
        .looseObject({ label: z.string(), description: z.string(), risks: z.number() })
        .describe(
          '`everything-i-hold`: every risk of the authority the resources can reach, written out as explicit lines at preview; `risks` counts them with every resource known now.',
        ),
    }),
  ),
});

const catalogAnswer = z.looseObject({
  provider: z.string(),
  provider_label: z.string(),
  derives_env: z.boolean(),
  connection_id: z.string().nullable(),
  risks: z.array(
    z.looseObject({
      risk_id: riskId,
      env: z.string().nullable(),
      label: z.string(),
      reason: z.string(),
      level: z.string().describe('`low`, `medium`, `high` or `critical`.'),
      tier: z.number().describe('1 mild to 4 irreversible: what a trust level maps to a gate.'),
      macro_action: z
        .string()
        .nullable()
        .describe('The macro-action the risk belongs to; `null` when deprecated.'),
      fallback: z.boolean(),
      deprecated: z.boolean(),
      rate_ceiling_per_minute: z.number().nullable(),
      in_my_authority: z.boolean().optional(),
    }),
  ),
  macro_actions: z.array(
    z.looseObject({
      id: z.string(),
      label: z.string(),
      description: z.string(),
      entries: z.array(policyLine).describe('Each risk with its base budget (×1 at Careful).'),
    }),
  ),
  trust_levels: z
    .looseObject({ careful: trustLevelRule, trusting: trustLevelRule, autonomous: trustLevelRule })
    .describe('Per trust level: the gate of each tier and the factor on the base budget.'),
  everything_i_hold: z
    .looseObject({ label: z.string(), entries: z.array(policyLine) })
    .optional()
    .describe('With `connection_id` only: the explicit lines it writes out on that connection.'),
});

const missionsAnswer = z.looseObject({
  missions: z.array(
    z.looseObject({
      mission_id: z.string(),
      name: z.string(),
      role: z
        .string()
        .describe(
          '`creator`: the user issued it. `member`: its creator shared it with the user, who reads it and uses it as it is; no tool of this door changes a mission the user is only a member of.',
        ),
      creator_email: z.string().nullable(),
      state: z.string().describe('`active`, `expired`, `orphaned` or `revoked`.'),
      orphan: z
        .looseObject({
          cause: z.string(),
          connection_id: z.string().nullable(),
          uncovered: riskIds,
          can_come_back: z.boolean(),
        })
        .nullable(),
      created_at: isoInstant,
      expires_at: isoInstant.nullable(),
      period,
      session: z
        .looseObject({ period_start: isoInstant, period_end: isoInstant.nullable() })
        .nullable(),
      issued_via: z
        .looseObject({
          client_id: z.string(),
          client_name: z.string(),
          this_client: z.boolean(),
          this_delegation: z
            .boolean()
            .describe('True for the missions `rotate_mission_token` accepts from this caller.'),
        })
        .nullable(),
      token_prefix: z
        .string()
        .nullable()
        .describe(
          'Masked prefix of the user’s own token of this mission; the secret is never shown again.',
        ),
      connection_ids: z.array(z.string()),
      resource_scopes: z.array(
        z.looseObject({ connection_id: z.string(), resource_scope: resourceScope }),
      ),
      policy: z.array(
        z.looseObject({
          risk_id: riskId,
          quota: z.number(),
          rate_limit: z.looseObject({ max: z.number(), window_seconds: z.number() }),
          gate: z.string().describe('`auto` or `approval`.'),
          remaining: z.number().nullable(),
        }),
      ),
      exhausted: riskIds,
      connections: z
        .array(
          z.looseObject({
            connection_id: z.string(),
            provider: z.string(),
            display_name: z.string(),
            status: z.string(),
            resource_scope: resourceScope,
            resources: z.array(resourceRef),
          }),
        )
        .optional()
        .describe('With `mission_id` only.'),
      policy_details: z
        .array(
          z.looseObject({
            risk_id: riskId,
            label: z.string(),
            gate_open_until: isoInstant.nullable(),
          }),
        )
        .optional()
        .describe('With `mission_id` only.'),
    }),
  ),
  hidden_closed: z.number(),
});

const previewAnswer = z.looseObject({
  ok: z.boolean().describe('True when `issue_mission` would accept this draft unchanged.'),
  issues: z.array(finding),
  notices: z.array(finding),
  uncovered: z.array(
    z.looseObject({ connection_id: z.string(), provider: z.string(), risk_ids: riskIds }),
  ),
  name: z.string(),
  policy: z.array(policyLine),
  connections: z.array(
    z.looseObject({
      connection_id: z.string(),
      provider: z.string(),
      display_name: z.string(),
      resource_scope: resourceScope,
      resources: z.array(resourceRef),
      preset: z.looseObject({ id: z.string(), label: z.string() }).nullable(),
      passes: z.array(policyLine),
      exceeds: riskIds,
      unknown: riskIds,
      unresolvable: z.array(policyLine),
      missing_budget: riskIds,
      left_out: z
        .array(policyLine)
        .describe(
          'What the trust levels or `everything-i-hold` would have written that is left out: `reason` `outside-authority`, `unresolvable-env` or `trust-level`.',
        ),
      trust_levels: z
        .looseObject({})
        .describe(
          'The trust levels kept with the mission, by macro-action id; they only redraw the form.',
        ),
    }),
  ),
  period,
  expires_at: isoInstant.nullable(),
  summary,
});

const revealedToken = z
  .looseObject({
    secret: z.string().describe('The mission token. Shown this once and never again.'),
    prefix: z.string(),
    env_var: z.string(),
    shown_once: z.boolean(),
  })
  .describe('A mission token, the only time it exists outside the gateway.');

const bootstrapKit = z
  .looseObject({
    endpoint: z.string(),
    env: z.string(),
    mcp_json: z.string(),
    agent_instructions: z.string(),
    git: z
      .string()
      .nullable()
      .describe(
        "git's configuration when the gateway is the git remote of the mission's repositories",
      ),
    verify: z.string(),
  })
  .describe(
    'What the executing agent needs: endpoint, variable, MCP configuration, instructions, git.',
  );

const issuedAnswer = z.looseObject({
  mission: z.looseObject({
    mission_id: z.string(),
    name: z.string(),
    creator_user_id: z.string(),
    issued_via_client_id: z.string(),
    expires_at: isoInstant.nullable(),
  }),
  token: revealedToken,
  bootstrap_kit: bootstrapKit,
  policy: z.array(policyLine),
  summary,
  notices: z.array(finding),
});

const rotatedAnswer = z.looseObject({
  mission_id: z.string(),
  token: revealedToken,
  bootstrap_kit: bootstrapKit,
});

const revokedAnswer = z.looseObject({
  mission_id: z.string(),
  state: z.string().describe('Always `revoked`.'),
  tokens_revoked: z.number(),
  already_revoked: z.boolean(),
});

/** One schema per tool: a tool without one does not compile. */
export const MANAGEMENT_OUTPUT_SCHEMAS = {
  list_my_connections: connectionsAnswer,
  get_catalog: catalogAnswer,
  list_my_missions: missionsAnswer,
  preview_policy: previewAnswer,
  issue_mission: issuedAnswer,
  rotate_mission_token: rotatedAnswer,
  revoke_mission: revokedAnswer,
} as const satisfies Readonly<Record<ManagementToolName, z.ZodType>>;
