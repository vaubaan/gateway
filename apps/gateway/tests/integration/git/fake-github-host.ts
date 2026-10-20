/**
 * A GitHub stand-in for the git remote's tests (spec §10: no call to a real
 * provider, ever): no request leaves the machine.
 *
 *   https://github.com/<owner>/<repo>.git/…   served by the real `git http-backend`
 *                                             over bare repositories in a temporary
 *                                             directory, behind a local listener
 *                                             records the scope each one asked for
 *   https://api.github.com/repos/<o>/<r>       `default_branch` from the bare repo's HEAD
 *   https://api.github.com/repos/<o>/<r>/compare/<base>...<head>
 *                                             computed with git on the same bare repo:
 *                                             status, ahead_by, total_commits, files
 *                                             (with `previous_filename` on renames)
 *
 * The git endpoint behaves like GitHub where it matters to the gateway: Basic
 * authentication with a minted token (`x-access-token:<token>`), and a push
 * only with a token that holds `contents: write`. `fetch` is the
 * `RootDeps.providerFetch` of the instance.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const GITHUB_WEB = 'https://github.com';
export const GITHUB_API = 'https://api.github.com';

/** One request the fake GitHub received. */
export interface HostRequest {
  readonly method: string;
  /** Path and query, e.g. `/acme/app.git/info/refs?service=git-upload-pack`. */
  readonly path: string;
  readonly host: 'git' | 'api';
  readonly authorization: string | null;
  readonly gitProtocol: string | null;
}

export interface MintedToken {
  readonly token: string;
  readonly repositories: readonly string[] | null;
  readonly permissions: Readonly<Record<string, string>> | null;
}

/** Environment every git command of the fake host runs with: no user config. */
export function isolatedGitEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV ?? 'test',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fake GitHub',
    GIT_AUTHOR_EMAIL: 'fake@github.test',
    GIT_COMMITTER_NAME: 'Fake GitHub',
    GIT_COMMITTER_EMAIL: 'fake@github.test',
  };
  return env;
}

export class FakeGithubHost {
  readonly root: string;
  readonly requests: HostRequest[] = [];
  readonly minted: MintedToken[] = [];
  /** When set, the compare API answers this status (a GitHub outage). */
  compareStatus: number | null = null;
  private server: Server | null = null;
  private port = 0;
  private next = 1;
  private readonly home: string;

  private constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'vaubaan-fake-github-'));
    this.home = mkdtempSync(join(tmpdir(), 'vaubaan-fake-github-home-'));
  }

  static async start(): Promise<FakeGithubHost> {
    const host = new FakeGithubHost();
    host.server = createServer((req, res) => {
      void host.serveGit(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      });
    });
    await new Promise<void>((resolve) => host.server!.listen(0, '127.0.0.1', resolve));
    host.port = (host.server.address() as AddressInfo).port;
    return host;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    rmSync(this.root, { recursive: true, force: true });
    rmSync(this.home, { recursive: true, force: true });
  }

  /**
   * Accept a token that was not minted here: the token of a token connection
   * (a fine-grained personal access token), with the permissions it carries.
   */
  acceptToken(token: string, permissions: Readonly<Record<string, string>>): void {
    this.minted.push({ token, repositories: null, permissions });
  }

  /** Path of a bare repository. */
  bare(repository: string): string {
    return join(this.root, `${repository}.git`);
  }

  /** git in a bare repository of the host. */
  async git(repository: string, args: readonly string[]): Promise<string> {
    const { stdout } = await run('git', args, {
      cwd: this.bare(repository),
      env: isolatedGitEnv(this.home),
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  }

  /**
   * A bare repository whose `main` holds a README and a CI workflow, pushed
   * from a scratch clone. Returns the sha of `main`.
   */
  async createRepository(
    repository: string,
    files: Readonly<Record<string, string>> = {},
  ): Promise<string> {
    await run('git', ['init', '--bare', '--initial-branch=main', this.bare(repository)], {
      env: isolatedGitEnv(this.home),
    });
    const work = mkdtempSync(join(tmpdir(), 'vaubaan-fake-github-seed-'));
    try {
      const env = isolatedGitEnv(this.home);
      const g = (args: string[]) => run('git', args, { cwd: work, env });
      await g(['init', '--initial-branch=main', '.']);
      const all: Record<string, string> = {
        'README.md': '# app\n',
        '.github/workflows/ci.yml': 'name: ci\non: push\njobs: {}\n',
        ...files,
      };
      for (const [path, content] of Object.entries(all)) {
        mkdirSync(join(work, dirname(path)), { recursive: true });
        writeFileSync(join(work, path), content);
      }
      await g(['add', '-A']);
      await g(['commit', '-q', '-m', 'initial']);
      await g(['push', '-q', this.bare(repository), 'main']);
      return (await g(['rev-parse', 'HEAD'])).stdout.trim();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** The value of a ref in a bare repository, or `null`. */
  async refOf(repository: string, ref: string): Promise<string | null> {
    try {
      return await this.git(repository, ['rev-parse', '--verify', '--quiet', ref]);
    } catch {
      return null;
    }
  }

  /** Every ref of a bare repository, `name → sha`. */
  async refs(repository: string): Promise<Record<string, string>> {
    const out = await this.git(repository, ['for-each-ref', '--format=%(refname) %(objectname)']);
    const refs: Record<string, string> = {};
    for (const line of out.split('\n').filter(Boolean)) {
      const [name = '', sha = ''] = line.split(' ');
      refs[name] = sha;
    }
    return refs;
  }

  /** `RootDeps.providerFetch`: GitHub's two hosts, nothing else. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === GITHUB_WEB) {
      const target = `http://127.0.0.1:${this.port}${url.pathname}${url.search}`;
      return fetch(target, init);
    }
    if (url.origin === GITHUB_API) return this.serveApi(url, init);
    return new Response(JSON.stringify({ message: 'no such host in this test' }), { status: 404 });
  };

  // ───────────────────────────────────────────────────────────────────────────
  // REST API
  // ───────────────────────────────────────────────────────────────────────────

  private async serveApi(url: URL, init: RequestInit | undefined): Promise<Response> {
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    this.requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      host: 'api',
      authorization: headers.get('authorization'),
      gitProtocol: null,
    });
    const token = this.tokenOf(headers.get('authorization'));
    if (!token) return json({ message: 'Bad credentials' }, 401);
    const refs = await this.serveRefs(url, method, init, token);
    if (refs) return refs;
    const repo = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (repo && method === 'GET') {
      const repository = `${repo[1]}/${repo[2]}`;
      const head = await this.git(repository, ['symbolic-ref', 'HEAD']).catch(
        () => 'refs/heads/main',
      );
      return json({ full_name: repository, default_branch: head.replace(/^refs\/heads\//, '') });
    }
    const history = /^\/repos\/([^/]+)\/([^/]+)\/commits$/.exec(url.pathname);
    if (history && method === 'GET') {
      return this.commitList(`${history[1]}/${history[2]}`, url.searchParams);
    }
    const commitRead = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]{40})$/.exec(url.pathname);
    if (commitRead && method === 'GET') {
      return this.commitFiles(`${commitRead[1]}/${commitRead[2]}`, commitRead[3] ?? '');
    }
    const database = /^\/repos\/([^/]+)\/([^/]+)\/git\/(commits|trees|tags)\/([0-9a-f]{40})$/.exec(
      url.pathname,
    );
    if (database && method === 'GET') {
      if (this.databaseStatus !== null)
        return json({ message: 'unavailable' }, this.databaseStatus);
      return this.gitDatabase(
        `${database[1]}/${database[2]}`,
        database[3] as 'commits' | 'trees' | 'tags',
        database[4] ?? '',
      );
    }
    const compare = /^\/repos\/([^/]+)\/([^/]+)\/compare\/(.+)$/.exec(url.pathname);
    if (compare && method === 'GET') {
      if (this.compareStatus !== null) return json({ message: 'unavailable' }, this.compareStatus);
      const [base = '', head = ''] = (compare[3] ?? '').split('...').map(decodeURIComponent);
      return this.compare(`${compare[1]}/${compare[2]}`, base, head);
    }
    return json({ message: 'Not Found' }, 404);
  }

  /** Ref writes the REST API refused, for the tests that check what reached GitHub. */
  readonly refWrites: { method: string; ref: string; force?: boolean }[] = [];

  /** `GET git/ref/<ref>`, `POST git/refs`, `PATCH|DELETE git/refs/<ref>` over the bare repository. */
  private async serveRefs(
    url: URL,
    method: string,
    init: RequestInit | undefined,
    token: MintedToken,
  ): Promise<Response | null> {
    const m = /^\/repos\/([^/]+)\/([^/]+)\/git\/(ref|refs)(\/.*)?$/.exec(url.pathname);
    if (!m) return null;
    const repository = `${m[1]}/${m[2]}`;
    const ref = m[4] ? `refs${m[4].split('/').map(decodeURIComponent).join('/')}` : null;
    if (method === 'GET' && m[3] === 'ref' && ref) {
      const sha = await this.refOf(repository, ref);
      if (sha === null) return json({ message: 'Not Found' }, 404);
      return json({ ref, object: { sha, type: 'commit' } });
    }
    if (token.permissions && token.permissions.contents !== 'write') {
      return json({ message: 'Resource not accessible by integration' }, 403);
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      ref?: string;
      sha?: string;
      force?: boolean;
    };
    if (method === 'POST' && m[3] === 'refs' && !ref) {
      const target = body.ref ?? '';
      this.refWrites.push({ method, ref: target });
      if ((await this.refOf(repository, target)) !== null) {
        return json({ message: 'Reference already exists' }, 422);
      }
      await this.git(repository, ['update-ref', target, body.sha ?? '', '0'.repeat(40)]);
      return json({ ref: target, object: { sha: body.sha } }, 201);
    }
    if (!ref || m[3] !== 'refs') return null;
    const current = await this.refOf(repository, ref);
    if (current === null) return json({ message: 'Reference does not exist' }, 422);
    if (method === 'PATCH') {
      this.refWrites.push({ method, ref, force: body.force === true });
      const sha = body.sha ?? '';
      if (body.force !== true) {
        const ff = await this.git(repository, ['merge-base', '--is-ancestor', current, sha])
          .then(() => true)
          .catch(() => false);
        if (!ff) return json({ message: 'Update is not a fast forward' }, 422);
      }
      await this.git(repository, ['update-ref', ref, sha, current]);
      return json({ ref, object: { sha } });
    }
    if (method === 'DELETE') {
      this.refWrites.push({ method, ref });
      await this.git(repository, ['update-ref', '-d', ref, current]);
      return new Response(null, { status: 204 });
    }
    return null;
  }

  /**
   * The commit a side of a comparison names, as GitHub resolves it: a ref
   * name through its tag, a raw object id only when it is a commit's — the
   * id of an annotated tag object is "Not Found" (observed 2026-10-18).
   */
  private async commitOf(repository: string, rev: string): Promise<string | null> {
    if (/^[0-9a-f]{40}$/.test(rev)) {
      const type = await this.git(repository, ['cat-file', '-t', rev]).catch(() => null);
      return type === 'commit' ? rev : null;
    }
    return this.refOf(repository, `${rev}^{commit}`);
  }

  private async compare(repository: string, base: string, head: string): Promise<Response> {
    const b = await this.commitOf(repository, base);
    const h = await this.commitOf(repository, head);
    if (!b || !h) return json({ message: 'Not Found' }, 404);
    let mergeBase: string;
    try {
      mergeBase = await this.git(repository, ['merge-base', b, h]);
    } catch {
      return json({ message: 'No common ancestor' }, 404);
    }
    const count = async (range: string) =>
      Number(await this.git(repository, ['rev-list', '--count', range]));
    const ahead = await count(`${mergeBase}..${h}`);
    const behind = await count(`${mergeBase}..${b}`);
    const status =
      b === h ? 'identical' : behind === 0 ? 'ahead' : ahead === 0 ? 'behind' : 'diverged';
    const diff = await this.git(repository, ['diff', '--name-status', '-M', mergeBase, h]);
    const files = diff
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [code = '', first = '', second] = line.split('\t');
        return code.startsWith('R') && second !== undefined
          ? { filename: second, previous_filename: first, status: 'renamed' }
          : { filename: first, status: code };
      })
      // GitHub lists at most 300 files.
      .slice(0, 300);
    const list = await this.git(repository, ['rev-list', '--reverse', `${mergeBase}..${h}`]);
    const commits = list
      .split('\n')
      .filter(Boolean)
      .slice(0, 250)
      .map((sha) => ({ sha }));
    return json({
      status,
      ahead_by: ahead,
      behind_by: behind,
      total_commits: ahead,
      commits,
      files,
    });
  }

  /** `GET commits/{sha}`: the files of one commit against its first parent. */
  private async commitFiles(repository: string, sha: string): Promise<Response> {
    if ((await this.refOf(repository, `${sha}^{commit}`)) === null) {
      return json({ message: 'Not Found' }, 404);
    }
    const out = await this.git(repository, [
      'diff-tree',
      '--no-commit-id',
      '--name-status',
      '-r',
      '-M',
      '--root',
      // A merge against its first parent, as GitHub lists it (without `-m`,
      // diff-tree lists nothing for a merge).
      '-m',
      '--first-parent',
      sha,
    ]);
    const files = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [code = '', first = '', second] = line.split('\t');
        return code.startsWith('R') && second !== undefined
          ? { filename: second, previous_filename: first }
          : { filename: first };
      });
    this.commitReads += 1;
    return json({ sha, files });
  }

  /** `GET commits?sha=&per_page=&page=`: the commits reachable from `sha`, newest first. */
  private async commitList(repository: string, query: URLSearchParams): Promise<Response> {
    const sha = query.get('sha') ?? 'HEAD';
    const perPage = Number(query.get('per_page') ?? '30');
    const page = Number(query.get('page') ?? '1');
    if ((await this.refOf(repository, `${sha}^{commit}`)) === null) {
      return json({ message: 'Not Found' }, 404);
    }
    const out = await this.git(repository, [
      'rev-list',
      `--max-count=${perPage}`,
      `--skip=${(page - 1) * perPage}`,
      sha,
    ]);
    return json(
      out
        .split('\n')
        .filter(Boolean)
        .map((oid) => ({ sha: oid })),
    );
  }

  /**
   * `GET git/commits|trees|tags/{sha}`: GitHub's git database over the bare
   * repository — every object it holds, reachable or not, as GitHub does.
   */
  private async gitDatabase(
    repository: string,
    kind: 'commits' | 'trees' | 'tags',
    sha: string,
  ): Promise<Response> {
    const type = await this.git(repository, ['cat-file', '-t', sha]).catch(() => null);
    const expected = { commits: 'commit', trees: 'tree', tags: 'tag' }[kind];
    if (type !== expected) return json({ message: 'Not Found' }, 404);
    if (kind === 'trees') {
      const out = await this.git(repository, ['ls-tree', sha]);
      const tree = out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [meta = '', path = ''] = line.split('\t');
          const [mode = '', entryType = '', oid = ''] = meta.split(' ');
          return { path, mode, type: entryType, sha: oid };
        });
      return json({ sha, tree, truncated: false });
    }
    const body = await this.git(repository, ['cat-file', '-p', sha]);
    const header = body.split('\n\n')[0]?.split('\n') ?? [];
    const field = (name: string) =>
      header.filter((l) => l.startsWith(`${name} `)).map((l) => l.slice(name.length + 1));
    if (kind === 'commits') {
      return json({
        sha,
        tree: { sha: field('tree')[0] },
        parents: field('parent').map((p) => ({ sha: p })),
      });
    }
    return json({ sha, object: { sha: field('object')[0], type: field('type')[0] } });
  }

  /** When set, the git database API answers this status (a GitHub outage). */
  databaseStatus: number | null = null;

  /** How many `GET commits/{sha}` the review made. */
  commitReads = 0;

  // ───────────────────────────────────────────────────────────────────────────
  // Smart HTTP, through `git http-backend`
  // ───────────────────────────────────────────────────────────────────────────

  private tokenOf(authorization: string | null): MintedToken | null {
    if (!authorization) return null;
    const [scheme = '', value = ''] = authorization.split(' ');
    let secret = value;
    if (scheme.toLowerCase() === 'basic') {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      secret = decoded.slice(decoded.indexOf(':') + 1);
    }
    return this.minted.find((m) => m.token === secret) ?? null;
  }

  private async serveGit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers.authorization ?? null;
    this.requests.push({
      method: req.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      host: 'git',
      authorization,
      gitProtocol: (req.headers['git-protocol'] as string | undefined) ?? null,
    });
    const token = this.tokenOf(authorization);
    if (!token) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' });
      res.end('Invalid username or token.');
      return;
    }
    const pushing =
      url.pathname.endsWith('/git-receive-pack') ||
      url.searchParams.get('service') === 'git-receive-pack';
    if (pushing && token.permissions?.contents !== 'write') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Permission to push denied.');
      return;
    }
    const child = spawn('git', ['http-backend'], {
      env: {
        ...isolatedGitEnv(this.home),
        GIT_PROJECT_ROOT: this.root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.replace(/^\?/, ''),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: 'x-access-token',
        REMOTE_ADDR: '127.0.0.1',
        GIT_PROTOCOL: (req.headers['git-protocol'] as string | undefined) ?? '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
      },
    });
    req.pipe(child.stdin);
    await relayCgi(Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, res);
  }
}

/** Parse a CGI answer (headers, a blank line, the body) onto an HTTP response. */
async function relayCgi(stdout: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  const reader = stdout.getReader();
  let buffer = Buffer.alloc(0);
  let headerEnd = -1;
  while (headerEnd === -1) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = Buffer.concat([buffer, Buffer.from(value)]);
    headerEnd = buffer.indexOf('\r\n\r\n');
  }
  if (headerEnd === -1) {
    res.writeHead(500);
    res.end('no CGI headers');
    return;
  }
  const head = buffer.subarray(0, headerEnd).toString('utf8');
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of head.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
    else headers[name] = value;
  }
  res.writeHead(status, headers);
  res.write(buffer.subarray(headerEnd + 4));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
