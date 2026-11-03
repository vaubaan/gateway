/**
 * Which URL a messaging address may be, per kind (spec §6; handbook notifications). An
 * address is typed by a signed-in person, who is not trusted with the instance's network:
 *
 *   every kind     https, no user name or password in the URL, at most 2048 characters
 *   slack          hooks.slack.com/services/…                          (default port)
 *   teams          a Workflows trigger: *.logic.azure.com or
 *                  *.environment.api.powerplatform.com; or a connector
 *                  of *.webhook.office.com (retired by Microsoft)      (default port)
 *   discord        discord.com/api/webhooks/… (ptb., canary., and the
 *                  former discordapp.com)                              (default port)
 *   ntfy           any host, a topic as the last path segment
 *   generic        any host
 *
 * For the two kinds whose host is free, the destination must be on the public internet:
 * `localhost`, an IP literal outside it, or a name that resolves to any address outside it
 * is refused, when the address is added and again before each send (`destination.ts`).
 * The vendors' hosts are what an egress allow-list opens (docs/handbook/configuration.md).
 */
import { ADDRESS_KINDS, type AddressKind } from '../../store/repositories/notification-addresses';

export { ADDRESS_KINDS, type AddressKind };

export const ADDRESS_URL_MAX = 2048;

interface VendorRule {
  /** Exact hosts, or suffixes written with a leading dot. */
  readonly hosts: readonly string[];
  readonly pathPrefix: string;
}

/** The kinds whose host is the vendor's: nothing else is posted to. */
export const VENDOR_HOSTS: Readonly<Record<'slack' | 'teams' | 'discord', VendorRule>> = {
  slack: { hosts: ['hooks.slack.com'], pathPrefix: '/services/' },
  teams: {
    hosts: ['.logic.azure.com', '.environment.api.powerplatform.com', '.webhook.office.com'],
    pathPrefix: '/',
  },
  discord: {
    hosts: ['discord.com', 'ptb.discord.com', 'canary.discord.com', 'discordapp.com'],
    pathPrefix: '/api/webhooks/',
  },
};

/** A topic of ntfy: letters, digits, `-` and `_`, up to 64 (ntfy's own rule). */
const NTFY_TOPIC = /^[-_A-Za-z0-9]{1,64}$/;

export type AddressRuleProblem = 'invalid-address' | 'wrong-host';

export function isAddressKind(value: unknown): value is AddressKind {
  return typeof value === 'string' && (ADDRESS_KINDS as readonly string[]).includes(value);
}

/** Whether the kind's host is free, so the destination must be checked for a public address. */
export function hostIsFree(kind: AddressKind): kind is 'ntfy' | 'generic' {
  return kind === 'ntfy' || kind === 'generic';
}

function matches(host: string, rule: VendorRule): boolean {
  return rule.hosts.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h));
}

/** The ntfy topic of a topic URL (its last path segment), or `null`. */
export function ntfyTopicOf(url: URL): string | null {
  const segments = url.pathname.split('/');
  const topic = segments[segments.length - 1] ?? '';
  return NTFY_TOPIC.test(topic) && url.search === '' ? topic : null;
}

/**
 * The URL of an address of this kind, canonical (`URL.href`), or why it cannot be one. The
 * destination of a free host is checked apart, by resolving it (`destination.ts`).
 */
export function checkAddressUrl(
  kind: AddressKind,
  raw: string,
):
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly problem: AddressRuleProblem } {
  const refuse = (problem: AddressRuleProblem) => ({ ok: false as const, problem });
  if (raw.length === 0 || raw.length > ADDRESS_URL_MAX) return refuse('invalid-address');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return refuse('invalid-address');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return refuse('invalid-address');
  }
  const host = url.hostname.toLowerCase();
  if (kind === 'ntfy')
    return ntfyTopicOf(url) === null ? refuse('invalid-address') : { ok: true, url };
  if (kind === 'generic') return { ok: true, url };
  const rule = VENDOR_HOSTS[kind];
  if (url.port !== '' || !matches(host, rule) || !url.pathname.startsWith(rule.pathPrefix)) {
    return refuse('wrong-host');
  }
  return { ok: true, url };
}
