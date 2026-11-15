/**
 * Property-based tests of the shell reading of the `ssh` plugin: the command
 * line is the agent's, so the lexer and the classifier are fed generated
 * shell-shaped text (quotes, expansions, substitutions, separators,
 * redirections, globs, braces, control characters) and arbitrary strings.
 *
 * Properties: nothing throws, and the reading fails closed — a destructive
 * command after `;` is never hidden by what precedes it, and a word quoted
 * whole is read back as the literal it is. Seeded and replayable
 * (`propertyRuns`, FC_SEED / FC_RUNS).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { serializeSlice, type Resource } from '@vaubaan/plugin-sdk';
import { propertyRuns } from '@vaubaan/plugin-sdk/testing';

import { classifySsh } from '../../src/classify.ts';
import { lexCommandLine } from '../../src/shell-lex.ts';

const HOST = 'staging-vps';
const MISSION: readonly Resource[] = [
  { service: 'ssh', ref: HOST, env: 'staging', displayName: `deploy@${HOST}:22` },
];

/**
 * Fragments of shell syntax. `#` and the backslash are left out of the
 * prefix generator on purpose: a comment, or a backslash-newline, really
 * does change what the shell runs after it, and the property below is about
 * a command the shell does run.
 */
const FRAGMENTS = [
  'ls',
  'cat',
  'grep',
  'echo',
  'sudo',
  'env',
  'x',
  '-la',
  '/etc/hostname',
  '~/.ssh',
  ' ',
  '\t',
  '\n',
  ';',
  '&&',
  '||',
  '|',
  '&',
  '(',
  ')',
  '{',
  '}',
  '<',
  '>',
  '>>',
  '2>&1',
  '<<',
  "'",
  '"',
  '$',
  '$(',
  '${',
  '`',
  '*',
  '?',
  '[',
  ']',
  '=',
  'a=b',
  '\u0001',
  'é',
] as const;

const shellish = fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 30 }).map((p) => p.join(''));
const anyText = fc.oneof(
  shellish,
  fc.string({ maxLength: 200 }),
  fc.string({ unit: 'binary', maxLength: 80 }),
);

function suffixes(cmd: string): string[] | 'denied' {
  const out = classifySsh('ssh__exec', { cmd }, MISSION);
  if ('denied' in out) return 'denied';
  const prefix = `ssh.host[${HOST}].command`;
  return out.slices.map(serializeSlice).map((s) => s.slice(prefix.length));
}

describe('SSH shell reading — properties', () => {
  it('the lexer and the classifier never throw', () => {
    fc.assert(
      fc.property(anyText, (line) => {
        lexCommandLine(line);
        suffixes(line);
      }),
      propertyRuns(),
    );
  });

  it('a destructive command after `;` is never hidden by what precedes it', () => {
    fc.assert(
      fc.property(shellish, (prefix) => {
        const read = suffixes(`${prefix} ; rm -rf /srv/data`);
        if (read === 'denied') return;
        expect(read).toContain('.destructive.W');
        expect(read).not.toEqual(['.R']);
      }),
      propertyRuns(),
    );
  });

  it('a word in single quotes is the literal it holds', () => {
    const literal = fc.string({ maxLength: 40 }).filter((s) => !s.includes("'"));
    fc.assert(
      fc.property(literal, (text) => {
        const lexed = lexCommandLine(`echo '${text}'`);
        if (lexed.malformed || lexed.opaque.length > 0) return; // a control character, say
        const words = lexed.commands[0]?.words ?? [];
        expect(words.map((w) => w.value)).toEqual(['echo', text]);
        expect(words[1]?.bare.every((flag) => !flag)).toBe(true);
      }),
      propertyRuns(),
    );
  });
});
