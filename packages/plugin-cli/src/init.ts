/**
 * `vaubaan-plugin init <dir> --id <id>`: a new plugin project, outside the gateway's
 * repository (spec plugin-authoring §0 "Scaffold", intent "Start a plugin project").
 *
 * The project is the gateway's own template plugin (`plugins/_template`: an imaginary
 * service of widgets in workspaces, complete and tested) renamed to the new id, made
 * standalone (its own package.json, tsconfig, .gitignore), with the author's agent
 * instructions and skills (`scaffold/`, copied to `.claude/skills` and `.agents/skills`).
 * Its checks pass before any change: `npm install && npm run check`.
 *
 * The template is read from the package's own `template/` folder once published (the
 * publication copies `plugins/_template` there), else from the repository it runs in.
 *
 * Renaming is textual, by case: `TEMPLATE` → `ACME_CRM`, `Template` → `AcmeCrm`,
 * `template` before a capital → `acmeCrm` (identifiers), any other `template` → `acme-crm`
 * (the service id in strings, slices and the risk catalog). The template keeps its ids in
 * `src/identity.ts`, so the words left are names, never logic.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SDK_VERSION } from '@vaubaan/plugin-sdk';

import { ArchiveError } from './archive.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');

/**
 * The plugin id grammar: a lowercase slug, words of letters and digits joined by single
 * dashes, as `toolPrefixFor` and the catalog loader expect. A flat character class and
 * two plain checks, no nested quantifier.
 */
export function isPluginId(id: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(id) && !id.endsWith('-') && !id.includes('--');
}

/** What a new project's development dependencies are pinned to (the gateway's own pins). */
export const SCAFFOLD_DEV_DEPENDENCIES = {
  '@types/node': '26.6.6',
  typescript: '6.0.3',
  vitest: '5.0.5',
} as const;

/** The version a new plugin starts at, in package.json and `definePlugin`. */
export const SCAFFOLD_VERSION = '0.1.0';

export interface InitOptions {
  readonly dir: string;
  readonly id: string;
  /** The service's name as people read it; from the id when absent (`acme-crm` → `Acme Crm`). */
  readonly displayName?: string;
}

export interface InitResult {
  readonly dir: string;
  readonly id: string;
  readonly files: number;
}

/** The names a plugin id is written under. */
export interface PluginNames {
  readonly id: string;
  readonly camel: string;
  readonly pascal: string;
  readonly upper: string;
  readonly displayName: string;
}

export function namesOf(id: string, displayName?: string): PluginNames {
  if (!isPluginId(id)) {
    throw new ArchiveError(
      `"${id}" is not a plugin id: lowercase letters, digits and dashes (acme-crm)`,
    );
  }
  const words = id.split('-');
  const cap = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
  return {
    id,
    camel: words[0] + words.slice(1).map(cap).join(''),
    pascal: words.map(cap).join(''),
    upper: words.map((word) => word.toUpperCase()).join('_'),
    displayName: displayName?.trim() || words.map(cap).join(' '),
  };
}

/** The template's text renamed to `names` (see the file's header). Pure. */
export function renameTemplate(text: string, names: PluginNames): string {
  return text
    .replace(/'Template service'/g, `'${names.displayName.replace(/'/g, "\\'")}'`)
    .replace(/\b(?:a copy of )?this template\b/g, 'this plugin')
    .replace(/TEMPLATE/g, names.upper)
    .replace(/Template/g, names.pascal)
    .replace(/template(?=[A-Z])/g, names.camel)
    .replace(/template/g, names.id);
}

/** Where the template plugin is: the published package's copy, else the repository's. */
export function templateDir(): string {
  const published = join(PACKAGE_ROOT, 'template');
  if (existsSync(published)) return published;
  const repository = join(PACKAGE_ROOT, '..', '..', 'plugins', '_template');
  if (existsSync(repository)) return repository;
  throw new ArchiveError(
    'the template plugin is missing from this installation of @vaubaan/plugin-cli',
  );
}

/** The agent instructions and skills a project ships with. */
export function scaffoldDir(): string {
  return join(PACKAGE_ROOT, 'scaffold');
}

function cliVersion(): string {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

function walk(root: string, at = root): string[] {
  return readdirSync(at).flatMap((name) => {
    const path = join(at, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(root, path);
    return [relative(root, path)];
  });
}

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    lib: ['ES2022'],
    module: 'ESNext',
    moduleResolution: 'Bundler',
    types: ['node'],
    strict: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
    noFallthroughCasesInSwitch: true,
    useUnknownInCatchVariables: true,
    isolatedModules: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    noEmit: true,
  },
  include: ['src/**/*', 'tests/**/*'],
};

const GITIGNORE = ['node_modules/', 'dist/', '*.key.pem', '*.tsbuildinfo', ''].join('\n');

function packageJson(names: PluginNames): object {
  return {
    name: `vaubaan-plugin-${names.id}`,
    version: SCAFFOLD_VERSION,
    private: true,
    type: 'module',
    description: `Vaubaan Gateway plugin for ${names.displayName}`,
    license: 'UNLICENSED',
    exports: { '.': './src/index.ts' },
    scripts: {
      check: 'tsc --noEmit && vitest run',
      test: 'vitest run',
      build: 'vaubaan-plugin build',
      try: 'vaubaan-plugin try',
      // The company key lives outside the project (skill vaubaan-ship); CI sets the path.
      sign: 'vaubaan-plugin sign dist/plugin --key "$VAUBAAN_SIGNING_KEY"',
    },
    dependencies: { '@vaubaan/plugin-sdk': `^${SDK_VERSION}` },
    devDependencies: { '@vaubaan/plugin-cli': `^${cliVersion()}`, ...SCAFFOLD_DEV_DEPENDENCIES },
  };
}

/** Writes a new project in `dir`, which must be absent or empty. */
export function initProject(options: InitOptions): InitResult {
  const names = namesOf(options.id, options.displayName);
  const { dir } = options;
  if (existsSync(dir) && readdirSync(dir).some((name) => name !== '.git')) {
    throw new ArchiveError(`${dir} is not empty: nothing was written`);
  }
  mkdirSync(dir, { recursive: true });
  let files = 0;
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    files += 1;
  };

  const template = templateDir();
  for (const path of walk(template)) {
    if (!/^(src|tests)\//.test(path) || path.endsWith('.tsbuildinfo')) continue;
    const text = readFileSync(join(template, path), 'utf8');
    let renamed = renameTemplate(text, names);
    if (path === 'src/index.ts') {
      renamed = renamed.replace(/version: '[^']+'/, `version: '${SCAFFOLD_VERSION}'`);
    }
    write(path, renamed);
  }

  const scaffold = scaffoldDir();
  if (existsSync(scaffold)) {
    for (const path of walk(scaffold)) {
      const text = readFileSync(join(scaffold, path), 'utf8')
        .replace(/\{\{id\}\}/g, names.id)
        .replace(/\{\{displayName\}\}/g, names.displayName);
      write(path, text);
    }
    const skills = join(dir, '.claude', 'skills');
    if (existsSync(skills)) cpSync(skills, join(dir, '.agents', 'skills'), { recursive: true });
  }

  write('package.json', `${JSON.stringify(packageJson(names), null, 2)}\n`);
  write('tsconfig.json', `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  write('.gitignore', GITIGNORE);
  return { dir, id: names.id, files };
}
