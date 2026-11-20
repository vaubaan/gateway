/**
 * The privacy page (website spec §2.5 bis): what the project's own services do
 * with personal data — the site, the collector, and Vaubaan's OAuth broker —
 * with the statements Google requires of an application it verifies (its
 * consent screen links here). What the broker keeps is the broker spec §3;
 * keep this page in step with it.
 */
import { githubBlob, githubTree } from '../site/constants';

/** Google's Limited Use sentence, word for word (Google API Services User Data Policy). */
export const LIMITED_USE_SENTENCE =
  "Vaubaan's use and transfer of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.";

export const PRIVACY_PUBLISHER = 'DALAE, 200 rue de la Croix Nivert, 75015 Paris, France';

export function privacyMarkdown(): string {
  return `# Privacy

Vaubaan collects nothing about you on this site, and the project never receives what your agents do with your accounts. This page says what each of the project's own services handles: this site, the telemetry collector and Vaubaan's OAuth broker. A Vaubaan instance is run by you or your company: what it stores belongs to whoever runs it, not to the project.

## This site

- No account, no cookie, no tracker, no analytics or third-party script.
- The site and the collector are hosted on Vercel, which records the network address of each request in the project's runtime logs and keeps it for its plan's base window (one day on Pro, one hour on Hobby); the project reads these logs only to run the site, never to identify anyone. Details: [trust center](/trust#what-leaves-an-instance).

## The telemetry collector

Only if your instance's administrator turns telemetry on. A report holds a plugin's version and the outcome of its tools: never a call's content, an account, a person or an address. What is sent, field by field: [telemetry](/docs/operations/telemetry).

## Vaubaan's OAuth broker and your Google data

Some services, Google Calendar among them, let an application sign in only through an OAuth client registered with them. Vaubaan runs one such client in a broker at \`oauth.vaubaan.app\`, so that your instance connects your calendar without you registering a client at Google.

**What the broker does.** When you connect Google Calendar in your instance, the broker sends your browser to Google's consent screen, receives Google's answer and hands your instance the tokens that let it call Google Calendar on your behalf. Later, your instance asks the broker to refresh an expired access token, and to revoke your access when you disconnect.

**What it asks Google for**: two scopes, nothing wider.

- \`calendar.calendarlist.readonly\`: to list your calendars, so that you choose the ones a mission may use.
- \`calendar.events\`: to read your events and when you are busy, and to create, move or cancel the events a mission allows, after your approval when the mission asks for it.

**Where your Google data goes.** Your calendars and events go from Google to **your own instance** only. They never pass through the broker and never reach the Vaubaan project. Your instance stores the refresh token encrypted, sealed by the broker so that it opens only with your instance's broker key.

**What the broker keeps**: its own Google client secret, the key that seals refresh tokens, and, for each instance enrolled with it, an opaque identifier and the digests of its key and return addresses.

**What the broker never keeps**: your tokens beyond the call that carries them, your Google account, your email address, a record of who connected what, or anything on disk. A token passes through its memory only while it is exchanged, refreshed or revoked. Its logs hold route names, statuses and durations, never a token, a code or an address of yours. Its code is public: [apps/oauth-broker](${githubTree('apps/oauth-broker')}), and what it keeps is its [specification](${githubBlob('docs/spec/oauth-broker.md')}).

**Where it runs.** Today on Fly.io, without an enclave: the hosting platform could in principle read the broker's memory while a token passes through it. The broker is built to run in an attested enclave, where neither the platform nor the project can; moving it there is planned.

**Removing access.** Disconnect the account in your instance: it asks the broker to revoke the token at Google and erases its copy. You can also remove Vaubaan from your Google account at any time (Google Account, Security, Third-party apps); your instance then shows the account as expired.

**Limited Use.** ${LIMITED_USE_SENTENCE} Your Google data is used only to provide the calendar features you see in your instance; it is never sold, never used for advertising, never read by people at Vaubaan, and never used to train AI models.

## Who publishes this site

${PRIVACY_PUBLISHER}. Security reports: [SECURITY.md](${githubBlob('SECURITY.md')}).
`;
}
