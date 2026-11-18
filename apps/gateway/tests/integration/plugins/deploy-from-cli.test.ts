/**
 * `vaubaan-plugin deploy` against a real gateway (intent "Deploy a plugin to a gateway";
 * ADR plugins-activated-by-an-administrator-on-trial): the plugin author's command line,
 * its `fetch` wired to the instance's MCP door, hands an archive with the token of a
 * mission on the Vaubaan account. A mission created by an administrator leaves the
 * version pending (nothing activated, the activation URL printed); any other mission, or
 * an unknown token, stores nothing and says why.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '@vaubaan/plugin-cli';
import { SDK_VERSION } from '@vaubaan/plugin-sdk';
import { ARCHIVE_MANIFEST_FILE, manifestOfFiles, packArchive } from '@vaubaan/plugin-sdk/archive';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ADA,
  BOB,
  openVaubaanRig,
  PLATFORM_AUTONOMOUS,
  PUBLIC_URL,
  type VaubaanRig,
} from '../vaubaan/support';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ACME = join(REPO, 'packages/plugin-sdk/tests/fixtures/acme');

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** An archive the upload accepts (unsigned, `acme` allowed so); its code never runs here. */
function archive(version: string): Uint8Array {
  const files = new Map<string, Uint8Array>([
    ['index.js', encode('export default {};\n')],
    [
      'package.json',
      encode(
        JSON.stringify({
          name: '@acme/p',
          version,
          type: 'module',
          exports: { '.': './index.js' },
          peerDependencies: { '@vaubaan/plugin-sdk': `^${SDK_VERSION}` },
        }),
      ),
    ],
    ['risk-catalog.yaml', readFileSync(join(ACME, 'risk-catalog.yaml'))],
  ]);
  files.set(ARCHIVE_MANIFEST_FILE, encode(JSON.stringify(manifestOfFiles(files, 'acme', version))));
  return packArchive(files);
}

interface Deployed {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

describe('vaubaan-plugin deploy — through the MCP door of a real gateway', () => {
  let dir: string;
  let file: string;
  let rig: VaubaanRig;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vbn-deploy-cli-'));
    file = join(dir, 'plugin.tgz');
    writeFileSync(file, archive('1.0.0'));
    rig = await openVaubaanRig({
      env: {
        // The store stays in memory; the installed archives go beside this path.
        VAUBAAN_STORE_PATH: join(dir, 'gateway.db'),
        VAUBAAN_PLUGINS_ALLOW_UNSIGNED: 'acme',
      },
    });
    // Ada administers the instance; Bob does not.
    await rig.root.store.administrators.addUser(rig.seeded.ada.id, {
      grantedBy: 'configuration',
      origin: 'configuration',
    });
  });

  afterEach(async () => {
    await rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** `vaubaan-plugin deploy plugin.tgz --gateway <instance>` with this token. */
  async function deploy(token: string): Promise<Deployed> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(['deploy', file, '--gateway', PUBLIC_URL], {
      cwd: dir,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      env: { VAUBAAN_MISSION_TOKEN: token },
      fetch: (url, init) => rig.root.execution.handlers.mcp(new Request(url, init)),
    });
    return { code, out, err };
  }

  /** A mission on the person's Vaubaan account that accepts the upload ("Install plugins"). */
  async function missionTokenOf(claims: { readonly email: string }): Promise<string> {
    const agent = await rig.agentOf(claims, { ...PLATFORM_AUTONOMOUS, plugins: 'autonomous' });
    await agent.close();
    return agent.token;
  }

  it('a mission created by an administrator deploys the archive: pending, not activated, the activation URL printed, audited', async () => {
    const deployed = await deploy(await missionTokenOf(ADA));

    expect(deployed.err).toEqual([]);
    expect(deployed.code).toBe(0);
    const versions = await rig.root.store.pluginVersions.list();
    expect(versions).toHaveLength(1);
    const [version] = versions;
    expect(version).toMatchObject({ pluginId: 'acme', version: '1.0.0', state: 'pending' });
    expect(rig.root.registry.get('acme')).toBeUndefined();
    const printed = deployed.out.join('\n');
    expect(printed).toContain(`uploaded acme 1.0.0 (${version?.digest})`);
    expect(printed).toMatch(
      new RegExp(`^activate: ${PUBLIC_URL}/\\S*${version?.digest ?? 'none'}`, 'm'),
    );
    const uploaded = await rig.adminEntries('plugin-uploaded');
    expect(uploaded.map((e) => e.object.id)).toEqual([version?.digest]);
  });

  it('a mission whose creator is not an administrator is refused: administrator-only with its hint, nothing stored', async () => {
    const deployed = await deploy(await missionTokenOf(BOB));

    expect(deployed.code).toBe(1);
    const said = deployed.err.join('\n');
    expect(said).toContain('administrator-only');
    expect(said).toContain('Ask an administrator of the instance to issue the mission');
    expect(await rig.root.store.pluginVersions.list()).toEqual([]);
    expect(await rig.adminEntries('plugin-uploaded')).toEqual([]);
  });

  it('a token the gateway does not know is refused with the 401 naming VAUBAAN_MISSION_TOKEN', async () => {
    const deployed = await deploy('vbn_not-a-mission-token');

    expect(deployed.code).toBe(1);
    const said = deployed.err.join('\n');
    expect(said).toContain('401');
    expect(said).toContain('VAUBAAN_MISSION_TOKEN');
    expect(await rig.root.store.pluginVersions.list()).toEqual([]);
  });
});
