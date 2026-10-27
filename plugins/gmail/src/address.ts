/**
 * Strict e-mail address parsing for the `gmail` classifier.
 *
 * Handbook : docs/handbook/providers/gmail.md.
 *
 * The zone of a read or of a draft is decided from addresses the agent
 * writes, so an address is **parsed, never searched for** : a value is one
 * whole address or it is nothing. Anything the parser does not fully
 * understand is reported (`null`, or `denied` for a recipient field) so the
 * classifier takes the worst case instead of guessing a zone.
 *
 * Deliberately narrower than RFC 5322 : no quoted local part, no comment, no
 * address list inside one string, no separator character in a display name.
 * A value the mail system could read as two addresses must never parse as
 * one.
 *
 * The same rules exist in `plugins/resend/src/zones.ts` (plugins do not
 * import each other) ; both are candidates for `@vaubaan/plugin-sdk`.
 */

export interface EmailAddress {
  /** Lower-cased `local@domain`. */
  readonly address: string;
  /** Lower-cased local part. */
  readonly local: string;
  /** Lower-cased domain part. */
  readonly domain: string;
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
const ANGLE_FORM = /^(?:"[^<>,;:@"\\]*"|[^<>,;:@"\\]*)\s*<([^<>]+)>$/;

/** `local@domain` and nothing else → the address ; `null` otherwise. */
export function parseBareAddress(value: unknown): EmailAddress | null {
  if (typeof value !== 'string') return null;
  const m = BARE_ADDRESS.exec(value.trim().toLowerCase());
  if (!m) return null;
  return { address: m[0], local: m[1]!, domain: m[2]! };
}

/** `Name <local@domain>` or `local@domain` → the address ; `null` when the value is anything else. */
export function parseRecipient(value: unknown): EmailAddress | null {
  if (typeof value !== 'string') return null;
  const angle = ANGLE_FORM.exec(value.trim());
  return parseBareAddress(angle ? angle[1]! : value);
}

export type RecipientsOutcome =
  { readonly recipients: readonly EmailAddress[] } | { readonly denied: string };

const RECIPIENT_FIELDS = ['to', 'cc', 'bcc'] as const;

/**
 * Every recipient of `to` + `cc` + `bcc`. A field is absent, one address
 * string, or a list of address strings — one address per string. A field of
 * another shape, or one element that is not exactly one address, refuses the
 * call : a recipient the classifier cannot read is a recipient it cannot zone.
 */
export function collectRecipients(args: Readonly<Record<string, unknown>>): RecipientsOutcome {
  const recipients: EmailAddress[] = [];
  for (const field of RECIPIENT_FIELDS) {
    const value = args[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' && !Array.isArray(value)) {
      return { denied: `${field}: expected an address or a list of addresses.` };
    }
    const items: readonly unknown[] = typeof value === 'string' ? [value] : value;
    for (const item of items) {
      const parsed = parseRecipient(item);
      if (!parsed) {
        return {
          denied: `${field}: ${describeUnparseable(item)} is not exactly one e-mail address ('addr@example.com' or 'Name <addr@example.com>').`,
        };
      }
      recipients.push(parsed);
    }
  }
  return { recipients };
}

/** Bounded, quote-free rendering of a refused value for the denial message. */
function describeUnparseable(item: unknown): string {
  if (typeof item !== 'string') {
    return `a value of type ${Array.isArray(item) ? 'array' : typeof item}`;
  }
  return `'${item.slice(0, 80).replace(/[^\x20-\x7e]/g, '?')}'`;
}
