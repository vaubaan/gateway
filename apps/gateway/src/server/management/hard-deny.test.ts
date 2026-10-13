/**
 * The hard deny of the management door, as a matter of structure (spec §4.1
 * bis "what the management surface never exposes, whatever scope is
 * requested"): the module is not *given* anything that answers a request,
 * opens a gate, moves a budget, touches a connection, a share or a group, or
 * executes a tool.
 *
 * Three readings of the same fact:
 *
 *   types     the dependency type of the module names four ports and no
 *             service; the type assertions below fail `tsc` (the `type-check`
 *             step of CI) the day a forbidden handle is added
 *   imports   no source file of the module imports a forbidden module
 *   surface   the tool table is the seven tools, and none belongs to a
 *             forbidden family
 *
 * The fourth reading — the object graph of the door the real composition
 * root builds — is `tests/integration/management/hard-deny.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { AuthorityModule } from '../authority';
import type { SessionService } from '../budget';
import type { ConnectionsModule } from '../connections';
import type { ExecutionModule } from '../execution';
import type { GroupsModule } from '../groups';
import type { MissionService } from '../missions';
import type { RequestsModule } from '../requests';
import type { SharesModule } from '../shares';
import type { Store } from '../store';
import { MANAGEMENT_TOOL_NAMES, MANAGEMENT_TOOLS } from './definitions';
import {
  MANAGEMENT_DEPENDENCIES,
  MANAGEMENT_MISSION_METHODS,
  type ManagementMissions,
  type ManagementModuleDeps,
} from './ports';
import { ManagementTools } from './tools';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every type the module is handed, as one union. */
type Handed = ManagementModuleDeps[keyof ManagementModuleDeps];

/** What must never be among them: the services and stores of the forbidden families. */
type Forbidden =
  | RequestsModule
  | RequestsModule['service']
  | SessionService
  | ExecutionModule
  | ExecutionModule[keyof ExecutionModule]
  | ConnectionsModule
  | ConnectionsModule['service']
  | SharesModule
  | SharesModule['service']
  | GroupsModule
  | GroupsModule['service']
  | AuthorityModule
  | AuthorityModule[keyof AuthorityModule]
  | Store
  | Store[keyof Store]
  | MissionService
  | PluginRegistry;

describe('management door — hard deny, by type', () => {
  it('the module depends on four ports, the build information and a logger, and on nothing else', () => {
    expectTypeOf<keyof ManagementModuleDeps>().toEqualTypeOf<
      'admit' | 'missions' | 'catalog' | 'rateLimit' | 'build' | 'logger'
    >();
    expect([...MANAGEMENT_DEPENDENCIES].sort()).toEqual([
      'admit',
      'build',
      'catalog',
      'logger',
      'missions',
      'rateLimit',
    ]);
  });

  it('no dependency is a service, a module or a repository of a forbidden family', () => {
    // `Extract` keeps the members of `Handed` assignable to a forbidden type: there is none.
    expectTypeOf<Extract<Handed, Forbidden>>().toBeNever();
    // …and the check can fail: the mission service itself would be caught.
    expectTypeOf<Extract<Handed | MissionService, Forbidden>>().not.toBeNever();
    expectTypeOf<Extract<Handed | Store['requests'], Forbidden>>().not.toBeNever();
  });

  it('of the mission service the door holds seven methods: no gate edit, no duplication, no token check', () => {
    expectTypeOf<keyof ManagementMissions>().toEqualTypeOf<
      'issuanceContext' | 'preview' | 'issue' | 'rotate' | 'revoke' | 'list' | 'get'
    >();
    expectTypeOf<ManagementMissions>().not.toHaveProperty('setGate');
    expectTypeOf<ManagementMissions>().not.toHaveProperty('duplicate');
    expectTypeOf<ManagementMissions>().not.toHaveProperty('draftFrom');
    expectTypeOf<ManagementMissions>().not.toHaveProperty('verifyToken');
    expect([...MANAGEMENT_MISSION_METHODS].sort()).toEqual([
      'get',
      'issuanceContext',
      'issue',
      'list',
      'preview',
      'revoke',
      'rotate',
    ]);
  });
});

describe('management door — hard deny, by imports', () => {
  const FORBIDDEN_MODULES = [
    'requests',
    'budget',
    'execution',
    'connections',
    'shares',
    'groups',
    'authority',
    'store',
    'provider-apps',
    'crypto',
    'auth',
    'telemetry',
    'audit',
  ];
  const ALLOWED_MODULES = ['compose/ports', 'config', 'logging', 'missions', 'oauth-as'];

  function importsOf(file: string): string[] {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1] ?? '');
  }

  const sources = readdirSync(HERE).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'testing.ts',
  );

  it('the module has its source files', () => {
    expect(sources.sort()).toEqual([
      'definitions.ts',
      'door.ts',
      'index.ts',
      'output-schemas.ts',
      'ports.ts',
      'tools.ts',
      'views.ts',
    ]);
  });

  it.each(sources)('%s imports no forbidden module, only the allowed ones', (name) => {
    const siblings = importsOf(join(HERE, name)).filter((spec) => spec.startsWith('../'));
    for (const spec of siblings) {
      const target = spec.slice('../'.length);
      expect(
        FORBIDDEN_MODULES.some((module) => target === module || target.startsWith(`${module}/`)),
        `${name} imports ${spec}`,
      ).toBe(false);
      expect(ALLOWED_MODULES, `${name} imports ${spec}`).toContain(target);
    }
  });

  it('the wiring narrows the mission service and the registry, and touches no forbidden module', () => {
    const wiring = importsOf(join(HERE, '../compose/management.ts'));
    const siblings = wiring.filter((spec) => spec.startsWith('../')).map((spec) => spec.slice(3));
    expect(siblings.sort()).toEqual(['config', 'logging', 'management', 'missions', 'oauth-as']);
  });
});

describe('management door — hard deny, by surface', () => {
  // Words that name an act of a forbidden family (spec §4.1 bis), as a tool name would carry them.
  const FORBIDDEN_WORDS = [
    'request',
    'claim',
    'approv',
    'answer',
    'decide',
    'grant',
    'gate',
    'budget',
    'quota',
    'extend',
    'reset',
    'period',
    'connect',
    'share',
    'transfer',
    'group',
    'member',
    'execute',
    'call',
    'invoke',
    'proxy',
  ];

  it('the tool table is the seven tools, in order', () => {
    expect(MANAGEMENT_TOOLS.map((tool) => tool.name)).toEqual([...MANAGEMENT_TOOL_NAMES]);
    expect(MANAGEMENT_TOOL_NAMES).toEqual([
      'list_my_connections',
      'get_catalog',
      'list_my_missions',
      'preview_policy',
      'issue_mission',
      'rotate_mission_token',
      'revoke_mission',
    ]);
  });

  it('no tool is named after an act of a forbidden family', () => {
    for (const tool of MANAGEMENT_TOOLS) {
      // `list_my_connections` reads connections; it is the one name that carries such a word.
      const name = tool.name === 'list_my_connections' ? 'list_my' : tool.name;
      for (const word of FORBIDDEN_WORDS) {
        expect(name.includes(word), `${tool.name} contains "${word}"`).toBe(false);
      }
    }
  });

  it('the class behind the tools has one public method per tool and no other', () => {
    const methods = Object.getOwnPropertyNames(ManagementTools.prototype).filter(
      (name) => name !== 'constructor',
    );
    const camel = (name: string): string =>
      name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    const helpers = ['takeMutation', 'log'];
    expect(methods.filter((name) => !helpers.includes(name)).sort()).toEqual(
      MANAGEMENT_TOOL_NAMES.map(camel).sort(),
    );
  });

  it('mutations are exactly issue, rotate and revoke, and say so to the client', () => {
    const mutations = MANAGEMENT_TOOLS.filter((tool) => tool.kind === 'mutation');
    expect(mutations.map((tool) => tool.name)).toEqual([
      'issue_mission',
      'rotate_mission_token',
      'revoke_mission',
    ]);
    for (const tool of MANAGEMENT_TOOLS) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(tool.kind !== 'mutation');
      expect(tool.annotations.openWorldHint, tool.name).toBe(false);
    }
  });
});
