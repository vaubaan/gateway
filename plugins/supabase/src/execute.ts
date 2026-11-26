/**
 * Upstream calls of the `supabase` service : Management API, per-project
 * data plane, and resource discovery.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 (the credential arrives decrypted
 *        in the context, is used for one call, never returned to the executor).
 * Handbook : docs/handbook/services/supabase.md.
 *
 * Rules :
 *   - every request goes through the SDK's transport, with `fetch` and the
 *     caller's `signal` from the context : `httpJson` for an API that answers
 *     JSON, `upstreamFailure` + `readBoundedText` for a data-plane answer that
 *     may be text. A failure is thrown typed — 401 / 403 `UpstreamAuthError`
 *     (the host tries `refresh`, otherwise marks the account `expired`),
 *     another failed status `UpstreamHttpError`, an answer that is not what
 *     the plugin reads `UpstreamProtocolError` ;
 *   - what this executor declines itself (an unknown tool, a call the
 *     classifier denies) is an `isError` result (`refusalResult`,
 *     `ExecutorRefusal` under `declining`) : nothing failed at the service ;
 *   - the Management API base URL is a fact about the service, hence a
 *     constant of the plugin (`identity.ts`), not configuration of the instance ;
 *   - `execute_sql`, `list_tables` and `list_migrations` go through the
 *     **read-only** query endpoint : Postgres refuses any mutation there,
 *     which is what lets the classifier emit a read slice for opaque SQL ;
 *   - the target project is resolved **once**, by the classifier's own
 *     `resolveProjectRef(args, ctx.resources)` : every URL is built from its
 *     answer, never from `args.project_ref`, so a call reaches the project
 *     its authorised slices name or no project at all ; `list_projects`
 *     sends no request, it answers the mission's projects (`missionProjects`) ;
 *   - every other identifier that lands in a path, a query string, a header
 *     or the SQL text of `list_tables` comes from the classifier's own
 *     `readIdentifiers(tool, args)` / `tableSchemas(args)`, never from
 *     `args` : each is within the grammar of its kind (`identifiers.ts`), so
 *     the request names the function, user, bucket or object the slices
 *     named. A call the classifier denies is refused before any request, the
 *     `service_role` key lookup included.
 *
 * Data plane (GoTrue admin, Storage) : the Management API token cannot call
 * `{ref}.supabase.co/auth/v1/admin` or `/storage/v1`. The plugin fetches the
 * project's `service_role` key through the Management API for the duration of
 * the call and never surfaces it (`get_anon_key` returns the anon key only).
 *
 * Project secrets : the edge-function secrets listing and the auth config
 * answer with secret values ; `redact.ts` replaces each by a fixed marker
 * (allow-list of non-secret fields), so no Supabase read returns one.
 */

import {
  DEFAULT_MAX_ANSWER_BYTES,
  ExecutorRefusal,
  UpstreamProtocolError,
  anyJson,
  declining,
  describeUrl,
  httpJson,
  isList,
  isRecord,
  jsonResult,
  readBoundedText,
  readShape,
  refusalResult,
  upstreamFailure,
  type AccountContext,
  type ExecuteContext,
  type Guard,
  type McpToolResult,
  type Resource,
  type UpstreamIo,
} from '@vaubaan/plugin-sdk';

import {
  branchParentOf,
  classifySupabase,
  missionProjects,
  readIdentifiers,
  resolveProjectRef,
  type ToolIdentifiers,
} from './classify.ts';
import { supabaseBearerOf } from './credential.ts';
import { SERVICE_ID, SUPABASE_API_BASE, TOOL, projectUrl } from './identity.ts';
import { projectRefIdent, tableSchemas } from './identifiers.ts';
import { redactAuthConfig, redactBranchConfig, redactFunctionSecrets } from './redact.ts';
import { SUPABASE_DATA_PLANE_TOOLS, SUPABASE_TOOL_NAMES } from './tools.ts';

/** Upper bound on the resources (projects, then preview branches) one account may expose. */
export const MAX_DISCOVERED_PROJECTS = 200;

/** What a call without an answer body returns to the agent (a `204`, a `DELETE`). */
const NO_CONTENT_PAYLOAD = { ok: true };

const DATA_PLANE_TOOLS: ReadonlySet<string> = new Set(SUPABASE_DATA_PLANE_TOOLS);

// ─────────────────────────────────────────────────────────────────────────────
// ServicePlugin entry points
// ─────────────────────────────────────────────────────────────────────────────

export async function executeSupabase(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  if (!SUPABASE_TOOL_NAMES.has(tool)) return refusalResult(`unknown tool '${tool}'`);
  // What the classifier denies is refused here for the same reason, before
  // any request : a missing SQL text, an identifier outside its grammar, a
  // project outside the mission.
  const classified = classifySupabase(tool, args, ctx.resources);
  if ('denied' in classified) return refusalResult(classified.denied);
  // The mission's projects, from the gateway's resources : no request.
  if (tool === TOOL.listProjects) return jsonResult(missionProjects(ctx.resources));
  // Same functions, same inputs as the classifier : the project and the
  // identifiers the slices named are the ones the request carries.
  const target = resolveProjectRef(args, ctx.resources);
  if ('denied' in target) return refusalResult(target.denied);
  const read = readIdentifiers(tool, args);
  if ('denied' in read) return refusalResult(read.denied);
  const token = supabaseBearerOf(SERVICE_ID, ctx.credential);
  const call: SupabaseCall = {
    io: ctx,
    token,
    projectRef: target.ref,
    branchParent: branchParentOf(target.ref, ctx.resources),
    id: read.id,
  };
  return declining(async () => {
    const payload = DATA_PLANE_TOOLS.has(tool)
      ? await callDataPlane(call, tool, args)
      : await callManagement(call, tool, args);
    return jsonResult(payload ?? NO_CONTENT_PAYLOAD);
  });
}

/** One call, resolved : where it goes and the identifiers it carries. */
interface SupabaseCall {
  readonly io: UpstreamIo;
  /** The account's personal access token : the Management API's bearer. */
  readonly token: string;
  /** The project `resolveProjectRef` answered. */
  readonly projectRef: string;
  /** Its parent project when discovery described it as a preview branch (`branchParentOf`). */
  readonly branchParent: string | null;
  /** The identifiers `readIdentifiers` answered, each within the grammar of its kind. */
  readonly id: ToolIdentifiers;
}

/**
 * One `Resource` per project the token can reach, across every organization
 * of the connected account. The Management API returns the whole list in one
 * answer (no paging) ; the plugin caps it at `MAX_DISCOVERED_PROJECTS` and
 * warns through the logger when the cap truncates. The owner labels `env`
 * on the account page.
 */
export async function discoverSupabaseResources(ctx: AccountContext): Promise<readonly Resource[]> {
  const token = supabaseBearerOf(SERVICE_ID, ctx.credential);
  const [organizations, projects] = await Promise.all([
    managementJson(ctx, token, '/organizations', isRecordList),
    managementJson(ctx, token, '/projects', isRecordList),
  ]);
  const orgNames = new Map<string, string>();
  for (const org of organizations) {
    const name = stringField(org, 'name');
    if (!name) continue;
    for (const key of [stringField(org, 'id'), stringField(org, 'slug')]) {
      if (key) orgNames.set(key, name);
    }
  }
  // A project without a ref names nothing a mission could reach : left out.
  const all = projects.flatMap((project) => {
    const ref = refOf(project);
    return ref === null ? [] : [{ ref, project }];
  });
  // A ref the classifier would refuse is of no use to a mission : say so at
  // account time instead of listing a resource no call can name.
  const unusable = all.find(({ ref }) => projectRefIdent(ref) === null);
  if (unusable) {
    throw new UpstreamProtocolError(
      `${SERVICE_ID}: project ref ${JSON.stringify(unusable.ref)} is not a project ref (a host label)`,
    );
  }
  if (all.length > MAX_DISCOVERED_PROJECTS) {
    ctx.logger?.warn(`${SERVICE_ID}: more projects than the discovery cap, list truncated`, {
      total: all.length,
      cap: MAX_DISCOVERED_PROJECTS,
    });
  }
  const discovered = all.slice(0, MAX_DISCOVERED_PROJECTS).map(({ ref, project }) => {
    const orgKey =
      stringField(project, 'organization_slug') ?? stringField(project, 'organization_id') ?? null;
    const orgName = orgKey ? (orgNames.get(orgKey) ?? orgKey) : null;
    const name = stringField(project, 'name') ?? ref;
    const region = stringField(project, 'region');
    const status = stringField(project, 'status');
    return {
      service: SERVICE_ID,
      ref,
      displayName: orgName ? `${orgName} / ${name}` : name,
      metadata: {
        ...(orgKey ? { organization: orgKey } : {}),
        ...(orgName ? { organization_name: orgName } : {}),
        ...(region ? { region } : {}),
        ...(status ? { status } : {}),
      },
    } satisfies Resource;
  });
  const branches = await discoverBranches(ctx, token, discovered);
  const room = Math.max(0, MAX_DISCOVERED_PROJECTS - discovered.length);
  if (branches.length > room) {
    ctx.logger?.warn(
      `${SERVICE_ID}: more preview branches than the discovery cap, list truncated`,
      {
        total: branches.length,
        cap: room,
      },
    );
  }
  return [...discovered, ...branches.slice(0, room)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview branches (ADR preview-branches-are-discovered-resources)
// ─────────────────────────────────────────────────────────────────────────────

/** How many projects' branches discovery lists at a time. */
const BRANCH_LISTING_CONCURRENCY = 4;

/** One branch of `GET /projects/{ref}/branches`, read field by field. */
interface BranchEntry {
  readonly ref: string;
  readonly isDefault: boolean;
  readonly record: Readonly<Record<string, unknown>>;
}

/** The branches of a project, each with a ref within the ref grammar ; others are left out. */
async function branchesOf(io: UpstreamIo, token: string, ref: string): Promise<BranchEntry[]> {
  const listed = await managementJson(io, token, `/projects/${ref}/branches`, isRecordList);
  return listed.flatMap((record) => {
    const branchRef = projectRefIdent(record.project_ref);
    return branchRef === null
      ? []
      : [{ ref: branchRef, isDefault: record.is_default === true, record }];
  });
}

/** What `list_branches` answers of one branch : no field Supabase may add tomorrow. */
function branchView({ ref, isDefault, record }: BranchEntry): Record<string, unknown> {
  return {
    ref,
    name: record.name ?? null,
    git_branch: record.git_branch ?? null,
    pr_number: record.pr_number ?? null,
    is_default: isDefault,
    persistent: record.persistent === true,
    status: record.status ?? null,
    created_at: record.created_at ?? null,
    updated_at: record.updated_at ?? null,
  };
}

/**
 * The project's branches as resources : every branch but the default one (the
 * project itself), named after the project and the git branch. A branch that
 * lives with one pull request is labelled `preview` by the plugin ; a
 * persistent branch is left for the owner to label. A project whose branches
 * cannot be listed (branching off, a token without the Branching permission)
 * contributes none : the projects are still discovered.
 */
async function discoverBranches(
  ctx: AccountContext,
  token: string,
  projects: readonly Resource[],
): Promise<Resource[]> {
  const found: Resource[][] = [];
  const known = new Set(projects.map((p) => p.ref));
  let failures = 0;
  for (let start = 0; start < projects.length; start += BRANCH_LISTING_CONCURRENCY) {
    const batch = projects.slice(start, start + BRANCH_LISTING_CONCURRENCY);
    const answers = await Promise.allSettled(batch.map((p) => branchesOf(ctx, token, p.ref)));
    answers.forEach((answer, k) => {
      const parent = batch[k];
      if (parent === undefined) return;
      if (answer.status === 'rejected') {
        failures += 1;
        return;
      }
      found.push(
        answer.value
          .filter((b) => !b.isDefault && !known.has(b.ref))
          .map((b) => branchResource(parent, b)),
      );
    });
  }
  if (failures > 0) {
    ctx.logger?.info(`${SERVICE_ID}: preview branches not listed for some projects`, {
      projects: failures,
    });
  }
  return found.flat();
}

function branchResource(parent: Resource, { ref, record }: BranchEntry): Resource {
  const gitBranch = stringField(record, 'git_branch');
  const name = gitBranch ?? stringField(record, 'name') ?? ref;
  const persistent = record.persistent === true;
  const prNumber = typeof record.pr_number === 'number' ? record.pr_number : undefined;
  const status = stringField(record, 'status');
  return {
    service: SERVICE_ID,
    ref,
    displayName: `${parent.displayName} / ${name}`,
    ...(persistent ? {} : { env: PREVIEW_ENV }),
    metadata: {
      ...pick(parent.metadata, ['organization', 'organization_name', 'region']),
      parent_project_ref: parent.ref,
      ...(gitBranch ? { git_branch: gitBranch } : {}),
      ...(prNumber !== undefined ? { pr_number: prNumber } : {}),
      persistent,
      ...(status ? { status } : {}),
    },
  };
}

/** The named fields of a parent's metadata a branch shares (its organization, its region). */
function pick(
  metadata: Readonly<Record<string, unknown>> | undefined,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (metadata?.[key] !== undefined) out[key] = metadata[key];
  return out;
}

/** The environment of a branch that lives with one pull request. */
const PREVIEW_ENV = 'preview';

/**
 * Before deleting or resetting : Supabase lists the call's ref among the
 * branches of the parent discovery named, and not as its default branch. The
 * classifier already refused a resource discovery did not describe as a
 * branch ; this check holds when the description is out of date.
 */
async function confirmBranch(call: SupabaseCall): Promise<void> {
  const parent = call.branchParent;
  if (parent === null) {
    throw new ExecutorRefusal(`project_ref: '${call.projectRef}' is not a preview branch.`);
  }
  const branches = await branchesOf(call.io, call.token, parent);
  const branch = branches.find((b) => b.ref === call.projectRef);
  if (branch === undefined || branch.isDefault) {
    throw new ExecutorRefusal(
      `project_ref: '${call.projectRef}' is not a preview branch of '${parent}' at Supabase now. ${TOOL.listBranches} on '${parent}' lists them.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading Supabase's answers : guards, never casts
// ─────────────────────────────────────────────────────────────────────────────

/** A list of objects : the Management API's organizations, projects and API keys. */
function isRecordList(value: unknown): value is readonly Readonly<Record<string, unknown>>[] {
  return isList(value) && value.every(isRecord);
}

/** The field `key` of an answer's object when it is a string. */
function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** The ref of a listed project : `ref`, else `id` (older answers), when it is a non-empty string. */
function refOf(project: Readonly<Record<string, unknown>>): string | null {
  const ref = project.ref ?? project.id;
  return typeof ref === 'string' && ref.length > 0 ? ref : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Management API
// ─────────────────────────────────────────────────────────────────────────────

/** One Management API call with the personal access token, its JSON answer read through `guard`. */
function managementJson<T>(
  io: UpstreamIo,
  token: string,
  path: string,
  guard: Guard<T>,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  return httpJson(
    io,
    {
      url: `${SUPABASE_API_BASE}${path}`,
      method,
      headers: { authorization: `Bearer ${token}` },
      body,
    },
    guard,
  );
}

/** The Supabase names of the two project keys the plugin reads (`GET /projects/{ref}/api-keys`). */
type ProjectKeyName = 'anon' | 'service_role';

/**
 * One key of the project, read through the Management API. `service_role`
 * serves the data-plane calls and is never returned to the caller.
 */
async function projectKey(call: SupabaseCall, name: ProjectKeyName): Promise<string> {
  const path = `/projects/${call.projectRef}/api-keys`;
  const keys = await managementJson(call.io, call.token, path, isRecordList);
  const key = keys.find((entry) => entry.name === name)?.api_key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new UpstreamProtocolError(`${SERVICE_ID} ${path} returned no '${name}' entry`);
  }
  return key;
}

/**
 * Dispatch one resolved Management API call. The project ref and every
 * `id(…)` went through the classifier's grammars : an opaque id or a slug is
 * one path segment and is interpolated as it is. Nothing that reaches a
 * path, a query string or a header is read from `args`.
 */
async function callManagement(
  call: SupabaseCall,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const { projectRef: ref, id } = call;
  const mgmt = (path: string, method?: string, body?: unknown): Promise<unknown> =>
    managementJson(call.io, call.token, path, anyJson, method, body);
  const readOnlyQuery = (query: string): Promise<unknown> =>
    mgmt(`/projects/${ref}/database/query/read-only`, 'POST', { query });

  switch (tool) {
    // ─── db ─────────────────────────────────────────────────────────────────
    case TOOL.getProject:
      return mgmt(`/projects/${ref}`);
    case TOOL.getAnonKey:
      return { url: projectUrl(ref), anon_key: await projectKey(call, 'anon') };
    case TOOL.listTables: {
      // Schema identifiers only (`tableSchemas`) : no quote, no backslash, so
      // each one is written between quotes as it is.
      const schemas = tableSchemas(args);
      if (schemas === null) throw new ExecutorRefusal('schemas: missing or malformed.');
      const listLiteral = schemas.map((s) => `'${s}'`).join(',');
      return readOnlyQuery(
        `select table_schema, table_name, table_type
        from information_schema.tables
        where table_schema in (${listLiteral})
        order by table_schema, table_name;`,
      );
    }
    case TOOL.listMigrations:
      return readOnlyQuery(
        'select version, name from supabase_migrations.schema_migrations order by version;',
      );
    case TOOL.executeSql:
      return readOnlyQuery(String(args.query));
    case TOOL.getAdvisors:
      return mgmt(`/projects/${ref}/advisors/${id('type')}`);
    case TOOL.applyMigration:
      return mgmt(`/projects/${ref}/database/migrations`, 'POST', {
        name: args.name,
        query: args.query,
      });

    // ─── preview branches ───────────────────────────────────────────────────
    case TOOL.listBranches:
      return (await branchesOf(call.io, call.token, ref)).map(branchView);
    // The branch's database password and JWT secret : `redactBranchConfig` keeps the rest.
    case TOOL.getBranch:
      return redactBranchConfig(await mgmt(`/branches/${ref}`));
    case TOOL.deleteBranch:
      await confirmBranch(call);
      return mgmt(`/branches/${ref}`, 'DELETE');
    case TOOL.resetBranch:
      await confirmBranch(call);
      return mgmt(`/branches/${ref}/reset`, 'POST', {});

    // ─── storage (Management API side) ──────────────────────────────────────
    case TOOL.listBuckets:
      return mgmt(`/projects/${ref}/storage/buckets`);
    case TOOL.getStorageConfig:
      return mgmt(`/projects/${ref}/config/storage`);
    case TOOL.updateStorageConfig:
      return mgmt(`/projects/${ref}/config/storage`, 'PATCH', args.config ?? {});

    // ─── auth (Management API side) ─────────────────────────────────────────
    // The auth config carries the project's OAuth client secrets, SMTP
    // password, hook secrets… : `redactAuthConfig` keeps the settings only.
    case TOOL.getAuthConfig:
      return redactAuthConfig(await mgmt(`/projects/${ref}/config/auth`));
    case TOOL.updateAuthConfig:
      return redactAuthConfig(
        await mgmt(`/projects/${ref}/config/auth`, 'PATCH', args.config ?? {}),
      );
    case TOOL.listSsoProviders:
      return mgmt(`/projects/${ref}/config/auth/sso/providers`);
    case TOOL.getSsoProvider:
      return mgmt(`/projects/${ref}/config/auth/sso/providers/${id('provider_id')}`);
    case TOOL.createSsoProvider:
      return mgmt(`/projects/${ref}/config/auth/sso/providers`, 'POST', bodyOf(args));
    case TOOL.updateSsoProvider:
      return mgmt(
        `/projects/${ref}/config/auth/sso/providers/${id('provider_id')}`,
        'PUT',
        bodyOf(args, ['provider_id']),
      );
    case TOOL.deleteSsoProvider:
      return mgmt(`/projects/${ref}/config/auth/sso/providers/${id('provider_id')}`, 'DELETE');
    case TOOL.listThirdPartyAuth:
      return mgmt(`/projects/${ref}/config/auth/third-party-auth`);
    case TOOL.getThirdPartyAuth:
      return mgmt(`/projects/${ref}/config/auth/third-party-auth/${id('tpa_id')}`);
    case TOOL.createThirdPartyAuth:
      return mgmt(`/projects/${ref}/config/auth/third-party-auth`, 'POST', bodyOf(args));
    case TOOL.deleteThirdPartyAuth:
      return mgmt(`/projects/${ref}/config/auth/third-party-auth/${id('tpa_id')}`, 'DELETE');

    // ─── functions ──────────────────────────────────────────────────────────
    case TOOL.listFunctions:
      return mgmt(`/projects/${ref}/functions`);
    case TOOL.getFunction:
      return mgmt(`/projects/${ref}/functions/${id('function_slug')}`);
    case TOOL.getFunctionBody:
      return mgmt(`/projects/${ref}/functions/${id('function_slug')}/body`);
    case TOOL.createFunction:
      return mgmt(`/projects/${ref}/functions`, 'POST', bodyOf(args));
    case TOOL.updateFunction:
      return mgmt(
        `/projects/${ref}/functions/${id('function_slug')}`,
        'PATCH',
        bodyOf(args, ['function_slug']),
      );
    case TOOL.deleteFunction:
      return mgmt(`/projects/${ref}/functions/${id('function_slug')}`, 'DELETE');
    case TOOL.deployFunction: {
      // The slug travels as a query parameter ; the body describes the bundle.
      const query = new URLSearchParams({ slug: id('slug') }).toString();
      return mgmt(`/projects/${ref}/functions/deploy?${query}`, 'POST', bodyOf(args, ['slug']));
    }
    case TOOL.listFunctionSecrets:
      // Supabase answers `{ name, value, updated_at }` : names and dates only.
      return redactFunctionSecrets(await mgmt(`/projects/${ref}/secrets`));
    case TOOL.createFunctionSecrets:
      return mgmt(`/projects/${ref}/secrets`, 'POST', args.secrets ?? []);
    case TOOL.deleteFunctionSecrets:
      return mgmt(`/projects/${ref}/secrets`, 'DELETE', args.names ?? []);

    default:
      throw new ExecutorRefusal(`unknown tool '${tool}'`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data plane — `{ref}.supabase.co` with the service_role key
// ─────────────────────────────────────────────────────────────────────────────

const NO_CONTENT = 204;

/**
 * One data-plane call with a JSON body (or none). GoTrue and Storage answer
 * JSON, but the plugin has always passed a text answer through as text :
 * the `content-type` decides, and only a JSON answer is parsed.
 */
async function dataPlane(
  call: SupabaseCall,
  serviceRole: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<unknown> {
  const url = `${projectUrl(call.projectRef)}${path}`;
  const what = `${method} ${describeUrl(url)}`;
  const res = await call.io.fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...serviceRoleHeaders(serviceRole),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(call.io.signal ? { signal: call.io.signal } : {}),
  });
  if (!res.ok) throw await upstreamFailure(res, what);
  const text = await readBoundedText(res, DEFAULT_MAX_ANSWER_BYTES, what);
  if (res.status === NO_CONTENT) return null;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.startsWith('application/json')) return text;
  return readShape(parsedJson(text, what), anyJson, what);
}

/** The data plane takes the `service_role` key twice : as the bearer and as the `apikey`. */
function serviceRoleHeaders(serviceRole: string): Record<string, string> {
  return { authorization: `Bearer ${serviceRole}`, apikey: serviceRole };
}

/** A JSON answer's value ; an empty body is `null`, a body that is not JSON a protocol failure. */
function parsedJson(text: string, what: string): unknown {
  if (text.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new UpstreamProtocolError(`${what}: the answer is not JSON`);
  }
}

/**
 * Dispatch one resolved data-plane call. A bucket id and the segments of an
 * object path may hold dots (never dots alone, per their grammar) and are
 * percent-encoded ; the other identifiers are one path segment each.
 */
async function callDataPlane(
  call: SupabaseCall,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const { id } = call;
  const serviceRole = await projectKey(call, 'service_role');
  const data = (path: string, method?: string, body?: unknown): Promise<unknown> =>
    dataPlane(call, serviceRole, path, method, body);

  switch (tool) {
    // ─── auth / users ───────────────────────────────────────────────────────
    case TOOL.listUsers: {
      const query = new URLSearchParams({ page: id('page'), per_page: id('per_page') });
      return data(`/auth/v1/admin/users?${query.toString()}`);
    }
    case TOOL.getUser:
      return data(`/auth/v1/admin/users/${id('user_id')}`);
    case TOOL.createUser:
      return data('/auth/v1/admin/users', 'POST', bodyOf(args));
    case TOOL.updateUser:
      return data(`/auth/v1/admin/users/${id('user_id')}`, 'PUT', bodyOf(args, ['user_id']));
    case TOOL.deleteUser:
      return data(`/auth/v1/admin/users/${id('user_id')}`, 'DELETE');
    case TOOL.generateLink:
      return data('/auth/v1/admin/generate_link', 'POST', bodyOf(args));

    // ─── storage / buckets ──────────────────────────────────────────────────
    case TOOL.createBucket:
      return data('/storage/v1/bucket', 'POST', bodyOf(args));
    case TOOL.updateBucket:
      return data(`/storage/v1/bucket/${enc(id('id'))}`, 'PUT', bodyOf(args, ['id']));
    case TOOL.deleteBucket:
      return data(`/storage/v1/bucket/${enc(id('id'))}`, 'DELETE');

    // ─── storage / objects ──────────────────────────────────────────────────
    case TOOL.listObjects:
      return data(`/storage/v1/object/list/${enc(id('bucket'))}`, 'POST', bodyOf(args, ['bucket']));
    case TOOL.uploadObject:
      // The bytes, not JSON : sent as they are, under the media type the agent named.
      return httpJson(
        call.io,
        {
          url: `${projectUrl(call.projectRef)}${objectPathOf(id)}`,
          method: 'POST',
          headers: {
            ...serviceRoleHeaders(serviceRole),
            'content-type': id('content_type'),
            'x-upsert': args.upsert === true ? 'true' : 'false',
          },
          rawBody: new Uint8Array(Buffer.from(id('content_base64'), 'base64')),
        },
        anyJson,
      );
    case TOOL.deleteObject:
      return data(objectPathOf(id), 'DELETE');
    case TOOL.createSignedUrl: {
      // Bounded by the classifier (`signedUrlTtl`): 1 s to a day, 3600 by default.
      const expiresIn = Number(id('expires_in'));
      return data(
        `/storage/v1/object/sign/${enc(id('bucket'))}/${encodePath(id('path'))}`,
        'POST',
        { expiresIn },
      );
    }
    default:
      throw new ExecutorRefusal(`unknown tool '${tool}'`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The Storage path of the call's object : `/storage/v1/object/{bucket}/{path}`. */
function objectPathOf(id: ToolIdentifiers): string {
  return `/storage/v1/object/${enc(id('bucket'))}/${encodePath(id('path'))}`;
}

/** Percent-encode one dotted path segment the classifier's grammar accepted (never dot-only). */
function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/** Encode a `/`-separated object path, keeping the separators ; no segment is empty or dot-only. */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** Request body from the arguments, minus the path parameters (never body fields). */
function bodyOf(
  args: Readonly<Record<string, unknown>>,
  alsoStrip: readonly string[] = [],
): Record<string, unknown> {
  const drop = new Set<string>(['project_ref', ...alsoStrip]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!drop.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}
