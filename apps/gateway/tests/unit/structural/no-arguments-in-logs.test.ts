/**
 * Structural test (spec §6 "No secret in logs. Mission tokens are logged by
 * prefix. Call arguments are never logged in clear, only hashed").
 *
 * Read from the source with the TypeScript parser: every call of a logger
 * (`.debug`, `.info`, `.warn`, `.error` on something named like a logger) in
 * the server code and in the packages it runs. What such a call is given must
 * not be the arguments of a tool call, a bearer, or a credential:
 *
 *   - no identifier or property named like call arguments (`args`,
 *     `arguments`, `rawArgs`, `input`, `params`, `body`, `form`);
 *   - no identifier or property named like a secret (`token`, `secret`,
 *     `bearer`, `password`, `credential`, `authorization`, `cookie`, …) unless
 *     its name says it is a non-secret derivative (`token_prefix`,
 *     `arguments_hash`, `has_secret`, …).
 *
 * A static check cannot prove what a value holds. It holds the *naming*: a
 * line that logs `{ args }` or `{ token }` does not pass review by accident.
 * What the running instance actually writes is checked at the door
 * (`tests/integration/execution/door-http.test.ts`, "writes no secret and no
 * argument to the logs") and by the redactor
 * (`src/server/logging/logging.test.ts`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SCANNED = [
  'apps/gateway/src/server',
  'packages/gateway-core/src',
  'packages/policy-engine/src',
  'packages/plugin-sdk/src',
  'packages/telemetry/src',
  'packages/shared/src',
];
const SKIPPED_FILE = /\.test\.tsx?$|\/testing\.ts$|\.d\.ts$/;
const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error']);
const LOGGER_NAME = /(?:^|\.)(?:logger|log)$/i;

/** Names that are the arguments of a call, or a request body. */
const ARGUMENT_NAME = /^(?:args|arguments|raw_?args|call_?args|input|params|body|form|payload)$/i;
/** Names that carry a secret… */
const SECRET_NAME =
  /(?:token|secret|bearer|password|passphrase|credential|authorization|cookie|private_?key|api_?key|master_?key|refresh|verifier|\bcode\b)/i;
/** …unless the name says it is what may be shown of one. */
const SAFE_DERIVATIVE =
  /(?:prefix|hash|digest|fingerprint|_id$|Id$|^has_|^has[A-Z]|count|length|kind|type|status|state|ttl|expires|expiry|_at$|At$|name$|label$|^refusal_code$|^error_code$|^code$|^status_code$|^exit_code$|reason$|^token_endpoint|endpoint$|_alg$|method$|^grant$|^outcome$|version$|^key$|^key_version$|^env$|^remedy$|_field$|^credential_kind$|^presented$|^expected$|rotated|revoked|reuse_window)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !SKIPPED_FILE.test(path) ? [path] : [];
  });
}

interface Offence {
  readonly where: string;
  readonly name: string;
  readonly why: 'arguments' | 'secret';
}

function classify(name: string): Offence['why'] | null {
  if (ARGUMENT_NAME.test(name)) return 'arguments';
  if (SECRET_NAME.test(name) && !SAFE_DERIVATIVE.test(name)) return 'secret';
  return null;
}

/** Every name a log call's arguments mention: property keys, and the values handed over. */
function namesIn(node: ts.Node, source: ts.SourceFile, out: string[]): void {
  if (ts.isPropertyAssignment(node)) {
    // The key is what the line will read; a key that is a safe derivative vouches for
    // its value (`token_prefix: token.prefix`), any other key does not.
    const key = node.name.getText(source).replace(/^['"]|['"]$/g, '');
    out.push(key);
    if (classify(key) === null && SAFE_DERIVATIVE.test(key)) return;
    namesIn(node.initializer, source, out);
    return;
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    out.push(node.name.text);
    return;
  }
  if (ts.isPropertyAccessExpression(node)) {
    // `mission.id`, `err.message`: the last name is what is logged.
    out.push(node.name.text);
    return;
  }
  if (ts.isIdentifier(node)) {
    out.push(node.text);
    return;
  }
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return;
  ts.forEachChild(node, (child) => namesIn(child, source, out));
}

/** The logger calls of one file, as the parser sees them. */
function logCallsOf(file: string): { source: ts.SourceFile; calls: ts.CallExpression[] } {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      LOG_METHODS.has(node.expression.name.text) &&
      LOGGER_NAME.test(node.expression.expression.getText(source))
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { source, calls };
}

function offencesOf(file: string): Offence[] {
  const { source, calls } = logCallsOf(file);
  const found: Offence[] = [];
  for (const call of calls) {
    // The first argument is the message; what follows is the structured context.
    for (const argument of call.arguments.slice(1)) {
      const names: string[] = [];
      namesIn(argument, source, names);
      for (const name of names) {
        const why = classify(name);
        if (!why) continue;
        const { line } = source.getLineAndCharacterOfPosition(call.getStart(source));
        found.push({ where: `${relative(REPO, file)}:${line + 1}`, name, why });
      }
    }
  }
  return found;
}

describe('no log line is handed call arguments or a secret', () => {
  const files = SCANNED.flatMap((dir) => sourceFiles(join(REPO, dir)));

  it('scans the server and the packages it runs, and finds their log calls', () => {
    expect(files.length).toBeGreaterThan(150);
    const calls = files.reduce((count, file) => count + logCallsOf(file).calls.length, 0);
    expect(calls).toBeGreaterThan(80);
  });

  it('no logger call names call arguments, a request body or a secret', () => {
    expect(files.flatMap(offencesOf)).toEqual([]);
  });

  it('the scan sees what it is meant to see (a planted offence is reported)', () => {
    const planted = join(REPO, 'apps/gateway/src/server/__planted__.ts');
    const offences = (code: string): string[] => {
      const source = ts.createSourceFile(planted, code, ts.ScriptTarget.ES2022, true);
      const names: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          for (const argument of node.arguments.slice(1)) namesIn(argument, source, names);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return names.filter((name) => classify(name) !== null);
    };
    expect(offences(`logger.info('call', { args });`)).toEqual(['args']);
    expect(offences(`logger.info('call', { tool, detail: call.args });`)).toEqual(['args']);
    expect(offences(`this.deps.logger.warn('x', { token: bearer });`)).toEqual(['token', 'bearer']);
    expect(offences(`logger.info('x', { client_secret: s });`)).toEqual(['client_secret']);
    // What may be shown of them passes.
    expect(
      offences(`logger.info('x', { token_prefix: token.prefix, arguments_hash: h });`),
    ).toEqual([]);
    expect(offences(`logger.info('x', { mission_id: mission.id, refusal_code: r.code });`)).toEqual(
      [],
    );
  });
});
