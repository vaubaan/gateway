/**
 * The one reader of a `fly` call : `readFlyCall(tool, args, resources)`
 * checks every identifier and value the call carries and returns them, or
 * the denial. `classify` turns what it returns into slices ; `execute` builds
 * its requests from it and from nothing else (kit step 4, "One reader for both
 * sides"). Pure.
 */

import {
  declaredArgumentsOf,
  isRecord,
  undeclaredArgumentDenial,
  type ClassifyAccount,
  type Resource,
} from '@vaubaan/plugin-sdk';

import {
  appName,
  configImageRefusal,
  hostname,
  imagePrefixesOf,
  imageRefusal,
  ipAddress,
  pathIdent,
  region,
  secretName,
  slug,
  volumeName,
} from './identifiers.ts';
import { ORG_SLUG_FIELD, SERVICE_ID, TOOL } from './identity.ts';
import { flyTools } from './tools.ts';

export interface Denial {
  readonly denied: string;
}

/** Resource metadata keys written by discovery and read here. */
export const META = {
  appId: 'app_id',
  orgSlug: 'org_slug',
  network: 'network',
  imagePrefixes: 'image_prefixes',
} as const;

/** What a call names, every value checked. */
export interface FlyCall {
  readonly tool: string;
  /**
   * The org slug the call is cited under : the account's (its form field),
   * else the one the mission's apps share ; `null` when neither says it (the
   * slice then says `org[*]`).
   */
  readonly org: string | null;
  /** The resolved app : a resource of the mission. Absent for org-level tools. */
  readonly app?: Resource;
  readonly machineId?: string;
  readonly volumeId?: string;
  readonly hostname?: string;
  readonly ip?: string;
  /** Secret names written by the call (sorted, unique). */
  readonly secretNames?: readonly string[];
  /** Validated scalar and object values, keyed by the API field they become. */
  readonly values: Readonly<Record<string, unknown>>;
}

const DECLARED = declaredArgumentsOf(flyTools);
const TOOLS: ReadonlySet<string> = new Set(Object.values(TOOL));

/** Tools that name no app : the organization's own. */
const ORG_TOOLS: ReadonlySet<string> = new Set([TOOL.listRegions, TOOL.listApps, TOOL.createApp]);

const MACHINE_TOOLS: ReadonlySet<string> = new Set([
  TOOL.getMachine,
  TOOL.listMachineEvents,
  TOOL.listMachineProcesses,
  TOOL.waitMachine,
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
]);

const VOLUME_TOOLS: ReadonlySet<string> = new Set([
  TOOL.getVolume,
  TOOL.listSnapshots,
  TOOL.extendVolume,
  TOOL.updateVolume,
  TOOL.createSnapshot,
  TOOL.destroyVolume,
]);

const CERTIFICATE_TOOLS: ReadonlySet<string> = new Set([
  TOOL.getCertificate,
  TOOL.requestCertificate,
  TOOL.checkCertificate,
  TOOL.removeCertificate,
]);

/** Limits of free-form values. */
export const LIMITS = {
  secretsPerCall: 50,
  secretValueBytes: 65536,
  execArguments: 64,
  execArgumentLength: 4096,
  execStdinLength: 65536,
  execTimeoutSeconds: 60,
  waitTimeoutSeconds: 60,
} as const;

const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LOG_CURSOR = /^[0-9]{1,25}$/;
const WAIT_STATES = ['started', 'stopped', 'suspended', 'destroyed'] as const;
const CPU_KINDS = ['shared', 'performance'] as const;
const IP_TYPES = ['v4', 'v6', 'shared_v4', 'private_v6'] as const;

const deny = (denied: string): Denial => ({ denied });

/** The mission's Fly apps. */
function ownApps(resources: readonly Resource[]): Resource[] {
  return resources.filter((r) => r.service === SERVICE_ID);
}

/**
 * The app a call targets : `args.app` must be a well-formed app name and one
 * of the mission's apps ; absent, the mission's single app ; otherwise a
 * denial. A resource whose ref is not an app name is never used.
 */
export function resolveApp(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): Resource | Denial {
  const own = ownApps(resources);
  if (args.app !== undefined) {
    const name = appName(args.app);
    if (!name) return deny('app: malformed app name');
    const found = own.find((r) => r.ref === name);
    return found ?? deny(`app '${name}' is not an app of this mission`);
  }
  if (own.length === 1) {
    const only = own[0]!;
    return appName(only.ref) ? only : deny('app: the app of this mission is not a Fly app name');
  }
  return deny(
    own.length === 0
      ? 'app: argument missing and the mission has no Fly app'
      : `app: argument missing and the mission has ${own.length} Fly apps — name one`,
  );
}

/** The org slug the mission's apps share, or `null`. */
export function orgOf(resources: readonly Resource[]): string | null {
  const slugs = new Set(ownApps(resources).map((r) => slug(r.metadata?.[META.orgSlug])));
  if (slugs.size !== 1) return null;
  const [only] = [...slugs];
  return only ?? null;
}

/** The org slug the account was made for (a public form field), or `null`. */
export function orgOfAccount(account: ClassifyAccount | undefined): string | null {
  return slug(account?.fields[ORG_SLUG_FIELD]);
}

/** The allowed image prefixes discovery stored on an app, or the refusal. */
export function prefixesOfApp(app: Resource): readonly string[] | Denial {
  const raw = app.metadata?.[META.imagePrefixes];
  const prefixes = raw === undefined ? null : imagePrefixesOf(raw);
  return (
    prefixes ??
    deny(
      `app '${app.ref}': no list of allowed images is recorded for it — refresh the account's resources`,
    )
  );
}

function intIn(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T | null {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

type Values = Record<string, unknown>;

/** An optional value : absent passes, present must read. */
function optional<T>(
  values: Values,
  key: string,
  raw: unknown,
  read: (v: unknown) => T | null,
  denial: string,
): Denial | null {
  if (raw === undefined) return null;
  const value = read(raw);
  if (value === null) return deny(denial);
  values[key] = value;
  return null;
}

const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

export function isDenial(x: unknown): x is Denial {
  return isRecord(x) && typeof x.denied === 'string';
}

/** Reads a call ; see the module comment. */
export function readFlyCall(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
  account?: ClassifyAccount,
): FlyCall | Denial {
  if (!TOOLS.has(tool)) return deny(`unknown tool '${tool}'`);
  const accountOrg = orgOfAccount(account);
  const org = accountOrg ?? orgOf(resources);
  const values: Values = {};

  if (ORG_TOOLS.has(tool)) {
    const undeclared = undeclaredArgumentDenial(DECLARED, tool, args);
    if (undeclared) return deny(undeclared);
    if (tool === TOOL.createApp) {
      const name = appName(args.name);
      if (!name) return deny('name: missing or not a Fly app name (lower case, digits, hyphens)');
      const network = slug(args.network);
      if (!network) {
        return deny(
          'network: required — every app is created on a private network of its own (lower case, digits, hyphens, underscores)',
        );
      }
      values.name = name;
      values.network = network;
    }
    return { tool, org, values };
  }

  const app = resolveApp(args, resources);
  if (isDenial(app)) return app;
  const undeclared = undeclaredArgumentDenial(DECLARED, tool, args);
  if (undeclared) return deny(undeclared);
  // The account's org is the one `execute` sends and checks the app against.
  const appOrg = accountOrg ?? slug(app.metadata?.[META.orgSlug]) ?? org;
  const base = { tool, org: appOrg, app };

  let machineId: string | undefined;
  if (MACHINE_TOOLS.has(tool)) {
    const id = pathIdent(args.machine_id);
    if (!id) return deny('machine_id: missing or malformed');
    machineId = id;
  }
  let volumeId: string | undefined;
  if (VOLUME_TOOLS.has(tool)) {
    const id = pathIdent(args.volume_id);
    if (!id) return deny('volume_id: missing or malformed');
    volumeId = id;
  }
  let host: string | undefined;
  if (CERTIFICATE_TOOLS.has(tool)) {
    const h = hostname(args.hostname);
    if (!h) return deny('hostname: missing or not a lower-case hostname (no wildcard)');
    host = h;
  }
  const ids = {
    ...(machineId ? { machineId } : {}),
    ...(volumeId ? { volumeId } : {}),
    ...(host ? { hostname: host } : {}),
  };

  const problem = readValues(tool, args, app, values);
  if (isDenial(problem)) return problem;
  return { ...base, ...ids, ...problem, values };
}

/** Tool-specific values ; returns extra fields of the call, or a denial. */
function readValues(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  app: Resource,
  values: Values,
): Denial | { readonly secretNames?: readonly string[]; readonly ip?: string } {
  switch (tool) {
    case TOOL.listMachines:
      return optional(values, 'region', args.region, region, 'region: not a Fly region code') ?? {};
    case TOOL.listMachineEvents:
      return (
        optional(values, 'limit', args.limit, (v) => intIn(v, 1, 100), 'limit: 1 to 100') ?? {}
      );
    case TOOL.waitMachine: {
      const state = oneOf(args.state, WAIT_STATES);
      if (!state) return deny(`state: one of ${WAIT_STATES.join(', ')}`);
      values.state = state;
      return (
        optional(
          values,
          'timeout',
          args.timeout,
          (v) => intIn(v, 1, LIMITS.waitTimeoutSeconds),
          `timeout: 1 to ${LIMITS.waitTimeoutSeconds} seconds`,
        ) ?? {}
      );
    }
    case TOOL.createMachine:
    case TOOL.updateMachine: {
      const prefixes = prefixesOfApp(app);
      if (isDenial(prefixes)) return prefixes;
      const refusal = configImageRefusal(args.config, prefixes);
      if (refusal) return deny(refusal);
      values.config = args.config;
      if (tool === TOOL.createMachine) {
        const r = region(args.region);
        if (!r) return deny('region: required, a Fly region code');
        values.region = r;
        const named = optional(
          values,
          'name',
          args.name,
          (v) => (typeof v === 'string' && MACHINE_NAME.test(v) ? v : null),
          'name: lower case, digits, hyphens',
        );
        if (named) return named;
      }
      return (
        optional(values, 'skip_launch', args.skip_launch, bool, 'skip_launch: a boolean') ?? {}
      );
    }
    case TOOL.deployImage: {
      const prefixes = prefixesOfApp(app);
      if (isDenial(prefixes)) return prefixes;
      const refusal = imageRefusal(args.image, prefixes);
      if (refusal) return deny(refusal);
      values.image = args.image;
      return {};
    }
    case TOOL.scaleMachine: {
      const cpuKind = oneOf(args.cpu_kind, CPU_KINDS);
      const cpus = intIn(args.cpus, 1, 16);
      const memory = intIn(args.memory_mb, 256, 131072);
      if (!cpuKind || cpus === null || memory === null) {
        return deny(
          'cpu_kind (shared | performance), cpus (1–16) and memory_mb (256–131072) are required',
        );
      }
      values.cpu_kind = cpuKind;
      values.cpus = cpus;
      values.memory_mb = memory;
      return {};
    }
    case TOOL.execMachine: {
      const command = args.command;
      if (
        !Array.isArray(command) ||
        command.length === 0 ||
        command.length > LIMITS.execArguments ||
        !command.every(
          (part) =>
            typeof part === 'string' && part.length > 0 && part.length <= LIMITS.execArgumentLength,
        )
      ) {
        return deny(
          `command: a list of 1 to ${LIMITS.execArguments} non-empty strings (program, then arguments)`,
        );
      }
      values.command = command;
      const stdin = optional(
        values,
        'stdin',
        args.stdin,
        (v) => (typeof v === 'string' && v.length <= LIMITS.execStdinLength ? v : null),
        `stdin: a string of at most ${LIMITS.execStdinLength} characters`,
      );
      if (stdin) return stdin;
      values.timeout = LIMITS.execTimeoutSeconds;
      return (
        optional(
          values,
          'timeout',
          args.timeout,
          (v) => intIn(v, 1, LIMITS.execTimeoutSeconds),
          `timeout: 1 to ${LIMITS.execTimeoutSeconds} seconds`,
        ) ?? {}
      );
    }
    case TOOL.createVolume: {
      const name = volumeName(args.name);
      const r = region(args.region);
      const size = intIn(args.size_gb, 1, 500);
      if (!name) return deny('name: letters, digits and underscores');
      if (!r) return deny('region: required, a Fly region code');
      if (size === null) return deny('size_gb: 1 to 500');
      Object.assign(values, { name, region: r, size_gb: size });
      if (args.snapshot_id !== undefined && args.source_volume_id !== undefined) {
        return deny('snapshot_id and source_volume_id: give one source, not both');
      }
      return (
        optional(values, 'snapshot_id', args.snapshot_id, pathIdent, 'snapshot_id: malformed') ??
        optional(
          values,
          'source_volume_id',
          args.source_volume_id,
          pathIdent,
          'source_volume_id: malformed',
        ) ??
        backupValues(args, values) ??
        {}
      );
    }
    case TOOL.extendVolume: {
      const size = intIn(args.size_gb, 1, 500);
      if (size === null) return deny('size_gb: 1 to 500');
      values.size_gb = size;
      return {};
    }
    case TOOL.updateVolume: {
      if (args.auto_backup_enabled === undefined && args.snapshot_retention === undefined) {
        return deny('auto_backup_enabled or snapshot_retention: give at least one');
      }
      return backupValues(args, values) ?? {};
    }
    case TOOL.setSecrets: {
      const raw = args.values;
      if (!isRecord(raw)) return deny('values: an object of secret name → value');
      const names = Object.keys(raw);
      if (names.length === 0 || names.length > LIMITS.secretsPerCall) {
        return deny(`values: 1 to ${LIMITS.secretsPerCall} secrets`);
      }
      for (const key of names) {
        if (!secretName(key))
          return deny('values: a secret name is not an environment variable name');
        const value = raw[key];
        if (typeof value !== 'string' || value.length > LIMITS.secretValueBytes) {
          return deny(
            `values: each value is a string of at most ${LIMITS.secretValueBytes} characters`,
          );
        }
      }
      values.values = raw;
      return { secretNames: [...names].sort() };
    }
    case TOOL.unsetSecret: {
      const name = secretName(args.name);
      if (!name) return deny('name: missing or not an environment variable name');
      return { secretNames: [name] };
    }
    case TOOL.allocateIp: {
      const type = oneOf(args.type, IP_TYPES);
      if (!type) return deny(`type: one of ${IP_TYPES.join(', ')}`);
      values.type = type;
      return optional(values, 'region', args.region, region, 'region: not a Fly region code') ?? {};
    }
    case TOOL.releaseIp: {
      const ip = ipAddress(args.ip);
      if (!ip) return deny('ip: missing or not an IP address');
      return { ip };
    }
    case TOOL.getLogs: {
      return (
        optional(values, 'instance', args.machine_id, pathIdent, 'machine_id: malformed') ??
        optional(values, 'region', args.region, region, 'region: not a Fly region code') ??
        optional(
          values,
          'next_token',
          args.next_token,
          (v) => (typeof v === 'string' && LOG_CURSOR.test(v) ? v : null),
          'next_token: the digits of meta.next_token',
        ) ??
        {}
      );
    }
    default:
      return {};
  }
}

function backupValues(args: Readonly<Record<string, unknown>>, values: Values): Denial | null {
  return (
    optional(
      values,
      'auto_backup_enabled',
      args.auto_backup_enabled,
      bool,
      'auto_backup_enabled: a boolean',
    ) ??
    optional(
      values,
      'snapshot_retention',
      args.snapshot_retention,
      (v) => intIn(v, 1, 60),
      'snapshot_retention: 1 to 60 days',
    )
  );
}
