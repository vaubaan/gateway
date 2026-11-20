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

/** What {@link argumentTypeIssue} reads of a property of a tool's input schema. */
export interface ArgumentSchema {
  readonly type?: unknown;
  readonly nullable?: unknown;
  readonly enum?: unknown;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly items?: { readonly type?: unknown };
}

function hasJsonType(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * Why the value of the argument `name` does not fit the property `schema` of its tool's
 * input schema: its JSON type, `enum`, `minimum` and `maximum`, the type of an array's
 * items; `null` when it fits, or when `schema` says nothing the check reads. A `null`
 * value fits a property marked `nullable: true`. Messages end with a full stop and name
 * the argument (`limit: at most 50.`).
 */
export function argumentTypeIssue(name: string, schema: unknown, value: unknown): string | null {
  const declared: ArgumentSchema = typeof schema === 'object' && schema !== null ? schema : {};
  if (value === null && declared.nullable === true) return null;
  if (!hasJsonType(declared.type, value)) return `${name}: expected ${String(declared.type)}.`;
  if (Array.isArray(declared.enum) && !declared.enum.includes(value)) {
    return `${name}: expected one of ${declared.enum.join(', ')}.`;
  }
  if (typeof value === 'number') {
    if (typeof declared.minimum === 'number' && value < declared.minimum) {
      return `${name}: at least ${declared.minimum}.`;
    }
    if (typeof declared.maximum === 'number' && value > declared.maximum) {
      return `${name}: at most ${declared.maximum}.`;
    }
  }
  const itemType = declared.items?.type;
  if (Array.isArray(value) && itemType !== undefined) {
    const bad = value.findIndex((item) => !hasJsonType(itemType, item));
    if (bad >= 0) return `${name}[${bad}]: expected ${String(itemType)}.`;
  }
  return null;
}
