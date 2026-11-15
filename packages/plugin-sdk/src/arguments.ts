/**
 * The argument surface of a tool is closed : what its schema does not declare
 * is refused.
 *
 * ADR  : docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md
 *        ("refuse, never repair" ; what is classified is what is sent).
 *
 * A classifier reads the arguments it knows. An argument it does not know was
 * priced by no rule, and an executor that forwards the arguments it was given
 * (a JSON body built from `args`, a rewrapped upstream tool) would send it to
 * the service all the same — `verify_jwt: false` next to a deployment, a
 * field the service added after the schema was written. Dropping it silently
 * in `execute` would be a repair ; the call is refused in `classify`, so the
 * agent learns the argument does nothing here and the audit records the
 * refusal.
 *
 * Top-level keys only : the value of a declared argument is the tool's own
 * business (its classifier reads it, or documents that it does not).
 */

import type { McpToolDeclaration } from '@vaubaan/shared';

/** The argument names each tool declares, by tool name. */
export type DeclaredArguments = ReadonlyMap<string, ReadonlySet<string>>;

/** Built once per plugin from its tool declarations. */
export function declaredArgumentsOf(tools: readonly McpToolDeclaration[]): DeclaredArguments {
  return new Map(
    tools.map((tool) => [tool.name, new Set(Object.keys(tool.inputSchema.properties ?? {}))]),
  );
}

/**
 * The denial for the first argument of the call its tool does not declare, in
 * the order the call gives them ; `null` when every argument is declared, or
 * when the tool itself is unknown (the classifier says that in its own words).
 * An argument given as `undefined` is absent.
 */
export function undeclaredArgumentDenial(
  declared: DeclaredArguments,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  /**
   * Arguments the plugin reads itself whatever the tool declares, and writes again
   * (or drops) before the call leaves : the project or team a mission pins.
   */
  routing: ReadonlySet<string> = NO_ROUTING_ARGUMENT,
): string | null {
  const names = declared.get(tool);
  if (!names) return null;
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && !names.has(key) && !routing.has(key)) {
      return `${argumentLabel(key)}: not an argument of '${tool}' — nothing classifies it, so it is not sent.`;
    }
  }
  return null;
}

const NO_ROUTING_ARGUMENT: ReadonlySet<string> = new Set();

const ARGUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** The key as a denial may quote it : a name-shaped key verbatim, anything else described. */
function argumentLabel(key: string): string {
  return ARGUMENT_NAME.test(key) ? key : 'an argument with a malformed name';
}
