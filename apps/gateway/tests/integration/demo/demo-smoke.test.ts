/**
 * Smoke test of the demo mode (handbook demo-mode): the command a human runs,
 * started as they start it and used over real HTTP.
 *
 * `tests/demo/main.ts` is spawned on a port the system picks, with the build
 * already there (`DEMO_SKIP_BUILD=1`). The test then reads the printed tour,
 * signs in as Alice through the demo identity provider — following the
 * redirects of `/auth/login` by hand, with a cookie jar, as a browser does —
 * fetches the cardinal pages and finds a seeded item on each, calls
 * `tools/list` on `/mcp` with the mission token the tour prints, checks the
 * seeded team (Bob, a member of a mission of Alice, and the named token "CI
 * runner") from both sides, and stops the process: it must exit cleanly and
 * leave no data behind.
 *
 * Skipped when `apps/gateway/.next` holds no build; `npm run ci` builds
 * before testing, so it runs there.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { base32Decode, totpCode, totpStepOf } from '../../../src/server/crypto/totp';
import { DEMO_IDP_PATH } from '../../demo/demo-idp';
import { hasBuild } from '../../demo/demo-instance';
import { ALICE, BOB, DEMO_PEOPLE, type DemoPerson } from '../../demo/people';
import { CI_TOKEN_NAME } from '../../demo/seed';
import { DEMO_BANNER } from '../../demo/tour';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
const MAIN = resolve(HERE, '../../demo/main.ts');
const TSX = resolve(REPO_ROOT, 'node_modules/.bin/tsx');
const BOOT_TIMEOUT_MS = 120_000;

/** The demo's process, what it printed, and the facts read from its tour. */
interface StartedDemo {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly origin: string;
  readonly missionToken: string;
  /** The named token of the seeded team mission. */
  readonly ciToken: string;
  readonly directory: string;
  readonly exited: Promise<number | null>;
}

function startDemoProcess(): Promise<StartedDemo> {
  return new Promise((resolveStarted, reject) => {
    // The demo refuses a shell configured for a real instance: hand it none of ours.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('VAUBAAN_')),
    );
    const child = spawn(TSX, [MAIN], {
      cwd: REPO_ROOT,
      env: { ...env, NODE_ENV: 'test', DEMO_PORT: '0', DEMO_SKIP_BUILD: '1', DEMO_KEEP: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the demo did not start within ${BOOT_TIMEOUT_MS} ms:\n${text}`));
    }, BOOT_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('utf8');
      // The tour ends with the "Stop" line: everything above it is printed.
      if (!/^Stop\s+Ctrl-C/m.test(text)) return;
      clearTimeout(timer);
      const origin = /^Open\s+(http:\/\/localhost:\d+)$/m.exec(text)?.[1];
      const missionToken = /VAUBAAN_MISSION_TOKEN='([^']+)'/.exec(text)?.[1];
      const directory = /^Data\s+(\S+)$/m.exec(text)?.[1];
      const ciToken = /VAUBAAN_CI_TOKEN='([^']+)'/.exec(text)?.[1];
      if (!origin || !missionToken || !directory || !ciToken) {
        reject(new Error(`the tour does not say where the demo is:\n${text}`));
        return;
      }
      resolveStarted({
        child,
        output: () => text,
        origin,
        missionToken,
        ciToken,
        directory,
        exited,
      });
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`the demo exited with code ${code} before it was ready:\n${text}`));
    });
  });
}

/** A browser's cookie jar, and one request at a time: redirects are the test's to follow. */
class Browser {
  private readonly cookies = new Map<string, string>();

  constructor(private readonly origin: string) {}

  has(name: string): boolean {
    return this.cookies.has(name);
  }

  async get(pathOrUrl: string): Promise<Response> {
    const response = await fetch(new URL(pathOrUrl, this.origin), {
      headers: { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      redirect: 'manual',
    });
    this.absorb(response);
    return response;
  }

  /** A same-origin form post, as the gateway's pages make them. */
  async post(path: string, fields: Record<string, string>): Promise<Response> {
    const response = await fetch(new URL(path, this.origin), {
      method: 'POST',
      headers: {
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        origin: this.origin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });
    this.absorb(response);
    return response;
  }

  private absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = header.split(';');
      const [name = '', value = ''] = pair.split('=');
      if (!value || attributes.some((a) => a.trim() === 'Max-Age=0')) {
        this.cookies.delete(name.trim());
      } else {
        this.cookies.set(name.trim(), value.trim());
      }
    }
  }
}

/**
 * The gateway's own second factor at a sign-in (ADR administrators-live-in-the-instance
 * §7), enrolled as a person would: the secret the page shows, typed into an app.
 */
async function enrolAsked(browser: Browser, finished: Response): Promise<Response> {
  if (finished.headers.get('location') !== '/login/second-factor') return finished;
  const page = await (await browser.get('/login/second-factor')).text();
  const shown = /([A-Z2-7]{4}(?: [A-Z2-7]{4}){7})/.exec(page)?.[1]?.replace(/ /g, '');
  const bytes = shown ? base32Decode(shown) : null;
  if (!bytes) throw new Error('no secret on the enrolment page');
  return browser.post('/auth/factor/enrol', { code: totpCode(bytes, totpStepOf(Date.now())) });
}

/** Signs a person in through the demo identity provider's account picker. */
async function signIn(browser: Browser, person: DemoPerson): Promise<void> {
  const started = await browser.get('/auth/login?return_to=/missions');
  const authorization = new URL(locationOf(started));
  authorization.searchParams.set('account', person.key);
  const picked = await browser.get(authorization.href);
  const finished = await enrolAsked(browser, await browser.get(locationOf(picked)));
  if (finished.status !== 303 || !browser.has(SESSION_COOKIE)) {
    throw new Error(`${person.name} was not signed in (${finished.status})`);
  }
}

function locationOf(response: Response): string {
  const location = response.headers.get('location');
  if (!location) throw new Error(`expected a redirect, got ${response.status}`);
  return location;
}

/**
 * A page as a reader sees its names: an identifier is printed with break
 * opportunities between its words (`github__<wbr/>list_<wbr/>branches`), which
 * are markup, not text.
 */
function readable(html: string): string {
  return html.replace(/<wbr\s*\/?>/g, '');
}

describe.skipIf(!hasBuild())('npm run demo', () => {
  let demo: StartedDemo;
  let browser: Browser;

  beforeAll(async () => {
    demo = await startDemoProcess();
    browser = new Browser(demo.origin);
  }, BOOT_TIMEOUT_MS + 5_000);

  afterAll(async () => {
    if (demo && demo.child.exitCode === null) {
      demo.child.kill('SIGKILL');
      await demo.exited;
    }
  });

  it('prints the banner, the accounts and the tour', () => {
    const text = demo.output();
    expect(text).toContain(DEMO_BANNER);
    for (const person of DEMO_PEOPLE) expect(text).toContain(person.tagline);
    expect(text).toMatch(/ssh -L \d+:localhost:\d+ \S+/);
    expect(text).toContain('Things to try');
    expect(demo.origin).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it('serves the demo identity provider over HTTP on the same listener', async () => {
    const issuer = `${demo.origin}${DEMO_IDP_PATH}`;
    const discovery = await fetch(`${issuer}/.well-known/openid-configuration`);
    expect(discovery.status).toBe(200);
    const metadata = (await discovery.json()) as Record<string, string>;
    expect(metadata.issuer).toBe(issuer);
    expect(metadata.authorization_endpoint).toBe(`${issuer}/authorize`);
    expect(metadata.token_endpoint).toBe(`${issuer}/token`);
    const jwks = await fetch(metadata.jwks_uri ?? '');
    expect(((await jwks.json()) as { keys: unknown[] }).keys).toHaveLength(1);
  });

  it('sends an anonymous visitor to the sign-in page', async () => {
    const response = await new Browser(demo.origin).get('/missions');
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(new URL(locationOf(response), demo.origin).pathname).toBe('/login');
  });

  it('signs Alice in through the account picker', async () => {
    const started = await browser.get('/auth/login?return_to=/missions');
    expect(started.status).toBe(303);
    const authorization = new URL(locationOf(started));
    expect(`${authorization.origin}${authorization.pathname}`).toBe(
      `${demo.origin}${DEMO_IDP_PATH}/authorize`,
    );

    const picker = await browser.get(authorization.href);
    expect(picker.status).toBe(200);
    const html = await picker.text();
    for (const person of DEMO_PEOPLE) expect(html).toContain(person.name);
    expect(html).toContain(DEMO_BANNER);

    authorization.searchParams.set('account', ALICE.key);
    const picked = await browser.get(authorization.href);
    expect(picked.status).toBe(303);
    const callback = new URL(locationOf(picked));
    expect(callback.pathname).toBe('/auth/callback/idp');

    // Alice administers the demo: she enrols the gateway's own second factor first.
    const asked = await browser.get(callback.href);
    expect(locationOf(asked)).toBe('/login/second-factor');
    const finished = await enrolAsked(browser, asked);
    expect(finished.status).toBe(303);
    expect(locationOf(finished)).toMatch(/^\/settings\/security\?notice=.*return_to=%2Fmissions/);
    expect(browser.has(SESSION_COOKIE)).toBe(true);
  });

  it.each([
    ['/missions', 'Ship the billing page'],
    ['/accounts', 'Acme app'],
    ['/waiting', 'Nightly dependency audit'],
    ['/activity/record', 'github__list_pull_requests'],
    ['/activity/timeline', 'github__list_pull_requests'],
    // What a colleague gave access to is a region of Accounts; so is her Vaubaan account.
    ['/accounts', 'Acme billing'],
    ['/missions', 'Platform management'],
    ['/accounts/new/github', 'Create the token at GitHub'],
    ['/admin/groups', 'GitHub admins'],
  ])('shows seeded data on %s', async (path, seeded) => {
    const response = await browser.get(path);
    expect(response.status).toBe(200);
    const html = readable(await response.text());
    expect(html).toContain(ALICE.email);
    expect(html).toContain(seeded);
  });

  it('sums the seeded calls on the Overview, bytes included', async () => {
    const response = await browser.get('/activity');
    expect(response.status).toBe(200);
    const html = readable(await response.text());
    expect(html).toContain('Ship the billing page');
    // The seeded calls went through the door: their bytes were counted.
    expect(html).toMatch(/Sent<\/dt>(?:<[^>]+>)*[1-9][\d.]* (?:B|KB|MB)</);
    expect(html).toMatch(/Received<\/dt>(?:<[^>]+>)*[1-9][\d.]* (?:B|KB|MB)</);
  });

  it('answers tools/list on /mcp with the mission token the tour prints', async () => {
    const response = await fetch(`${demo.origin}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${demo.missionToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((tool) => tool.name);
    expect(names).toContain('github__list_branches');
    expect(names).toContain('upstash_redis__get');
  });

  it('attributes the seeded team: the named token says its name, and Alice finds both holders', async () => {
    const catalog = await fetch(`${demo.origin}/mcp/catalog`, {
      headers: { Authorization: `Bearer ${demo.ciToken}` },
    });
    expect(catalog.status).toBe(200);
    const body = (await catalog.json()) as {
      mission: { name: string; creator: string };
      token: { kind: string; holder: string };
    };
    expect(body.token).toMatchObject({ kind: 'named', holder: CI_TOKEN_NAME });
    expect(body.mission).toMatchObject({ name: 'Ship the billing page', creator: ALICE.email });
    // The creator's own token on the same mission says who she is.
    const own = await fetch(`${demo.origin}/mcp/catalog`, {
      headers: { Authorization: `Bearer ${demo.missionToken}` },
    });
    expect(((await own.json()) as typeof body).token).toMatchObject({
      kind: 'member',
      holder: ALICE.email,
    });

    // The audit, filtered on each holder (Alice is signed in).
    const byCi = readable(
      await (
        await browser.get(`/activity/record?holder=${encodeURIComponent(CI_TOKEN_NAME)}`)
      ).text(),
    );
    expect(byCi).toContain(CI_TOKEN_NAME);
    expect(byCi).toContain('machine key');
    expect(byCi).toContain('github__list_branches');
    const byBob = readable(
      await (await browser.get(`/activity/record?holder=${encodeURIComponent(BOB.email)}`)).text(),
    );
    expect(byBob).toContain(BOB.email);
    expect(byBob).toContain('github__get_file_contents');
  });

  it('shows Bob the mission Alice shared with him, read-only, with his own key', async () => {
    const bob = new Browser(demo.origin);
    await signIn(bob, BOB);
    const list = await (await bob.get('/missions')).text();
    expect(list).toContain('Shared with you');
    expect(list).toContain('Ship the billing page');
    expect(list).toContain(ALICE.email);
    const href = /href="(\/missions\/[^"/]+)"[^>]*>Ship the billing page/.exec(list)?.[1];
    expect(href).toBeDefined();
    const page = await (await bob.get(href ?? '/missions')).text();
    expect(page).toContain('data-testid="shared-with-me"');
    expect(page).toContain('id="keys-title"');
    expect(page).toContain('Replace my key');
    expect(page).toContain(CI_TOKEN_NAME);
    // Nothing of the creator's controls.
    expect(page).not.toContain('Stop the mission');
    expect(page).not.toContain('Add keys');
    expect(page).not.toContain('New machine key');
    // No secret on any page: the named token's and Alice's are shown nowhere to him.
    for (const secret of [demo.ciToken, demo.missionToken]) {
      expect(page).not.toContain(secret.slice(-32));
    }
  });

  it('refuses /mcp without a token', async () => {
    const response = await fetch(`${demo.origin}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  it('stops cleanly and deletes its data', async () => {
    expect(existsSync(demo.directory)).toBe(true);
    demo.child.kill('SIGTERM');
    expect(await demo.exited).toBe(0);
    expect(existsSync(demo.directory)).toBe(false);
    await expect(fetch(`${demo.origin}/healthz`)).rejects.toThrow();
  }, 30_000);
});
