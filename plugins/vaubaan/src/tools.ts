/**
 * MCP tools of the `vaubaan` provider: the seven acts of the retired management
 * door, with the names, arguments and answers it published, prefixed `vaubaan__`.
 *
 * Handbook : docs/handbook/providers/vaubaan.md.
 *
 * **The descriptions are read by a language model**, which composes a mission
 * from them with no other documentation. They state the rules of issuance where
 * the model needs them — explicit `RiskId`s only, macro-actions as the starting
 * point, env-qualified ids need a labelled resource, a budget for every risk, the
 * user is the creator and answers every request — and they say what these tools
 * cannot do, so that an agent refused by its mission does not come looking for a
 * way around here.
 *
 * `tool-schemas.json` is the JSON Schema of each tool's arguments, keyed by act.
 * The host reads the same arguments with its own zod schemas and holds the file
 * to them (`apps/gateway/src/server/vaubaan/inputs.test.ts`); the file is written
 * by `npm run vaubaan:schemas` in `apps/gateway`, never by hand.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { ACT, PROVIDER_ID, TOOL, type VaubaanActName } from './identity.ts';
import schemas from './tool-schemas.json' with { type: 'json' };

/** What an agent reads first: the order of the calls and the rules, in one place. */
const ORDER_OF_CALLS =
  'Order of the calls: `vaubaan__list_my_connections` (what the user may put in a mission) → `vaubaan__get_catalog` (the risks and macro-actions of a service) → `vaubaan__preview_policy` until it answers `ok: true` → `vaubaan__issue_mission`.';

const DESCRIPTIONS: Readonly<Record<VaubaanActName, string>> = {
  listMyConnections: [
    'Lists the provider connections (accounts) the user may build a mission from: the ones they own and the ones shared with them, directly or through a group.',
    'For each connection: `authority.risk_ids` is the exact list of RiskIds a mission may accept on it — nothing outside that list will ever pass —, `resources` are the refs a mission can be limited to, with their environment label (their own, or the connection’s `default_env` the owner chose for unlabelled resources), `env_qualified_risks` says which environment-qualified ids are usable (an id such as `provider[prod].x` needs a selected resource labelled `prod`; unlabelled resources refuse it), `macro_actions` are what a mission may tick there, each with what it writes at each trust level (`at_trust_level`: how many run freely, ask first, are left out) and the risks of it the user cannot get here (`unavailable`), and `everything_i_hold` counts the lines of the gateway’s own expansion: every risk the user holds there that the resources can reach.',
    'Call this first. Use `vaubaan__get_catalog` for the meaning of each RiskId and the risks of each macro-action.',
    ORDER_OF_CALLS,
    'A Vaubaan account is listed too, but a mission issued here never carries one: it is refused.',
  ].join(' '),
  getCatalog: [
    'Returns the risk catalog of one provider as explicit RiskIds — label, reason, row and the reason of the row, environment, macro-action —, its `macro_actions` with every risk and its base budget, and `trust_levels`: per trust level, the gate each row gets (`null`: left out) and the factor on the base budget.',
    'Each risk sits in a row (`row`): 1 harmless, 2 repairable but worth a look, 3 repairable at a price, 4 cannot be repaired. Careful runs row 1 freely, asks before rows 2 and 3 and leaves row 4 out; Trusting runs rows 1 and 2 freely, limits ×3; Autonomous asks only before row 4, limits ×10.',
    'A policy accepts ids from this list only, written exactly as shown; an id qualified with an environment (`provider[staging].x`) is a different id from the same risk in another environment.',
    'Pass `connection_id` to have each id flagged `in_my_authority` for that connection.',
    'With `connection_id`, `everything_i_hold` is the built-in expansion written out for that connection, entry by entry.',
    'Tick the macro-actions the task needs at the lowest trust level that lets it run, then remove what the task does not need. The `fallback` id (uncategorized writes) is only in `anything-else`: tick it only when the user asks — `everything-i-hold` includes it, because the user asked for everything they hold.',
  ].join(' '),
  listMyMissions: [
    'Lists the missions of the user, newest first — the ones they created (`role: creator`) and the ones another user shared with them as a member (`role: member`, read-only here) —: state (`active`, `expired`, `orphaned`, `revoked`), `orphan` — why an orphaned mission lost its authority and whether it can come back —, `lost_connections` — accounts that no longer serve a mission still running on its others (revoked for good, or access withdrawn) —, policy with what is left of each quota this period, the current period of the session, the masked token prefix, and `issued_via`: the mission whose agent issued it (`this_mission` when it is the mission making this call), or the app that issued it before the management door was retired.',
    'With `mission_id`, returns that mission with its connections and the resources it reaches.',
    '`resource_selections` lists, per connection, its resource sets: each an explicit list of resources of one environment (`env`), with `future` when the resources that later appear in that environment join it.',
    'Reading only: a budget cannot be extended, a period reset or a gate changed from here — the user does that in the web interface, when the executing agent hands them the URL of a refusal.',
  ].join(' '),
  previewPolicy: [
    'Checks a mission draft, issuing nothing. Answers `ok`, the `issues` that block it, `uncovered` — the accepted risks outside the user’s authority, per connection —, and `policy`: exactly what the mission could call, with the budget of each risk.',
    'Rules: explicit RiskIds only, no wildcard, no pattern, no "everything" risk; one connection per provider; per connection `trust_levels` alone (they write the policy; `left_out` says what they leave out), or `everything_i_hold: true` alone — only when the user asks for a mission as wide as their authority there; show them the notice `everything-i-hold-expanded` before you issue —, or `policy` with a quota and a rate limit for every risk; an environment-qualified id needs a selected resource labelled with that environment; `period` and `expires_at` are mandatory (`expires_at` may be null).',
    "Resources: `{ scope: 'all' }` (default) — known now, a resource discovered later is not reached, except one the mission itself creates through the gateway; `{ scope: 'selected', resource_refs: [...] }`; `{ scope: 'connection' }` — `all` with `future: true`: use it only when the task operates the whole account, and say so to the user. A set holds one environment: a connection's selection is split per environment, a mixed set is refused (`resource-set-mixed-env`), an unlabelled one where risks depend on it (`resource-unlabelled`).",
    'Call it until `ok` is true, then pass the same draft to `vaubaan__issue_mission`. A risk listed in `uncovered` cannot be obtained here: remove it, or tell the user.',
  ].join(' '),
  issueMission: [
    'Issues a mission from a draft that `vaubaan__preview_policy` accepts. The creator is the user, not you: the mission appears under their name, marked as prepared by the mission making this call, and they alone answer the requests it raises (claims for more budget, approvals of gated actions) in the web interface.',
    'The answer contains `token.secret` — the mission token, shown this once and never again — and `bootstrap_kit`: the environment variable, the MCP configuration and the instruction block to give the agent that will execute the mission. Do not write the token anywhere but where the kit says.',
    "A draft that exceeds the user’s authority is refused whole, with `uncovered`; nothing is narrowed silently. A draft that carries a Vaubaan account is refused (`vaubaan-account-not-allowed`): a mission issued here never prepares missions itself. Issue the narrowest mission that does the task: the mission and its width are visible to the user. The mission stores the explicit list the preview showed, never a macro-action, a trust level or `everything-i-hold`: a later change of the catalog or of the user’s authority does not widen it. `future: true` (or `resources: { scope: 'connection' }`) adds the resources that later appear in each set's environment.",
  ].join(' '),
  rotateMissionToken: [
    'Replaces the token of an active mission that this mission issued (`issued_via.this_mission` in `vaubaan__list_my_missions`): the previous token stops working at once, the mission, its policy, its session and its budget are unchanged.',
    'A mission the user issued in the web interface, or that another mission issued, is refused with `mission-not-issued-here`: the user rotates those themselves. This mission’s own token is never rotated here (`self-not-allowed`).',
    'The answer contains the new `token.secret`, shown this once, and the bootstrap kit.',
    'Use it when a token leaked or was lost. A revoked or expired mission is not rotated: issue a new one. An orphaned mission is not rotated either: it refuses every call until the user’s authority returns, and its token then works again.',
  ].join(' '),
  revokeMission: [
    'Ends one of the user’s missions for good: its token is refused from now on. It cannot be undone; a new mission must be issued.',
    'Use it when the task is finished or the token leaked. An orphaned mission can be revoked too: that closes it for good. It does not touch the user’s connections, shares or other missions. This mission never revokes itself here (`self-not-allowed`): the user does, in the web interface.',
  ].join(' '),
};

/** The JSON Schema of one act's arguments, read from `tool-schemas.json`. */
function schemaOf(act: VaubaanActName): McpToolDeclaration['inputSchema'] {
  const all = schemas as Readonly<Record<string, unknown>>;
  const schema = all[ACT[act]];
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(`${PROVIDER_ID}: tool-schemas.json has no schema for '${ACT[act]}'`);
  }
  const record = schema as Record<string, unknown>;
  if (record.type !== 'object' || typeof record.properties !== 'object') {
    throw new Error(`${PROVIDER_ID}: the schema of '${ACT[act]}' does not describe an object`);
  }
  // The whole document is forwarded (`additionalProperties`, `$defs`…).
  return { ...record, type: 'object' };
}

export const vaubaanTools: readonly McpToolDeclaration[] = (
  Object.keys(TOOL) as VaubaanActName[]
).map((act) => ({ name: TOOL[act], description: DESCRIPTIONS[act], inputSchema: schemaOf(act) }));

/**
 * What each tool does, in a few words a person reads at a glance
 * (`ProviderPlugin.toolTitles`): the head of an approval request in the web
 * interface. For people only: never part of `tools/list`.
 */
export const vaubaanToolTitles: Readonly<Record<string, string>> = {
  [TOOL.listMyConnections]: 'List my accounts',
  [TOOL.getCatalog]: 'Read a service’s risk catalog',
  [TOOL.listMyMissions]: 'List my missions',
  [TOOL.previewPolicy]: 'Preview a mission',
  [TOOL.issueMission]: 'Issue a mission',
  [TOOL.rotateMissionToken]: 'Replace a mission’s key',
  [TOOL.revokeMission]: 'Revoke a mission',
};
