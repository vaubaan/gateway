/**
 * Rig of the git remote's integration tests: the real composition root with
 * the shipped GitHub plugin, a `FakeGithubHost` behind `RootDeps.providerFetch`,
 * the git door served on a local listener, and the real `git` client.
 *
 * Nothing reaches github.com. The agent's side runs git with an empty
 * configuration and the setup kit's credential helper: the key is read from
 * `VAUBAAN_MISSION_TOKEN`, never written anywhere.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { githubPlugin } from '@vaubaan/plugin-github';
import { parseReceivePackResult } from '@vaubaan/plugin-sdk';
import type { MissionPolicyEntry } from '@vaubaan/shared';

import { serializeSecret } from '../../../src/server/connections';
import {
  executionInstance,
  type ExecutionInstance,
  type IssuedMission,
} from '../../../src/server/execution/testing';
import type { ConnectionRecord } from '../../../src/server/store/types';
import { FakeGithubHost, isolatedGitEnv } from './fake-github-host';

/** The fine-grained token of Ada's GitHub account, accepted by the host with every permission. */
export const CONNECTION_TOKEN = 'github_pat_11AAAAAAA0GITRIG_0123456789abcdefghijklmnopqrstuv';
export const REPOSITORY = 'acme/app';
export const OTHER_REPOSITORY = 'acme/lib';
/**
 * What the former `developer` preset stood for: read and propose at Confiant
 * (push and pull requests run freely, a force-push or a branch delete asks
 * first), administer at Confiant (a workflow file write asks first).
 */
export const DEVELOPER_CRANS: Readonly<Record<string, string>> = {
  read: 'confiant',
  propose: 'confiant',
  administer: 'confiant',
};

/** The inline credential helper of the setup kit: the key comes from the environment. */
export const KIT_CREDENTIAL_HELPER =
  '!f() { echo username=mission; echo "password=$VAUBAAN_MISSION_TOKEN"; }; f';

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRig extends ExecutionInstance {
  readonly host: FakeGithubHost;
  readonly github: ConnectionRecord;
  /** `http://127.0.0.1:<port>/git/` — the remote base the agent uses. */
  readonly remoteBase: string;
  readonly logs: string[];
  remote(repository?: string): string;
  /** A mission on the GitHub connection: macro-actions at their crans, or an explicit policy. */
  mission(input: {
    readonly crans?: Readonly<Record<string, string>>;
    readonly policy?: readonly MissionPolicyEntry[];
    readonly repositories?: readonly string[];
  }): Promise<IssuedMission>;
  /** Another account, whose token holds only `permissions`, with the repository. */
  tokenHolding(
    token: string,
    permissions: Readonly<Record<string, string>>,
  ): Promise<ConnectionRecord>;
  /** A mission on another connection, from macro-actions at their crans or an explicit policy. */
  missionOn(
    connection: ConnectionRecord,
    composition: Readonly<Record<string, string>> | readonly MissionPolicyEntry[],
  ): Promise<IssuedMission>;
  /** The agent's git: `key` in `VAUBAAN_MISSION_TOKEN`, nothing else configured. */
  git(
    cwd: string,
    args: readonly string[],
    key: string | null,
    extraConfig?: Record<string, string>,
  ): Promise<GitResult>;
  /**
   * A push git would never send: `body` (a command list, then a pack) posted
   * as it is to the door, the key as the Basic password. The report is read
   * without side-band (ask only `report-status`).
   */
  rawPush(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    repository?: string,
  ): Promise<RawPushAnswer>;
  /** A pack of `revs` (`git pack-objects --revs` syntax: `<sha>`, `^<sha>`) from a working copy. */
  packOf(cwd: string, revs: readonly string[]): Promise<Uint8Array>;
  /** A fresh directory for a clone. */
  workdir(): string;
}

export interface RawPushAnswer {
  readonly status: number;
  /** The `ERR` line of a refused request, if any. */
  readonly err: string | null;
  readonly unpack: string | null;
  readonly refs: ReadonlyMap<string, { ok: true } | { ok: false; error: string }>;
}

export interface GitRigOptions {
  readonly env?: Record<string, string>;
}

export async function openGitRig(options: GitRigOptions = {}): Promise<GitRig> {
  const host = await FakeGithubHost.start();
  await host.createRepository(REPOSITORY);
  await host.createRepository(OTHER_REPOSITORY);
  const logs: string[] = [];
  const instance = await executionInstance({
    plugins: [githubPlugin],
    env: {
      VAUBAAN_LOG_LEVEL: 'debug',
      ...options.env,
    },
    deps: { providerFetch: host.fetch, logWrite: (_level, text) => logs.push(text) },
  });
  const { store } = instance.root;
  host.acceptToken(CONNECTION_TOKEN, { metadata: 'read', contents: 'write', workflows: 'write' });
  const github = await store.connections.create({
    provider: 'github',
    owner: { kind: 'user', id: instance.ada.id },
    displayName: 'acme-org',
    credential: serializeSecret({
      kind: 'api-key',
      fields: { token: CONNECTION_TOKEN },
      metadata: {},
    }),
  });
  await store.connections.syncDiscoveredResources(github.id, [
    { ref: REPOSITORY, displayName: REPOSITORY, env: null },
    { ref: OTHER_REPOSITORY, displayName: OTHER_REPOSITORY, env: null },
  ]);

  const server = await serve(instance.root.git.handle);
  const port = (server.address() as AddressInfo).port;
  const remoteBase = `http://127.0.0.1:${port}/git/`;
  const scratch: string[] = [];
  const home = mkdtempSync(join(tmpdir(), 'vaubaan-git-agent-home-'));
  scratch.push(home);

  const rig: GitRig = {
    ...instance,
    host,
    github,
    remoteBase,
    logs,
    remote: (repository = REPOSITORY) => `${remoteBase}${repository}.git`,
    async mission(input) {
      const repositories = input.repositories ?? [REPOSITORY];
      const connection = input.crans
        ? {
            connection_id: github.id,
            crans: input.crans,
            resources: { scope: 'selected' as const, resource_refs: [...repositories] },
          }
        : {
            connection_id: github.id,
            resources: { scope: 'selected' as const, resource_refs: [...repositories] },
            policy: [...(input.policy ?? [])],
          };
      const issued = await instance.root.missions.service.issue(instance.ada, {
        name: 'Develop acme/app with git',
        connections: [connection],
        period: { kind: 'recurring', length_seconds: 86_400 },
        expires_at: null,
      });
      if (!issued.ok) throw new Error(`issue refused: ${JSON.stringify(issued)}`);
      return { mission: issued.mission, token: issued.token.secret, prefix: issued.token.prefix };
    },
    async tokenHolding(token, permissions) {
      host.acceptToken(token, permissions);
      const connection = await store.connections.create({
        provider: 'github',
        owner: { kind: 'user', id: instance.ada.id },
        displayName: `acme-${token.slice(-6)}`,
        credential: serializeSecret({ kind: 'api-key', fields: { token }, metadata: {} }),
      });
      await store.connections.syncDiscoveredResources(connection.id, [
        { ref: REPOSITORY, displayName: REPOSITORY, env: null },
      ]);
      return connection;
    },
    async missionOn(connection, composition) {
      const entry = isPolicy(composition)
        ? {
            connection_id: connection.id,
            resources: { scope: 'selected' as const, resource_refs: [REPOSITORY] },
            policy: [...composition],
          }
        : { connection_id: connection.id, crans: composition };
      const issued = await instance.root.missions.service.issue(instance.ada, {
        name: `On ${connection.displayName}`,
        connections: [entry],
        period: { kind: 'recurring', length_seconds: 86_400 },
        expires_at: null,
      });
      if (!issued.ok) throw new Error(`issue refused: ${JSON.stringify(issued)}`);
      return { mission: issued.mission, token: issued.token.secret, prefix: issued.token.prefix };
    },
    async rawPush(key, body, repository = REPOSITORY) {
      const response = await fetch(`${remoteBase}${repository}.git/git-receive-pack`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`mission:${key}`).toString('base64')}`,
          'content-type': 'application/x-git-receive-pack-request',
        },
        body,
        duplex: 'half',
      } as RequestInit);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      const err = /ERR ([^\n]*)/.exec(text)?.[1] ?? null;
      if (err !== null || bytes.length === 0) {
        return { status: response.status, err, unpack: null, refs: new Map() };
      }
      const report = parseReceivePackResult(bytes, false);
      return { status: response.status, err: null, unpack: report.unpack, refs: report.refs };
    },
    async packOf(cwd, revs) {
      return new Promise((resolve, reject) => {
        const child = spawn('git', ['pack-objects', '--stdout', '--revs', '-q'], {
          cwd,
          env: isolatedGitEnv(home),
        });
        const out: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0
            ? resolve(new Uint8Array(Buffer.concat(out)))
            : reject(new Error(`pack-objects ${code}`)),
        );
        child.stdin.end(`${revs.join('\n')}\n`);
      });
    },
    git: (cwd, args, key, extraConfig = {}) => runGit(cwd, args, home, key, extraConfig),
    workdir() {
      const dir = mkdtempSync(join(tmpdir(), 'vaubaan-git-agent-'));
      scratch.push(dir);
      return dir;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await instance.close();
      await host.close();
      for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    },
  };
  return rig;
}

/** Run the agent's git with an empty configuration, the kit's helper, and the key in the environment. */
function runGit(
  cwd: string,
  args: readonly string[],
  home: string,
  key: string | null,
  extraConfig: Record<string, string>,
): Promise<GitResult> {
  const config: Record<string, string> = {
    'credential.helper': KIT_CREDENTIAL_HELPER,
    'user.name': 'Agent',
    'user.email': 'agent@example.com',
    'init.defaultBranch': 'main',
    'advice.detachedHead': 'false',
    ...extraConfig,
  };
  const entries = Object.entries(config);
  const env: NodeJS.ProcessEnv = {
    ...isolatedGitEnv(home),
    GIT_CONFIG_COUNT: String(entries.length),
    ...(key !== null ? { VAUBAAN_MISSION_TOKEN: key } : {}),
  };
  entries.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd, env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** The door on a local listener: Node's request as a fetch `Request`, the body streamed both ways. */
async function serve(handle: (request: Request) => Promise<Response>): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const init: RequestInit & { duplex?: 'half' } = {
        method: req.method,
        headers,
        signal: controller.signal,
        ...(hasBody
          ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' }
          : {}),
      };
      const response = await handle(new Request(`http://127.0.0.1${req.url ?? '/'}`, init));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk);
        }
      }
      res.end();
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function isPolicy(
  composition: Readonly<Record<string, string>> | readonly MissionPolicyEntry[],
): composition is readonly MissionPolicyEntry[] {
  return Array.isArray(composition);
}
