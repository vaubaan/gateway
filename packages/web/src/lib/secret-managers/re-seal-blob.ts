/**
 * `runReseal({ orgSlug, resourceId, accessKey })` — per-blob re-seal
 * handler invoked by the banner (spec §4.5).
 *
 * Steps :
 *
 *   1. GET /resources/:rId/access/:key       → fetch the current sealed blob.
 *   2. unsealAs(blob, me.fingerprint, me)    → recover the cleartext.
 *   3. GET /resources/:rId/access/:key/recipients → fetch the fresh
 *      recipient list (now includes the new member, excludes the
 *      revoked one).
 *   4. sealForRecipients(cleartext, fresh)   → build the new blob.
 *   5. PUT /resources/:rId/access/:key       → persist. Server PATCHes
 *      `recipients_stale=false` on the row.
 *   6. wipe the cleartext bytes (`fill(0)`).
 *
 * Returns `{ ok: true }` on success, `{ ok: false, error }` otherwise.
 *
 * ZK invariants :
 *
 * - The cleartext lives in a single `Uint8Array` local to this function.
 * - The function `fill(0)`s the cleartext in a `finally` block, even on
 *   error.
 * - The current user must have an unlocked identity (via
 *   `identityStore.get()`) — without it the handler aborts with
 *   `identity_locked`.
 * - The user must be a recipient of the current blob. If not (`unsealAs`
 *   returns `null`), the handler aborts with `not_a_recipient` and
 *   surfaces the count to the banner so the admin knows another
 *   recipient must do the re-seal.
 */

import { sealForRecipients, unsealAs } from '@crm/core/crypto';

import { identityStore } from '@/lib/crypto/identity-store';
import { base64ToBytes } from '@/lib/sealed/base64';

export interface RunResealInput {
  readonly orgSlug: string;
  readonly resourceId: string;
  readonly accessKey: string;
}

export type RunResealResult = { ok: true; sealed_for: number } | { ok: false; error: string };

interface AccessGetResponse {
  readonly access: {
    readonly sealed_blob: {
      readonly v: 1;
      readonly recipients: ReadonlyArray<{ fp: string; ct: string }>;
    };
  };
}

interface RecipientWire {
  readonly user_id?: string;
  readonly public_key: string;
  readonly fingerprint: string;
}

interface RecipientsResponse {
  readonly defaults: ReadonlyArray<RecipientWire>;
}

export async function runReseal(input: RunResealInput): Promise<RunResealResult> {
  const identity = identityStore.get();
  if (!identity) {
    return { ok: false, error: 'identity_locked' };
  }

  const accessUrl = `/api/crm/v1/orgs/${encodeURIComponent(
    input.orgSlug,
  )}/resources/${encodeURIComponent(input.resourceId)}/access/${encodeURIComponent(
    input.accessKey,
  )}`;
  const recipientsUrl = `/api/crm/v1/resources/${encodeURIComponent(
    input.resourceId,
  )}/access/${encodeURIComponent(input.accessKey)}/recipients`;

  let cleartext: Uint8Array | null = null;
  try {
    const getRes = await fetch(accessUrl, { cache: 'no-store' });
    if (!getRes.ok) {
      const body = (await getRes.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? `fetch_${String(getRes.status)}` };
    }
    const accessBody = (await getRes.json()) as AccessGetResponse;
    const blob = accessBody.access.sealed_blob;
    const recovered = await unsealAs(blob, identity.fingerprint, identity);
    if (!recovered) {
      return { ok: false, error: 'not_a_recipient' };
    }
    cleartext = recovered;

    const recRes = await fetch(recipientsUrl, { cache: 'no-store' });
    if (!recRes.ok) {
      const body = (await recRes.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? `recipients_${String(recRes.status)}` };
    }
    const recBody = (await recRes.json()) as RecipientsResponse;
    const fresh = recBody.defaults.map((r) => ({
      publicKey: base64ToBytes(r.public_key),
      fingerprint: r.fingerprint,
    }));
    if (fresh.length === 0) {
      return { ok: false, error: 'no_recipients' };
    }

    const newBlob = await sealForRecipients(cleartext, fresh);
    const putRes = await fetch(accessUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sealed_blob: newBlob }),
    });
    if (!putRes.ok) {
      const body = (await putRes.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? `put_${String(putRes.status)}` };
    }
    return { ok: true, sealed_for: fresh.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown_error' };
  } finally {
    if (cleartext) cleartext.fill(0);
  }
}
