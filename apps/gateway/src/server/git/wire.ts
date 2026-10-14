/**
 * Responses of the git remote, in what git reads (gitprotocol-http(5)):
 *
 *   - `401` with `WWW-Authenticate: Basic`, so git asks its credential helper;
 *   - a `text/plain` error, which git prints as `remote:` lines before
 *     `fatal: unable to access …: The requested URL returned error: <status>`;
 *   - an `ERR` pkt-line on a `200`, which git prints as `fatal: remote error:`;
 *   - the report of a push (`unpack`, then `ok` / `ng` per ref), wrapped in
 *     side-band packets when git asked for them, with the gateway's
 *     messages on the progress channel (`remote:` lines);
 *   - Git LFS's own JSON error, which the LFS client prints.
 *
 * Every response says `Cache-Control: no-cache`: nothing a mission key opened
 * may be kept by an intermediary.
 */
import {
  concatBytes,
  encodeReportStatus,
  flushPkt,
  pktLine,
  RECEIVE_PACK_RESULT_TYPE,
  SIDE_BAND,
  sideBand,
} from '@vaubaan/plugin-sdk';

import { HTTP_NOT_IMPLEMENTED, HTTP_OK, HTTP_UNAUTHORIZED, NO_CACHE } from './constants';
import { oneLine, prefixed } from './words';

/** Realm of the Basic challenge; git shows it to a person typing a password. */
export const GIT_REALM = 'Vaubaan Gateway';

/** A plain-text answer; git prints its lines under `remote:`. */
export function gitText(
  status: number,
  text: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(prefixed(text), {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_CACHE, ...headers },
  });
}

/** No key, or one that does not authenticate: git asks its credential helper. */
export function unauthorized(text: string): Response {
  return gitText(HTTP_UNAUTHORIZED, text, {
    'WWW-Authenticate': `Basic realm="${GIT_REALM}", charset="UTF-8"`,
  });
}

/** An `ERR` pkt-line: git stops with `fatal: remote error: <line>`. */
export function errPacket(service: string, line: string): Response {
  return new Response(pktLine(`ERR ${oneLine(line)}\n`), {
    status: HTTP_OK,
    headers: { 'Content-Type': `application/x-${service}-result`, ...NO_CACHE },
  });
}

/** Git LFS asks; the remote does not serve LFS (ADR gateway-as-git-remote D8). */
export function lfsUnsupported(): Response {
  return new Response(
    JSON.stringify({
      message:
        'Git LFS is not supported by the Vaubaan git remote. A mission that needs LFS uses github__mint_install_token and talks to GitHub directly.',
    }),
    {
      status: HTTP_NOT_IMPLEMENTED,
      headers: { 'Content-Type': 'application/vnd.git-lfs+json', ...NO_CACHE },
    },
  );
}

/** What the client asked of the report: `report-status`, and side-band packets. */
export interface ReportFormat {
  readonly reportStatus: boolean;
  readonly sideBand: boolean;
}

export interface RefOutcome {
  readonly ref: string;
  /** `null`: the ref moved. */
  readonly error: string | null;
}

/**
 * The answer to a push: the report git turns into `* [new branch]` and
 * `! [remote rejected]` lines, and `messages` on the progress channel.
 */
export function pushReport(input: {
  readonly format: ReportFormat;
  readonly unpack: string;
  readonly refs: readonly RefOutcome[];
  readonly messages?: string;
}): Response {
  const { format } = input;
  const report = format.reportStatus
    ? encodeReportStatus(
        oneLine(input.unpack),
        input.refs.map((r) => ({ ref: r.ref, error: r.error === null ? null : oneLine(r.error) })),
      )
    : new Uint8Array(0);
  let body: Uint8Array;
  if (format.sideBand) {
    const progress = input.messages ? new TextEncoder().encode(input.messages) : new Uint8Array(0);
    body = concatBytes([
      ...sideBand(SIDE_BAND.progress, progress),
      ...sideBand(SIDE_BAND.data, report),
      flushPkt(),
    ]);
  } else {
    body = report;
  }
  return new Response(concatBytes([body]), {
    status: HTTP_OK,
    headers: { 'Content-Type': RECEIVE_PACK_RESULT_TYPE, ...NO_CACHE },
  });
}
