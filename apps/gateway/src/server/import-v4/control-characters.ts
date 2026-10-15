/**
 * Text from the v4 database (project names, refs, labels) printed in the
 * importer's report: a newline or an escape sequence in it must not forge a
 * line or drive the operator's terminal.
 */

/** Every C0 and C1 control character (newline, escape, …) replaced by a blank. */
export function withoutControlCharacters(line: string): string {
  let out = '';
  for (const char of line) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : char;
  }
  return out;
}
