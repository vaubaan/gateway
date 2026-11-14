/**
 * Structural test (security audit 2026-10-31, H2): the attested OAuth broker
 * channel opens its TLS connections without checking the certificate chain (the
 * enclave's key is self-issued) and relies on one ordering instead: the key the
 * socket presents is compared with the key the attestation pinned before the
 * broker key is written. Nothing in the types holds that ordering, so this test
 * reads the source:
 *
 *   - certificate verification is off in one place of the server, the channel's
 *     `open`;
 *   - the broker key is written by `exchange` only when its caller asks
 *     (`withKey`), and only `send` asks;
 *   - in `send`, every socket `open` returns is compared with the pin by the
 *     statement right after it, before any exchange;
 *   - nothing else writes to a socket.
 *
 * The behaviour is proven beside the code (`oauth-broker.test.ts`: a key no
 * attestation carries gets nothing).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/server');
const CHANNEL = join(SERVER, 'accounts/broker-channel.ts');

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

const text = readFileSync(CHANNEL, 'utf8');
const source = ts.createSourceFile('broker-channel.ts', text, ts.ScriptTarget.ES2022, true);

/** The methods of the `AttestedChannel` class, by name. */
function attestedChannelMethods(): Map<string, ts.MethodDeclaration> {
  const methods = new Map<string, ts.MethodDeclaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'AttestedChannel') {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
          methods.set(member.name.text, member);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return methods;
}

/** The calls `this.<name>(…)` under `node`. */
function callsOf(node: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      child.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      child.expression.name.text === name
    ) {
      found.push(child);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** The `withKey` an exchange call passes, as written. */
function withKeyOf(call: ts.CallExpression): string | null {
  const options = call.arguments[4];
  if (!options || !ts.isObjectLiteralExpression(options)) return null;
  const property = options.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && p.name.getText(source) === 'withKey',
  );
  return property ? property.initializer.getText(source) : null;
}

/** The statement of `block` that holds `node`, and the one after it. */
function statementAndNext(
  node: ts.Node,
): { statement: ts.Statement; next: ts.Statement | undefined } | null {
  let current: ts.Node = node;
  while (current.parent && !ts.isBlock(current.parent)) current = current.parent;
  if (!current.parent || !ts.isBlock(current.parent)) return null;
  const statements = current.parent.statements;
  const index = statements.findIndex((s) => s === current);
  return index < 0 ? null : { statement: statements[index]!, next: statements[index + 1] };
}

const PIN_CHECK = 'spkiOf(socket) !== pin.spkiHash';

describe('the broker key is written only on a socket whose key is the pinned one', () => {
  const methods = attestedChannelMethods();

  it('turns certificate verification off in one place of the server: the channel’s open', () => {
    const offenders = sourcesUnder(SERVER)
      .filter((path) => /rejectUnauthorized:\s*false/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SERVER, path));
    expect(offenders).toEqual(['accounts/broker-channel.ts']);
    expect(text.match(/rejectUnauthorized:\s*false/g)).toHaveLength(1);
    const open = methods.get('open');
    expect(open?.getText(source)).toMatch(/rejectUnauthorized:\s*false/);
  });

  it('writes the key from exchange only when asked, and only send asks', () => {
    expect(methods.get('exchange')?.getText(source)).toContain('options.withKey ? this.key : null');
    const asking = [...methods].flatMap(([name, method]) =>
      callsOf(method, 'exchange')
        .filter((call) => withKeyOf(call) !== 'false')
        .map(() => name),
    );
    expect(asking).toEqual(['send']);
  });

  it('compares every socket send opens with the pin, right after it opens', () => {
    const send = methods.get('send');
    if (!send) throw new Error('AttestedChannel.send is gone');
    const opens = callsOf(send, 'open');
    expect(opens.length).toBeGreaterThan(0);
    for (const open of opens) {
      const next = statementAndNext(open)?.next;
      if (!next || !ts.isIfStatement(next)) {
        throw new Error(`no check right after ${open.getText(source)}`);
      }
      expect(next.expression.getText(source)).toBe(PIN_CHECK);
    }
    const [exchange] = callsOf(send, 'exchange');
    const lastOpen = opens.at(-1);
    expect(exchange && lastOpen && exchange.getStart() > lastOpen.getStart()).toBe(true);
  });

  it('writes to no socket but through exchange', () => {
    const exchange = methods.get('exchange');
    const writes: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['write', 'end'].includes(node.expression.name.text) &&
        node.arguments.length > 0
      ) {
        const inExchange =
          exchange !== undefined && node.pos >= exchange.pos && node.end <= exchange.end;
        if (!inExchange) writes.push(node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(writes).toEqual([]);
    expect(exchange?.getText(source)).toContain('req.end(body)');
  });
});
