/**
 * Redaction of the project object returned by `vercel__get_project`,
 * `vercel__list_projects` and `vercel__update_project_settings`.
 *
 * Handbook : docs/handbook/services/vercel.md (projects).
 *
 * SEC 2026-10-15 (re-check H-1). Both tools are priced `vercel.read-account`
 * (`data: metadata`), yet Vercel's project object carries `env[]` with values
 * (`value`, `vsmValue`, `legacyValue`) and `link.deployHooks[].url`, a
 * capability URL that triggers a deploy. The project keeps an **allow-list**
 * of descriptive fields; every other field holding a value is replaced by
 * `REDACTED_VALUE` (a field Vercel adds tomorrow included); `env` entries go
 * through the env-var allow-list of `redact.ts`; `link` keeps its descriptive
 * fields and its deploy hooks without their URL. An answer that is not JSON is
 * replaced whole (`redactProjectResult`): the filter fails closed.
 */
import { isList, isRecord, type McpToolResult } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';
import { isEmpty, REDACTED_VALUE, redactEntry } from './redact.ts';

/**
 * The tools whose answer is a project object. `update_project_settings` is
 * priced `vercel.project-settings-write` (`data: metadata`) and Vercel's PATCH
 * answers with the whole project: the same redaction applies. The settings it
 * writes are all in `PROJECT_PUBLIC_FIELDS`, so the agent reads them back.
 */
export const PROJECT_TOOLS: ReadonlySet<string> = new Set([
  TOOL.getProject,
  TOOL.listProjects,
  TOOL.updateProjectSettings,
]);

/** Fields of a project that describe it. `env` and `link` are filtered on their own. */
export const PROJECT_PUBLIC_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'accountId',
  'framework',
  'createdAt',
  'updatedAt',
  'nodeVersion',
  'buildCommand',
  'devCommand',
  'installCommand',
  'outputDirectory',
  'rootDirectory',
  'directoryListing',
  'publicSource',
  'serverlessFunctionRegion',
  'live',
  'paused',
  'autoAssignCustomDomains',
  'autoExposeSystemEnvs',
  'gitForkProtection',
  'gitLFS',
  'sourceFilesOutsideRootDirectory',
  'skewProtectionMaxAge',
  'latestDeployments',
  'targets',
  'alias',
  'customEnvironments',
]);

/** Fields of `link` (the Git connection) that describe it. */
export const PROJECT_LINK_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'repo',
  'repoId',
  'org',
  'repoOwnerId',
  'productionBranch',
  'createdAt',
  'updatedAt',
  'sourceless',
]);

/** Fields of a deploy hook that describe it; `url` is the capability and is not one. */
export const DEPLOY_HOOK_FIELDS: ReadonlySet<string> = new Set(['id', 'name', 'ref', 'createdAt']);

function keepOnly(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = allowed.has(key) || isEmpty(value) ? value : REDACTED_VALUE;
  }
  return out;
}

function redactLink(link: unknown): unknown {
  if (!isRecord(link)) return isEmpty(link) ? link : REDACTED_VALUE;
  const out = keepOnly(link, PROJECT_LINK_FIELDS);
  if (Array.isArray(link.deployHooks)) {
    out.deployHooks = link.deployHooks.map((hook: unknown) =>
      isRecord(hook) ? keepOnly(hook, DEPLOY_HOOK_FIELDS) : REDACTED_VALUE,
    );
  }
  return out;
}

/** One project object: allow-listed fields, `env` and `link` filtered. */
export function redactProject(project: unknown): unknown {
  if (!isRecord(project)) return isEmpty(project) ? project : REDACTED_VALUE;
  const out = keepOnly(project, PROJECT_PUBLIC_FIELDS);
  if (Array.isArray(project.env)) out.env = project.env.map(redactEntry);
  if ('link' in project) out.link = redactLink(project.link);
  return out;
}

/**
 * The payload of `get_project` or `list_projects`: one project, `{ project }`,
 * `{ projects, pagination }` or a bare list. `pagination` stays as it is; any
 * other wrapper field is redacted.
 */
export function redactProjectPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(redactProject);
  if (!isRecord(payload)) return isEmpty(payload) ? payload : REDACTED_VALUE;
  if (Array.isArray(payload.projects)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'projects' && isList(value)) out.projects = value.map(redactProject);
      else if (key === 'pagination') out.pagination = value;
      else out[key] = isEmpty(value) ? value : REDACTED_VALUE;
    }
    return out;
  }
  if (isRecord(payload.project)) {
    const out = keepOnly(payload, new Set());
    out.project = redactProject(payload.project);
    return out;
  }
  return redactProject(payload);
}

/**
 * The tool result as the upstream MCP server gave it, every text part and the
 * structured content filtered. A text part that is not JSON is replaced whole.
 */
export function redactProjectResult(result: McpToolResult): McpToolResult {
  if (result.isError) return result;
  const content = result.content.map((part) => {
    if (part.type !== 'text') return part;
    let parsed: unknown;
    try {
      parsed = JSON.parse(part.text);
    } catch {
      return { type: 'text' as const, text: REDACTED_VALUE };
    }
    return { type: 'text' as const, text: JSON.stringify(redactProjectPayload(parsed), null, 2) };
  });
  // A record stays a record through `redactProjectPayload` (allow-list, never replaced whole).
  const structured =
    result.structuredContent === undefined
      ? undefined
      : redactProjectPayload(result.structuredContent);
  return { ...result, content, ...(isRecord(structured) ? { structuredContent: structured } : {}) };
}
