/**
 * Administration › Plugins over HTTP (spec §4.2; ADR
 * plugins-activated-by-an-administrator-on-trial): the forms of the page driven with
 * real requests and web sessions on a store file. An administrator uploads, activates
 * with the plugin's id typed, refuses and restarts; a person who is not an
 * administrator, or a request from another origin, changes nothing; every act is audited.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SDK_VERSION } from '@vaubaan/plugin-sdk';
import { ARCHIVE_MANIFEST_FILE, manifestOfFiles, packArchive } from '@vaubaan/plugin-sdk/archive';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import {
  ARCHIVE_FIELD,
  CONFIRM_FIELD,
  DIGEST_FIELD,
  PLUGIN_ACTIONS,
} from '../../../src/server/plugins/handlers';
import { validEnv } from '../../support/config/testing';

const PUBLIC_URL = 'https://gateway.example.com';
const OPERATOR_EMAIL = 'ops@example.com';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ACME = join(REPO, 'packages/plugin-sdk/tests/fixtures/acme');

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** An archive the upload accepts; its code never runs in this test. */
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

describe('Administration › Plugins over HTTP', () => {
  let dir: string;
  let root: GatewayRoot;
  let restarts = 0;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vbn-install-http-'));
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_PUBLIC_URL: PUBLIC_URL,
            VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL,
            VAUBAAN_STORE_PATH: join(dir, 'gateway.db'),
            VAUBAAN_PLUGINS_ALLOW_UNSIGNED: 'acme',
          }),
        }),
      logWrite: () => undefined,
      requestRestart: () => {
        restarts += 1;
      },
    });
  });

  afterAll(async () => {
    await root.close();
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    restarts = 0;
  });

  async function cookie(as: 'operator' | 'user'): Promise<string> {
    const user = await root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: `idp|${as}`,
      email: as === 'operator' ? OPERATOR_EMAIL : 'dev@example.com',
    });
    const session = await root.auth.sessions.create({
      kind: 'user',
      userId: user.id,
      login: { email: user.email, groups: [] },
    });
    return `${SESSION_COOKIE}=${session.id}`;
  }

  async function post(
    action: string,
    body: FormData,
    options: { as?: 'operator' | 'user'; origin?: string } = {},
  ): Promise<Response> {
    const request = new Request(`${PUBLIC_URL}${action}`, {
      method: 'POST',
      body,
      headers: {
        origin: options.origin ?? PUBLIC_URL,
        cookie: await cookie(options.as ?? 'operator'),
      },
    });
    const handlers = root.pluginInstall.handlers;
    const handler = {
      [PLUGIN_ACTIONS.upload]: handlers.upload,
      [PLUGIN_ACTIONS.activate]: handlers.activate,
      [PLUGIN_ACTIONS.refuse]: handlers.refuse,
      [PLUGIN_ACTIONS.followImage]: handlers.followImage,
      [PLUGIN_ACTIONS.restart]: handlers.restart,
    }[action];
    if (!handler) throw new Error(`no handler for ${action}`);
    return handler(request);
  }

  function uploadForm(bytes: Uint8Array): FormData {
    const form = new FormData();
    form.set(
      ARCHIVE_FIELD,
      new File([new Uint8Array(bytes)], 'acme.tgz', { type: 'application/gzip' }),
    );
    return form;
  }

  function location(response: Response): URL {
    return new URL(response.headers.get('location') ?? '', PUBLIC_URL);
  }

  it('uploads, refuses a wrong confirmation, activates, and restarts, each audited', async () => {
    const uploaded = await post(PLUGIN_ACTIONS.upload, uploadForm(archive('1.0.0')));
    expect(uploaded.status).toBe(303);
    const back = location(uploaded);
    expect(back.pathname).toBe('/admin/plugins');
    expect(back.searchParams.get('done')).toBe('uploaded');
    const digest = back.searchParams.get('version') ?? '';
    expect((await root.store.pluginVersions.get(digest))?.state).toBe('pending');

    const wrong = new FormData();
    wrong.set(DIGEST_FIELD, digest);
    wrong.set(CONFIRM_FIELD, 'acm');
    expect(location(await post(PLUGIN_ACTIONS.activate, wrong)).searchParams.get('problem')).toBe(
      'confirmation-mismatch',
    );
    expect((await root.store.pluginVersions.get(digest))?.state).toBe('pending');

    const right = new FormData();
    right.set(DIGEST_FIELD, digest);
    right.set(CONFIRM_FIELD, 'acme');
    expect(location(await post(PLUGIN_ACTIONS.activate, right)).searchParams.get('done')).toBe(
      'activated',
    );
    expect((await root.store.pluginVersions.get(digest))?.state).toBe('trial');

    const restarted = await post(PLUGIN_ACTIONS.restart, new FormData());
    expect(location(restarted).searchParams.get('done')).toBe('restarting');
    await new Promise((r) => setTimeout(r, 700));
    expect(restarts).toBe(1);

    const acts = (await root.store.audit.list({ kind: 'admin' })).flatMap((e) =>
      e.kind === 'admin' ? [e.act] : [],
    );
    expect(acts).toEqual(
      expect.arrayContaining(['plugin-uploaded', 'plugin-activated', 'instance-restarted']),
    );
  });

  it('refuses a pending version and deletes its files', async () => {
    const back = location(await post(PLUGIN_ACTIONS.upload, uploadForm(archive('2.0.0'))));
    const digest = back.searchParams.get('version') ?? '';
    const form = new FormData();
    form.set(DIGEST_FIELD, digest);
    expect(location(await post(PLUGIN_ACTIONS.refuse, form)).searchParams.get('done')).toBe(
      'refused',
    );
    expect((await root.store.pluginVersions.get(digest))?.state).toBe('refused');
  });

  it('says what is wrong with an archive that is not one', async () => {
    const back = location(await post(PLUGIN_ACTIONS.upload, uploadForm(encode('not a tgz'))));
    expect(back.searchParams.get('problem')).toBe('archive-invalid');
  });

  it('changes nothing for a person who is not an administrator, or from another origin', async () => {
    const before = (await root.store.pluginVersions.list()).length;
    const asUser = await post(PLUGIN_ACTIONS.upload, uploadForm(archive('3.0.0')), { as: 'user' });
    expect(asUser.status).toBeGreaterThanOrEqual(400);
    const foreign = await post(PLUGIN_ACTIONS.upload, uploadForm(archive('3.0.1')), {
      origin: 'https://evil.example',
    });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    const restart = await post(PLUGIN_ACTIONS.restart, new FormData(), { as: 'user' });
    expect(restart.status).toBeGreaterThanOrEqual(400);
    await new Promise((r) => setTimeout(r, 700));
    expect(restarts).toBe(0);
    expect((await root.store.pluginVersions.list()).length).toBe(before);
  });

  it('lets an agent on an administrator’s mission upload, inert, and read the status', async () => {
    const ops = await root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|operator',
      email: OPERATOR_EMAIL,
    });
    const caller = { missionId: 'mission-plugins', userId: ops.id, holderUserId: ops.id };
    const uploaded = await root.vaubaan.ports.uploadPlugin(caller, {
      archive_base64: Buffer.from(archive('4.0.0')).toString('base64'),
    });
    expect(uploaded.ok).toBe(true);
    const data = (uploaded as { ok: true; data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ plugin: 'acme', version: '4.0.0', state: 'pending' });
    expect(String(data.activation_url)).toBe(
      `${PUBLIC_URL}/admin/plugins#version-${String(data.digest)}`,
    );
    const version = await root.store.pluginVersions.get(String(data.digest));
    expect(version).toMatchObject({ state: 'pending', viaMissionId: 'mission-plugins' });

    const status = await root.vaubaan.ports.pluginStatus(caller, {});
    expect(status.ok).toBe(true);
    expect(JSON.stringify(status)).toContain(String(data.digest));
  });

  it('refuses both tools to a mission whose creator is not an administrator', async () => {
    const dev = await root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|user',
      email: 'dev@example.com',
    });
    const caller = { missionId: 'mission-dev', userId: dev.id, holderUserId: dev.id };
    for (const answer of [
      await root.vaubaan.ports.uploadPlugin(caller, {
        archive_base64: Buffer.from(archive('5.0.0')).toString('base64'),
      }),
      await root.vaubaan.ports.pluginStatus(caller, {}),
    ]) {
      expect(answer).toMatchObject({ ok: false, refusal: { code: 'administrator-only' } });
    }
  });
});
