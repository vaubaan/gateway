/**
 * What is posted to a messaging address, per kind: the notification's payload
 * (`buildPayload`: title, body, url) with the url made absolute, and nothing else. Each
 * format is the service's own incoming-webhook body:
 *
 *   slack     `{ text }` in mrkdwn, `&`, `<`, `>` escaped (no `<!channel>` from a name)
 *   teams     a Workflows message: `{ type: "message", attachments: [Adaptive Card 1.4] }`
 *   discord   `{ content }`, markdown escaped, no mention parsed (`allowed_mentions`)
 *   ntfy      the JSON publish (`{ topic, title, message, click }`), posted to the server's root
 *   generic   `{ title, body, url, kind, instance }`
 *
 * Pure. The url is the instance's own page, never anything of a call.
 */
import { buildPayload, line, type Notification, type NotificationKind } from '../notification';
import type { AddressKind } from './address-rules';
import { ntfyTopicOf } from './address-rules';

/** The kind of the test message posted when an address is added. */
export const ADDRESS_TEST_KIND = 'address-test';

/** A message to one address: the payload's three fields, and what the generic body names. */
export interface OutgoingMessage {
  readonly title: string;
  readonly body: string;
  /** Absolute: the instance's public URL and the payload's path. */
  readonly url: string;
  readonly kind: NotificationKind | typeof ADDRESS_TEST_KIND;
  readonly instance: string;
}

/** What a messaging address receives of a notification: its payload, the url made absolute. */
export function messageOf(notification: Notification, publicUrl: URL): OutgoingMessage {
  const payload = buildPayload(notification);
  return {
    title: payload.title,
    body: payload.body,
    url: new URL(payload.url, publicUrl).href,
    kind: notification.kind,
    instance: line(notification.instance),
  };
}

/** The message posted when an address is added; it leads to the Settings page. */
export function testMessage(instance: string, settingsUrl: string): OutgoingMessage {
  const name = line(instance);
  return {
    title: name,
    body: `This address receives notifications of ${name}.`,
    url: settingsUrl,
    kind: ADDRESS_TEST_KIND,
    instance: name,
  };
}

/** Where a message is posted, and the JSON posted. */
export interface OutgoingRequest {
  readonly url: string;
  readonly json: unknown;
}

/** Discord's limit on `content`. */
const DISCORD_CONTENT_MAX = 2000;

function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function discordEscape(text: string): string {
  return text.replace(/[\\*_~`|>[\]()#<@-]/g, (c) => `\\${c}`);
}

/** At most `max` characters of escaped text, never ending on a lone escaping backslash. */
function cutEscaped(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1));
  const trailing = /\\+$/.exec(cut)?.[0].length ?? 0;
  return `${trailing % 2 === 1 ? cut.slice(0, -1) : cut}…`;
}

/** The body of one message to one address of this kind. */
export function outgoingRequest(
  kind: AddressKind,
  address: URL,
  message: OutgoingMessage,
): OutgoingRequest {
  switch (kind) {
    case 'slack':
      return {
        url: address.href,
        json: {
          text: `*${slackEscape(message.title)}*\n${slackEscape(message.body)}\n<${message.url}|Open>`,
          unfurl_links: false,
          unfurl_media: false,
        },
      };
    case 'teams':
      return {
        url: address.href,
        json: {
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              contentUrl: null,
              content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                  { type: 'TextBlock', text: message.title, weight: 'Bolder', wrap: true },
                  { type: 'TextBlock', text: message.body, wrap: true },
                ],
                actions: [{ type: 'Action.OpenUrl', title: 'Open', url: message.url }],
              },
            },
          ],
        },
      };
    case 'discord': {
      // The link always goes whole: the body is what is cut to fit `content`.
      const head = `**${discordEscape(message.title)}**\n`;
      const tail = `\n${message.url}`;
      const room = Math.max(0, DISCORD_CONTENT_MAX - head.length - tail.length);
      return {
        url: address.href,
        json: {
          content: `${head}${cutEscaped(discordEscape(message.body), room)}${tail}`,
          allowed_mentions: { parse: [] },
        },
      };
    }
    case 'ntfy': {
      // The JSON publish goes to the server's root (with its base path, for a self-hosted
      // server under one), the topic in the body: titles in any script, no header encoding.
      const root = new URL('.', address);
      return {
        url: root.href,
        json: {
          topic: ntfyTopicOf(address) ?? '',
          title: message.title,
          message: message.body,
          click: message.url,
        },
      };
    }
    case 'generic':
      return {
        url: address.href,
        json: {
          title: message.title,
          body: message.body,
          url: message.url,
          kind: message.kind,
          instance: message.instance,
        },
      };
  }
}
