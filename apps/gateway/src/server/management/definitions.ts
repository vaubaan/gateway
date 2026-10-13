/**
 * The tools of the management door: name, input schema, the text an agent
 * reads, and the method of `ManagementTools` each one calls.
 *
 * `MANAGEMENT_TOOLS` is the whole surface (spec §4.1 bis): three reads, one
 * preview, three mutations. The door registers this table and nothing else.
 *
 * **The descriptions are read by a language model**, which composes a policy
 * from them with no other documentation. They therefore state the rules of
 * issuance where the model needs them — explicit `RiskId`s only, a preset as
 * the starting point, env-qualified ids need a labelled resource, a budget
 * for every risk, the user is the creator and answers every request — and
 * they say what the door cannot do, so that an agent refused by its mission
 * does not come looking for a way around here.
 */
import { z } from 'zod';

import { missionDraftSchema } from '../missions';
import { MANAGEMENT_OUTPUT_SCHEMAS } from './output-schemas';
import type { ManagementActor } from './ports';
import type { ManagementTools, ToolOutcome } from './tools';

export const MANAGEMENT_TOOL_NAMES = [
  'list_my_connections',
  'get_catalog',
  'list_my_missions',
  'preview_policy',
  'issue_mission',
  'rotate_mission_token',
  'revoke_mission',
] as const;
export type ManagementToolName = (typeof MANAGEMENT_TOOL_NAMES)[number];

/** `read` and `preview` write nothing; a `mutation` leaves an administrative audit entry. */
export type ManagementToolKind = 'read' | 'preview' | 'mutation';

export interface ManagementToolDefinition {
  readonly name: ManagementToolName;
  readonly title: string;
  readonly description: string;
  readonly kind: ManagementToolKind;
  readonly inputSchema: z.ZodType;
  /**
   * The shape of a successful answer's `structuredContent`, advertised by
   * `tools/list` and checked by the SDK after the tool ran (`output-schemas.ts`).
   */
  readonly outputSchema: z.ZodType;
  /** MCP behaviour hints for the client's own confirmation prompts. */
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: false;
  };
  /** `args` already passed `inputSchema`. */
  run(tools: ManagementTools, actor: ManagementActor, args: unknown): Promise<ToolOutcome<unknown>>;
}

function define<Schema extends z.ZodType>(definition: {
  readonly name: ManagementToolName;
  readonly title: string;
  readonly description: string;
  readonly kind: ManagementToolKind;
  readonly inputSchema: Schema;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly run: (
    tools: ManagementTools,
    actor: ManagementActor,
    args: z.infer<Schema>,
  ) => Promise<ToolOutcome<unknown>>;
}): ManagementToolDefinition {
  const { inputSchema, run } = definition;
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    kind: definition.kind,
    inputSchema,
    outputSchema: MANAGEMENT_OUTPUT_SCHEMAS[definition.name],
    annotations: {
      readOnlyHint: definition.kind !== 'mutation',
      destructiveHint: definition.destructive === true,
      idempotentHint: definition.idempotent ?? definition.kind !== 'mutation',
      openWorldHint: false,
    },
    run: (tools, actor, args) => run(tools, actor, inputSchema.parse(args)),
  };
}

const missionId = z
  .string()
  .min(1)
  .max(300)
  .describe('Id of one of the user’s missions, as `list_my_missions` returns it.');

/**
 * What an MCP client shows the model when it connects (`initialize`): the
 * door in one paragraph, the order of the calls, the rules, the limits.
 */
export const MANAGEMENT_INSTRUCTIONS = [
  'Vaubaan Gateway, management door. You act on behalf of the user who authorized you, within their authority over the company’s provider connections and never beyond it. Use it to prepare a mission — a token with selected resources, accepted risks and a budget — for an agent that will do the work.',
  '',
  'Order of the calls: `list_my_connections` (what the user may delegate) → `get_catalog` (the risks and presets of a provider) → `preview_policy` until it answers `ok: true` → `issue_mission`. The answer of `issue_mission` contains the mission token, shown once, and the bootstrap kit to hand to the executing agent.',
  '',
  'Rules of a policy:',
  '- Accept explicit RiskIds only, copied from `get_catalog`. No wildcard, no pattern, no "everything".',
  '- Start from one preset per connection and trim it to the task; add single risks only when the task needs them.',
  '- Every accepted risk needs a budget: a quota per period and a rate limit. A preset supplies them; otherwise you must.',
  '- A RiskId qualified with an environment, such as `supabase[prod].row-write`, is only usable when a selected resource carries that environment label (`env_qualified_risks` in `list_my_connections`).',
  '- One connection per provider in a mission. Select the resources the task needs, not all of them.',
  '- A risk outside the user’s authority is refused, with the list of what is not covered. You cannot obtain it here: remove it, or tell the user.',
  '',
  'The user is the creator of every mission you issue and sees it marked as issued by you. Requests raised by a mission — a claim for more budget, an approval of an action — are answered by the user alone, in the web interface. This door cannot answer a request, open a gate, extend a budget, reset a period, connect a provider, share or revoke a connection, or call a provider tool. A mission token opens the execution door only, not this one.',
].join('\n');

export const MANAGEMENT_TOOLS: readonly ManagementToolDefinition[] = [
  define({
    name: 'list_my_connections',
    title: 'List my connections',
    kind: 'read',
    description: [
      'Lists the provider connections the user may build a mission from: the ones they own and the ones shared with them, directly or through a group.',
      'For each connection: `authority.risk_ids` is the exact list of RiskIds a mission may accept on it — nothing outside that list will ever pass —, `resources` are the refs a mission can be limited to, with their environment label, `env_qualified_risks` says which environment-qualified ids are usable (an id such as `provider[prod].x` needs a selected resource labelled `prod`; unlabelled resources refuse it), and `presets` are ready-made policies, each flagged when it exceeds the user’s authority.',
      'Call this first. Use `get_catalog` for the meaning of each RiskId and the content of each preset.',
    ].join(' '),
    inputSchema: z
      .object({
        include_experimental: z
          .boolean()
          .optional()
          .describe(
            'Also list connections of experimental providers (hidden by default). Only when the user asked for one.',
          ),
      })
      .strict(),
    run: (tools, actor, args) => tools.listMyConnections(actor, args),
  }),
  define({
    name: 'get_catalog',
    title: 'Get a provider’s risk catalog',
    kind: 'read',
    description: [
      'Returns the risk catalog of one provider as explicit RiskIds — label, reason, severity level, environment — and its presets with every entry (RiskId, quota, rate limit, gate).',
      'A policy accepts ids from this list only, written exactly as shown; an id qualified with an environment (`provider[staging].x`) is a different id from the same risk in another environment.',
      'Pass `connection_id` to have each id flagged `in_my_authority` for that connection.',
      'Pick the narrowest preset that covers the task as a starting point, then remove what the task does not need. The `fallback` id (uncategorized writes) is never part of a preset: accept it only when the user asks.',
    ].join(' '),
    inputSchema: z
      .object({
        provider: z
          .string()
          .min(1)
          .max(100)
          .describe('Provider id, as `list_my_connections` shows it, e.g. `github`.'),
        connection_id: z
          .string()
          .min(1)
          .max(300)
          .optional()
          .describe('One of the user’s connections of that provider.'),
      })
      .strict(),
    run: (tools, actor, args) => tools.getCatalog(actor, args),
  }),
  define({
    name: 'list_my_missions',
    title: 'List my missions',
    kind: 'read',
    description: [
      'Lists the missions of the user, newest first: state (`active`, `expired`, `orphaned`, `revoked`), `orphan` — why an orphaned mission lost its authority and whether it can come back —, policy with what is left of each quota this period, the current period of the session, the masked token prefix, and which client issued it when it was issued by delegation.',
      'With `mission_id`, returns that mission with its connections and the resources it reaches.',
      'Reading only: a budget cannot be extended, a period reset or a gate changed from here — the user does that in the web interface, when the executing agent hands them the URL of a refusal.',
    ].join(' '),
    inputSchema: z
      .object({
        mission_id: missionId.optional(),
        include_closed: z
          .boolean()
          .optional()
          .describe('Also list revoked and expired missions (left out by default).'),
      })
      .strict(),
    run: (tools, actor, args) => tools.listMyMissions(actor, args),
  }),
  define({
    name: 'preview_policy',
    title: 'Preview a mission policy',
    kind: 'preview',
    description: [
      'Checks a mission draft without issuing anything. Answers `ok`, the `issues` that block it, `uncovered` — the accepted risks outside the user’s authority, per connection —, and `policy`: exactly what the mission could call, with the budget of each risk.',
      'Rules: explicit RiskIds only; one connection per provider; either `preset` alone (the preset, bounded by the user’s authority) or `policy` with a quota and a rate limit for every risk (a named `preset` then supplies the missing budgets); an environment-qualified id needs a selected resource labelled with that environment; `period` and `expires_at` are mandatory (`expires_at` may be null).',
      'Call it until `ok` is true, then pass the same draft to `issue_mission`. A risk listed in `uncovered` cannot be obtained here: remove it.',
    ].join(' '),
    inputSchema: missionDraftSchema,
    run: (tools, actor, args) => tools.previewPolicy(actor, args),
  }),
  define({
    name: 'issue_mission',
    title: 'Issue a mission',
    kind: 'mutation',
    description: [
      'Issues a mission from a draft that `preview_policy` accepts. The creator is the user, not you: the mission appears under their name, marked as issued by this client, and they alone answer the requests it raises (claims for more budget, approvals of gated actions) in the web interface.',
      'The answer contains `token.secret` — the mission token, shown this once and never again — and `bootstrap_kit`: the environment variable, the MCP configuration and the instruction block to give the agent that will execute the mission. The mission token opens the execution door only; it is not accepted here. Do not write it anywhere but where the kit says.',
      'A draft that exceeds the user’s authority is refused whole, with `uncovered`; nothing is narrowed silently. Issue the narrowest mission that does the task: the mission and its width are visible to the user.',
    ].join(' '),
    inputSchema: missionDraftSchema,
    run: (tools, actor, args) => tools.issueMission(actor, args),
  }),
  define({
    name: 'rotate_mission_token',
    title: 'Rotate a mission’s token',
    kind: 'mutation',
    destructive: true,
    description: [
      'Replaces the token of one of the user’s active missions: the previous token stops working at once, the mission, its policy, its session and its budget are unchanged.',
      'The answer contains the new `token.secret`, shown this once, and the bootstrap kit.',
      'Use it when a token leaked or was lost. A revoked or expired mission is not rotated: issue a new one. An orphaned mission is not rotated either: it refuses every call until the user’s authority returns, and its token then works again.',
    ].join(' '),
    inputSchema: z.object({ mission_id: missionId }).strict(),
    run: (tools, actor, args) => tools.rotateMissionToken(actor, args),
  }),
  define({
    name: 'revoke_mission',
    title: 'Revoke a mission',
    kind: 'mutation',
    destructive: true,
    idempotent: true,
    description: [
      'Ends one of the user’s missions for good: its token is refused from now on. It cannot be undone; a new mission must be issued.',
      'Use it when the task is finished or the token leaked. An orphaned mission can be revoked too: that closes it for good. It does not touch the user’s connections, shares or other missions.',
    ].join(' '),
    inputSchema: z.object({ mission_id: missionId }).strict(),
    run: (tools, actor, args) => tools.revokeMission(actor, args),
  }),
];
