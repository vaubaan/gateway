/**
 * Tool argument resolution — turn the caller-supplied `{ name: value }`
 * map into the positional `argv: string[]` that `buildToolInvocation`
 * sends through `bash -s --`.
 *
 * Rules (mirror of the parser's args contract — required / optional /
 * default) :
 *  - Iterate over the tool's declared args in source order (positional).
 *  - Missing-or-empty raw value :
 *      • required + no default → user error.
 *      • required + default     → use default (i.e. default rescues required).
 *      • optional + default     → use default.
 *      • optional + no default  → push '' (the script must tolerate
 *        empty $N, e.g. `${1:-fallback}`).
 *  - Present raw value → stringify it (numbers → decimal string).
 *
 * Returned as a discriminated union so callers map the `error` to their
 * own protocol — HTTP 400, MCP error, etc. — without re-implementing the
 * rule. This is the same domain logic the future `/mcp` dispatch will
 * need ; keeping it here makes that wiring a one-import job.
 */

import type { ParsedTool } from './parse.ts';

export type RawArgs = Record<string, string | number>;

export type MaterializeResult = { ok: true; argv: string[] } | { ok: false; error: string };

export function materializeArgs(tool: ParsedTool, raw: RawArgs): MaterializeResult {
  const argv: string[] = [];
  for (const arg of tool.args) {
    const provided = raw[arg.name];
    if (provided === undefined || provided === '') {
      if (arg.required && arg.defaultValue === undefined) {
        return { ok: false, error: `arg '${arg.name}' is required` };
      }
      argv.push(arg.defaultValue ?? '');
      continue;
    }
    argv.push(String(provided));
  }
  return { ok: true, argv };
}
