/**
 * The plugin author's guide (`content/docs/plugins-guide`, website spec §2.2 bis) holds three
 * hand-written references, each checked here against the code it describes:
 *
 * - the command line: every usage line of `vaubaan-plugin` (`USAGE` in the CLI) is on the page,
 *   verbatim, and the page documents no command the CLI does not have;
 * - the risk catalog file: every value of the five facts (`RISK_VECTOR_AXES`), the row words,
 *   the gate of each row at each trust level and the budget factors are the policy engine's,
 *   and the narrative limit is the loader's;
 * - when something fails: every message quoted in the first column is written, piece by piece
 *   around its `…`, in the sources of the SDK, the CLI, the scaffold or the gateway.
 *
 * The guide itself uses the published kit only: no page sends an author into the gateway's
 * repository for a procedure.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  gateWordOf,
  GATE_WORDS,
  ROW_WORDS,
  TRUST_LEVEL_BUDGET_FACTOR,
  TRUST_LEVEL_GATES,
  TRUST_LEVEL_LABELS,
  TRUST_LEVELS,
} from '@vaubaan/policy-engine';
import { RISK_VECTOR_AXES } from '@vaubaan/shared';

import { readRepoFile, REPO_ROOT } from '../../../src/content/repo';

const GUIDE = 'apps/website/content/docs/plugins-guide';
const page = (name: string): string => readRepoFile(`${GUIDE}/${name}.mdx`);

/** The usage lines of the CLI, as `vaubaan-plugin <command> …`, without their trailing note. */
function usageLines(): string[] {
  const source = readRepoFile('packages/plugin-cli/src/cli.ts');
  const block = /export const USAGE = \[([\s\S]*?)\]\.join/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/(['"])(.*?)\1,?\s*$/gm)].map((match) =>
    (match[2] ?? '')
      .replace(/^usage:\s*/, '')
      .trim()
      .split(/\s{2,}/)[0]!
      .trim(),
  );
}

/** Every file under a folder of the repository, as text. */
function sourcesUnder(...dirs: string[]): string {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (name === 'node_modules' || name === 'dist') return [];
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [readFileSync(path, 'utf8')];
    });
  return dirs.flatMap((dir) => walk(join(REPO_ROOT, dir))).join('\n');
}

/** The first cell of each row of every table of a page, past the header and the rule. */
function firstCells(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('| ') && !/^\|\s*-/.test(line))
    .map((line) => line.split(/(?<!\\)\|/)[1]?.trim() ?? '')
    .filter((cell) => !['Message', 'Symptom or message'].includes(cell));
}

describe('the command line reference', () => {
  const reference = page('reference/cli');

  it('carries every usage line of vaubaan-plugin, verbatim', () => {
    const lines = usageLines();
    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const line of lines) expect(reference, line).toContain(`\n${line}\n`);
  });

  it('documents no command the CLI does not have', () => {
    const commands = new Set(usageLines().map((line) => line.split(' ')[1]));
    const headings = [...reference.matchAll(/^## (\S+)$/gm)].map((match) => match[1]);
    expect(new Set(headings)).toEqual(commands);
  });
});

describe('the risk catalog file reference', () => {
  const reference = page('reference/catalog');

  it('lists every value of the five facts', () => {
    for (const [axis, values] of Object.entries(RISK_VECTOR_AXES)) {
      const row = reference.split('\n').find((line) => line.startsWith(`| \`${axis}\``));
      expect(row, axis).toBeDefined();
      for (const value of values) expect(row, `${axis}: ${value}`).toContain(`\`${value}\``);
    }
  });

  it('writes the gate of each row at each trust level, and the budget factors, as the policy engine does', () => {
    const header = reference
      .split('\n')
      .find((line) => line.startsWith('| Row') && line.includes(TRUST_LEVEL_LABELS.careful));
    const cells = (line: string | undefined): string[] =>
      (line ?? '')
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
    expect(cells(header).slice(1)).toEqual(TRUST_LEVELS.map((level) => TRUST_LEVEL_LABELS[level]));
    for (const row of [4, 3, 2, 1] as const) {
      const label = `${row} · ${ROW_WORDS[row]}`;
      const line = reference
        .split('\n')
        .filter((l) => l.startsWith(`| ${label} `))
        .find((l) => cells(l).length === TRUST_LEVELS.length + 1);
      expect(line, label).toBeDefined();
      expect(cells(line).slice(1), label).toEqual(
        TRUST_LEVELS.map((level) => {
          const gate = TRUST_LEVEL_GATES[level][row];
          return gate === null ? GATE_WORDS.off : GATE_WORDS[gateWordOf(gate)];
        }),
      );
    }
    const budget = reference.split('\n').find((line) => line.startsWith('| Budget'));
    expect(cells(budget).slice(1)).toEqual(
      TRUST_LEVELS.map((level) => `×${TRUST_LEVEL_BUDGET_FACTOR[level]}`),
    );
  });

  it('gives the narrative the loader’s limit', () => {
    const limit = /NARRATIVE_MAX_LENGTH = (\d+)/.exec(
      readRepoFile('packages/plugin-sdk/src/catalog-document.ts'),
    )?.[1];
    expect(reference).toContain(`string, ${limit} characters at most`);
  });
});

describe('the reference of what fails', () => {
  it('quotes messages the kit and the gateway really write', () => {
    const sources = sourcesUnder(
      'packages/plugin-sdk/src',
      'packages/plugin-cli/src',
      'packages/shared/src',
      'apps/gateway/src',
      'plugins/_template',
    );
    const quoted = firstCells(page('reference/errors')).flatMap((cell) =>
      [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ''),
    );
    expect(quoted.length).toBeGreaterThan(10);
    const missing: string[] = [];
    for (const message of quoted) {
      for (const piece of message.split('…')) {
        const text = piece.replace(/^[\s;:,.(]+|[\s;:,(]+$/g, '');
        if (text.length >= 6 && !sources.includes(text)) missing.push(`${message} → ${text}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('the guide', () => {
  it('sends an author to no path of the gateway repository for a procedure', () => {
    const files = readdirSync(join(REPO_ROOT, GUIDE), { recursive: true }).filter((name) =>
      String(name).endsWith('.mdx'),
    );
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const file of files) {
      const text = readRepoFile(`${GUIDE}/${String(file)}`);
      expect(text, String(file)).not.toMatch(
        /github\.com\/vaubaan\/gateway\/(?:blob|tree)\/main\/(?:plugins|packages|docs\/(?:handbook|decisions|skills))\//,
      );
    }
  });
});
