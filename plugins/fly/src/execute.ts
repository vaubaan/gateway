/**
 * Upstream calls of the `fly` provider : the Machines API, and the logs
 * endpoint `fly logs` uses.
 *
 * Handbook : docs/handbook/providers/fly.md.
 *
 * The request is built from what `readFlyCall` returned, never from `args`.
 * Beyond routing, the executor holds these guards ; each declines with an
 * `ExecutorRefusal` before the request it protects :
 *
 *   - the app is still the one discovery saw (same id, same organization)
 *     before any write on it : app names are freed when an app is destroyed ;
 *   - every image a machine is given is pinned by digest and under the
 *     connection's prefixes, read from the credential this time ;
 *   - changing the image of a machine needs, for every volume it mounts, a
 *     snapshot created in the last hour ;
 *   - a volume is restored only from a snapshot or a volume of the same app ;
 *   - secret values never come back : the answers go through an allow-list ;
 *   - `list_apps` answers the apps of the mission only.
 */

import {
  ExecutorRefusal,
  UpstreamAuthError,
  UpstreamHttpError,
  declining,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { META, isDenial, readFlyCall, type FlyCall } from './call.ts';
import { appName, configImageRefusal, imageRefusal, isRecord, pathIdent } from './identifiers.ts';
import { IMAGE_PREFIX_SEPARATOR } from './identifiers.ts';
import { PROVIDER_ID, TOOL } from './identity.ts';
import {
  FLY_API_BASE,
  FLY_LOGS_BASE,
  authorizationOf,
  imagePrefixesOfCredential,
  orgSlugOf,
} from './token.ts';

/** Ceiling of the apps discovery lists. */
export const MAX_DISCOVERED_APPS = 2000;
/** Page size of discovery. */
const DISCOVERY_PAGE = 500;
/** How recent a snapshot must be for an image change on a machine with volumes. */
export const SNAPSHOT_FRESH_MINUTES = 60;
/** Lease taken around a read-modify-write of a machine config. */
const LEASE_TTL_SECONDS = 120;
/** Output of a command, per stream, beyond which it is cut. */
export const EXEC_OUTPUT_MAX = 65536;
/** Volumes looked through when checking that a snapshot belongs to the app. */
const MAX_VOLUMES_SEARCHED = 50;
/** The marker of a value the executor will not show. */
export const REDACTED = '[redacted by Vaubaan]';
/** Fields of a secret the agent may read. */
const SECRET_FIELDS: ReadonlySet<string> = new Set(['name', 'digest', 'created_at', 'updated_at']);

/** The writes that act on an existing app : the app is checked first. */
const APP_WRITES: ReadonlySet<string> = new Set([
  TOOL.destroyApp,
  TOOL.createMachine,
  TOOL.updateMachine,
  TOOL.deployImage,
  TOOL.scaleMachine,
  TOOL.startMachine,
  TOOL.stopMachine,
  TOOL.restartMachine,
  TOOL.suspendMachine,
  TOOL.cordonMachine,
  TOOL.uncordonMachine,
  TOOL.destroyMachine,
  TOOL.execMachine,
  TOOL.createVolume,
  TOOL.extendVolume,
  TOOL.updateVolume,
  TOOL.createSnapshot,
  TOOL.destroyVolume,
  TOOL.setSecrets,
  TOOL.unsetSecret,
  TOOL.allocateIp,
  TOOL.releaseIp,
  TOOL.requestCertificate,
  TOOL.checkCertificate,
  TOOL.removeCertificate,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export function executeFly(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  return declining(async () => {
    const call = readFlyCall(tool, args, ctx.resources);
    if (isDenial(call)) throw new ExecutorRefusal(call.denied);
    if (call.app && APP_WRITES.has(tool)) await checkAppIdentity(ctx, call.app);
    return text(await run(ctx, call));
  });
}

async function run(ctx: ExecuteContext, call: FlyCall): Promise<unknown> {
  const v = call.values;
  switch (call.tool) {
    case TOOL.listRegions:
      return get(ctx, '/platform/regions');
    case TOOL.listApps:
      return listMissionApps(ctx);
    case TOOL.createApp:
      return send(ctx, 'POST', '/apps', {
        name: v.name,
        network: v.network,
        org_slug: orgSlugOf(ctx.credential),
      });
    default:
      return runOnApp(ctx, call, appPathOf(call));
  }
}

async function runOnApp(ctx: ExecuteContext, call: FlyCall, app: string): Promise<unknown> {
  const v = call.values;
  const machine = call.machineId ? `${app}/machines/${call.machineId}` : '';
  const volume = call.volumeId ? `${app}/volumes/${call.volumeId}` : '';
  const certificate = call.hostname ? `${app}/certificates/${call.hostname}` : '';
  switch (call.tool) {
    case TOOL.getApp:
      return get(ctx, app);
    case TOOL.destroyApp:
      await send(ctx, 'DELETE', app);
      return { destroyed: call.app!.ref };

    case TOOL.listMachines:
      return get(ctx, `${app}/machines`, query({ region: v.region }));
    case TOOL.getMachine:
      return get(ctx, machine);
    case TOOL.listMachineEvents:
      return get(ctx, `${machine}/events`, query({ limit: v.limit }));
    case TOOL.listMachineProcesses:
      return get(ctx, `${machine}/ps`);
    case TOOL.waitMachine:
      return get(ctx, `${machine}/wait`, query({ state: v.state, timeout: v.timeout }));
    case TOOL.createMachine:
      checkImages(ctx, v.config);
      return send(ctx, 'POST', `${app}/machines`, {
        config: v.config,
        region: v.region,
        ...(v.name !== undefined ? { name: v.name } : {}),
        ...(v.skip_launch !== undefined ? { skip_launch: v.skip_launch } : {}),
      });
    case TOOL.updateMachine:
      return updateMachine(ctx, call, machine);
    case TOOL.deployImage:
      return replaceInConfig(ctx, call, machine, (config) => ({ ...config, image: v.image }), true);
    case TOOL.scaleMachine:
      return replaceInConfig(
        ctx,
        call,
        machine,
        (config) => ({
          ...config,
          guest: {
            ...(isRecord(config.guest) ? config.guest : {}),
            cpu_kind: v.cpu_kind,
            cpus: v.cpus,
            memory_mb: v.memory_mb,
          },
        }),
        false,
      );
    case TOOL.startMachine:
      return send(ctx, 'POST', `${machine}/start`);
    case TOOL.stopMachine:
      return send(ctx, 'POST', `${machine}/stop`);
    case TOOL.restartMachine:
      return send(ctx, 'POST', `${machine}/restart`);
    case TOOL.suspendMachine:
      return send(ctx, 'POST', `${machine}/suspend`);
    case TOOL.cordonMachine:
      return send(ctx, 'POST', `${machine}/cordon`);
    case TOOL.uncordonMachine:
      return send(ctx, 'POST', `${machine}/uncordon`);
    case TOOL.destroyMachine:
      await send(ctx, 'DELETE', machine);
      return { destroyed: call.machineId };
    case TOOL.execMachine:
      return exec(ctx, call, machine);

    case TOOL.listVolumes:
      return get(ctx, `${app}/volumes`);
    case TOOL.getVolume:
      return get(ctx, volume);
    case TOOL.listSnapshots:
      return get(ctx, `${volume}/snapshots`);
    case TOOL.createVolume:
      await checkRestoreSource(ctx, call, app);
      return send(ctx, 'POST', `${app}/volumes`, { ...v });
    case TOOL.extendVolume:
      return send(ctx, 'PUT', `${volume}/extend`, { size_gb: v.size_gb });
    case TOOL.updateVolume:
      return send(ctx, 'PUT', volume, { ...v });
    case TOOL.createSnapshot:
      await send(ctx, 'POST', `${volume}/snapshots`);
      return { snapshot_requested: call.volumeId };
    case TOOL.destroyVolume:
      return send(ctx, 'DELETE', volume);

    case TOOL.listSecrets:
      return redactSecrets(await get(ctx, `${app}/secrets`));
    case TOOL.setSecrets:
      return redactSecrets(await send(ctx, 'POST', `${app}/secrets`, { values: v.values }));
    case TOOL.unsetSecret:
      return redactSecrets(await send(ctx, 'DELETE', `${app}/secrets/${call.secretNames![0]}`));

    case TOOL.listIps:
      return get(ctx, `${app}/ip_assignments`);
    case TOOL.allocateIp:
      return send(ctx, 'POST', `${app}/ip_assignments`, {
        type: v.type,
        ...(v.region !== undefined ? { region: v.region } : {}),
      });
    case TOOL.releaseIp:
      await send(ctx, 'DELETE', `${app}/ip_assignments/${encodeURIComponent(call.ip!)}`);
      return { released: call.ip };

    case TOOL.listCertificates:
      return get(ctx, `${app}/certificates`);
    case TOOL.getCertificate:
      return get(ctx, certificate);
    case TOOL.requestCertificate:
      return send(ctx, 'POST', `${app}/certificates/acme`, { hostname: call.hostname });
    case TOOL.checkCertificate:
      return send(ctx, 'POST', `${certificate}/check`);
    case TOOL.removeCertificate:
      await send(ctx, 'DELETE', certificate);
      return { removed: call.hostname };

    case TOOL.getLogs:
      return getLogs(ctx, call);
    default:
      throw new ExecutorRefusal(`unknown tool '${call.tool}'`);
  }
}

/** `/apps/<name>` of the resolved app ; the name went through `appName`. */
function appPathOf(call: FlyCall): string {
  const name = call.app ? appName(call.app.ref) : null;
  if (!name) throw new ExecutorRefusal('app: the app of this call is not resolved');
  return `/apps/${name}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

/** The app is still the one discovery recorded : same id, same organization. */
async function checkAppIdentity(ctx: ExecuteContext, app: Resource): Promise<void> {
  const recorded = app.metadata?.[META.appId];
  if (typeof recorded !== 'string' || recorded.length === 0) {
    throw new ExecutorRefusal(
      `app '${app.ref}': no app id is recorded for it — refresh the account's resources`,
    );
  }
  const current = await get(ctx, `/apps/${app.ref}`);
  const org = orgSlugOf(ctx.credential);
  const currentOrg =
    isRecord(current) && isRecord(current.organization) ? current.organization.slug : undefined;
  if (
    !isRecord(current) ||
    current.id !== recorded ||
    (currentOrg !== undefined && currentOrg !== org)
  ) {
    throw new ExecutorRefusal(
      `app '${app.ref}' is no longer the app this account discovered (its id or organization changed) — refresh the account's resources`,
    );
  }
}

/** The image guard, from the credential this time. */
function checkImages(ctx: ExecuteContext, config: unknown): void {
  const prefixes = imagePrefixesOfCredential(ctx.credential);
  if (!prefixes) throw new ExecutorRefusal('the allowed images of this account are malformed');
  const refusal = configImageRefusal(config, prefixes);
  if (refusal) throw new ExecutorRefusal(refusal);
}

/** Every volume `config` mounts has a snapshot created in the last hour. */
async function checkFreshSnapshots(
  ctx: ExecuteContext,
  app: string,
  config: Record<string, unknown>,
): Promise<void> {
  const mounts = Array.isArray(config.mounts) ? config.mounts : [];
  const since = Date.now() - SNAPSHOT_FRESH_MINUTES * 60_000;
  for (const mount of mounts) {
    const volume = isRecord(mount) ? pathIdent(mount.volume) : null;
    if (!volume) throw new ExecutorRefusal('the machine mounts a volume whose id cannot be read');
    const snapshots = await get(ctx, `${app}/volumes/${volume}/snapshots`);
    const fresh =
      Array.isArray(snapshots) &&
      snapshots.some(
        (s) =>
          isRecord(s) &&
          (s.status === undefined || s.status === 'created') &&
          typeof s.created_at === 'string' &&
          Date.parse(s.created_at) >= since,
      );
    if (!fresh) {
      throw new ExecutorRefusal(
        `volume ${volume}: no snapshot created in the last ${SNAPSHOT_FRESH_MINUTES} minutes — ` +
          'call create_snapshot, wait until list_snapshots shows it created, then change the image',
      );
    }
  }
}

/** A restore reads from a snapshot or a volume of this app only. */
async function checkRestoreSource(ctx: ExecuteContext, call: FlyCall, app: string): Promise<void> {
  const { source_volume_id: source, snapshot_id: snapshot } = call.values;
  if (typeof source === 'string') {
    const volume = await get(ctx, `${app}/volumes/${source}`, '', [404]);
    if (!isRecord(volume) || volume.id !== source) {
      throw new ExecutorRefusal(
        `source_volume_id: ${source} is not a volume of app '${call.app!.ref}'`,
      );
    }
  }
  if (typeof snapshot === 'string') {
    const volumes = await get(ctx, `${app}/volumes`);
    const ids = (Array.isArray(volumes) ? volumes : [])
      .map((vol) => (isRecord(vol) ? pathIdent(vol.id) : null))
      .filter((id): id is string => id !== null)
      .slice(0, MAX_VOLUMES_SEARCHED);
    for (const id of ids) {
      const snapshots = await get(ctx, `${app}/volumes/${id}/snapshots`);
      if (Array.isArray(snapshots) && snapshots.some((s) => isRecord(s) && s.id === snapshot)) {
        return;
      }
    }
    throw new ExecutorRefusal(
      `snapshot_id: ${snapshot} is not a snapshot of a volume of app '${call.app!.ref}'`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Machine config changes
// ─────────────────────────────────────────────────────────────────────────────

interface CurrentMachine {
  readonly config: Record<string, unknown>;
  readonly version: string | undefined;
}

async function currentMachine(ctx: ExecuteContext, machine: string): Promise<CurrentMachine> {
  const answer = await get(ctx, machine);
  if (!isRecord(answer) || !isRecord(answer.config)) {
    throw new UpstreamHttpError(`Fly answered GET ${machine} without a config`, 502);
  }
  const version = typeof answer.version === 'string' ? answer.version : undefined;
  return { config: answer.config, version };
}

async function updateMachine(
  ctx: ExecuteContext,
  call: FlyCall,
  machine: string,
): Promise<unknown> {
  checkImages(ctx, call.values.config);
  const now = await currentMachine(ctx, machine);
  const next = call.values.config as Record<string, unknown>;
  if (next.image !== now.config.image) await checkFreshSnapshots(ctx, appPathOf(call), now.config);
  return send(ctx, 'POST', machine, {
    config: next,
    ...(now.version ? { current_version: now.version } : {}),
    ...(call.values.skip_launch !== undefined ? { skip_launch: call.values.skip_launch } : {}),
  });
}

/** Read the config, change one field, write it back under a lease. */
async function replaceInConfig(
  ctx: ExecuteContext,
  call: FlyCall,
  machine: string,
  change: (config: Record<string, unknown>) => Record<string, unknown>,
  imageChange: boolean,
): Promise<unknown> {
  const now = await currentMachine(ctx, machine);
  const next = change(now.config);
  if (imageChange) {
    const prefixes = imagePrefixesOfCredential(ctx.credential);
    const refusal = prefixes
      ? imageRefusal(next.image, prefixes)
      : 'the allowed images of this account are malformed';
    if (refusal) throw new ExecutorRefusal(refusal);
    await checkFreshSnapshots(ctx, appPathOf(call), now.config);
  }
  const lease = await send(ctx, 'POST', `${machine}/lease`, {
    ttl: LEASE_TTL_SECONDS,
    description: 'vaubaan gateway',
  });
  const nonce = isRecord(lease) && typeof lease.nonce === 'string' ? lease.nonce : null;
  if (!nonce)
    throw new UpstreamHttpError(`Fly answered the lease of ${machine} without a nonce`, 502);
  try {
    return await send(
      ctx,
      'POST',
      machine,
      { config: next, ...(now.version ? { current_version: now.version } : {}) },
      { 'fly-machine-lease-nonce': nonce },
    );
  } finally {
    // The lease expires by itself ; a failed release must not hide the update's outcome.
    await send(ctx, 'DELETE', `${machine}/lease`, undefined, {
      'fly-machine-lease-nonce': nonce,
    }).catch(() => undefined);
  }
}

async function exec(ctx: ExecuteContext, call: FlyCall, machine: string): Promise<unknown> {
  const v = call.values;
  const answer = await send(ctx, 'POST', `${machine}/exec`, {
    command: v.command,
    timeout: v.timeout,
    ...(v.stdin !== undefined ? { stdin: v.stdin } : {}),
  });
  if (!isRecord(answer)) return answer;
  const cut = (value: unknown): unknown =>
    typeof value === 'string' && value.length > EXEC_OUTPUT_MAX
      ? `${value.slice(0, EXEC_OUTPUT_MAX)}\n[output cut at ${EXEC_OUTPUT_MAX} characters]`
      : value;
  return { ...answer, stdout: cut(answer.stdout), stderr: cut(answer.stderr) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads with a filter
// ─────────────────────────────────────────────────────────────────────────────

async function listMissionApps(ctx: ExecuteContext): Promise<unknown> {
  const mission = new Set(
    ctx.resources.filter((r) => r.provider === PROVIDER_ID).map((r) => r.ref),
  );
  const apps = await allApps(ctx);
  return { apps: apps.filter((app) => mission.has(app.name)) };
}

/** Secrets as the agent may read them : allow-listed fields, every other value replaced. */
export function redactSecrets(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'secrets' && Array.isArray(value)) out.secrets = value.map(redactSecret);
    else if (key === 'version' || key === 'Version') out[key] = value;
    else out[key] = blank(value) ? value : REDACTED;
  }
  return out;
}

function redactSecret(secret: unknown): unknown {
  if (!isRecord(secret)) return REDACTED;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(secret)) {
    out[key] = SECRET_FIELDS.has(key) || blank(value) ? value : REDACTED;
  }
  return out;
}

function blank(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

async function getLogs(ctx: ExecuteContext, call: FlyCall): Promise<unknown> {
  const v = call.values;
  const url = `${FLY_LOGS_BASE}${appPathOf(call)}/logs${query({
    instance: v.instance,
    region: v.region,
    next_token: v.next_token,
  })}`;
  return fetchJson(ctx, 'GET', url);
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

interface AppDto {
  readonly id: string;
  readonly name: string;
  readonly network?: string;
  readonly organization?: { readonly slug?: string };
}

function isAppDto(x: unknown): x is AppDto {
  return (
    isRecord(x) &&
    typeof x.id === 'string' &&
    x.id.length > 0 &&
    x.id.length <= 64 &&
    typeof x.name === 'string' &&
    (x.network === undefined || typeof x.network === 'string') &&
    (x.organization === undefined || isRecord(x.organization))
  );
}

/** Every app of the connection's organization, page by page, up to the ceiling. */
async function allApps(ctx: ConnectionContext): Promise<AppDto[]> {
  const org = orgSlugOf(ctx.credential);
  const apps: AppDto[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchJson(
      ctx,
      'GET',
      `${FLY_API_BASE}/apps${query({ org_slug: org, limit: DISCOVERY_PAGE, cursor })}`,
    );
    if (!isRecord(page) || !Array.isArray(page.apps) || !page.apps.every(isAppDto)) {
      throw new Error(`${PROVIDER_ID}: unexpected app list (expected { apps: [{ id, name }] })`);
    }
    apps.push(...page.apps);
    cursor =
      typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor && apps.length < MAX_DISCOVERED_APPS);
  return apps.slice(0, MAX_DISCOVERED_APPS);
}

/** One resource per app of the organization. */
export async function discoverFlyResources(ctx: ConnectionContext): Promise<readonly Resource[]> {
  const org = orgSlugOf(ctx.credential);
  const prefixes = imagePrefixesOfCredential(ctx.credential);
  if (!prefixes)
    throw new Error(`${PROVIDER_ID}: the allowed images of this account are malformed`);
  const apps = await allApps(ctx);
  const unusable = apps.find((app) => appName(app.name) === null);
  if (unusable)
    throw new Error(`${PROVIDER_ID}: app name '${unusable.name}' is not a Fly app name`);
  const foreign = apps.find(
    (app) => app.organization?.slug !== undefined && app.organization.slug !== org,
  );
  if (foreign)
    throw new Error(`${PROVIDER_ID}: app '${foreign.name}' is not in the organization '${org}'`);
  return apps.map((app) => ({
    provider: PROVIDER_ID,
    ref: app.name,
    displayName: app.name,
    metadata: {
      [META.appId]: app.id,
      [META.orgSlug]: org,
      [META.network]: app.network ?? '',
      [META.imagePrefixes]: prefixes.join(IMAGE_PREFIX_SEPARATOR),
    },
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

/** A query string from the defined values, built with `URLSearchParams`. */
function query(values: Readonly<Record<string, unknown>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const built = params.toString();
  return built ? `?${built}` : '';
}

function get(
  ctx: ConnectionContext,
  path: string,
  search = '',
  missing: readonly number[] = [],
): Promise<unknown> {
  return fetchJson(ctx, 'GET', `${FLY_API_BASE}${path}${search}`, undefined, {}, missing);
}

function send(
  ctx: ConnectionContext,
  method: string,
  path: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<unknown> {
  return fetchJson(ctx, method, `${FLY_API_BASE}${path}`, body, headers);
}

/**
 * One request. 401 / 403 → `UpstreamAuthError`, another failure →
 * `UpstreamHttpError` ; a status listed in `missing` answers `null` (a lookup
 * whose absence is the answer).
 */
async function fetchJson(
  ctx: ConnectionContext,
  method: string,
  url: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
  missing: readonly number[] = [],
): Promise<unknown> {
  const res = await ctx.fetch(url, {
    method,
    headers: {
      authorization: authorizationOf(ctx.credential),
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const where = url.replace(/\?.*$/, '');
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamAuthError(
      `Fly refused the token for ${method} ${where} (HTTP ${res.status})`,
      res.status,
    );
  }
  if (missing.includes(res.status)) return null;
  if (!res.ok)
    throw new UpstreamHttpError(
      `Fly ${method} ${where} failed with HTTP ${res.status}`,
      res.status,
    );
  const raw = await res.text();
  if (raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function text(payload: unknown): McpToolResult {
  return {
    content: [
      {
        type: 'text',
        text:
          typeof payload === 'string' ? payload : JSON.stringify(payload ?? { ok: true }, null, 2),
      },
    ],
  };
}
