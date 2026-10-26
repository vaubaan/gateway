/**
 * HTML body → readable text, for a message that has no text/plain part.
 *
 * Handbook : docs/handbook/providers/gmail.md, "Execution".
 *
 * `html-to-text` (MIT) parses the HTML (htmlparser2) and writes text : the
 * target of a link is kept next to its words (`label [https://…]`, once when
 * they are the same), images are dropped, `script` / `style` / `head` never
 * reach the text, no line is wrapped. The input is bounded before parsing
 * (`MAX_HTML_BYTES`, read by the transport) and the output is capped like a
 * plain body. Nothing here is rendered or executed : the result is a string.
 */

import { convert, type HtmlToTextOptions } from 'html-to-text';

/** Bytes of an HTML body read from the server before conversion. */
export const MAX_HTML_BYTES = 200_000;

const OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  // The input is cut before conversion (below) : this limit, which would write to
  // stderr, is never reached.
  limits: { maxInputLength: MAX_HTML_BYTES * 4 },
  selectors: [
    { selector: 'img', format: 'skip' },
    { selector: 'head', format: 'skip' },
    { selector: 'script', format: 'skip' },
    { selector: 'style', format: 'skip' },
    {
      selector: 'a',
      options: { hideLinkHrefIfSameAsText: true, linkBrackets: ['[', ']'], noAnchorUrl: true },
    },
    { selector: 'h1', format: 'heading', options: { uppercase: false } },
    { selector: 'h2', format: 'heading', options: { uppercase: false } },
    { selector: 'h3', format: 'heading', options: { uppercase: false } },
  ],
};

/** The text of an HTML body, at most `maxChars` characters ; `truncated` when cut. */
export function htmlToText(html: string, maxChars: number): { text: string; truncated: boolean } {
  const text = convert(html.slice(0, MAX_HTML_BYTES), OPTIONS).trim();
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false };
}
