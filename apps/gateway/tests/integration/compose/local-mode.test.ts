/**
 * Local mode on a real data directory (ADR local-mode-for-an-instance-on-this-computer):
 * the switch alone starts an instance, which makes its bootstrap token, prints the setup
 * link while the setup is open, and writes cookies a browser keeps on http://localhost.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BOOTSTRAP_REVOKED_KEY } from '../../../src/server/auth/bootstrap';
import { startInstance } from '../../../src/server/compose/boot';
import { getRoot, resetRoot } from '../../../src/server/compose/root';
import { publishedLocalMode } from '../../../src/server/http/local-mode';
import { MASTER_KEY_GENERATED_KEY } from '../../../src/server/master-key';
import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';

const LINK = /http:\/\/localhost:3000\/admin\/bootstrap#token=([A-Za-z0-9_-]{43})/;

describe('local mode', () => {
  let dir: string;
  let env: Record<string, string>;
  let printed: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vbn-local-'));
    // What `/data` is in the image; everything else comes from the switch.
    env = {
      NODE_ENV: 'production',
      VAUBAAN_LOCAL: 'true',
      VAUBAAN_STORE_PATH: join(dir, 'gateway.db'),
      VAUBAAN_MASTER_KEY_FILE: join(dir, 'master.key'),
      VAUBAAN_MASTER_KEY_GENERATE: 'true',
      VAUBAAN_UPDATES_CHECK: 'false',
    };
    printed = [];
  });

  afterEach(async () => {
    await resetRoot();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start() {
    const state = await startInstance({
      env: { ...env },
      bundled: REPOSITORY_PLUGINS,
      logWrite: () => {},
      stdout: (text) => printed.push(text),
    });
    return { state, root: await getRoot() };
  }

  it('starts with the switch alone and prints a setup link that opens the bootstrap', async () => {
    const { state, root } = await start();
    expect(state).toBe('ready');
    expect(existsSync(join(dir, 'master.key'))).toBe(true);
    expect(root.config.publicUrl.origin).toBe('http://localhost:3000');
    expect(publishedLocalMode()).toBe(true);

    const token = LINK.exec(printed.join(''))?.[1];
    expect(token).toBeDefined();
    expect(root.config.bootstrapToken).toBe(token);
    expect(await root.auth.bootstrap.verify(token ?? '')).toBe(true);
  });

  it('makes a new link at each start, and prints none once the setup is finished', async () => {
    const first = await start();
    const firstToken = LINK.exec(printed.join(''))?.[1];
    await resetRoot();
    printed = [];
    const again = await start();
    const secondToken = LINK.exec(printed.join(''))?.[1];
    expect(secondToken).toBeDefined();
    expect(secondToken).not.toBe(firstToken);
    expect(first.root).not.toBe(again.root);

    await again.root.store.config.set(BOOTSTRAP_REVOKED_KEY, new Date().toISOString());
    await resetRoot();
    printed = [];
    await start();
    expect(printed.join('')).toBe('');
  });

  it('writes its session cookie without Secure, under a plain name', async () => {
    const { root } = await start();
    const { setCookie } = await root.auth.sessions.create({ kind: 'bootstrap' });
    expect(setCookie).toMatch(
      /^vbn_session=[A-Za-z0-9_-]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/,
    );
    const [pair] = setCookie.split(';');
    expect(await root.auth.sessions.read(new Headers({ cookie: pair ?? '' }))).not.toBeNull();
  });

  it('hands over a key it did not write on its first start, as the desktop app gives it', async () => {
    // The desktop app makes the key and passes it on standard input (`/dev/stdin`);
    // a file the instance did not write stands for it here.
    const given = join(dir, 'given.key');
    writeFileSync(given, `${randomBytes(32).toString('base64')}\n`);
    env.VAUBAAN_MASTER_KEY_FILE = given;
    delete env.VAUBAAN_MASTER_KEY_GENERATE;
    const { root } = await start();
    expect(existsSync(join(dir, 'master.key'))).toBe(false);
    expect(await root.store.config.get(MASTER_KEY_GENERATED_KEY)).not.toBeNull();
  });
});
