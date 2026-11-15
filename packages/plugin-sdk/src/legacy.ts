/**
 * Plugins built against an SDK older than 0.9.4 say `provider` where this SDK says
 * `service` (ADR one-word-per-thing-account-service-plugin, rename R2): the catalog and the
 * data model name their `provider`, a slice and a resource carry `provider`, a token's
 * expiry may be `provider-reports`. A pinned plugin is one self-contained bundle with its
 * own copy of the SDK, so its objects keep the old field. `fromLegacyPlugin` puts such a
 * plugin in this SDK's words, both ways: what it declares and returns says `service`, and
 * what the host hands it carries `provider` beside `service`, as it reads it. A plugin of
 * this SDK is returned as it is. Removed in 0.10 with the deprecated names.
 *
 * Handbook: docs/handbook/plugin-loading.md.
 */
import type { Resource, Slice } from '@vaubaan/shared';

import type { GitRemoteCapability } from './git/remote.ts';
import type { AccountContext, ClassifyOutcome, ServicePlugin } from './plugin.ts';

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{ provider }` → `{ service }`; an object that already says `service` is kept. */
function serviceOf<T>(value: T): T {
  if (!isRecord(value) || typeof value.provider !== 'string' || value.service !== undefined) {
    return value;
  }
  const { provider, ...rest } = value;
  return { ...rest, service: provider } as T;
}

/** What an old plugin reads: the `service` of this SDK, and the `provider` it knows. */
function withProvider<T>(value: T): T {
  if (!isRecord(value) || typeof value.service !== 'string') return value;
  return { ...value, provider: value.service };
}

function resourcesFor(resources: readonly Resource[]): readonly Resource[] {
  return resources.map(withProvider);
}

function ctxFor<C extends AccountContext>(ctx: C): C {
  const resources = (ctx as Partial<{ resources: readonly Resource[] }>).resources;
  return resources ? { ...ctx, resources: resourcesFor(resources) } : ctx;
}

/** A token expiry the person cannot type: `provider-reports` became `service-reports`. */
function expiryKindsOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expiryKindsOf);
  if (!isRecord(value)) return value;
  const out: Rec = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] =
      key === 'kind' && inner === 'provider-reports' ? 'service-reports' : expiryKindsOf(inner);
  }
  return out;
}

/** True for a plugin whose catalog still names its `provider`. */
export function isLegacyPlugin(plugin: unknown): boolean {
  if (!isRecord(plugin) || !isRecord(plugin.catalog)) return false;
  return plugin.catalog.service === undefined && typeof plugin.catalog.provider === 'string';
}

function legacyGitRemote(remote: GitRemoteCapability): GitRemoteCapability {
  return {
    ...remote,
    upstream: (ctx, repository, access) => remote.upstream(ctxFor(ctx), repository, access),
    review: (ctx, repository, updates) => remote.review(ctxFor(ctx), repository, updates),
    ...(remote.inspectPack
      ? {
          inspectPack: (ctx, repository, updates, objects) =>
            remote.inspectPack?.(ctxFor(ctx), repository, updates, objects) ?? Promise.resolve([]),
        }
      : {}),
    ...(remote.admitPush
      ? {
          admitPush: (ctx, repository, updates) =>
            remote.admitPush?.(ctxFor(ctx), repository, updates) ?? Promise.resolve(null),
        }
      : {}),
  };
}

/**
 * The plugin in this SDK's words. A plugin of this SDK (its catalog names its `service`)
 * comes back unchanged.
 */
export function fromLegacyPlugin(plugin: ServicePlugin): ServicePlugin {
  if (!isLegacyPlugin(plugin)) return plugin;
  const classified = (outcome: ClassifyOutcome): ClassifyOutcome =>
    'slices' in outcome ? { slices: outcome.slices.map(serviceOf) } : outcome;
  return {
    ...plugin,
    catalog: serviceOf(plugin.catalog),
    dataModel: serviceOf(plugin.dataModel),
    credential: expiryKindsOf(plugin.credential) as ServicePlugin['credential'],
    classify: (tool, args, resources, account) =>
      classified(plugin.classify(tool, args, resourcesFor(resources), account)),
    execute: (ctx, tool, args) => plugin.execute(ctxFor(ctx), tool, args),
    discoverResources: async (ctx) => (await plugin.discoverResources(ctx)).map(serviceOf),
    ...(plugin.createdResources
      ? {
          createdResources: (tool, args, result) =>
            (plugin.createdResources?.(tool, args, result) ?? []).map(serviceOf),
        }
      : {}),
    ...(plugin.envOf
      ? {
          envOf: (slice: Slice, resources: readonly Resource[]) =>
            plugin.envOf?.(withProvider(slice), resourcesFor(resources)),
        }
      : {}),
    ...(plugin.refresh
      ? {
          refresh: (ctx) =>
            plugin.refresh?.(ctxFor(ctx)) ?? Promise.reject(new Error('no refresh')),
        }
      : {}),
    ...(plugin.revoke
      ? { revoke: (ctx) => plugin.revoke?.(ctxFor(ctx)) ?? Promise.resolve() }
      : {}),
    ...(plugin.gitRemote ? { gitRemote: legacyGitRemote(plugin.gitRemote) } : {}),
  };
}
