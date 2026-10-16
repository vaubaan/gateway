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
 * The document itself — the tokens of the interface in both themes, the brand,
 * the column — is `http/document.ts`; this module owns what the pages say and
 * the headers they are sent with.
 *
 * **Everything a client says of itself is shown as a claim.** The name comes
 * from the registration; what the screen states as fact is where the
 * authorization code will be sent.
 */
import { randomBytes } from 'node:crypto';

import type { BuildInfo } from '../config/build-info';
import { escapeHtml, htmlDocument, messageDocument, type DocumentTheme } from '../http/document';
import type { OAuthClientRecord } from '../store/types';
import { MANAGEMENT_SCOPE } from './endpoints';
import type { RedirectKind } from './redirect-uri';

const NONCE_BYTES = 16;
/** The form field carrying the id of the consent shown, and the user's answer. */
export const CONSENT_FIELD = 'consent';
export const DECISION_FIELD = 'decision';

export { escapeHtml };

/**
 * The build footer of the application's pages (`components/shell/BuildFooter`),
 * for the documents rendered here: the same two stamps `/healthz` answers.
 */
function buildFooter(build: BuildInfo | undefined): string {
  if (!build) return '';
  return `<footer data-testid="build-footer">Vaubaan Gateway <span data-testid="gateway-version">${escapeHtml(build.version)}</span> · <span data-testid="gateway-commit">${escapeHtml(build.commit)}</span></footer>`;
}

/**
 * The response around a document: never framed, never cached, nothing loaded
 * but the one style element the nonce names.
 */
function respond(status: number, html: (nonce: string) => string): Response {
  const nonce = randomBytes(NONCE_BYTES).toString('base64');
  return new Response(html(nonce), {
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

/** How a document of this module is drawn: the running build, and the theme of the request. */
export interface PageLook {
  /** The running build, for the footer; absent, the page has none. */
  readonly build?: BuildInfo;
  /** The theme the person chose in the application (`documentThemeOf`); absent: the system's. */
  readonly theme?: DocumentTheme | null;
}

function lookOf(look: PageLook | BuildInfo | undefined): PageLook {
  if (!look) return {};
  return 'version' in look ? { build: look } : look;
}

/** A page with one title and one sentence: the request stops here. */
export function messagePage(
  status: number,
  title: string,
  message: string,
  look?: PageLook | BuildInfo,
): Response {
  const { build, theme } = lookOf(look);
  return respond(status, (nonce) =>
    messageDocument({ title, message, footer: buildFooter(build), theme, nonce }),
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
  /** The theme the person chose in the application; absent: the system's. */
  readonly theme?: DocumentTheme | null;
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
 * what it covers and never covers, and where the code goes. The words are the
 * interface's (accounts, keys, limits); what is granted is the scope's, and
 * the scope is printed as the protocol spells it.
 */
export function consentPage(view: ConsentView): Response {
  const { client, destination } = view;
  const name = escapeHtml(client.name);
  const body = `
<h1>Let ${name} manage your missions?</h1>
<p class="lede">An application that calls itself <strong>${name}</strong> asks to act on your behalf on this gateway, as <strong>${escapeHtml(view.userEmail)}</strong>.</p>

<div class="facts">
<dl>
<dt>Application</dt><dd>${name}<div class="note">This name is what the application says of itself. It is not verified.</div></dd>
<dt>Client id</dt><dd><code>${escapeHtml(client.clientId)}</code><div class="note">${registrationLine(client)}</div></dd>
<dt>Permission</dt><dd><code>${MANAGEMENT_SCOPE}</code> — mission management</dd>
</dl>
</div>

<div class="box">
<dl>
<dt>Access goes to</dt><dd><code>${escapeHtml(destination.label)}</code><div class="note">${escapeHtml(DESTINATION_SENTENCE[destination.kind])}</div></dd>
</dl>
</div>

<h2>It will be able to</h2>
<ul>
<li>read your accounts, what was shared with you, and your missions with their limits;</li>
<li>preview and <strong>create missions in your name</strong>, within what you yourself may do;</li>
<li>replace the key of the missions it created, and stop any of your missions.</li>
</ul>

<h2>It will never be able to</h2>
<ul>
<li>answer what waits for you: approve an action, give more room after a limit, extend a mission or let a permission run freely;</li>
<li>connect an account, give access to it, transfer it or disconnect it;</li>
<li>call a tool of a service itself.</li>
</ul>

<p class="note">Every mission it creates is recorded under your name with the name of this application. You can end this at any time under Settings, Connected apps.</p>

<form method="post" action="${escapeHtml(view.action)}">
<input type="hidden" name="${CONSENT_FIELD}" value="${escapeHtml(view.consentId)}">
<div class="actions">
<button type="submit" name="${DECISION_FIELD}" value="deny">Deny</button>
<button type="submit" name="${DECISION_FIELD}" value="approve" class="primary">Authorize</button>
</div>
</form>`;
  return respond(200, (nonce) =>
    htmlDocument({
      title: `Authorize ${client.name}`,
      body,
      footer: buildFooter(view.build),
      theme: view.theme,
      nonce,
    }),
  );
}
