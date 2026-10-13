import { describe, expect, test } from 'vitest';
import { materializeArgs } from '../../src/bash/args.ts';
import type { ParsedTool } from '../../src/bash/parse.ts';

function tool(args: ParsedTool['args']): ParsedTool {
  return { functionName: 'f', ring: 'r', action: 'read', args };
}

describe('materializeArgs', () => {
  test('returns empty argv when tool declares no args', () => {
    expect(materializeArgs(tool([]), {})).toEqual({ ok: true, argv: [] });
  });

  test('forwards a provided string in declared positional order', () => {
    const t = tool([
      { name: 'version', type: 'string', required: true },
      { name: 'env', type: 'string', required: false },
    ]);
    expect(materializeArgs(t, { env: 'prod', version: 'v1.2.3' })).toEqual({
      ok: true,
      argv: ['v1.2.3', 'prod'],
    });
  });

  test('stringifies numeric values', () => {
    const t = tool([{ name: 'lines', type: 'integer', required: false, defaultValue: '200' }]);
    expect(materializeArgs(t, { lines: 500 })).toEqual({
      ok: true,
      argv: ['500'],
    });
  });

  test('returns an error when a required arg has no default and is missing', () => {
    const t = tool([{ name: 'version', type: 'string', required: true }]);
    expect(materializeArgs(t, {})).toEqual({
      ok: false,
      error: "arg 'version' is required",
    });
  });

  test('returns an error when a required arg has no default and is empty string', () => {
    const t = tool([{ name: 'version', type: 'string', required: true }]);
    expect(materializeArgs(t, { version: '' })).toEqual({
      ok: false,
      error: "arg 'version' is required",
    });
  });

  test('falls back to defaultValue when required arg is missing but a default exists', () => {
    // Edge case : required + default is admittedly weird but the parser
    // allows it (treat the default as the rescue value).
    const t = tool([{ name: 'version', type: 'string', required: true, defaultValue: 'latest' }]);
    expect(materializeArgs(t, {})).toEqual({ ok: true, argv: ['latest'] });
  });

  test('falls back to defaultValue when optional arg is missing', () => {
    const t = tool([{ name: 'lines', type: 'integer', required: false, defaultValue: '200' }]);
    expect(materializeArgs(t, {})).toEqual({ ok: true, argv: ['200'] });
  });

  test("pushes '' when optional arg is missing AND has no default", () => {
    // Script must tolerate empty $N (e.g. `${1:-fallback}`).
    const t = tool([{ name: 'tag', type: 'string', required: false }]);
    expect(materializeArgs(t, {})).toEqual({ ok: true, argv: [''] });
  });

  test('preserves source order across mixed required/optional/default cases', () => {
    const t = tool([
      { name: 'a', type: 'string', required: true }, // raw → provided
      { name: 'b', type: 'string', required: false, defaultValue: 'B' }, // missing → default
      { name: 'c', type: 'string', required: false }, // missing → ''
      { name: 'd', type: 'integer', required: false }, // numeric → string
    ]);
    expect(materializeArgs(t, { a: 'A', d: 4 })).toEqual({
      ok: true,
      argv: ['A', 'B', '', '4'],
    });
  });
});
