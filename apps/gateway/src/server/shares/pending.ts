/**
 * A share that waits for its owner's confirmation (spec §2.3): the share would
 * bring orphaned missions back, so the dialog lists them first. What was asked
 * is kept server-side under an opaque id — the URL of the confirmation carries
 * that id and nothing of the share — in the root's `SessionStore` port, under
 * its own key prefix (`share-confirm:`), and expires on its own.
 *
 * Nothing here is an authorization: the confirmation posts the share again,
 * through the same guard and the same checks, with the missions it was shown.
 */
import { randomBytes } from 'node:crypto';

import type { SessionStore } from '../compose/ports';
import type { ShareInput } from './service';

const MINUTE_MS = 60_000;
/** How long the owner has to read the list and confirm. */
export const SHARE_CONFIRM_TTL_MS = 10 * MINUTE_MS;
/** Query parameter of the Share dialog that names a share waiting for confirmation. */
export const SHARE_CONFIRM_PARAM = 'confirm';
const ID_BYTES = 16;
const ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;

export interface PendingShare {
  readonly connectionId: string;
  readonly input: ShareInput;
}

interface StoredPendingShare extends PendingShare {
  /** The web session the dialog was posted from. */
  readonly owner: string;
}

export class PendingShareStore {
  constructor(private readonly store: SessionStore) {}

  async put(owner: string, pending: PendingShare): Promise<string> {
    const id = randomBytes(ID_BYTES).toString('base64url');
    const stored: StoredPendingShare = { ...pending, owner };
    await this.store.set(key(id), stored, SHARE_CONFIRM_TTL_MS);
    return id;
  }

  /**
   * Readable by the session it was written for, as often as the page is loaded
   * until it expires: reading it changes nothing and grants nothing.
   */
  async read(owner: string, id: string | null | undefined): Promise<PendingShare | null> {
    if (!id || !ID_PATTERN.test(id)) return null;
    const stored = (await this.store.get(key(id))) as StoredPendingShare | null;
    if (!stored || stored.owner !== owner) return null;
    return { connectionId: stored.connectionId, input: stored.input };
  }
}

function key(id: string): string {
  return `share-confirm:${id}`;
}
