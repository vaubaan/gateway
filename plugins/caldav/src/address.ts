/**
 * Strict e-mail address parsing for the `caldav` classifier and executor.
 *
 * Handbook : docs/handbook/providers/caldav.md, "Edge cases".
 *
 * The zone of a write is decided from addresses the agent writes, so an
 * address is **parsed, never searched for** : a value is one whole address or
 * it is nothing. Deliberately narrower than RFC 5322 : no quoted local part,
 * no comment, no list inside one string, no separator character in a display
 * name. The same rules exist in `plugins/gmail/src/address.ts` and
 * `plugins/resend/src/zones.ts` (plugins do not import each other).
 */

export interface EmailAddress {
  /** Lower-cased `local@domain`. */
  readonly address: string;
  /** Lower-cased domain part. */
  readonly domain: string;
  /** The display name the agent gave, if any (`Ada Lovelace <ada@example.com>`). */
  readonly name: string | null;
}

/** Dot-atom local part, then a domain of at least two DNS labels. */
const BARE_ADDRESS =
  /^([a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/;

/**
 * `Display Name <addr>` : exactly one bracket pair, at the end. The display
 * name, bare or wholly double-quoted, may not hold a character that separates
 * or introduces an address (`,` `;` `:` `@` `<` `>`), an inner quote or a
 * backslash.
 */
const ANGLE_FORM = /^("[^<>,;:@"\\]*"|[^<>,;:@"\\]*)\s*<([^<>]+)>$/;

/** Longest address accepted (RFC 5321 path limit). */
export const MAX_ADDRESS_LENGTH = 254;
/** Longest display name kept, in characters. */
const MAX_NAME_LENGTH = 100;

/** `local@domain` and nothing else → the address ; `null` otherwise. */
export function parseBareAddress(value: unknown): EmailAddress | null {
  if (typeof value !== 'string' || value.length > MAX_ADDRESS_LENGTH) return null;
  const m = BARE_ADDRESS.exec(value.trim().toLowerCase());
  if (!m) return null;
  return { address: m[0], domain: m[2]!, name: null };
}

/** `Name <local@domain>` or `local@domain` → the address ; `null` when the value is anything else. */
export function parseAttendee(value: unknown): EmailAddress | null {
  if (typeof value !== 'string' || value.length > MAX_ADDRESS_LENGTH + MAX_NAME_LENGTH + 4) {
    return null;
  }
  const angle = ANGLE_FORM.exec(value.trim());
  if (!angle) return parseBareAddress(value);
  const parsed = parseBareAddress(angle[2]!);
  if (parsed === null) return null;
  const name = angle[1]!.replace(/^"|"$/g, '').trim();
  return { ...parsed, name: name.length > 0 ? name.slice(0, MAX_NAME_LENGTH) : null };
}

/**
 * The address of a `mailto:` calendar user address (`ATTENDEE`, `ORGANIZER`,
 * `calendar-user-address-set`), or `null` for another scheme or a value that
 * is not exactly one address.
 */
export function addressOfCalAddress(value: string): EmailAddress | null {
  const trimmed = value.trim();
  if (!/^mailto:/i.test(trimmed)) return null;
  return parseBareAddress(decodeMailto(trimmed.slice('mailto:'.length)));
}

/** `%40` and friends, as some servers write them ; the raw value when it does not decode. */
function decodeMailto(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Longest attendee list accepted on a write. */
export const MAX_ATTENDEES = 100;

export type AttendeesOutcome =
  { readonly attendees: readonly EmailAddress[] } | { readonly denied: string };

/**
 * The `attendees` argument : absent, or a list of strings, one address per
 * string. Another shape, a list too long, or one element that is not exactly
 * one address refuses the call : an attendee the plugin cannot read is one it
 * cannot zone. Duplicates are kept once.
 */
export function collectAttendees(value: unknown): AttendeesOutcome {
  if (value === undefined || value === null) return { attendees: [] };
  if (!Array.isArray(value)) return { denied: 'attendees: expected a list of addresses.' };
  if (value.length > MAX_ATTENDEES) {
    return { denied: `attendees: at most ${MAX_ATTENDEES} addresses.` };
  }
  const seen = new Set<string>();
  const attendees: EmailAddress[] = [];
  for (const item of value) {
    const parsed = parseAttendee(item);
    if (!parsed) {
      return {
        denied: `attendees: ${describeUnparseable(item)} is not exactly one e-mail address ('addr@example.com' or 'Name <addr@example.com>').`,
      };
    }
    if (seen.has(parsed.address)) continue;
    seen.add(parsed.address);
    attendees.push(parsed);
  }
  return { attendees };
}

/** Bounded, quote-free rendering of a refused value for the denial message. */
function describeUnparseable(item: unknown): string {
  if (typeof item !== 'string') {
    return `a value of type ${Array.isArray(item) ? 'array' : typeof item}`;
  }
  return `'${item.slice(0, 80).replace(/[^\x20-\x7e]/g, '?')}'`;
}
