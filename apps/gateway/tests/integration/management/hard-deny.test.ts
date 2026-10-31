/**
 * The hard deny of the management door, read off the running instance (spec
 * §4.1 bis): starting from the door the real composition root built, no
 * service, module or repository of the instance is reachable — not the ones
 * that answer requests, move budgets, touch connections, shares and groups or
 * execute tools, and not the mission service itself (which can edit a gate).
 * The door holds ports made of closures (`compose/management.ts`).
 *
 * The types and the imports say the same in
 * `src/server/management/hard-deny.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  managementCatalogOf,
  managementMissionsOf,
  managementRateLimitOf,
} from '../../../src/server/compose/management';
import type { GatewayRoot } from '../../../src/server/compose/root';
import { MANAGEMENT_MISSION_METHODS } from '../../../src/server/management';
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

/** The root's own parts the door may legitimately share. */
const SHARED_WITH_THE_DOOR = new Set(['config', 'configFile', 'logger', 'build', 'startedAt']);

/** Every module, service, handler table and repository of the instance, by name. */
function partsOf(root: GatewayRoot): Map<object, string> {
  const parts = new Map<object, string>();
  for (const [key, value] of Object.entries(root as unknown as Record<string, unknown>)) {
    if (SHARED_WITH_THE_DOOR.has(key) || key === 'management') continue;
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

describe('management door — hard deny, on the object graph of the real root', () => {
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

  it('nothing of the instance is reachable from the door, its tools or its handler', () => {
    const parts = partsOf(root);
    const { door, tools, handlers } = root.management;
    const reached = reachableFrom([door, tools, handlers]);
    // The walk went somewhere: the door, its tools, the closures of its ports.
    expect(reached.has(tools)).toBe(true);
    expect(reached.size).toBeGreaterThan(20);
    const found = [...reached].flatMap((object) => parts.get(object) ?? []);
    expect(found).toEqual([]);
  });

  it('the same walk does find a service where one is held (the gate holds the token verifier)', () => {
    const parts = partsOf(root);
    const found = [...reachableFrom(root.management.gate)].flatMap((o) => parts.get(o) ?? []);
    expect(found).toContain('root.execution.tokens');
  });

  it('the mission port is a frozen object of exactly the seven methods, bound to the service', async () => {
    const port = managementMissionsOf(root.missions.service);
    expect(Object.keys(port).sort()).toEqual([...MANAGEMENT_MISSION_METHODS].sort());
    expect(Object.isFrozen(port)).toBe(true);
    for (const forbidden of ['setGate', 'duplicate', 'draftFrom', 'verifyToken', 'deps']) {
      expect(forbidden in port, forbidden).toBe(false);
    }
    expect(Object.getPrototypeOf(port)).toBe(Object.prototype);
    expect(await port.list({ id: 'nobody' })).toEqual([]);
  });

  it('the catalog port is data: ids, labels and macro-actions of every shipped plugin, and no plugin', () => {
    const catalog = managementCatalogOf(root.registry);
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

  it('the rate-limit port only reaches keys of the door', async () => {
    const keys: string[] = [];
    const port = managementRateLimitOf({
      take: async (key) => {
        keys.push(key);
        return { allowed: true, remaining: 1, retryAfterMs: 0 };
      },
    });
    // A caller cannot address another surface's window, or a mission's per-risk window.
    await port.take('mission:m1:risk:github.read-code', 1, 1000);
    await port.take('delegation:d1', 1, 1000);
    expect(keys).toEqual(['mgmt:mission:m1:risk:github.read-code', 'mgmt:delegation:d1']);
    expect(Object.keys(port)).toEqual(['take']);
  });
});
