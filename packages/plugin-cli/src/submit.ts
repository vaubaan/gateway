/**
 * `vaubaan-plugin submit [--owners <a>,<b>] [--dry-run]`: proposes the plugin to the public
 * catalog (intent "Submit a plugin to the catalog"; ADR plugin-catalog-rebuilt-from-source).
 *
 * The catalog never takes an author's archive: it rebuilds an exact commit of a public
 * repository and signs what it built. So `submit` checks that the project's HEAD is that
 * commit — a clean tree, pushed to a GitHub repository — writes the declaration
 * `catalog/<id>.yaml` (id, repo, path, version, commit, owners) and opens a pull request
 * on the catalog through the GitHub CLI (`gh`): fork, branch, commit, push, PR. The
 * catalog's own check builds it without secrets and reports what a reviewer reads.
 *
 * `--dry-run` prints the declaration and changes nothing. Every command it runs goes
 * through a `Runner`, so the flow is tested without git or the network.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { ArchiveError } from './archive.ts';
import { isPluginId } from './init.ts';

export const CATALOG_REPOSITORY = 'vaubaan/gateway-plugins';

/** Runs a command and returns its standard output, trimmed; throws on a non-zero exit. */
export type Runner = (command: string, args: readonly string[], cwd: string) => string;

export const runCommand: Runner = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface Declaration {
  readonly id: string;
  /** The service's name (`displayName`), shown before the plugin is installed. */
  readonly name: string;
  readonly repo: string;
  readonly path: string;
  readonly version: string;
  readonly commit: string;
  readonly owners: readonly string[];
}

/** `https://github.com/<owner>/<repo>` from a remote's URL (https or ssh), or null. Pure. */
export function githubRepositoryOf(remote: string): string | null {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    );
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

const OWNER = /^[A-Za-z0-9-]+(\/[A-Za-z0-9_.-]+)?$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The problems the catalog's own check would find (vaubaan/gateway-plugins, declarations.mjs). Pure. */
export function declarationProblems(declaration: Declaration): string[] {
  const problems: string[] = [];
  if (!isPluginId(declaration.id)) problems.push(`id ${declaration.id} is not a lowercase slug`);
  if (
    declaration.name.trim() === '' ||
    declaration.name.length > 80 ||
    declaration.name.includes('#')
  ) {
    problems.push(`name ${declaration.name} must be 1 to 80 characters, without #`);
  }
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(declaration.repo)) {
    problems.push(`repo ${declaration.repo} is not https://github.com/<owner>/<repo>`);
  }
  if (declaration.path.startsWith('/') || declaration.path.split('/').includes('..')) {
    problems.push(`path ${declaration.path} leaves the repository`);
  }
  if (!SEMVER.test(declaration.version))
    problems.push(`version ${declaration.version} is not semver`);
  if (!/^[0-9a-f]{40}$/.test(declaration.commit)) problems.push('commit is not a full sha');
  if (declaration.owners.length === 0)
    problems.push('owners must name at least one GitHub user or team');
  for (const owner of declaration.owners) {
    if (!OWNER.test(owner)) problems.push(`owner ${owner} is not a GitHub user or org/team`);
  }
  return problems;
}

/** The declaration file, in the catalog's flat YAML. Pure. */
export function declarationText(declaration: Declaration): string {
  return [
    `id: ${declaration.id}`,
    `name: ${declaration.name}`,
    `repo: ${declaration.repo}`,
    ...(declaration.path === '.' ? [] : [`path: ${declaration.path}`]),
    `version: ${declaration.version}`,
    `commit: ${declaration.commit}`,
    `owners: [${declaration.owners.join(', ')}]`,
    '',
  ].join('\n');
}

/** The plugin's id, from `SERVICE_ID` in `src/identity.ts` (the one place it is written). */
function pluginIdOf(pluginDir: string): string {
  const identity = readFileSync(join(pluginDir, 'src', 'identity.ts'), 'utf8');
  const match = /export const SERVICE_ID = '([^']+)'/.exec(identity);
  if (!match?.[1]) throw new ArchiveError('src/identity.ts declares no SERVICE_ID');
  return match[1];
}

/** The service's name, from the `displayName` of `src/index.ts` (where `init` writes it). */
function serviceNameOf(pluginDir: string): string {
  const entry = readFileSync(join(pluginDir, 'src', 'index.ts'), 'utf8');
  const match = /displayName:\s*(['"])(.+?)\1/.exec(entry);
  if (!match?.[2]) throw new ArchiveError("src/index.ts declares no displayName: '…'");
  return match[2].replace(/\\(['"])/g, '$1');
}

/** The declaration of the project's HEAD, after checking it is a commit the catalog can build. */
export function declarationOf(
  pluginDir: string,
  options: { readonly owners?: readonly string[]; readonly run: Runner },
): Declaration {
  const git = (...args: string[]): string => options.run('git', args, pluginDir);
  const top = git('rev-parse', '--show-toplevel');
  if (git('status', '--porcelain') !== '') {
    throw new ArchiveError(
      'the working tree has uncommitted changes: the catalog builds a commit, commit them first',
    );
  }
  const commit = git('rev-parse', 'HEAD');
  if (git('branch', '-r', '--contains', commit) === '') {
    throw new ArchiveError(
      `${commit.slice(0, 12)} is on no remote branch: push it first (the catalog builds it from GitHub)`,
    );
  }
  const remote = git('remote', 'get-url', 'origin');
  const repo = githubRepositoryOf(remote);
  if (repo === null) throw new ArchiveError(`origin (${remote}) is not a GitHub repository`);
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof manifest.version !== 'string') throw new ArchiveError('package.json has no version');
  if (!existsLockfile(pluginDir)) {
    throw new ArchiveError(
      'package-lock.json is missing: the catalog installs with `npm ci`, commit the lock file',
    );
  }
  const declaration: Declaration = {
    id: pluginIdOf(pluginDir),
    name: serviceNameOf(pluginDir),
    repo,
    path: relative(top, pluginDir) || '.',
    version: manifest.version,
    commit,
    owners: options.owners ?? [repo.split('/')[3] as string],
  };
  const problems = declarationProblems(declaration);
  if (problems.length > 0) throw new ArchiveError(problems.join('\n'));
  return declaration;
}

function existsLockfile(pluginDir: string): boolean {
  try {
    readFileSync(join(pluginDir, 'package-lock.json'));
    return true;
  } catch {
    return false;
  }
}

/** Opens the pull request on the catalog; returns its URL. */
export function openSubmission(declaration: Declaration, run: Runner): string {
  const work = mkdtempSync(join(tmpdir(), 'vaubaan-submit-'));
  try {
    const clone = join(work, CATALOG_REPOSITORY.split('/')[1] as string);
    const gh = (...args: string[]): string => run('gh', args, work);
    const git = (...args: string[]): string => run('git', args, clone);
    const login = gh('api', 'user', '--jq', '.login');
    // The fork is cloned into a folder named after the repository; origin is the fork.
    gh('repo', 'fork', CATALOG_REPOSITORY, '--clone', '--default-branch-only');
    const branch = `submit/${declaration.id}-${declaration.version}`;
    git('checkout', '-b', branch);
    const file = `catalog/${declaration.id}.yaml`;
    writeFileSync(join(clone, file), declarationText(declaration));
    git('add', file);
    git('commit', '-s', '-m', `${declaration.id} ${declaration.version}`);
    git('push', '--set-upstream', 'origin', branch);
    return run(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        CATALOG_REPOSITORY,
        '--head',
        `${login}:${branch}`,
        '--title',
        `${declaration.id} ${declaration.version}`,
        '--body',
        `Builds ${declaration.repo} at ${declaration.commit} (path ${declaration.path}).`,
      ],
      clone,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
