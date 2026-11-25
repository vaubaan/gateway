/**
 * The hard deny of the `vaubaan` plugin, as a matter of structure (spec §4.1
 * bis "what the management tools never do"; ADR
 * platform-management-is-a-plugin-on-the-execution-door): the host module is
 * not *given* anything that answers a request, opens a gate, moves a budget,
 * touches an account, a share or a group, or calls another service's tool.
 *
 * Three readings of the same fact:
 *
 *   types     the dependency type of the module names two ports and a logger
 *             and no service; the type assertions below fail `tsc` (the
 *             `type-check` step of CI) the day a forbidden handle is added
 *   imports   no source file of the module imports a forbidden module
 *   surface   the plugin's tools are the nine acts, and none belongs to a
 *             forbidden family; the ports are those nine and nothing else
 *
 * The fourth reading — the object graph of the ports the real composition
 * root builds — is `tests/integration/vaubaan/hard-deny.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import { ACT, TOOL, vaubaanTools, VAUBAAN_PORT_NAMES } from '@vaubaan/plugin-vaubaan';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { AuthorityModule } from '../authority';
import type { MissionLogService } from '../budget';
import type { AccountsModule } from '../accounts';
import type { ExecutionModule } from '../execution';
import type { GroupsModule } from '../groups';
import type { MissionService } from '../missions';
import type { RequestsModule } from '../requests';
import type { SharesModule } from '../shares';
import type { Store } from '../store';
import { VaubaanActs } from './acts';
import { VaubaanPluginActs } from './plugin-acts';
import {
  VAUBAAN_DEPENDENCIES,
  VAUBAAN_MISSION_METHODS,
  type VaubaanMissions,
  type VaubaanModuleDeps,
  type VaubaanPlugins,
} from './ports';
import type { PluginInstallService } from '../plugins/install-service';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every type the module is handed, as one union. */
type Handed = VaubaanModuleDeps[keyof VaubaanModuleDeps];

/** What must never be among them: the services and stores of the forbidden families. */
type Forbidden =
  | RequestsModule
  | RequestsModule['service']
  | MissionLogService
  | ExecutionModule
  | ExecutionModule[keyof ExecutionModule]
  | AccountsModule
  | AccountsModule['service']
  | SharesModule
  | SharesModule['service']
  | GroupsModule
  | GroupsModule['service']
  | AuthorityModule
  | AuthorityModule[keyof AuthorityModule]
  | Store
  | Store[keyof Store]
  | MissionService
  | PluginRegistry
  | PluginInstallService;

describe('vaubaan plugin — hard deny, by type', () => {
  it('the module depends on three ports and a logger, and on nothing else', () => {
    expectTypeOf<keyof VaubaanModuleDeps>().toEqualTypeOf<
      'missions' | 'catalog' | 'plugins' | 'logger'
    >();
    expect([...VAUBAAN_DEPENDENCIES].sort()).toEqual(['catalog', 'logger', 'missions', 'plugins']);
  });

  it('the plugins port reads, uploads an inert archive and names a page; nothing activates', () => {
    expectTypeOf<keyof VaubaanPlugins>().toEqualTypeOf<
      'isAdministrator' | 'upload' | 'activationUrl' | 'status'
    >();
  });

  it('no dependency is a service, a module or a repository of a forbidden family', () => {
    // `Extract` keeps the members of `Handed` assignable to a forbidden type: there is none.
    expectTypeOf<Extract<Handed, Forbidden>>().toBeNever();
    // …and the check can fail: the mission service itself would be caught.
    expectTypeOf<Extract<Handed | MissionService, Forbidden>>().not.toBeNever();
    expectTypeOf<Extract<Handed | Store['requests'], Forbidden>>().not.toBeNever();
  });

  it('of the mission service the plugin holds ten methods: the creator’s whole edit, but no gate, limit or permission-request path, no duplication, no token check', () => {
    expectTypeOf<keyof VaubaanMissions>().toEqualTypeOf<
      | 'issuanceContext'
      | 'preview'
      | 'issue'
      | 'editView'
      | 'previewEdit'
      | 'edit'
      | 'rotate'
      | 'revoke'
      | 'list'
      | 'get'
    >();
    // The edit is the creator's "Edit mission", judged under their authority and one
    // version in the History (ADR platform-management-is-a-plugin-on-the-execution-door,
    // amendment 2026-11-16); nothing that moves a gate, a limit or answers a request.
    expectTypeOf<VaubaanMissions>().not.toHaveProperty('setGate');
    expectTypeOf<VaubaanMissions>().not.toHaveProperty('setLimits');
    expectTypeOf<VaubaanMissions>().not.toHaveProperty('restore');
    expectTypeOf<VaubaanMissions>().not.toHaveProperty('changePermissions');
    expectTypeOf<VaubaanMissions>().not.toHaveProperty('duplicate');
    expectTypeOf<VaubaanMissions>().not.toHaveProperty('draftFrom');
    expectTypeOf<VaubaanMissions>().not.toHaveProperty('verifyToken');
    expect([...VAUBAAN_MISSION_METHODS].sort()).toEqual([
      'edit',
      'editView',
      'get',
      'issuanceContext',
      'issue',
      'list',
      'preview',
      'previewEdit',
      'revoke',
      'rotate',
    ]);
  });
});

describe('vaubaan plugin — hard deny, by imports', () => {
  const FORBIDDEN_MODULES = [
    'requests',
    'budget',
    'execution',
    'accounts',
    'shares',
    'groups',
    'authority',
    'store',
    'crypto',
    'auth',
    'telemetry',
    'audit',
  ];
  const ALLOWED_MODULES = ['logging', 'missions'];

  function importsOf(file: string): string[] {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1] ?? '');
  }

  const sources = readdirSync(HERE).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );

  it('the module has its source files', () => {
    expect(sources.sort()).toEqual([
      'acts.ts',
      'index.ts',
      'inputs.ts',
      'plugin-acts.ts',
      'ports.ts',
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

  it('the wiring narrows the mission service and the registry, and reaches the door by a type only', () => {
    const wiring = importsOf(join(HERE, '../compose/vaubaan.ts'));
    const siblings = wiring.filter((spec) => spec.startsWith('../')).map((spec) => spec.slice(3));
    expect(siblings.sort()).toEqual([
      'auth/administrators',
      'execution',
      'logging',
      'missions',
      'plugins',
      'plugins/install-service',
      'store',
      'vaubaan',
    ]);
    const source = readFileSync(join(HERE, '../compose/vaubaan.ts'), 'utf8');
    expect(source).toContain("import type { HostComposedExecute } from '../execution';");
    // The services the plugins port closes over are named by a type only: built elsewhere.
    for (const spec of ['auth/administrators', 'plugins', 'plugins/install-service', 'store']) {
      expect(source, spec).toMatch(new RegExp(`import type \\{[^}]*\\} from '\\.\\./${spec}';`));
    }
  });
});

describe('vaubaan plugin — hard deny, by surface', () => {
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
    'limit',
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

  it('the tools are the eleven acts, in order, prefixed `vaubaan__`', () => {
    expect(vaubaanTools.map((tool) => tool.name)).toEqual([
      'vaubaan__list_my_accounts',
      'vaubaan__get_catalog',
      'vaubaan__list_my_missions',
      'vaubaan__preview_policy',
      'vaubaan__issue_mission',
      'vaubaan__rename_mission',
      'vaubaan__edit_mission',
      'vaubaan__rotate_mission_token',
      'vaubaan__revoke_mission',
      'vaubaan__upload_plugin',
      'vaubaan__plugin_status',
    ]);
    expect(Object.values(TOOL)).toEqual(vaubaanTools.map((tool) => tool.name));
    expect([...VAUBAAN_PORT_NAMES].sort()).toEqual(Object.keys(ACT).sort());
  });

  it('no tool is named after an act of a forbidden family', () => {
    for (const act of Object.values(ACT)) {
      // `list_my_accounts` reads accounts; it is the one name that carries such a word.
      const name = act === 'list_my_accounts' ? 'list_my' : act;
      for (const word of FORBIDDEN_WORDS) {
        expect(name.includes(word), `${act} contains "${word}"`).toBe(false);
      }
    }
  });

  it('the classes behind the ports have one public method per act and no other', () => {
    const methods = [VaubaanActs.prototype, VaubaanPluginActs.prototype].flatMap((proto) =>
      Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor'),
    );
    expect(methods.filter((name) => name !== 'log').sort()).toEqual([...VAUBAAN_PORT_NAMES].sort());
  });
});
