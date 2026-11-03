/**
 * What each kind of messaging address receives: the payload's title, body and absolute url
 * in the service's own webhook format, escaped so that a name cannot mention a channel.
 */
import { describe, expect, it } from 'vitest';

import { outgoingRequest, type OutgoingMessage } from './messages';

const MESSAGE: OutgoingMessage = {
  title: 'Acme gateway',
  body: 'Release <!channel> & @everyone asks for your approval. Open it to answer.',
  url: 'https://gateway.example.com/r/req-1',
  kind: 'request-opened',
  instance: 'Acme gateway',
};

describe('messaging message formats', () => {
  it('slack: mrkdwn text with &, <, > escaped and a link', () => {
    const { url, json } = outgoingRequest(
      'slack',
      new URL('https://hooks.slack.com/services/T/B/x'),
      MESSAGE,
    );
    expect(url).toBe('https://hooks.slack.com/services/T/B/x');
    expect(json).toEqual({
      text: '*Acme gateway*\nRelease &lt;!channel&gt; &amp; @everyone asks for your approval. Open it to answer.\n<https://gateway.example.com/r/req-1|Open>',
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it('teams: a Workflows message carrying an Adaptive Card', () => {
    const { json } = outgoingRequest(
      'teams',
      new URL('https://prod-01.westeurope.logic.azure.com/workflows/1'),
      MESSAGE,
    );
    expect(json).toMatchObject({
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', text: MESSAGE.title },
              { type: 'TextBlock', text: MESSAGE.body },
            ],
            actions: [{ type: 'Action.OpenUrl', url: MESSAGE.url }],
          },
        },
      ],
    });
  });

  it('discord: content escaped, no mention parsed, at most 2000 characters, the link whole', () => {
    const { json } = outgoingRequest('discord', new URL('https://discord.com/api/webhooks/1/t'), {
      ...MESSAGE,
      body: `${MESSAGE.body} ${'x'.repeat(3000)}`,
    }) as { json: { content: string; allowed_mentions: unknown } };
    expect(json.allowed_mentions).toEqual({ parse: [] });
    expect(json.content.startsWith('**Acme gateway**\nRelease \\<!channel\\> & \\@everyone')).toBe(
      true,
    );
    expect(json.content.length).toBeLessThanOrEqual(2000);
    expect(json.content.endsWith(`…\n${MESSAGE.url}`)).toBe(true);
    // A cut never leaves a lone escaping backslash before the ellipsis.
    const long = outgoingRequest('discord', new URL('https://discord.com/api/webhooks/1/t'), {
      ...MESSAGE,
      body: '*'.repeat(3000),
    }) as { json: { content: string } };
    expect(long.json.content).toMatch(/(?:\\\*)+…\n/);
    expect(long.json.content.endsWith(MESSAGE.url)).toBe(true);
  });

  it('ntfy: the JSON publish to the server root, the topic in the body', () => {
    expect(outgoingRequest('ntfy', new URL('https://ntfy.sh/alerts'), MESSAGE)).toEqual({
      url: 'https://ntfy.sh/',
      json: { topic: 'alerts', title: MESSAGE.title, message: MESSAGE.body, click: MESSAGE.url },
    });
    expect(
      outgoingRequest('ntfy', new URL('https://ntfy.acme.example/base/alerts'), MESSAGE).url,
    ).toBe('https://ntfy.acme.example/base/');
  });

  it('generic: exactly title, body, url, kind and instance', () => {
    const { json } = outgoingRequest('generic', new URL('https://hooks.example.com/x'), MESSAGE);
    expect(json).toEqual({
      title: MESSAGE.title,
      body: MESSAGE.body,
      url: MESSAGE.url,
      kind: 'request-opened',
      instance: 'Acme gateway',
    });
  });
});
