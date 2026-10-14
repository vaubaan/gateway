/**
 * The app-permission declaration of a manifest registration: its validation
 * by `definePlugin`, and the readers the host and a plugin share (defaults,
 * a checked choice, the tools a level serves, needs and what covers them).
 */
import { describe, expect, test } from 'vitest';

import {
  accessCovers,
  checkPermissionChoice,
  defaultPermissionChoice,
  missingPermissions,
  NO_ACCESS,
  toolsLostAt,
  unconditionalNeeds,
} from '../../src/app-permissions.ts';
import type { AppManifestRegistration, AppPermission } from '../../src/credential.ts';
import { pluginIssues } from '../../src/define-plugin.ts';
import type { ProviderPlugin } from '../../src/plugin.ts';
import { acmePlugin } from '../fixtures/acme/acme-plugin.ts';

const THINGS: AppPermission = {
  name: 'things',
  label: 'Things',
  description: 'The things.',
  sensitive: 'Write changes every thing.',
  levels: [
    { access: 'read', label: 'Read', tools: ['acme__list_things'] },
    {
      access: 'write',
      label: 'Read and write',
      tools: ['acme__update_thing', 'acme__list_things'],
      onlyWhen: { acme__list_things: 'when listing archived things' },
    },
  ],
};
const BASICS: AppPermission = {
  name: 'basics',
  label: 'Basics',
  description: 'Basic facts.',
  mandatory: true,
  levels: [{ access: 'read', label: 'Read', tools: [] }],
};
const PERMISSIONS = [BASICS, THINGS];

const REGISTRATION: AppManifestRegistration = {
  permissions: PERMISSIONS,
  ownerLoginPattern: '^[a-z]+$',
  nameMaxLength: 34,
  registrationUrl: () => 'https://example.test/settings/apps/new',
  manifestField: 'manifest',
  stateParam: 'state',
  codeParam: 'code',
  buildManifest: (input) => ({ name: input.name }),
  conversionUrl: (code) => `https://api.example.test/conversions/${code}`,
  conversionHeaders: { Accept: 'application/json' },
  registeredApp: () => null,
};

const withRegistration = (manifestRegistration: unknown): ProviderPlugin =>
  ({
    ...acmePlugin,
    credential: {
      kind: 'app-install',
      appConfigFields: [{ name: 'app_id', label: 'App id', secret: false }],
      installUrl: () => 'https://example.test/apps/x/installations/new',
      installationIdParam: 'installation_id',
      manifestRegistration,
    },
  }) as unknown as ProviderPlugin;

describe('definePlugin — manifestRegistration', () => {
  test('a well-formed declaration passes', () => {
    expect(pluginIssues(withRegistration(REGISTRATION))).toEqual([]);
  });

  test('each malformed member is named', () => {
    expect(pluginIssues(withRegistration('yes'))).toEqual([
      'credential.manifestRegistration: expected an object when present',
    ]);
    const issues = pluginIssues(
      withRegistration({
        ...REGISTRATION,
        buildManifest: 'no',
        codeParam: 'state',
        ownerLoginPattern: '(',
        nameMaxLength: 0,
        conversionHeaders: { Authorization: 'Bearer x' },
        permissions: [
          THINGS,
          THINGS,
          { ...BASICS, levels: [] },
          {
            ...BASICS,
            name: 'other',
            levels: [
              { access: 'read', label: 'Read', tools: ['acme__nothing'] },
              {
                access: 'write',
                label: 'Write',
                tools: [],
                onlyWhen: { acme__list_things: 'never' },
              },
            ],
          },
        ],
      }),
    );
    expect(issues).toEqual([
      'credential.manifestRegistration.buildManifest: expected a function',
      'credential.manifestRegistration: stateParam and codeParam must differ',
      'credential.manifestRegistration.ownerLoginPattern: expected a regular expression',
      'credential.manifestRegistration.nameMaxLength: expected a positive integer',
      'credential.manifestRegistration.conversionHeaders: the host sets Authorization itself',
      "credential.manifestRegistration.permissions[1]: 'things' is declared twice",
      'credential.manifestRegistration.permissions[2].levels: expected at least one level',
      "credential.manifestRegistration.permissions[3].read: 'acme__nothing' is not a tool of the plugin",
      "credential.manifestRegistration.permissions[3].write.onlyWhen: 'acme__list_things' must be one of its tools",
    ]);
    expect(pluginIssues(withRegistration({ ...REGISTRATION, permissions: [] }))).toEqual([
      'credential.manifestRegistration.permissions: expected at least one permission',
    ]);
  });
});

describe('reading the declaration', () => {
  test('the default is every highest level', () => {
    expect(defaultPermissionChoice(PERMISSIONS)).toEqual({ basics: 'read', things: 'write' });
  });

  test('a choice keeps the mandatory permission and drops what is not requested', () => {
    expect(checkPermissionChoice(PERMISSIONS, { things: NO_ACCESS })).toEqual({
      ok: true,
      permissions: { basics: 'read' },
    });
    expect(checkPermissionChoice(PERMISSIONS, { things: 'read' })).toEqual({
      ok: true,
      permissions: { basics: 'read', things: 'read' },
    });
  });

  test('a choice outside the declaration is refused, never dropped', () => {
    expect(checkPermissionChoice(PERMISSIONS, { things: 'admin', other: 'read' })).toEqual({
      ok: false,
      problems: [
        "'other' is not a permission this app may request",
        "Things: 'admin' is not one of its levels",
      ],
    });
  });

  test('the tools lost at a level are those of the levels above it', () => {
    expect(toolsLostAt(THINGS, 'write')).toEqual([]);
    expect(toolsLostAt(THINGS, 'read')).toEqual(['acme__update_thing', 'acme__list_things']);
    expect(toolsLostAt(THINGS, NO_ACCESS)).toEqual(['acme__list_things', 'acme__update_thing']);
  });

  test('a higher level covers a lower one, never the reverse', () => {
    expect(accessCovers(THINGS, 'write', 'read')).toBe(true);
    expect(accessCovers(THINGS, 'read', 'write')).toBe(false);
    expect(accessCovers(THINGS, undefined, 'read')).toBe(false);
    expect(accessCovers(THINGS, 'admin', 'read')).toBe(false);
  });

  test('unconditional needs leave out the levels a tool needs only sometimes', () => {
    expect(unconditionalNeeds(PERMISSIONS, 'acme__list_things')).toEqual({ things: 'read' });
    expect(unconditionalNeeds(PERMISSIONS, 'acme__update_thing')).toEqual({ things: 'write' });
  });

  test('missing permissions are listed in declaration order', () => {
    const missing = missingPermissions(
      PERMISSIONS,
      { things: 'write', basics: 'read' },
      { things: 'read' },
    );
    expect(missing.map((m) => `${m.permission.name}:${m.access}`)).toEqual([
      'basics:read',
      'things:write',
    ]);
  });
});
