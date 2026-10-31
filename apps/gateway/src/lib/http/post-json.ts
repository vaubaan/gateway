/**
 * The one way a client component posts to the gateway's API (packages audit
 * 2026-10-31, F8): JSON in, JSON out, a failure in one sentence — the message the
 * gateway stated, its status otherwise, or that it could not be reached. And the
 * busy flag and the error a form shows while it waits, owned by `useAction`.
 */
import { useCallback, useState } from 'react';

import { messageOf } from './message-of';

/** What a form says when the request never reached the gateway. */
export const UNREACHABLE = 'The gateway could not be reached.';

export type PostAnswer =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | {
      readonly ok: false;
      /** `0` when the gateway could not be reached. */
      readonly status: number;
      readonly body: unknown;
      /** The sentence to show. */
      readonly message: string;
    };

/** POSTs `payload` as JSON (no body when absent); never throws. */
export async function postJson(
  url: string,
  payload?: unknown,
  send: typeof fetch = fetch,
): Promise<PostAnswer> {
  let response: Response;
  try {
    response = await send(url, {
      method: 'POST',
      ...(payload === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    });
  } catch {
    return { ok: false, status: 0, body: null, message: UNREACHABLE };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return { ok: true, status: response.status, body };
  return { ok: false, status: response.status, body, message: messageOf(body, response.status) };
}

export interface ActionOptions {
  /**
   * The error to show for a failed answer, instead of its message; `null` shows none
   * (the caller shows the failure its own way, a form's issues for instance).
   */
  readonly errorOf?: (answer: Extract<PostAnswer, { ok: false }>) => string | null;
}

/** `busy` while a post is under way, `error` the last failure's sentence. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (url: string, payload?: unknown, options: ActionOptions = {}): Promise<PostAnswer> => {
      setBusy(true);
      setError(null);
      try {
        const answer = await postJson(url, payload);
        if (!answer.ok) setError(options.errorOf ? options.errorOf(answer) : answer.message);
        return answer;
      } finally {
        setBusy(false);
      }
    },
    [],
  );
  return { busy, setBusy, error, setError, run };
}
