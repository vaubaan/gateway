/**
 * Server-side state of a connect flow in flight, and the one-time notices the
 * pages show after a redirect. Both live in the root's `SessionStore` port
 * under their own key prefixes (`connect:`, `notice:`), next to the web
 * sessions, so they survive a restart and expire on their own.
 *
 * Anti-replay (spec §6): the `state` sent to the provider is the key of the
 * pending record; `take()` returns the record at most once and only to the
 * user who started the flow. A callback replayed, forged, expired, or opened
 * in another user's session finds nothing.
 */
import { randomBytes } from 'node:crypto';

import type { SessionStore } from '../compose/ports';
import type { FormEcho } from './input';
import { newState } from './oauth2';

const MINUTE_MS = 60_000;
/** How long the browser has to come back from the provider. */
export const CONNECT_TTL_MS = 10 * MINUTE_MS;
/** How long a notice waits for the page that shows it. */
export const NOTICE_TTL_MS = 5 * MINUTE_MS;
const NOTICE_ID_BYTES = 16;
const STATE_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export type PendingFlowKind = 'oauth2' | 'app-install';

export interface PendingConnect {
  readonly kind: PendingFlowKind;
  readonly providerId: string;
  /** The user who started the flow; the callback must arrive in a session of the same user. */
  readonly userId: string;
  readonly displayName: string;
  /** PKCE verifier, when the spec asks for PKCE. */
  readonly codeVerifier: string | null;
  /** The redirect URI sent to the provider (built on `public_url`), replayed at the exchange. */
  readonly redirectUri: string;
  /** Same-origin path to land on afterwards; `null` means the connection's page. */
  readonly returnTo: string | null;
  /** Set when the flow re-authenticates an existing connection instead of creating one. */
  readonly reconnectId: string | null;
  readonly createdAt: string;
}

export class PendingConnectStore {
  // single-process only — makes `take` atomic inside one process (the port has no
  // get-and-delete). A hosted `SessionStore` needs an atomic GETDEL instead.
  private readonly taking = new Set<string>();

  constructor(private readonly store: SessionStore) {}

  /** Stores the flow and returns the `state` to send to the provider. */
  async create(pending: PendingConnect): Promise<string> {
    const state = newState();
    await this.store.set(key(state), pending, CONNECT_TTL_MS);
    return state;
  }

  /** Single use: the record is deleted whether or not the caller is its owner. */
  async take(state: string | null, userId: string): Promise<PendingConnect | null> {
    if (!state || !STATE_PATTERN.test(state) || this.taking.has(state)) return null;
    this.taking.add(state);
    try {
      const record = (await this.store.get(key(state))) as PendingConnect | null;
      if (!record) return null;
      await this.store.delete(key(state));
      return record.userId === userId ? record : null;
    } finally {
      this.taking.delete(state);
    }
  }
}

function key(state: string): string {
  return `connect:${state}`;
}

export type NoticeTone = 'success' | 'info' | 'warning' | 'danger';

export interface Notice {
  readonly tone: NoticeTone;
  readonly title: string;
  readonly lines: readonly string[];
  /**
   * A refused form, to draw it again as it was typed and mark the field in
   * error (`echoOfForm`): the name and the non-secret values only. Kept as
   * long as the notice — read once, by the session it was written for.
   */
  readonly form?: FormEcho;
}

interface StoredNotice extends Notice {
  readonly owner: string;
}

/**
 * One-time notices shown after a redirect. The URL carries only an opaque id
 * (`?notice=<id>`), never the text, so a crafted link cannot make the
 * instance display a message of the attacker's choosing; the id is readable
 * once, by the web session it was written for.
 */
export class NoticeStore {
  constructor(private readonly store: SessionStore) {}

  async put(owner: string, notice: Notice): Promise<string> {
    const id = randomBytes(NOTICE_ID_BYTES).toString('base64url');
    const stored: StoredNotice = { ...notice, owner };
    await this.store.set(`notice:${id}`, stored, NOTICE_TTL_MS);
    return id;
  }

  async take(owner: string, id: string | null | undefined): Promise<Notice | null> {
    if (!id || !/^[A-Za-z0-9_-]{10,64}$/.test(id)) return null;
    const stored = (await this.store.get(`notice:${id}`)) as StoredNotice | null;
    if (!stored || stored.owner !== owner) return null;
    await this.store.delete(`notice:${id}`);
    return {
      tone: stored.tone,
      title: stored.title,
      lines: stored.lines,
      ...(stored.form ? { form: stored.form } : {}),
    };
  }
}
