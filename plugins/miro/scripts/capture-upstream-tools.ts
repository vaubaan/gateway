/**
 * Captures the tool list of Miro's MCP server into `src/upstream-tools.json`,
 * verbatim — the refresh of the plugin's model (handbook services/miro, Procedures).
 *
 *   npm run capture-upstream-tools --workspace @vaubaan/plugin-miro
 *
 * `tools/list` needs a Miro account, so the script signs in the way any MCP
 * client does: it registers a throw-away client at Miro (RFC 7591) with a
 * loopback redirect, prints the authorization address to open in a browser,
 * receives the code on 127.0.0.1, exchanges it (PKCE), asks for the list,
 * writes the file, and prints how the new list differs from the model. The
 * token stays in this process's memory and is never printed or written.
 *
 * Then: run the plugin's tests (`tools.ts` refuses a list with a tool or a
 * locating argument it does not model), adapt the model where it differs,
 * bump the plugin version.
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { mcpRequest } from '@vaubaan/plugin-sdk';

import { toolDrift } from '../src/execute.ts';
import { MIRO_MCP_SERVER, MIRO_MCP_URL, MIRO_OAUTH } from '../src/identity.ts';
import { REQUIRED_SCOPES } from '../src/credential.ts';

const OUTPUT = new URL('../src/upstream-tools.json', import.meta.url);
const WAIT_FOR_BROWSER_MS = 5 * 60_000;

function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    redirect: 'error',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function postForm(
  url: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    redirect: 'error',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Waits for the browser to come back to the loopback redirect with a code. */
function waitForCode(server: Server, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('no answer from the browser in time')),
      WAIT_FOR_BROWSER_MS,
    );
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const ok = code !== null && url.searchParams.get('state') === state;
      res
        .writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end(ok ? 'Done: you can close this tab.' : 'Refused or interrupted: see the terminal.');
      clearTimeout(timer);
      if (ok) resolve(code);
      else
        reject(
          new Error(`authorization not granted (${url.searchParams.get('error') ?? 'bad state'})`),
        );
    });
  });
}

async function main(): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    const client = await postJson(MIRO_OAUTH.registrationUrl, {
      client_name: 'Vaubaan Gateway (tool list capture)',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: REQUIRED_SCOPES.join(' '),
    });
    const clientId = String(client.client_id);
    const clientSecret = String(client.client_secret);
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    const authorize = new URL(MIRO_OAUTH.authorizationUrl);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: REQUIRED_SCOPES.join(' '),
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: MIRO_OAUTH.resource,
    }).toString();
    say('Open this address in a browser, sign in to Miro, choose a team and allow the client:');
    say(authorize.href);

    const code = await waitForCode(server, state);
    const token = await postForm(MIRO_OAUTH.tokenUrl, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: clientId,
      client_secret: clientSecret,
      resource: MIRO_OAUTH.resource,
    });
    const accessToken = String(token.access_token);
    say(
      `Signed in. Lifetime of the access token: ${String(token.expires_in)} s; refresh token: ${typeof token.refresh_token === 'string' ? 'yes' : 'no'}.`,
    );

    const listed = await mcpRequest({ fetch }, MIRO_MCP_SERVER, accessToken, 'tools/list', {});
    const tools = (listed as { tools?: unknown } | null)?.tools;
    if (!Array.isArray(tools)) throw new Error(`${MIRO_MCP_URL} answered no tool list`);
    const drift = toolDrift(listed);
    writeFileSync(
      OUTPUT,
      `${JSON.stringify(
        {
          source: `tools/list of ${MIRO_MCP_URL}`,
          captured_at: new Date().toISOString().slice(0, 10),
          tools,
        },
        null,
        2,
      )}\n`,
    );
    say(`Wrote ${tools.length} tools to src/upstream-tools.json.`);
    say(`Differences with the previous model: ${JSON.stringify(drift, null, 2)}`);
    say(
      'In Miro, remove the app "Vaubaan Gateway (tool list capture)" from your profile settings.',
    );
  } finally {
    server.close();
  }
}

main().catch((err: unknown) => {
  say(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
