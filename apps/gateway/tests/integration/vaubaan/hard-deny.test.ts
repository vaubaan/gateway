/**
 * The hard deny of the `vaubaan` plugin, read off the running instance (spec
 * §4.1 bis; ADR platform-management-is-a-plugin-on-the-execution-door):
 * starting from the ports and the `execute` the real composition root bound,
 * no service, module or repository of the instance is reachable — not the ones
 * that answer requests, move budgets, touch accounts, shares and groups or
 * execute tools, and not the mission service itself (which can edit a gate).
 * The plugin holds ports made of closures (`compose/vaubaan.ts`).
 *
 * The types and the imports say the same in
 * `src/server/vaubaan/hard-deny.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GatewayRoot } from '../../../src/server/compose/root';
import { vaubaanCatalogOf, vaubaanMissionsOf } from '../../../src/server/compose/vaubaan';
import { VAUBAAN_MISSION_METHODS } from '../../../src/server/vaubaan';
import { buildTestRoot } from '../missions/support';

const BUILT_IN_PROTOTYPES = new Set<object>(
  [Object, Function, Array, Map, Set, Date, RegExp, Promise, Error, URL].map(
    (builtIn) => builtIn.prototype as object,
  ),
);

/** Every object and function reachable through properties (not through closures). */
function reachableFrom(start: unknown): Set<object> {
  const seen = new Set<object>();
  const queue: unknown[] = [start];
  while (queue.length > 0) {
    const value = queue.pop();
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (value instanceof Map || value instanceof Set)
      queue.push(...value.keys(), ...value.values());
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor) queue.push(descriptor.value);
    }
    // Class instances carry their methods on their prototype; the language's own
    // prototypes (arrays, maps, functions…) are not part of the instance.
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && !BUILT_IN_PROTOTYPES.has(prototype as object)) queue.push(prototype);
  }
  return seen;
}

/** The root's own parts the plugin may legitimately share. */
const SHARED_WITH_THE_PLUGIN = new Set(['config', 'configFile', 'logger', 'build', 'startedAt']);

/** Every module, service, handler table and repository of the instance, by name. */
function partsOf(root: GatewayRoot): Map<object, string> {
  const parts = new Map<object, string>();
  for (const [key, value] of Object.entries(root as unknown as Record<string, unknown>)) {
    if (SHARED_WITH_THE_PLUGIN.has(key) || key === 'vaubaan') continue;
    if (typeof value !== 'object' || value === null) continue;
    parts.set(value, `root.${key}`);
    for (const [inner, part] of Object.entries(value as Record<string, unknown>)) {
      if (typeof part === 'object' && part !== null && !parts.has(part)) {
        parts.set(part, `root.${key}.${inner}`);
      }
    }
  }
  return parts;
}

describe('vaubaan plugin — hard deny, on the object graph of the real root', () => {
  let root: GatewayRoot;
  beforeEach(async () => {
    root = await buildTestRoot();
  });
  afterEach(() => root.close());

  it('names the forbidden families among the parts it looks for', () => {
    const names = new Set(partsOf(root).values());
    for (const part of [
      'root.requests.service',
      'root.budget',
      'root.execution.door',
      'root.execution.pipeline',
      'root.connections.service',
      'root.connections.credentials',
      'root.shares.service',
      'root.groups.service',
      'root.authority.grounds',
      'root.missions.service',
      'root.store.requests',
      'root.store.sessions',
      'root.store.connections',
      'root.store.shares',
      'root.store.groups',
      'root.store.missions',
      'root.registry',
      'root.rateLimiter',
    ]) {
      expect(names, part).toContain(part);
    }
  });

  it('nothing of the instance is reachable from the ports or the bound execute', () => {
    const parts = partsOf(root);
    const { ports, hostExecutes } = root.vaubaan;
    expect([...hostExecutes.keys()]).toEqual(['vaubaan']);
    const reached = reachableFrom([ports, hostExecutes]);
    // The walk went somewhere: the ports, the execute, their functions.
    expect(reached.has(ports)).toBe(true);
    expect(reached.size).toBeGreaterThan(10);
    const found = [...reached].flatMap((object) => parts.get(object) ?? []);
    expect(found).toEqual([]);
  });

  it('the same walk does find a service where one is held (the door holds the pipeline)', () => {
    const parts = partsOf(root);
    const found = [...reachableFrom(root.execution)].flatMap((o) => parts.get(o) ?? []);
    expect(found).toContain('root.execution.pipeline');
  });

  it('the ports are a frozen object of the seven acts, and nothing else', () => {
    const { ports } = root.vaubaan;
    expect(Object.isFrozen(ports)).toBe(true);
    expect(Object.keys(ports).sort()).toEqual(
      [
        'getCatalog',
        'issueMission',
        'listMyConnections',
        'listMyMissions',
        'previewPolicy',
        'revokeMission',
        'rotateMissionToken',
      ].sort(),
    );
  });

  it('the mission port is a frozen object of exactly the seven methods, bound to the service', async () => {
    const port = vaubaanMissionsOf(root.missions.service);
    expect(Object.keys(port).sort()).toEqual([...VAUBAAN_MISSION_METHODS].sort());
    expect(Object.isFrozen(port)).toBe(true);
    for (const forbidden of ['setGate', 'duplicate', 'draftFrom', 'verifyToken', 'deps']) {
      expect(forbidden in port, forbidden).toBe(false);
    }
    expect(Object.getPrototypeOf(port)).toBe(Object.prototype);
    expect(await port.list({ id: 'nobody' })).toEqual([]);
  });

  it('the catalog port is data: ids, labels and macro-actions of every shipped plugin, and no plugin', () => {
    const catalog = vaubaanCatalogOf(root.registry);
    expect([...catalog.providers()]).toEqual([...root.registry.ids]);
    const reached = reachableFrom(catalog.get('github'));
    for (const id of root.registry.ids) {
      expect(reached.has(root.registry.require(id).plugin), id).toBe(false);
    }
    expect(catalog.get('github')?.risks.length).toBeGreaterThan(5);
    expect(catalog.get('github')?.macro_actions.map((a) => a.id)).toContain('anything-else');
    expect(catalog.get('nope')).toBeNull();
    for (const object of reached) expect(typeof object).not.toBe('function');
  });
});
