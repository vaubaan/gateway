/**
 * A new plugin project (intent "Start a plugin project") and one call tried without a
 * gateway (intent "Try a call without a gateway"): `init` renames the template plugin to
 * the new id, the project's own checks pass before any change, and `try` prints the
 * slices, the risks and the decision, its exit code saying whether the call is allowed.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  initProject,
  namesOf,
  parseCommand,
  renameTemplate,
  run,
  SCAFFOLD_DEV_DEPENDENCIES,
  tryProjectCall,
} from '../../src/index.ts';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

describe('the names of a plugin id', () => {
  it('derives every case from the id', () => {
    expect(namesOf('acme-crm')).toEqual({
      id: 'acme-crm',
      camel: 'acmeCrm',
      pascal: 'AcmeCrm',
      upper: 'ACME_CRM',
      displayName: 'Acme Crm',
    });
    expect(namesOf('acme', 'ACME Inc.').displayName).toBe('ACME Inc.');
  });

  it('refuses what is not a plugin id', () => {
    for (const id of ['Acme', 'acme_crm', '-acme', 'acme-', '1acme', 'ac me', '']) {
      expect(() => namesOf(id), id).toThrow(/not a plugin id/);
    }
  });

  it('renames identifiers, constants and the service id each in its own case', () => {
    const names = namesOf('acme-crm', "Acme's CRM");
    expect(
      renameTemplate(
        [
          "export const SERVICE_ID = 'template';",
          'export function classifyTemplate() {}',
          'export const templateExamples = TEMPLATE_API_BASE;',
          "displayName: 'Template service',",
          "matches: 'template.workspace[**].W'",
          '// Replace with the real base URL in a copy of this template.',
        ].join('\n'),
        names,
      ),
    ).toBe(
      [
        "export const SERVICE_ID = 'acme-crm';",
        'export function classifyAcmeCrm() {}',
        'export const acmeCrmExamples = ACME_CRM_API_BASE;',
        "displayName: 'Acme\\'s CRM',",
        "matches: 'acme-crm.workspace[**].W'",
        '// Replace with the real base URL in this plugin.',
      ].join('\n'),
    );
  });
});

describe('a new plugin project', () => {
  let parent: string;
  let dir: string;

  beforeAll(() => {
    parent = mkdtempSync(join(tmpdir(), 'vbn-init-'));
    dir = join(parent, 'acme-crm');
    initProject({ dir, id: 'acme-crm', displayName: 'Acme CRM' });
    // What `npm install` would bring: the repository's own packages.
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir');
  });

  afterAll(() => rmSync(parent, { recursive: true, force: true }));

  it('is the template under the new id, standalone', () => {
    expect(readFileSync(join(dir, 'src/identity.ts'), 'utf8')).toContain(
      "export const SERVICE_ID = 'acme-crm';",
    );
    expect(readFileSync(join(dir, 'src/risk-catalog.yaml'), 'utf8')).toMatch(
      /^service: acme-crm$/m,
    );
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest).toMatchObject({ name: 'vaubaan-plugin-acme-crm', version: '0.1.0' });
    expect(manifest.scripts).toMatchObject({
      check: 'tsc --noEmit && vitest run',
      build: 'vaubaan-plugin build',
      sign: 'vaubaan-plugin sign dist/plugin --key "$VAUBAAN_SIGNING_KEY"',
    });
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toContain("version: '0.1.0'");
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('*.key.pem');
    expect(existsSync(join(dir, 'README.md.tsbuildinfo'))).toBe(false);
  });

  it('holds the instructions and skills for the coding agents, named for the plugin', () => {
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8').trim()).toBe('@AGENTS.md');
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('acme-crm');
    expect(agents).not.toContain('{{');
    for (const skill of ['vaubaan-model-service', 'vaubaan-classify', 'vaubaan-ship']) {
      const claude = readFileSync(join(dir, '.claude/skills', skill, 'SKILL.md'), 'utf8');
      expect(claude).toMatch(/^---\nname: /);
      // Each skill ends on the command that says whether its step is done.
      expect(claude).toMatch(/Done when/);
      expect(readFileSync(join(dir, '.agents/skills', skill, 'SKILL.md'), 'utf8')).toBe(claude);
    }
  });

  it('pins the development tools the gateway itself is checked with', () => {
    const root = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    for (const [name, version] of Object.entries(SCAFFOLD_DEV_DEPENDENCIES)) {
      expect(root.devDependencies[name], name).toBe(version);
    }
  });

  it('passes its own checks before any change', () => {
    const tsc = spawnSync(
      process.execPath,
      [join(REPO, 'node_modules/typescript/bin/tsc'), '--noEmit'],
      {
        cwd: dir,
        encoding: 'utf8',
      },
    );
    expect(tsc.stdout + tsc.stderr).toBe('');
    expect(tsc.status).toBe(0);
    const vitest = spawnSync(
      process.execPath,
      [join(REPO, 'node_modules/vitest/vitest.mjs'), 'run', '--root', dir],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '1' } },
    );
    expect(vitest.status, vitest.stdout + vitest.stderr).toBe(0);
    // A runner may force colours (FORCE_COLOR on GitHub): read the summary without them.
    // eslint-disable-next-line no-control-regex
    expect(vitest.stdout.replace(/\u001b\[[0-9;]*m/g, '')).toMatch(/Tests\s+\d+ passed/);
  }, 120_000);

  it('refuses a directory that is not empty', () => {
    expect(() => initProject({ dir, id: 'other' })).toThrow(/not empty/);
    const withGit = join(parent, 'with-git');
    mkdirSync(join(withGit, '.git'), { recursive: true });
    expect(() => initProject({ dir: withGit, id: 'other' })).not.toThrow();
  });

  it('tries a call under every macro-action at Careful: a prod write waits for a person', async () => {
    const report = await tryProjectCall({
      pluginDir: dir,
      tool: 'acme_crm__update_widget',
      args: '{"workspace":"ws-prd","widget_id":"w1","name":"x"}',
      resources: 'ws-stg:staging,ws-prd:prod',
    });
    expect(report.allowed).toBe(true);
    expect(report.lines.join('\n')).toContain('slices    acme-crm.workspace[ws-prd].widget[w1].W');
    expect(report.lines.join('\n')).toContain('acme-crm[prod].widget-write (gate: approval)');
    expect(report.lines.at(-1)).toMatch(/once a person approves/);
  }, 60_000);

  it('refuses a call whose risks the mission did not accept, and says which', async () => {
    const report = await tryProjectCall({
      pluginDir: dir,
      tool: 'acme_crm__delete_widget',
      accept: 'acme-crm.read-widgets',
    });
    expect(report.allowed).toBe(false);
    expect(report.lines.join('\n')).toMatch(/refused: .*acme-crm\[staging\]\.widget-delete/);
  }, 60_000);

  it('exits 1 when the classifier denies the call, 2 on a usage error', async () => {
    const out: string[] = [];
    const io = {
      cwd: dir,
      log: (line: string) => out.push(line),
      error: (line: string) => out.push(line),
    };
    expect(await run(['try', 'acme_crm__list_widgets', '{"workspace":"other"}'], io)).toBe(1);
    expect(out.at(-1)).toMatch(/denied by the classifier/);
    expect(await run(['try', 'acme_crm__list_widgets', '--trust', 'reckless'], io)).toBe(2);
    expect(await run(['try', 'nope'], io)).toBe(1);
    expect(out.at(-1)).toMatch(/has no tool nope; its tools: acme_crm__list_widgets/);
  }, 60_000);
});

describe('the command line', () => {
  it('parses init and try', () => {
    expect(parseCommand(['init', 'x', '--id', 'acme', '--name', 'Acme'], '/w')).toEqual({
      name: 'init',
      dir: '/w/x',
      id: 'acme',
      displayName: 'Acme',
    });
    expect(parseCommand(['try', 't', '{}', '--accept', 'a.b'], '/w')).toMatchObject({
      name: 'try',
      pluginDir: '/w',
      tool: 't',
      args: '{}',
      accept: 'a.b',
    });
    expect(() => parseCommand(['init', 'x'], '/w')).toThrow(/usage/);
  });

  it('writes nothing over an existing file', () => {
    const at = mkdtempSync(join(tmpdir(), 'vbn-init-file-'));
    writeFileSync(join(at, 'notes.txt'), 'mine');
    expect(() => initProject({ dir: at, id: 'acme' })).toThrow(/not empty/);
    expect(readFileSync(join(at, 'notes.txt'), 'utf8')).toBe('mine');
    rmSync(at, { recursive: true, force: true });
  });
});
