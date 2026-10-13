/**
 * The pages of the authorization endpoint: the consent screen, and the
 * messages a human reads when a request cannot be honoured.
 *
 * They are rendered here, as self-contained documents, rather than as pages of
 * the application: the consent screen is the one place where a user hands an
 * agent part of their authority, so its content, its escaping and its response
 * headers are decided — and tested — in one host-agnostic place. No script, no
 * external resource, never framed, never cached, no referrer outside the
 * instance.
 *
 * **Everything a client says of itself is shown as a claim.** The name comes
 * from the registration; what the screen states as fact is where the
 * authorization code will be sent.
 */
import { randomBytes } from 'node:crypto';

import type { BuildInfo } from '../config/build-info';
import type { OAuthClientRecord } from '../store/types';
import { MANAGEMENT_SCOPE } from './endpoints';
import type { RedirectKind } from './redirect-uri';

const NONCE_BYTES = 16;
/** The form field carrying the id of the consent shown, and the user's answer. */
export const CONSENT_FIELD = 'consent';
export const DECISION_FIELD = 'decision';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; line-height: 1.5; }
main { width: 100%; max-width: 36rem; padding: 2rem 1.5rem; box-sizing: border-box; }
h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.75rem; }
h2 { font-size: 0.875rem; font-weight: 600; margin: 1.25rem 0 0.25rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
p { margin: 0 0 0.75rem; }
ul { margin: 0 0 0.75rem; padding-left: 1.25rem; }
dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
dt { opacity: 0.7; }
dd { margin: 0; overflow-wrap: anywhere; }
code { font-family: ui-monospace, monospace; font-size: 0.875em; }
.box { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 0.5rem; padding: 1rem; margin: 1rem 0; }
.warn { border-color: #b45309; }
.note { font-size: 0.875rem; opacity: 0.8; }
.actions { display: flex; gap: 0.75rem; justify-content: flex-end; margin-top: 1.5rem; }
button { font: inherit; padding: 0.5rem 1.25rem; border-radius: 0.375rem; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); background: transparent; color: inherit; cursor: pointer; }
button.primary { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
footer { margin-top: 2rem; font-size: 0.75rem; opacity: 0.7; text-align: center; }
`;

/**
 * The build footer of the application's pages (`components/shell/BuildFooter`),
 * for the documents rendered here: the same two stamps `/healthz` answers.
 */
function buildFooter(build: BuildInfo | undefined): string {
  if (!build) return '';
  return `<footer data-testid="build-footer">Vaubaan Gateway <span data-testid="gateway-version">${escapeHtml(build.version)}</span> · <span data-testid="gateway-commit">${escapeHtml(build.commit)}</span></footer>`;
}

function document(status: number, title: string, body: string, build?: BuildInfo): Response {
  const nonce = randomBytes(NONCE_BYTES).toString('base64');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body><main>${body}${buildFooter(build)}</main></body>
</html>
`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      // `same-origin`, not `no-referrer`: a form posted from a `no-referrer`
      // document carries `Origin: null`, which the mutation guard refuses. The
      // address of this page still never leaves the instance.
      'Referrer-Policy': 'same-origin',
    },
  });
}

/** A page with one title and one sentence: the request stops here. */
export function messagePage(
  status: number,
  title: string,
  message: string,
  build?: BuildInfo,
): Response {
  return document(
    status,
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`,
    build,
  );
}

export interface ConsentView {
  /** The id of the pending consent the form posts back. */
  readonly consentId: string;
  readonly userEmail: string;
  readonly client: OAuthClientRecord;
  /** Where the authorization code goes, already classified. */
  readonly destination: { readonly kind: RedirectKind; readonly label: string };
  /** The path the form posts to (`CONSENT_DECISION_PATH`). */
  readonly action: string;
  /** The running build, for the footer; absent, the page has none. */
  readonly build?: BuildInfo;
}

const DESTINATION_SENTENCE: Readonly<Record<RedirectKind, string>> = {
  loopback:
    'An application running on this computer. Any program on this computer can claim to be it: only continue if you started this connection yourself, just now.',
  web: 'A server on the network. Only continue if you recognise this address and trust whoever runs it with your missions.',
  'app-scheme':
    'Whichever application your system opens for this kind of link. Only continue if you started this connection yourself, just now.',
};

function registrationLine(client: OAuthClientRecord): string {
  const day = escapeHtml(client.createdAt.slice(0, 10));
  return client.registration === 'metadata-document'
    ? `Described by its own document at the address above; first seen on ${day}.`
    : `Registered itself on ${day}.`;
}

/**
 * The consent screen (spec §4.1 bis): who asks, for whom, the one scope and
 * what it covers and never covers, and where the code goes.
 */
export function consentPage(view: ConsentView): Response {
  const { client, destination } = view;
  const name = escapeHtml(client.name);
  const body = `
<h1>Let ${name} manage your missions?</h1>
<p>An application that calls itself <strong>${name}</strong> asks to act on your behalf on this gateway, as <strong>${escapeHtml(view.userEmail)}</strong>.</p>

<div class="box">
<dl>
<dt>Application</dt><dd>${name}<div class="note">This name is what the application says of itself. It is not verified.</div></dd>
<dt>Client id</dt><dd><code>${escapeHtml(client.clientId)}</code><div class="note">${registrationLine(client)}</div></dd>
<dt>Permission</dt><dd><code>${MANAGEMENT_SCOPE}</code> — mission management</dd>
</dl>
</div>

<div class="box warn">
<dl>
<dt>Access goes to</dt><dd><code>${escapeHtml(destination.label)}</code><div class="note">${escapeHtml(DESTINATION_SENTENCE[destination.kind])}</div></dd>
</dl>
</div>

<h2>It will be able to</h2>
<ul>
<li>read your connections, what was shared with you, and your missions with their budgets;</li>
<li>preview and <strong>issue missions in your name</strong>, within what you yourself may do;</li>
<li>rotate the token of the missions it issued, and revoke any of your missions.</li>
</ul>

<h2>It will never be able to</h2>
<ul>
<li>answer a request: grant a claim, approve an action, extend a budget or open a gate;</li>
<li>connect, share, transfer or revoke a provider connection;</li>
<li>call a provider tool itself.</li>
</ul>

<p class="note">Every mission it issues is recorded under your name with the name of this application. You can end this delegation at any time on the Delegations page.</p>

<form method="post" action="${escapeHtml(view.action)}">
<input type="hidden" name="${CONSENT_FIELD}" value="${escapeHtml(view.consentId)}">
<div class="actions">
<button type="submit" name="${DECISION_FIELD}" value="deny">Deny</button>
<button type="submit" name="${DECISION_FIELD}" value="approve" class="primary">Authorize</button>
</div>
</form>`;
  return document(200, `Authorize ${client.name}`, body, view.build);
}
