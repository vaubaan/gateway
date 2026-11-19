/**
 * The rewrapped tools of an account scoped to one project (`project_id`).
 *
 * Handbook : docs/handbook/services/vercel.md (project mode).
 *
 * Vercel's MCP server rejects a token scoped to one project : every
 * `tools/call` answers `401 {"error":"invalid_token"}`, while the REST API
 * accepts the same token without `teamId` (checked live 2026-11-19). In
 * project mode the essential reads are therefore served through the REST API
 * — same tool names, same input schemas, same classification — and every
 * other rewrapped tool is refused before any request (`projectModeRefusal`).
 *
 * Read on Vercel's REST reference and live on 2026-11-19 :
 *   - `GET /v9/projects/{id}` : the project object (redacted by
 *     `project-redact.ts`, like the MCP answer) ;
 *   - `GET /v6/deployments?projectId=…&limit=…&since=…&until=…` :
 *     `{ deployments, pagination: { count, next, prev } }`, `next` being the
 *     `until` of the following page ;
 *   - `GET /v13/deployments/{idOrUrl}` : one deployment (its `env` lists keys,
 *     never values) — the binding lookup already reads it ;
 *   - `GET /v3/deployments/{id}/events?follow=0&direction=backward&limit=N` :
 *     a JSON list of `{ created, type, text, … }`, the newest first ; `limit`
 *     -1 would return every event, so the plugin bounds it itself.
 */

import { ExecutorRefusal, isList, isRecord } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';

/** The rewrapped tools a project-mode account runs through the REST API. */
export const PROJECT_REST_TOOLS: ReadonlySet<string> = new Set([
  TOOL.getProject,
  TOOL.listDeployments,
  TOOL.getDeployment,
  TOOL.getDeploymentBuildLogs,
]);

/** Deployments per `list_deployments` answer ; `pagination.next` reaches the older ones. */
export const LIST_DEPLOYMENTS_LIMIT = 20;

/** Build-log lines : the upstream default, and the most one answer carries. */
export const BUILD_LOGS_DEFAULT_LIMIT = 100;
export const BUILD_LOGS_MAX_LIMIT = 1000;

/** The refusal of a rewrapped tool Vercel's MCP server would answer 401. */
export function projectModeRefusal(tool: string, projectId: string): string {
  return (
    `${tool}: Vercel's MCP server does not accept a token scoped to one project (it answers 401 invalid_token), ` +
    `and this account is scoped to the vercel project '${projectId}'. ` +
    'A team account (token Scope = the team, All Projects) runs this tool.'
  );
}

/** A timestamp argument (ms) as a query value ; absent stays absent, anything else is refused. */
function timestamp(tool: string, name: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ExecutorRefusal(`${tool}: ${name} must be a timestamp in milliseconds.`);
  }
  return String(Math.trunc(value));
}

/** The query of `GET /v6/deployments` for the pinned project. */
export function listDeploymentsQuery(
  projectId: string,
  args: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const query: Record<string, string> = { projectId, limit: String(LIST_DEPLOYMENTS_LIMIT) };
  for (const name of ['since', 'until'] as const) {
    const value = timestamp(TOOL.listDeployments, name, args[name]);
    if (value !== null) query[name] = value;
  }
  return query;
}

/** The query of `GET /v3/deployments/{id}/events` : the newest `limit` events, no streaming. */
export function buildLogsQuery(args: Readonly<Record<string, unknown>>): Record<string, string> {
  const { limit } = args;
  let lines = BUILD_LOGS_DEFAULT_LIMIT;
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
      throw new ExecutorRefusal(`${TOOL.getDeploymentBuildLogs}: limit must be a positive number.`);
    }
    lines = Math.min(Math.trunc(limit), BUILD_LOGS_MAX_LIMIT);
  }
  return { follow: '0', direction: 'backward', limit: String(lines) };
}

/** One build-log line as the tool answers it. */
interface BuildLogLine {
  readonly created: unknown;
  readonly type: unknown;
  readonly text: unknown;
}

/**
 * The events answer, oldest first, each event reduced to its time, type and
 * text (a `payload` of the older event shape included).
 */
export function shapeBuildLogs(
  deploymentId: string,
  answer: unknown,
): { deploymentId: string; lines: BuildLogLine[] } {
  const events = isList(answer) ? answer : [];
  const lines = events.filter(isRecord).map((e) => {
    const payload = isRecord(e.payload) ? e.payload : {};
    return {
      created: e.created ?? payload.created ?? null,
      type: e.type ?? null,
      text: e.text ?? payload.text ?? null,
    };
  });
  return { deploymentId, lines: lines.reverse() };
}
