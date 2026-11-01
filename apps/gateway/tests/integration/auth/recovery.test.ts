/**
 * Recovery by the master key, loudly (ADR administrators-live-in-the-instance §9): the
 * browser proves it holds the key without sending it — the page's Web Crypto proof is
 * the server's —, a passed proof opens a session that can name one administrator and
 * nothing else, and the naming is audited, mailed to the administrators and shown on
 * every page for thirty days.
 */
import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { keyBytes, proofOf } from '../../../src/components/auth/recovery-proof';
import {
  CHALLENGE_COOKIE,
  RECOVERY_COOKIE,
  recoveryProof,
  SESSION_COOKIE,
} from '../../../src/server/auth';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { memoryStoreDeps } from '../../support/compose/testing';
import { loadInstanceConfig } from '../../../src/server/config';
import { TEST_MASTER_KEY, validEnv } from '../../support/config/testing';

const PUBLIC_URL = 'https://gateway.example.com';

type Jar = Map<string, string>;
const header = (jar: Jar): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function absorb(jar: Jar, res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';');
    const [name, value] = (pair ?? '').split('=');
    if (!name) continue;
    if (attrs.some((a) => a.trim() === 'Max-Age=0') || !value) jar.delete(name.trim());
    else jar.set(name.trim(), value.trim());
  }
}

describe('recovery by the master key', () => {
  let root: GatewayRoot;
  const mails: { to: string; subject: string }[] = [];

  beforeEach(async () => {
    mails.length = 0;
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL, VAUBAAN_ADMIN_EMAILS: undefined }),
        }),
      logWrite: () => undefined,
      mailer: {
        async sendLink() {},
        async sendNotice(input) {
          mails.push({ to: input.to, subject: input.subject });
        },
      },
      ...memoryStoreDeps,
    });
  });
  afterEach(async () => {
    await root.close();
  });

  function post(path: string, jar: Jar, body: string, type: string): Request {
    return new Request(`${PUBLIC_URL}${path}`, {
      method: 'POST',
      headers: { cookie: header(jar), origin: PUBLIC_URL, 'content-type': type },
      body,
    });
  }

  /** The page's steps: a challenge, the proof made with `keyText` in the browser. */
  async function prove(jar: Jar, keyText: string): Promise<Response> {
    const asked = await root.auth.handlers.recoverChallenge(
      post('/api/recover/challenge', jar, '', 'text/plain'),
    );
    absorb(jar, asked);
    const { challenge } = (await asked.json()) as { challenge: string };
    const key = keyBytes(keyText);
    if (!key) throw new Error('not a key');
    const proof = await proofOf(key, PUBLIC_URL, challenge);
    const answered = await root.auth.handlers.recoverProof(
      post('/api/recover/proof', jar, JSON.stringify({ proof }), 'application/json'),
    );
    absorb(jar, answered);
    return answered;
  }

  it('the proof made in the browser with Web Crypto is the one the server computes', async () => {
    const key = keyBytes(TEST_MASTER_KEY)!;
    expect(await proofOf(key, PUBLIC_URL, 'abc')).toBe(recoveryProof(key, PUBLIC_URL, 'abc'));
    // Another origin, another challenge, another key: another proof.
    expect(await proofOf(key, 'https://other.example', 'abc')).not.toBe(
      recoveryProof(key, PUBLIC_URL, 'abc'),
    );
  });

  it('a wrong key is refused, a challenge serves once, and no session opens', async () => {
    const jar: Jar = new Map();
    const wrong = await prove(jar, randomBytes(32).toString('base64'));
    expect(wrong.status).toBe(403);
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
    expect(jar.has(CHALLENGE_COOKIE)).toBe(false);
    // The challenge is spent: the right proof of it is refused afterwards.
    const replay = await root.auth.handlers.recoverProof(
      post('/api/recover/proof', jar, JSON.stringify({ proof: 'x' }), 'application/json'),
    );
    expect(replay.status).toBe(403);
    // Without a recovery session, naming leads back to the page.
    const name = await root.auth.handlers.recoverName(
      post(
        '/api/recover/name',
        jar,
        'kind=email&provider=idp&email=x%40example.com',
        'application/x-www-form-urlencoded',
      ),
    );
    expect(name.headers.get('location')).toBe('/admin/recover');
    expect(await root.store.administrators.count()).toBe(0);
  });

  it('the right key names one administrator, loudly — and only one', async () => {
    // An administrator who lost their way in, and a person to name.
    const lost = await root.store.users.upsertFromIdp({
      issuer: 'https://idp.example.com',
      subject: 'lost',
      email: 'lost@example.com',
    });
    await root.auth.administrators.grantUser(lost.id, 'bootstrap', 'setup');
    const ada = await root.store.users.upsertFromIdp({
      issuer: 'https://idp.example.com',
      subject: 'ada',
      email: 'ada@example.com',
    });

    const jar: Jar = new Map();
    const ok = await prove(jar, TEST_MASTER_KEY);
    expect(ok.status).toBe(200);
    expect(jar.has(RECOVERY_COOKIE)).toBe(true);
    // A recovery session is no web session: it opens no page of the gateway.
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    expect(
      await root.auth.authenticator.authenticate(new Headers({ cookie: header(jar) })),
    ).toBeNull();

    const named = await root.auth.handlers.recoverName(
      post(
        '/api/recover/name',
        jar,
        `kind=user&user=${ada.id}`,
        'application/x-www-form-urlencoded',
      ),
    );
    absorb(jar, named);
    expect(named.headers.get('location')).toMatch(/^\/admin\/recover\?done=/);
    expect(await root.store.administrators.ofUser(ada.id)).toMatchObject({
      origin: 'recovered',
      grantedBy: 'recovery',
    });
    const [entry] = (await root.store.audit.list({ kind: 'admin' })).filter(
      (e) => e.kind === 'admin' && e.act === 'administrator-recovered',
    );
    expect(entry).toMatchObject({ user_id: 'recovery' });
    expect(JSON.stringify(entry)).not.toContain(TEST_MASTER_KEY);
    expect(await root.auth.recovery.banner()).toMatchObject({
      named: { email: 'ada@example.com' },
    });
    // Every administrator is told: the locked-out one and the one just named.
    expect(mails.map((m) => m.to).sort()).toEqual(['ada@example.com', 'lost@example.com']);

    // The session served once.
    const again = await root.auth.handlers.recoverName(
      post(
        '/api/recover/name',
        jar,
        `kind=user&user=${lost.id}`,
        'application/x-www-form-urlencoded',
      ),
    );
    expect(again.headers.get('location')).toBe('/admin/recover');
  });

  it('the banner stays thirty days', async () => {
    await root.store.config.set(
      'recovery.last',
      JSON.stringify({ at: new Date(Date.now() - 31 * 24 * 3600_000).toISOString(), named: {} }),
    );
    expect(await root.auth.recovery.banner()).toBeNull();
    await root.store.config.set(
      'recovery.last',
      JSON.stringify({ at: new Date(Date.now() - 29 * 24 * 3600_000).toISOString(), named: {} }),
    );
    expect(await root.auth.recovery.banner()).not.toBeNull();
  });

  it('naming an address of local accounts hands its account link over, once', async () => {
    await root.auth.providers.save(
      {
        id: 'local',
        kind: 'local',
        name: '',
        issuer: '',
        clientId: '',
        clientSecret: null,
        allowedEmailDomains: [],
        invitationOnly: true,
      },
      'create',
    );
    const jar: Jar = new Map();
    await prove(jar, TEST_MASTER_KEY);
    const named = await root.auth.handlers.recoverName(
      post(
        '/api/recover/name',
        jar,
        'kind=email&provider=local&email=new%40example.com',
        'application/x-www-form-urlencoded',
      ),
    );
    const id = new URL(named.headers.get('location') ?? '', PUBLIC_URL).searchParams.get('done');
    const { takeRecoveryOutcome } = await import('../../../src/server/auth');
    const outcome = await takeRecoveryOutcome(root.sessions, id);
    expect(outcome?.accountLink).toMatch(/\/account\/create\?token=/);
    expect(await takeRecoveryOutcome(root.sessions, id)).toBeNull();
    expect(
      await root.auth.administrators.admits(
        { issuer: 'urn:vaubaan:local:local', subject: 'x', email: 'new@example.com', groups: [] },
        'local',
      ),
    ).toBe(true);
  });
});
