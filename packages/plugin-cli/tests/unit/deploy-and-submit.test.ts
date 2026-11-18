/**
 * Handing a plugin over (intents "Deploy a plugin to a gateway" and "Submit a plugin to
 * the catalog"): `deploy` sends the archive to a gateway's MCP door and prints where an
 * administrator activates it, never activating; `submit` declares the project's pushed
 * HEAD to the catalog and opens the pull request, or prints the declaration on a dry run.
 * The door is a fake here (the real one: apps/gateway/tests/integration/plugins/
 * deploy-from-cli.test.ts); git and gh are a recorded `Runner`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { manifestOfFiles, packArchive } from '@vaubaan/plugin-sdk/archive';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  declarationOf,
  declarationProblems,
  declarationText,
  deployArchive,
  doorOf,
  githubRepositoryOf,
  initProject,
  run,
  type Declaration,
  type Runner,
} from '../../src/index.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function archiveBytes(): Uint8Array {
  const files = new Map<string, Uint8Array>([
    ['index.js', encode('export default {};\n')],
    ['package.json', encode('{"name":"acme","version":"1.0.0","type":"module"}')],
  ]);
  files.set(
    'vaubaan-manifest.json',
    encode(JSON.stringify(manifestOfFiles(files, 'acme', '1.0.0'))),
  );
  return packArchive(files);
}

/** A door that answers `body` (JSON) with `status`, recording the request. */
function door(body: unknown, status = 200, contentType = 'application/json') {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const ANSWER = {
  plugin: 'acme',
  version: '1.0.0',
  digest: 'sha256:abc',
  state: 'pending',
  activation_url: 'https://gw.example.com/admin/plugins/sha256:abc',
  next: 'An administrator activates it.',
};

describe('deploy', () => {
  let dir: string;
  let archive: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vbn-deploy-'));
    archive = join(dir, 'plugin.tgz');
    writeFileSync(archive, archiveBytes());
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('posts the archive to the door as upload_plugin, with the mission token, and reads the answer', async () => {
    const { fetchImpl, requests } = door({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(ANSWER) }] },
    });
    const result = await deployArchive({
      archive,
      gateway: 'https://gw.example.com/',
      token: 'vbn_m_secret',
      fetch: fetchImpl,
    });
    expect(result).toEqual({
      plugin: 'acme',
      version: '1.0.0',
      digest: 'sha256:abc',
      activationUrl: ANSWER.activation_url,
      next: ANSWER.next,
    });
    const [request] = requests;
    expect(request?.url).toBe('https://gw.example.com/mcp');
    expect(new Headers(request?.init.headers).get('authorization')).toBe('Bearer vbn_m_secret');
    const sent = JSON.parse(String(request?.init.body)) as {
      method: string;
      params: { name: string; arguments: { archive_base64: string } };
    };
    expect(sent.method).toBe('tools/call');
    expect(sent.params.name).toBe('vaubaan__upload_plugin');
    expect(Buffer.from(sent.params.arguments.archive_base64, 'base64')).toEqual(
      Buffer.from(archiveBytes()),
    );
  });

  it('reads structuredContent and an event stream too', async () => {
    const stream = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: ANSWER } })}\n\n`;
    const { fetchImpl } = door(stream, 200, 'text/event-stream');
    await expect(
      deployArchive({ archive, gateway: 'https://gw.example.com', token: 't', fetch: fetchImpl }),
    ).resolves.toMatchObject({ activationUrl: ANSWER.activation_url });
  });

  it('says the refusal and its hint, and names the token variable on a 401', async () => {
    const refused = door({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32603,
        message: 'refused',
        data: { code: 'administrator-only', message: 'Only an administrator…', hint: 'Ask one.' },
      },
    });
    await expect(
      deployArchive({
        archive,
        gateway: 'https://gw.example.com',
        token: 't',
        fetch: refused.fetchImpl,
      }),
    ).rejects.toThrow(/\(administrator-only\): Only an administrator…\nAsk one\./);
    const unknown = door({ error: 'unauthorized' }, 401);
    await expect(
      deployArchive({
        archive,
        gateway: 'https://gw.example.com',
        token: 't',
        fetch: unknown.fetchImpl,
      }),
    ).rejects.toThrow(/401.*VAUBAAN_MISSION_TOKEN/);
  });

  it('never sends the token in clear or without one', async () => {
    expect(() => doorOf('http://gw.example.com')).toThrow(/https/);
    expect(doorOf('http://localhost:3000').href).toBe('http://localhost:3000/mcp');
    const { fetchImpl, requests } = door({});
    await expect(
      deployArchive({
        archive,
        gateway: 'https://gw.example.com',
        token: undefined,
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(/VAUBAAN_MISSION_TOKEN is not set/);
    expect(requests).toHaveLength(0);
  });

  it('prints the activation URL and says nothing was activated', async () => {
    const { fetchImpl } = door({ jsonrpc: '2.0', id: 1, result: { structuredContent: ANSWER } });
    const out: string[] = [];
    const code = await run(['deploy', archive, '--gateway', 'https://gw.example.com'], {
      cwd: dir,
      log: (line) => out.push(line),
      error: (line) => out.push(line),
      env: { VAUBAAN_MISSION_TOKEN: 't' },
      fetch: fetchImpl,
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/pending, not active/);
    expect(out.join('\n')).toContain(`activate: ${ANSWER.activation_url}`);
  });
});

const DECLARATION: Declaration = {
  id: 'acme-crm',
  repo: 'https://github.com/acme/vaubaan-plugin-crm',
  path: '.',
  version: '0.1.0',
  commit: 'a'.repeat(40),
  owners: ['acme'],
};

describe('the catalog declaration', () => {
  it('reads a GitHub repository from its https or ssh remote', () => {
    for (const remote of [
      'https://github.com/acme/vaubaan-plugin-crm.git',
      'https://github.com/acme/vaubaan-plugin-crm',
      'git@github.com:acme/vaubaan-plugin-crm.git',
      'ssh://git@github.com/acme/vaubaan-plugin-crm.git',
    ]) {
      expect(githubRepositoryOf(remote), remote).toBe('https://github.com/acme/vaubaan-plugin-crm');
    }
    expect(githubRepositoryOf('https://gitlab.com/acme/crm.git')).toBeNull();
  });

  it('is written as the catalog reads it, path left out at the root', () => {
    expect(declarationText(DECLARATION)).toBe(
      [
        'id: acme-crm',
        'repo: https://github.com/acme/vaubaan-plugin-crm',
        'version: 0.1.0',
        `commit: ${'a'.repeat(40)}`,
        'owners: [acme]',
        '',
      ].join('\n'),
    );
    expect(declarationText({ ...DECLARATION, path: 'plugins/crm' })).toContain(
      'path: plugins/crm\n',
    );
  });

  it('finds what the catalog’s check would refuse', () => {
    expect(declarationProblems(DECLARATION)).toEqual([]);
    expect(
      declarationProblems({
        ...DECLARATION,
        path: '../x',
        commit: 'abc',
        version: 'one',
        owners: ['not an owner'],
      }),
    ).toHaveLength(4);
  });
});

describe('submit', () => {
  let parent: string;
  let dir: string;
  beforeAll(() => {
    parent = mkdtempSync(join(tmpdir(), 'vbn-submit-'));
    dir = join(parent, 'crm');
    initProject({ dir, id: 'acme-crm' });
    writeFileSync(join(dir, 'package-lock.json'), '{}');
  });
  afterAll(() => rmSync(parent, { recursive: true, force: true }));

  /** git and gh as a pushed, clean project would answer; every command recorded. */
  function runner(overrides: Record<string, string> = {}) {
    const calls: string[] = [];
    const answers: Record<string, string> = {
      'git rev-parse --show-toplevel': dir,
      'git status --porcelain': '',
      'git rev-parse HEAD': 'b'.repeat(40),
      [`git branch -r --contains ${'b'.repeat(40)}`]: 'origin/main',
      'git remote get-url origin': 'git@github.com:acme/vaubaan-plugin-crm.git',
      'gh api user --jq .login': 'acme-dev',
      ...overrides,
    };
    const run: Runner = (command, args, cwd) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      // What the real fork does: a clone of the catalog, named after it.
      if (line.startsWith('gh repo fork')) {
        mkdirSync(join(cwd, 'gateway-plugins', 'catalog'), { recursive: true });
      }
      if (line.startsWith('gh pr create'))
        return 'https://github.com/vaubaan/gateway-plugins/pull/42';
      return answers[line] ?? '';
    };
    return { run, calls };
  }

  it('declares the pushed HEAD, owned by the repository’s owner unless told otherwise', () => {
    const { run } = runner();
    expect(declarationOf(dir, { run })).toEqual({
      id: 'acme-crm',
      repo: 'https://github.com/acme/vaubaan-plugin-crm',
      path: '.',
      version: '0.1.0',
      commit: 'b'.repeat(40),
      owners: ['acme'],
    });
    expect(declarationOf(dir, { run, owners: ['acme/plugin-team'] }).owners).toEqual([
      'acme/plugin-team',
    ]);
  });

  it('refuses a dirty tree, an unpushed commit, a remote outside GitHub', () => {
    expect(() =>
      declarationOf(dir, runner({ 'git status --porcelain': ' M src/index.ts' })),
    ).toThrow(/uncommitted/);
    expect(() =>
      declarationOf(dir, runner({ [`git branch -r --contains ${'b'.repeat(40)}`]: '' })),
    ).toThrow(/push it first/);
    expect(() =>
      declarationOf(dir, runner({ 'git remote get-url origin': 'https://gitlab.com/a/b.git' })),
    ).toThrow(/not a GitHub repository/);
  });

  it('prints the declaration on a dry run and runs neither gh nor a push', async () => {
    const { run: runGit, calls } = runner();
    const out: string[] = [];
    const code = await run(['submit', '--dry-run'], {
      cwd: dir,
      log: (line) => out.push(line),
      error: (line) => out.push(line),
      run: runGit,
    });
    expect(code).toBe(0);
    expect(out).toContain('catalog/acme-crm.yaml');
    expect(out).toContain('  owners: [acme]');
    expect(calls.filter((call) => call.startsWith('gh') || call.includes('push'))).toEqual([]);
  });

  it('forks the catalog, commits the declaration on a branch and opens the pull request', async () => {
    const { run: runGit, calls } = runner();
    const out: string[] = [];
    const code = await run(['submit', '--owners', 'acme,acme/plugin-team'], {
      cwd: dir,
      log: (line) => out.push(line),
      error: (line) => out.push(line),
      run: runGit,
    });
    expect(code).toBe(0);
    expect(calls).toEqual(
      expect.arrayContaining([
        'gh repo fork vaubaan/gateway-plugins --clone --default-branch-only',
        'git checkout -b submit/acme-crm-0.1.0',
        'git add catalog/acme-crm.yaml',
        'git commit -s -m acme-crm 0.1.0',
        'git push --set-upstream origin submit/acme-crm-0.1.0',
      ]),
    );
    expect(calls.find((call) => call.startsWith('gh pr create'))).toContain(
      '--repo vaubaan/gateway-plugins --head acme-dev:submit/acme-crm-0.1.0',
    );
    expect(out).toContain('pull request: https://github.com/vaubaan/gateway-plugins/pull/42');
  });
});
