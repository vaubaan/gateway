/**
 * Structural test (spec §6 "No secret in logs. Mission tokens are logged by
 * prefix. Call arguments are never logged in clear, only hashed").
 *
 * Read from the source with the TypeScript parser: every call of a logger in
 * the server code and in the packages it runs. A logger call is `.debug`,
 * `.info`, `.warn`, `.error` or `.child` on something named like a logger, or
 * a call of a local name bound to one of those (`const log =
 * logger.warn.bind(logger)`). What such a call is given — its message when it
 * is built from values, and everything after it — must not be the arguments of
 * a tool call, a bearer, or a credential:
 *
 *   - no identifier or property named like call arguments (`args`,
 *     `arguments`, `rawArgs`, `input`, `params`, `body`, `form`);
 *   - no identifier or property named like a secret (`token`, `secret`,
 *     `bearer`, `password`, `credential`, `authorization`, `cookie`, …) unless
 *     its name says it is a non-secret derivative (`token_prefix`,
 *     `arguments_hash`, `has_secret`, …). A key named like a derivative does
 *     not vouch for a value that is named like the secret itself
 *     (`{ token_prefix: bearer }` is reported);
 *   - no object that carries them, handed over whole (`headers`, `request`,
 *     `req`, `call`, `ctx`), as a value, a shorthand or a spread;
 *   - no `reason` of a refused call: the caller-facing reason quotes a plugin's
 *     free text. The log lines that carry a reason of another kind are listed
 *     below, one by one.
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
/** `logger.child({ … })`: what it is given is written on every later line. */
const BINDING_METHOD = 'child';
const LOGGER_NAME = /(?:^|\.)(?:logger|log)$/i;

/** Names that are the arguments of a call, or a request body. */
const ARGUMENT_NAME = /^(?:args|arguments|raw_?args|call_?args|input|params|body|form|payload)$/i;
/** Objects that hold the bearer, the cookie or the arguments: never handed over whole. */
const CARRIER_NAME = /^(?:headers|request|req|call|ctx)$/;
/** The caller-facing reason of a refused call quotes a plugin's free text. */
const REASON_NAME = /^reason$/;
/**
 * Log lines that carry a `reason` which is not the reason of a refused call: a
 * closed code chosen by this code base. Keyed by file and message; adding a line
 * here is a statement that its reason is such a code.
 */
const REASON_IS_A_CODE: ReadonlySet<string> = new Set([
  // `ConnectRefusalReason`, a closed union.
  'apps/gateway/src/server/connections/service.ts — connection refused: installation not bound to the user',
  // `AUTH_FAILURE_OF[…]`: why a retired token is retired (`rotated`, `holder-removed`, …).
  'apps/gateway/src/server/execution/admission.ts — retired mission token presented at the execution surface',
  // Why a label carrier was dropped (`too-long`, `invalid-character`, `not-a-string`): never its value.
  'apps/gateway/src/server/execution/door.ts — agent label dropped',
  // The message of this instance's own `ClientDocumentError`, or of the failed fetch of
  // a public document: no call, no credential.
  'apps/gateway/src/server/oauth-as/clients.ts — client metadata document refused',
  // `DelegationRevokeReason`, a closed union.
  'apps/gateway/src/server/oauth-as/delegations.ts — delegation revoked',
  // The title of an `AuthorizationPageError`, written where it is thrown.
  'apps/gateway/src/server/oauth-as/handlers.ts — authorization request refused',
  // `StatsUnavailable.reason`, written where it is thrown (the collector's HTTP status, a
  // shape problem), or the literal `unreachable`: telemetry carries no call and no credential.
  'apps/gateway/src/server/telemetry/stats.ts — telemetry: plugin statistics unavailable',
]);
/** Names that carry a secret… */
const SECRET_NAME =
  /(?:token|secret|bearer|password|passphrase|credential|authorization|cookie|private_?key|api_?key|master_?key|refresh|verifier|\bcode\b)/i;
/** …unless the name says it is what may be shown of one. */
const SAFE_DERIVATIVE =
  /(?:prefix|hash|digest|fingerprint|_id$|Id$|^has_|^has[A-Z]|count|length|kind|type|status|state|ttl|expires|expiry|_at$|At$|name$|label$|^refusal_code$|^error_code$|^code$|^status_code$|^exit_code$|^token_endpoint|endpoint$|_alg$|method$|^grant$|^outcome$|version$|^key$|^key_version$|^env$|^remedy$|_field$|^credential_kind$|^presented$|^expected$|[Rr]otated|[Rr]evoked|reuse_window)/;

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
  readonly why: 'arguments' | 'secret' | 'carrier' | 'reason';
}

function classify(name: string): Offence['why'] | null {
  if (ARGUMENT_NAME.test(name)) return 'arguments';
  if (SECRET_NAME.test(name) && !SAFE_DERIVATIVE.test(name)) return 'secret';
  return null;
}

interface Named {
  readonly name: string;
  /** A bare value handed over whole (`{ request }`, `...call`, `ctx`), not a property of one. */
  readonly whole: boolean;
}

/** Every name a log call's arguments mention: property keys, and the values handed over. */
function namesIn(node: ts.Node, source: ts.SourceFile, out: Named[]): void {
  if (ts.isPropertyAssignment(node)) {
    // The key is what the line will read. A key that is a safe derivative vouches for a
    // value that is computed (`token_prefix: prefixOf(token)`), never for a value that
    // is itself named like the secret (`token_prefix: bearer`).
    const key = node.name.getText(source).replace(/^['"]|['"]$/g, '');
    out.push({ name: key, whole: false });
    const vouched = classify(key) === null && SAFE_DERIVATIVE.test(key);
    if (vouched && ts.isCallExpression(node.initializer)) return;
    namesIn(node.initializer, source, out);
    return;
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    out.push({ name: node.name.text, whole: true });
    return;
  }
  if (ts.isPropertyAccessExpression(node)) {
    // `mission.id`, `err.message`: the last name is what is logged.
    out.push({ name: node.name.text, whole: false });
    return;
  }
  if (ts.isIdentifier(node)) {
    out.push({ name: node.text, whole: true });
    return;
  }
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    // `ids.map((request) => request.id)`: a parameter is a local name, not a value handed
    // over; what the function returns is read.
    namesIn(node.body, source, out);
    return;
  }
  ts.forEachChild(node, (child) => namesIn(child, source, out));
}

/** `logger.info`, `this.deps.logger.warn`, `log.error`: a method of something named like a logger. */
function loggerMethodOf(node: ts.Node, source: ts.SourceFile): string | null {
  if (!ts.isPropertyAccessExpression(node)) return null;
  const method = node.name.text;
  if (!LOG_METHODS.has(method) && method !== BINDING_METHOD) return null;
  return LOGGER_NAME.test(node.expression.getText(source)) ? method : null;
}

/** True when `node` is, or chooses between, `logger.<level>.bind(…)` expressions. */
function isBoundLogMethod(node: ts.Node, source: ts.SourceFile): boolean {
  if (ts.isParenthesizedExpression(node)) return isBoundLogMethod(node.expression, source);
  if (ts.isConditionalExpression(node)) {
    return isBoundLogMethod(node.whenTrue, source) || isBoundLogMethod(node.whenFalse, source);
  }
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'bind' &&
    loggerMethodOf(node.expression.expression, source) !== null
  );
}

/** The logger calls of one source text, as the parser sees them. */
function logCallsOf(
  file: string,
  text = readFileSync(file, 'utf8'),
): { source: ts.SourceFile; calls: ts.CallExpression[] } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  // Local names bound to a log method: `const log = logger.warn.bind(logger)`.
  const aliases = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isBoundLogMethod(node.initializer, source)
    ) {
      aliases.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const direct = loggerMethodOf(node.expression, source) !== null;
      const aliased = ts.isIdentifier(node.expression) && aliases.has(node.expression.text);
      if (direct || aliased) calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { source, calls };
}

/** The message of a log call, when it is a plain string: what `REASON_IS_A_CODE` is keyed by. */
function messageOf(call: ts.CallExpression): string {
  const [first] = call.arguments;
  return first && ts.isStringLiteralLike(first) ? first.text : '';
}

function offencesOf(file: string, text?: string): Offence[] {
  const { source, calls } = logCallsOf(file, text);
  const path = relative(REPO, file);
  const found: Offence[] = [];
  for (const call of calls) {
    const { line } = source.getLineAndCharacterOfPosition(call.getStart(source));
    const where = `${path}:${line + 1}`;
    const names: Named[] = [];
    // A message that is one plain string says nothing of a value; a template or a
    // concatenation is read like the rest. `.child({ … })` has no message.
    for (const argument of call.arguments) namesIn(argument, source, names);
    for (const { name, whole } of names) {
      const why = classify(name);
      if (why) found.push({ where, name, why });
      else if (whole && CARRIER_NAME.test(name)) found.push({ where, name, why: 'carrier' });
      else if (REASON_NAME.test(name) && !REASON_IS_A_CODE.has(`${path} — ${messageOf(call)}`)) {
        found.push({ where: `${where} — ${messageOf(call)}`, name, why: 'reason' });
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
    expect(files.flatMap((file) => offencesOf(file))).toEqual([]);
  });

  it('the scan sees what it is meant to see (a planted offence is reported)', () => {
    const planted = join(REPO, 'apps/gateway/src/server/__planted__.ts');
    // Through the same functions as the real scan: what is a log call, then what it names.
    const offences = (code: string): string[] =>
      offencesOf(planted, code).map((offence) => `${offence.why}:${offence.name}`);

    expect(offences(`logger.info('call', { args });`)).toEqual(['arguments:args']);
    expect(offences(`logger.info('call', { tool, detail: call.args });`)).toEqual([
      'arguments:args',
    ]);
    expect(offences(`this.deps.logger.warn('x', { token: bearer });`)).toEqual([
      'secret:token',
      'secret:bearer',
    ]);
    expect(offences(`logger.info('x', { client_secret: s });`)).toEqual(['secret:client_secret']);

    // The message, when it is built from values.
    expect(offences('logger.info(`call ${JSON.stringify(args)}`);')).toEqual(['arguments:args']);
    expect(offences(`logger.warn('bad ' + token);`)).toEqual(['secret:token']);
    // A name bound to a log method, and a child logger's bindings.
    expect(
      offences(
        `const log = replay ? logger.warn.bind(logger) : logger.info.bind(logger); log('x', { args });`,
      ),
    ).toEqual(['arguments:args']);
    expect(offences(`const scoped = logger.child({ token });`)).toEqual(['secret:token']);
    // The objects that carry them, handed over whole.
    expect(offences(`logger.info('x', { headers });`)).toEqual(['carrier:headers']);
    expect(offences(`logger.info('x', { ...call });`)).toEqual(['carrier:call']);
    expect(offences(`logger.info('x', { detail: request });`)).toEqual(['carrier:request']);
    expect(offences(`logger.info('x', ctx);`)).toEqual(['carrier:ctx']);
    // A key named like a derivative does not vouch for a value named like the secret.
    expect(offences(`logger.info('x', { token_prefix: bearer });`)).toEqual(['secret:bearer']);
    // The reason of a refused call.
    expect(offences(`logger.info('call refused', { reason: outcome.reason });`)).toEqual([
      'reason:reason',
      'reason:reason',
    ]);

    // What may be shown of them passes.
    expect(
      offences(`logger.info('x', { token_prefix: token.prefix, arguments_hash: h });`),
    ).toEqual([]);
    expect(offences(`logger.info('x', { token_prefix: prefixOf(token) });`)).toEqual([]);
    expect(offences(`logger.info('x', { mission_id: mission.id, refusal_code: r.code });`)).toEqual(
      [],
    );
    expect(offences(`logger.info('x', { method: request.method, path: ctx.path });`)).toEqual([]);
    // A callback's parameter is a local name; what it returns is read.
    expect(offences(`logger.info('x', { ids: all.map((request) => request.id) });`)).toEqual([]);
    expect(offences(`logger.info('x', { ids: all.map((call) => call.args) });`)).toEqual([
      'arguments:args',
    ]);
    // Not a logger: nothing to report.
    expect(offences(`audit.info('x', { args });`)).toEqual([]);
  });
});
