/**
 * iCalendar (RFC 5545) content lines : read into a tree, written back folded.
 *
 * Handbook : docs/handbook/providers/caldav.md, "Libraries" and "Execution".
 *
 * A small codec of the syntax, not a calendar engine. It keeps every
 * component and property it does not know, in order, so that an event the
 * plugin changes is written back with its alarms, its `X-` properties, its
 * time zones and the participation status of its attendees untouched — the
 * plugin rewrites only the properties a tool names. Nothing here expands a
 * recurrence or converts a time zone.
 *
 *   - **reading** (`parseIcs`) : lines unfolded (RFC 5545 §3.1), each split
 *     into name, parameters and value with a character scanner (no regular
 *     expression over the line), `BEGIN` / `END` matched ; anything else is
 *     an `IcsError`. Bounded in size, lines and depth : the text comes from
 *     the server, and through it from whoever sent an invitation.
 *   - **writing** (`serializeIcs`) : `CRLF` line ends, lines folded at 75
 *     octets without splitting a UTF-8 character, parameter values quoted
 *     when they hold `:` `;` `,` ; a value or a parameter that holds a
 *     control character is refused, never written (it could start a line).
 *   - **text values** (`escapeText` / `unescapeText`, §3.3.11) : `\` `;` `,`
 *     and line breaks escaped.
 */

/** One parameter of a property, its values unquoted. */
export interface IcsParam {
  /** Upper-cased (`TZID`, `CN`). */
  readonly name: string;
  readonly values: readonly string[];
}

/** One content line. */
export interface IcsProperty {
  /** Upper-cased (`DTSTART`, `X-APPLE-TRAVEL-ADVISORY-BEHAVIOR`). */
  readonly name: string;
  readonly params: readonly IcsParam[];
  /** The raw value, still escaped for a TEXT property. */
  readonly value: string;
}

/** A component (`VCALENDAR`, `VEVENT`, `VALARM`…) with its properties and sub-components, in order. */
export interface IcsComponent {
  /** Upper-cased. */
  readonly name: string;
  readonly properties: IcsProperty[];
  readonly components: IcsComponent[];
}

/** The text is not an iCalendar object the plugin can read. */
export class IcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcsError';
  }
}

/** Largest object read, in characters (an event with a long description and many attendees is far below). */
export const MAX_ICS_LENGTH = 1_000_000;
/** Most content lines read in one object. */
export const MAX_ICS_LINES = 20_000;
/** Deepest nesting of components (`VCALENDAR` › `VEVENT` › `VALARM` is 3). */
const MAX_DEPTH = 8;
/** Octets of a written line before it is folded (RFC 5545 §3.1). */
const FOLD_OCTETS = 75;

// ─── Reading ───────────────────────────────────────────────────────────────

/** Name characters of a property or parameter (RFC 5545 §3.1 : `iana-token` / `x-name`). */
const isNameChar = (ch: string): boolean => /^[A-Za-z0-9-]$/.test(ch);

/** The lines of the object, unfolded : a line that starts with a space or a tab continues the previous one. */
function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1);
    } else if (raw.length > 0) {
      lines.push(raw);
    }
  }
  return lines;
}

/** One content line → its property, or the reason it is not one. */
export function parseContentLine(line: string): IcsProperty {
  let i = 0;
  const readName = (what: string): string => {
    const start = i;
    while (i < line.length && isNameChar(line[i]!)) i += 1;
    if (i === start) throw new IcsError(`a content line has no ${what} name.`);
    return line.slice(start, i).toUpperCase();
  };

  const name = readName('property');
  const params: IcsParam[] = [];
  while (line[i] === ';') {
    i += 1;
    const paramName = readName('parameter');
    if (line[i] !== '=') throw new IcsError(`parameter ${paramName} of ${name} has no value.`);
    i += 1;
    const values: string[] = [];
    for (;;) {
      if (line[i] === '"') {
        const end = line.indexOf('"', i + 1);
        if (end < 0) throw new IcsError(`parameter ${paramName} of ${name} has an unclosed quote.`);
        values.push(line.slice(i + 1, end));
        i = end + 1;
      } else {
        const start = i;
        while (i < line.length && !';:,"'.includes(line[i]!)) i += 1;
        values.push(line.slice(start, i));
      }
      if (line[i] !== ',') break;
      i += 1;
    }
    params.push({ name: paramName, values });
  }
  if (line[i] !== ':') throw new IcsError(`property ${name} has no value.`);
  return { name, params, value: line.slice(i + 1) };
}

/**
 * The object an iCalendar text holds : one `VCALENDAR`, every component and
 * property kept in order. Throws `IcsError` when the text is too large, a line
 * does not parse, or `BEGIN` / `END` do not match.
 */
export function parseIcs(text: string): IcsComponent {
  if (text.length > MAX_ICS_LENGTH) throw new IcsError('the object is too large.');
  const lines = unfold(text);
  if (lines.length > MAX_ICS_LINES) throw new IcsError('the object has too many lines.');

  const stack: IcsComponent[] = [];
  let root: IcsComponent | null = null;
  for (const line of lines) {
    const property = parseContentLine(line);
    if (property.name === 'BEGIN') {
      if (root !== null) throw new IcsError('content after the end of the calendar.');
      if (stack.length >= MAX_DEPTH) throw new IcsError('components nest too deep.');
      const component: IcsComponent = {
        name: property.value.trim().toUpperCase(),
        properties: [],
        components: [],
      };
      stack[stack.length - 1]?.components.push(component);
      stack.push(component);
    } else if (property.name === 'END') {
      const open = stack.pop();
      if (!open || open.name !== property.value.trim().toUpperCase()) {
        throw new IcsError(`END:${property.value} does not close the open component.`);
      }
      if (stack.length === 0) root = open;
    } else {
      const open = stack[stack.length - 1];
      if (!open) throw new IcsError(`property ${property.name} outside any component.`);
      open.properties.push(property);
    }
  }
  if (stack.length > 0 || root === null) throw new IcsError('the calendar is not closed.');
  if (root.name !== 'VCALENDAR') throw new IcsError('the object is not a VCALENDAR.');
  return root;
}

// ─── Writing ───────────────────────────────────────────────────────────────

/** A control character a value may not carry when written (CR and LF included : they would start a line). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/** One parameter value, quoted when it must be ; `IcsError` for a quote or a control character. */
function paramValue(value: string): string {
  if (value.includes('"') || CONTROL.test(value)) {
    throw new IcsError('a parameter value holds a quote or a control character.');
  }
  return /[:;,]/.test(value) ? `"${value}"` : value;
}

/** The content line of a property, unfolded. */
export function contentLine(property: IcsProperty): string {
  if (CONTROL.test(property.value)) {
    throw new IcsError(`the value of ${property.name} holds a control character.`);
  }
  const params = property.params
    .map((p) => `;${p.name}=${p.values.map(paramValue).join(',')}`)
    .join('');
  return `${property.name}${params}:${property.value}`;
}

/** UTF-8 length of one character. */
const octets = (ch: string): number => Buffer.byteLength(ch, 'utf8');

/**
 * A line folded at 75 octets (RFC 5545 §3.1) : every continuation starts with
 * one space, and no UTF-8 character is split.
 */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = octets(ch);
    // A continuation line carries the leading space in its 75 octets.
    if (size + n > FOLD_OCTETS) {
      parts.push(current);
      current = ' ';
      size = 1;
    }
    current += ch;
    size += n;
  }
  parts.push(current);
  return parts.join('\r\n');
}

/** The text of a component, `CRLF` ended and folded. */
export function serializeIcs(component: IcsComponent): string {
  const out: string[] = [];
  const write = (c: IcsComponent): void => {
    out.push(foldLine(`BEGIN:${c.name}`));
    for (const p of c.properties) out.push(foldLine(contentLine(p)));
    for (const child of c.components) write(child);
    out.push(foldLine(`END:${c.name}`));
  };
  write(component);
  return `${out.join('\r\n')}\r\n`;
}

// ─── TEXT values (RFC 5545 §3.3.11) ────────────────────────────────────────

/** A text value as written in a content line : `\` `;` `,` escaped, line breaks as `\n`. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** A text value as read : the escapes of `escapeText` undone, an unknown escape kept as its character. */
export function unescapeText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch !== '\\' || i === value.length - 1) {
      out += ch;
      continue;
    }
    const next = value[i + 1]!;
    out += next === 'n' || next === 'N' ? '\n' : next;
    i += 1;
  }
  return out;
}

// ─── Lookups ───────────────────────────────────────────────────────────────

/** The first property of that name, or `undefined`. */
export function propertyOf(component: IcsComponent, name: string): IcsProperty | undefined {
  return component.properties.find((p) => p.name === name);
}

/** Every property of that name, in order. */
export function propertiesOf(component: IcsComponent, name: string): IcsProperty[] {
  return component.properties.filter((p) => p.name === name);
}

/** The first value of a parameter, or `undefined`. */
export function paramOf(property: IcsProperty, name: string): string | undefined {
  return property.params.find((p) => p.name === name)?.values[0];
}

/** The property, or a new one, with `name` replaced by `value` and `params`. */
export function setProperty(
  component: IcsComponent,
  name: string,
  value: string,
  params: readonly IcsParam[] = [],
): void {
  const property: IcsProperty = { name, params, value };
  const index = component.properties.findIndex((p) => p.name === name);
  removeProperties(component, name);
  if (index < 0) component.properties.push(property);
  else component.properties.splice(Math.min(index, component.properties.length), 0, property);
}

/** Every property of that name removed. */
export function removeProperties(component: IcsComponent, name: string): void {
  for (let i = component.properties.length - 1; i >= 0; i -= 1) {
    if (component.properties[i]!.name === name) component.properties.splice(i, 1);
  }
}
