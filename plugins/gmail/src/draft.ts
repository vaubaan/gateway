/**
 * The RFC 5322 message `create_draft` appends to the `\Drafts` folder and
 * `send_message` relays over SMTP (built without its `Bcc` header).
 *
 * Handbook : docs/handbook/services/gmail.md.
 *
 * The plugin builds the whole message itself ; nothing the agent writes is
 * copied into a header as it is :
 *   - addresses are the ones `collectRecipients` parsed (the classifier's
 *     grammar : one bare `local@domain` each, no display name), so no comma,
 *     quote or line break of the agent's reaches `To`, `Cc` or `Bcc` ;
 *   - the subject must hold no CR, LF or other control character (refused,
 *     not stripped) and is encoded as RFC 2047 words when it is not ASCII ;
 *   - the body is UTF-8, base64 in lines of 76 : whatever it holds, it cannot
 *     end the headers or start a MIME part.
 * A message to send is the same text with `bcc: []` : the Bcc recipients
 * travel in the SMTP envelope only. `withoutBccHeader` takes the header out
 * of a draft the owner wrote before `send_draft` relays it.
 */

import { randomBytes } from 'node:crypto';

import type { EmailAddress } from './address.ts';

/** Longest subject accepted, in characters. */
export const MAX_SUBJECT_LENGTH = 998;
/** Largest body accepted, in UTF-8 bytes. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** True when the value holds a C0 control character (CR and LF among them) or DEL. */
export function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
const BASE64_LINE = 76;
/** Bytes of UTF-8 per encoded word, so that a word stays under 75 characters. */
const WORD_BYTES = 45;

export interface DraftInput {
  readonly from: string;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly subject: string;
  readonly body: string;
  readonly date: Date;
}

/** Why a subject or body cannot become a draft, or `null`. */
export function draftProblem(subject: unknown, body: unknown): string | null {
  if (typeof subject !== 'string') return 'subject: expected a string.';
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return `subject: longer than ${MAX_SUBJECT_LENGTH} characters.`;
  }
  if (hasControlCharacter(subject)) return 'subject: holds a line break or a control character.';
  if (typeof body !== 'string') return 'body: expected a string.';
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return `body: larger than ${MAX_BODY_BYTES} bytes.`;
  }
  return null;
}

/** `=?UTF-8?B?…?=` words, folded, for a value that is not printable ASCII. */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let current: string[] = [];
  let size = 0;
  // Split on characters, never inside one, so each word is valid UTF-8.
  for (const ch of value) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (size + n > WORD_BYTES && current.length > 0) {
      words.push(current.join(''));
      current = [];
      size = 0;
    }
    current.push(ch);
    size += n;
  }
  if (current.length > 0) words.push(current.join(''));
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function base64Lines(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += BASE64_LINE) {
    lines.push(encoded.slice(i, i + BASE64_LINE));
  }
  return lines.join('\r\n');
}

const addressList = (list: readonly EmailAddress[]): string =>
  list.map((a) => a.address).join(', ');

/** The message, CRLF line endings, ready for `APPEND`. */
export function buildDraft(input: DraftInput): string {
  const domain = input.from.split('@')[1] ?? 'localhost';
  const headers: string[] = [
    `From: ${input.from}`,
    ...(input.to.length > 0 ? [`To: ${addressList(input.to)}`] : []),
    ...(input.cc.length > 0 ? [`Cc: ${addressList(input.cc)}`] : []),
    ...(input.bcc.length > 0 ? [`Bcc: ${addressList(input.bcc)}`] : []),
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${input.date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${base64Lines(input.body)}\r\n`;
}

/**
 * The message with every `Bcc` header field (and its folded lines) removed
 * from the header section ; the body is left byte for byte. A draft keeps its
 * Bcc recipients in a header, and a relayed header is delivered to every
 * recipient : the envelope carries them instead.
 */
export function withoutBccHeader(source: Buffer): Buffer {
  // latin1 maps each byte to one character and back : no byte of the message changes.
  const text = source.toString('latin1');
  const blank = /\r?\n\r?\n/.exec(text);
  const cut = blank === null ? text.length : blank.index + (text[blank.index] === '\r' ? 2 : 1);
  const lines = text.slice(0, cut).split(/(?<=\n)/);
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines) {
    // A line starting with a blank continues the field above it.
    if (/^[ \t]/.test(line)) {
      if (!dropping) kept.push(line);
      continue;
    }
    dropping = /^bcc[ \t]*:/i.test(line);
    if (!dropping) kept.push(line);
  }
  return Buffer.from(kept.join('') + text.slice(cut), 'latin1');
}
