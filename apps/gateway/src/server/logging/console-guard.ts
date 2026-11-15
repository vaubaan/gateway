/**
 * Next.js prints the errors of route handlers and server components itself, with
 * `console.error`, outside `createLogger`: the message of such an error can quote a
 * service's answer (and a credential the service echoed) or a configured secret.
 * `guardConsole` replaces `console.error` and `console.warn` so that what they print
 * goes through the redactor, and an `Error` argument is printed as its class and its
 * stack frames — never its message (ADR provider-error-text-stays-with-the-agent).
 *
 * The gateway's own logger writes to the streams directly and is not affected.
 */
import { format } from 'node:util';

import { stackFramesOf } from './error-fields';
import type { Redactor } from './redact';

const WITHHELD = '[message withheld]';
const GUARDED = Symbol.for('vaubaan.console-guard');

type ConsoleMethod = (...args: unknown[]) => void;
type GuardableConsole = { error: ConsoleMethod; warn: ConsoleMethod } & {
  [GUARDED]?: true;
};

/** One argument as the guard prints it. */
export function describeArgument(arg: unknown): unknown {
  if (!(arg instanceof Error)) return arg;
  const digest = (arg as { digest?: unknown }).digest;
  const frames = stackFramesOf(arg)
    .map((frame) => `\n    ${frame}`)
    .join('');
  const name = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(arg.name) ? arg.name : 'Error';
  return `${name}: ${WITHHELD}${typeof digest === 'string' ? ` (digest ${digest})` : ''}${frames}`;
}

/** The line a guarded method prints for these arguments. */
export function guardedLine(redact: Redactor, args: readonly unknown[]): string {
  return redact(format(...args.map(describeArgument)));
}

/** Installs the guard once per process (`globalThis.console` by default). */
export function guardConsole(redact: Redactor, target: GuardableConsole = console): void {
  if (target[GUARDED]) return;
  for (const method of ['error', 'warn'] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(guardedLine(redact, args));
  }
  target[GUARDED] = true;
}
