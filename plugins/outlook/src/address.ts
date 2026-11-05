/**
 * Strict e-mail address parsing for the `outlook` classifier — the rules of
 * `plugins/gmail/src/address.ts` (plugins do not import each other).
 *
 * Handbook : docs/handbook/providers/outlook.md.
 *
 * The zone of a read, a draft or a send is decided from addresses, so an
 * address is **parsed, never searched for**: a value is one whole address or
 * it is nothing. Narrower than RFC 5322: no quoted local part, no comment,
 * no display name (Graph takes the address alone, `{ emailAddress: { address } }`),
 * no address list inside one string. A value a mail system could read as two
 * addresses never parses as one.
 */

export interface EmailAddress {
  /** Lower-cased `local@domain`. */
  readonly address: string;
  /** Lower-cased local part. */
  readonly local: string;
  /** Lower-cased domain part. */
  readonly domain: string;
}

/** Longest address accepted (RFC 5321's path limit). */
export const MAX_ADDRESS_LENGTH = 320;

/** Dot-atom local part, then a domain of at least two DNS labels. */
const BARE_ADDRESS =
  /^([a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/;

/** `local@domain` and nothing else → the address; `null` otherwise. */
export function parseAddress(value: unknown): EmailAddress | null {
  if (typeof value !== 'string' || value.length > MAX_ADDRESS_LENGTH) return null;
  const m = BARE_ADDRESS.exec(value.trim().toLowerCase());
  if (!m) return null;
  return { address: m[0], local: m[1]!, domain: m[2]! };
}

/**
 * A list of addresses, each element exactly one address, deduplicated in
 * order; the refusal naming the first element that is not.
 */
export function addressList(
  name: string,
  value: unknown,
): readonly EmailAddress[] | { readonly denied: string } {
  if (!Array.isArray(value)) return { denied: `${name}: expected a list of e-mail addresses.` };
  const out: EmailAddress[] = [];
  for (const [i, item] of value.entries()) {
    const parsed = parseAddress(item);
    if (!parsed) {
      return { denied: `${name}[${i}]: ${describe(item)} is not exactly one e-mail address.` };
    }
    if (!out.some((a) => a.address === parsed.address)) out.push(parsed);
  }
  return out;
}

/** Bounded, quote-free rendering of a refused value for the denial message. */
function describe(item: unknown): string {
  if (typeof item !== 'string')
    return `a value of type ${Array.isArray(item) ? 'array' : typeof item}`;
  return `'${item.slice(0, 80).replace(/[^\x20-\x7e]/g, '?')}'`;
}
