/**
 * `github__get_job_logs` : the log of one workflow job, as plain text, bounded.
 *
 * `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` answers a redirect
 * (302) to a short-lived download URL. The redirect is not followed by
 * `fetch` (`redirect: 'manual'`) : the download is a second request, sent
 * **without** the connection's token — the URL carries its own short-lived
 * signature, and the token never leaves for another host.
 *
 * The body is read as a stream and at most `maxBytes` of it is kept : the
 * beginning, or with `tail` the end (the whole log is read, the last
 * `maxBytes` kept). The answer says when the log was truncated.
 *
 * Neither the download URL nor the log is ever logged or put in an error
 * message : the URL is a bearer of the log for its lifetime, and the log can
 * hold what a step printed.
 */
import { UpstreamHttpError, type ExecuteContext, type McpToolResult } from '@vaubaan/plugin-sdk';

import { GITHUB_API_BASE, GITHUB_API_HEADERS } from './api.ts';
import type { RepoCall } from './call.ts';

export type JobLogsCall = Extract<RepoCall, { tool: 'github__get_job_logs' }>;

/** The most a `tail` read streams before giving up (256 MiB) : the end of a larger log is not read. */
export const JOB_LOG_TAIL_READ_MAX = 256 * 1024 * 1024;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** What a bounded read kept of a log. */
export interface BoundedLog {
  readonly bytes: Uint8Array;
  /** The bytes read in all ; the size of the log when it was read to its end. */
  readonly read: number;
  readonly truncated: boolean;
}

export async function readJobLogs(
  ctx: Pick<ExecuteContext, 'fetch' | 'signal'>,
  token: string,
  call: JobLogsCall,
): Promise<McpToolResult> {
  const { owner, repo } = call.target;
  const signal = ctx.signal ? { signal: ctx.signal } : {};
  const asked = await ctx.fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/jobs/${call.jobId}/logs`,
    {
      method: 'GET',
      headers: { ...GITHUB_API_HEADERS, Authorization: `Bearer ${token}` },
      redirect: 'manual',
      ...signal,
    },
  );
  let answer = asked;
  if (REDIRECTS.has(asked.status)) {
    await asked.body?.cancel();
    const location = downloadUrlOf(asked.headers.get('location'));
    // No Authorization : the download URL is signed, and the token stays with GitHub's API.
    answer = await ctx.fetch(location, { method: 'GET', redirect: 'follow', ...signal });
    if (!answer.ok) {
      await answer.body?.cancel();
      throw new UpstreamHttpError(
        `github: the download of the log of job ${call.jobId} answered HTTP ${answer.status}`,
        answer.status,
      );
    }
  } else if (!asked.ok) {
    throw new UpstreamHttpError(
      `github GET actions/jobs/${call.jobId}/logs failed with HTTP ${asked.status}${await messageOf(asked)}`,
      asked.status,
    );
  }
  const log = await readBounded(answer.body, call.maxBytes, call.tail);
  return { content: [{ type: 'text', text: render(log, call) }] };
}

/** The download location GitHub answered, when it is an https URL ; never quoted back. */
function downloadUrlOf(location: string | null): string {
  let url: URL | null;
  try {
    url = location === null ? null : new URL(location);
  } catch {
    url = null;
  }
  if (url === null || url.protocol !== 'https:') {
    throw new UpstreamHttpError(
      'github: the job log redirect did not name an https download URL',
      502,
    );
  }
  return url.toString();
}

/** GitHub's `message` of a failed API answer, as ` (message)`, bounded ; empty when absent. */
async function messageOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    return typeof body.message === 'string' ? ` (${body.message.slice(0, 200)})` : '';
  } catch {
    return '';
  }
}

/**
 * At most `max` bytes of `body` : the first ones, the stream cancelled as
 * soon as more arrive ; or with `tail` the last ones, the stream read to its
 * end (up to `JOB_LOG_TAIL_READ_MAX`) with only the end kept in memory.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  tail: boolean,
): Promise<BoundedLog> {
  if (body === null) return { bytes: new Uint8Array(0), read: 0, truncated: false };
  const reader = body.getReader();
  const kept: Uint8Array[] = [];
  let keptBytes = 0;
  let read = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.length;
    kept.push(value);
    keptBytes += value.length;
    if (!tail && keptBytes > max) {
      truncated = true;
      await reader.cancel();
      break;
    }
    if (tail) {
      // Drop whole chunks from the front while what stays still covers `max`.
      while (kept.length > 1 && keptBytes - kept[0]!.length >= max) {
        keptBytes -= kept.shift()!.length;
      }
      if (read > JOB_LOG_TAIL_READ_MAX) {
        await reader.cancel();
        throw new UpstreamHttpError(
          `github: the log is longer than ${JOB_LOG_TAIL_READ_MAX} bytes; its end cannot be read here — read its beginning (tail: false) or open the job's page`,
          413,
        );
      }
    }
  }
  const all = concat(kept, keptBytes);
  if (all.length <= max) return { bytes: all, read, truncated };
  return {
    bytes: tail ? all.subarray(all.length - max) : all.subarray(0, max),
    read,
    truncated: true,
  };
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** UTF-8 continuation bytes : a cut inside a character starts with them. */
const CONTINUATION_MASK = 0xc0;
const CONTINUATION = 0x80;

/** The text of the log, led by one line saying what was cut when it was. */
function render(log: BoundedLog, call: JobLogsCall): string {
  let bytes = log.bytes;
  if (log.truncated && call.tail) {
    // The cut may fall inside a character : start at the next one.
    let skip = 0;
    while (skip < bytes.length && skip < 3 && (bytes[skip]! & CONTINUATION_MASK) === CONTINUATION) {
      skip += 1;
    }
    bytes = bytes.subarray(skip);
  }
  const text = new TextDecoder('utf-8').decode(bytes);
  if (!log.truncated) return text;
  const note = call.tail
    ? `[log truncated: the last ${log.bytes.length} bytes of ${log.read}]`
    : `[log truncated: the first ${log.bytes.length} bytes; the log is longer — pass tail: true for its end, or a larger max_bytes]`;
  return `${note}\n${text}`;
}
