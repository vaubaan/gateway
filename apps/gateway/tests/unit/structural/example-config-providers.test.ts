/**
 * Structural test: the provider-app settings the deployment examples show
 * (`deploy/config/gateway.example.yaml`, `deploy/config/.env.example`) are the
 * ones the shipped plugins take.
 *
 * Nothing is listed by hand here. Which providers take a company app, and
 * under which field names, is derived from the shipped plugin list
 * (`compose/shipped-plugins.ts`) through the provider-app field derivation
 * (`provider-apps/fields.ts`), the way Admin → Provider apps derives its
 * forms. The examples are read with their commented lines: an example is a
 * promise whether or not it is active.
 *
 * An example fails when it names a provider this image does not ship, a
 * provider that takes no app (API key, SSH key), or a field the plugin does
 * not declare; when it shows a provider without one of its required fields;
 * and when a provider that takes an app has no example at all. An
 * experimental plugin may be left out of the examples (it is hidden until
 * the operator opts in); when it is shown, the same rules apply.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';
import { parseProviderEnvName, PROVIDER_ENV_PREFIX } from '../../../src/server/config';
import { appConfigFieldsOf, isRequired } from '../../../src/server/provider-apps/fields';

const CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/config');
const YAML_EXAMPLE = 'gateway.example.yaml';
const ENV_EXAMPLE = '.env.example';

interface AppFields {
  readonly all: readonly string[];
  readonly required: readonly string[];
  readonly experimental: boolean;
}

/** Provider id → the fields of its company app, for the providers that take one. */
const APP_PROVIDERS: ReadonlyMap<string, AppFields> = new Map(
  SHIPPED_PLUGINS.flatMap((plugin) => {
    const fields = appConfigFieldsOf(plugin.credential);
    if (fields.length === 0) return [];
    const entry: AppFields = {
      all: fields.map((f) => f.name),
      required: fields.filter(isRequired).map((f) => f.name),
      experimental: plugin.experimental === true,
    };
    return [[plugin.id, entry] as const];
  }),
);
const SHIPPED_IDS = SHIPPED_PLUGINS.map((plugin) => plugin.id);

/** Provider id → the field names an example shows for it. */
type Shown = ReadonlyMap<string, readonly string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `providers:` block of the YAML example, commented out or not: the block
 * runs from the `providers:` line to the first line that is not indented under
 * it, and one comment marker is removed from each of its lines (a comment
 * inside the block stays a comment).
 */
function yamlProviders(source: string): Shown {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^(# ?)?providers:\s*$/.test(line));
  if (start < 0) return new Map();
  const block: string[] = ['providers:'];
  for (const line of lines.slice(start + 1)) {
    const uncommented = line.replace(/^# ?/, '');
    if (!/^\s+\S/.test(uncommented)) break;
    block.push(uncommented);
  }
  const parsed: unknown = parseYaml(block.join('\n'));
  const providers = isRecord(parsed) && isRecord(parsed.providers) ? parsed.providers : {};
  return new Map(
    Object.entries(providers).map(([id, fields]) => [
      id,
      isRecord(fields) ? Object.keys(fields) : [],
    ]),
  );
}

interface EnvExample {
  readonly shown: Shown;
  /** `VAUBAAN_PROVIDER_*` names that name no provider-app field. */
  readonly unparsed: readonly string[];
}

/** The `VAUBAAN_PROVIDER_<ID>_<FIELD>[_FILE]=` lines of the env example, commented out or not. */
function envProviders(source: string): EnvExample {
  const shown = new Map<string, string[]>();
  const unparsed: string[] = [];
  for (const line of source.split('\n')) {
    const name = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (!name?.startsWith(PROVIDER_ENV_PREFIX)) continue;
    const parsed = parseProviderEnvName(name.replace(/_FILE$/, ''));
    if (!parsed) {
      unparsed.push(name);
      continue;
    }
    shown.set(parsed.providerId, [...(shown.get(parsed.providerId) ?? []), parsed.field]);
  }
  return { shown, unparsed };
}

/** Every way the providers an example shows disagree with the shipped plugins. */
function mismatches(shown: Shown): string[] {
  const problems: string[] = [];
  for (const [id, fields] of shown) {
    if (!SHIPPED_IDS.includes(id)) {
      problems.push(`${id}: not a provider this image ships`);
      continue;
    }
    const app = APP_PROVIDERS.get(id);
    if (!app) {
      problems.push(`${id}: takes no provider app (the user brings the credential)`);
      continue;
    }
    for (const field of fields) {
      if (!app.all.includes(field)) problems.push(`${id}.${field}: not a field of this plugin`);
    }
    for (const field of app.required) {
      if (!fields.includes(field)) problems.push(`${id}.${field}: required, not shown`);
    }
  }
  for (const [id, app] of APP_PROVIDERS) {
    if (!app.experimental && !shown.has(id)) problems.push(`${id}: takes an app, has no example`);
  }
  return problems;
}

describe('the deployment examples show the provider apps the shipped plugins take', () => {
  const yamlExample = readFileSync(resolve(CONFIG_DIR, YAML_EXAMPLE), 'utf8');
  const envExample = readFileSync(resolve(CONFIG_DIR, ENV_EXAMPLE), 'utf8');

  it('derives at least one provider that takes an app and one that does not', () => {
    expect(APP_PROVIDERS.size).toBeGreaterThan(0);
    expect(APP_PROVIDERS.size).toBeLessThan(SHIPPED_IDS.length);
  });

  it(`${YAML_EXAMPLE}: every provider block is one the plugin declares`, () => {
    const shown = yamlProviders(yamlExample);
    expect(shown.size).toBeGreaterThan(0);
    expect(mismatches(shown)).toEqual([]);
  });

  it(`${ENV_EXAMPLE}: every VAUBAAN_PROVIDER_* variable is one the plugin declares`, () => {
    const { shown, unparsed } = envProviders(envExample);
    expect(shown.size).toBeGreaterThan(0);
    expect(unparsed).toEqual([]);
    expect(mismatches(shown)).toEqual([]);
  });

  it('the two examples show the same providers', () => {
    expect([...envProviders(envExample).shown.keys()].sort()).toEqual(
      [...yamlProviders(yamlExample).keys()].sort(),
    );
  });

  describe('the checks themselves', () => {
    const [appProvider, app] = [...APP_PROVIDERS].find(([, a]) => !a.experimental) ?? [];
    const keyProvider = SHIPPED_IDS.find((id) => !APP_PROVIDERS.has(id));
    if (!appProvider || !app || !keyProvider) throw new Error('the shipped plugins changed shape');
    /** A complete example: every stable provider that takes an app, with all its fields. */
    const complete = (): Map<string, readonly string[]> =>
      new Map([...APP_PROVIDERS].filter(([, a]) => !a.experimental).map(([id, a]) => [id, a.all]));

    it('accept a complete example', () => {
      expect(mismatches(complete())).toEqual([]);
    });

    it('refuse a provider that takes no app', () => {
      const shown = complete().set(keyProvider, ['client_id']);
      expect(mismatches(shown)).toEqual([
        `${keyProvider}: takes no provider app (the user brings the credential)`,
      ]);
    });

    it('refuse an unknown provider', () => {
      const shown = complete().set('no-such-provider', ['client_id']);
      expect(mismatches(shown)).toEqual(['no-such-provider: not a provider this image ships']);
    });

    it('refuse a field the plugin does not declare', () => {
      const shown = complete().set(appProvider, [...app.all, 'tenant_id']);
      expect(mismatches(shown)).toEqual([`${appProvider}.tenant_id: not a field of this plugin`]);
    });

    it('refuse a missing provider and a missing required field', () => {
      const missing = complete();
      missing.delete(appProvider);
      expect(mismatches(missing)).toEqual([`${appProvider}: takes an app, has no example`]);

      const required = app.required[0];
      if (!required) throw new Error(`${appProvider} has no required field`);
      const partial = complete().set(
        appProvider,
        app.all.filter((f) => f !== required),
      );
      expect(mismatches(partial)).toEqual([`${appProvider}.${required}: required, not shown`]);
    });

    it('read commented and active lines alike', () => {
      const commented =
        '# providers:\n#   acme:\n#     # a note\n#     client_id: x\n\n# other: 1\n';
      const active = 'providers:\n  acme:\n    client_id: x\nother: 1\n';
      expect([...yamlProviders(commented)]).toEqual([['acme', ['client_id']]]);
      expect([...yamlProviders(active)]).toEqual([['acme', ['client_id']]]);

      const env = envProviders(
        [
          '# VAUBAAN_PROVIDER_CLOUDFLARE_DNS_CLIENT_SECRET_FILE=/run/secrets/x',
          'VAUBAAN_PROVIDER_ACME_APP_ID=1',
          '# VAUBAAN_PROVIDER_ACME_TOKEN=nope',
          '# FIELD is one of CLIENT_ID; see VAUBAAN_PROVIDER_<ID>_<FIELD>',
        ].join('\n'),
      );
      expect([...env.shown]).toEqual([
        ['cloudflare-dns', ['client_secret']],
        ['acme', ['app_id']],
      ]);
      expect(env.unparsed).toEqual(['VAUBAAN_PROVIDER_ACME_TOKEN']);
    });
  });
});
