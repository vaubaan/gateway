/**
 * Which URL a messaging address may be (spec §6): https, no credentials, the vendor's host
 * for Slack, Teams and Discord, a topic URL for ntfy, any host for generic.
 */
import { describe, expect, it } from 'vitest';

import { checkAddressUrl, ntfyTopicOf, type AddressKind } from './address-rules';

const ok = (kind: AddressKind, url: string) => expect(checkAddressUrl(kind, url).ok).toBe(true);
const refused = (kind: AddressKind, url: string, problem: string) =>
  expect(checkAddressUrl(kind, url)).toEqual({ ok: false, problem });

describe('messaging address rules', () => {
  it('takes the incoming webhooks of each vendor', () => {
    ok('slack', 'https://hooks.slack.com/services/T0/B0/x');
    ok(
      'teams',
      'https://prod-01.westeurope.logic.azure.com/workflows/1/triggers/manual/paths/invoke',
    );
    ok(
      'teams',
      'https://default0000.00.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/1/triggers/manual/paths/invoke',
    );
    ok('teams', 'https://acme.webhook.office.com/webhookb2/1');
    ok('discord', 'https://discord.com/api/webhooks/1/token');
    ok('discord', 'https://canary.discord.com/api/webhooks/1/token');
    ok('ntfy', 'https://ntfy.sh/my-topic_1');
    ok('ntfy', 'https://ntfy.acme.example:8443/sub/path/alerts');
    ok('generic', 'https://hooks.example.com:8443/anything?x=1');
  });

  it('refuses another host, path or port for the vendors', () => {
    refused('slack', 'https://hooks.slack.com.evil.example/services/x', 'wrong-host');
    refused('slack', 'https://hooks.slack.com/triggers/x', 'wrong-host');
    refused('slack', 'https://hooks.slack.com:8443/services/x', 'wrong-host');
    refused('teams', 'https://logic.azure.com.evil.example/workflows', 'wrong-host');
    refused('teams', 'https://outlook.office.com/webhook/1', 'wrong-host');
    refused('discord', 'https://discord.com/api/v10/channels/1/messages', 'wrong-host');
    refused('discord', 'https://evil-discord.com/api/webhooks/1/x', 'wrong-host');
  });

  it('refuses anything but https, credentials in the URL, garbage and overlong URLs', () => {
    refused('generic', 'http://hooks.example.com/x', 'invalid-address');
    refused('generic', 'https://user:secret@hooks.example.com/x', 'invalid-address');
    refused('slack', 'https://u@hooks.slack.com/services/x', 'invalid-address');
    refused('generic', 'not a url', 'invalid-address');
    refused('generic', '', 'invalid-address');
    refused('generic', `https://hooks.example.com/${'x'.repeat(2048)}`, 'invalid-address');
  });

  it('takes a ntfy topic URL only', () => {
    refused('ntfy', 'https://ntfy.sh/', 'invalid-address');
    refused('ntfy', 'https://ntfy.sh/topic?x=1', 'invalid-address');
    refused('ntfy', 'https://ntfy.sh/bad.topic', 'invalid-address');
    expect(ntfyTopicOf(new URL('https://ntfy.acme.example/base/alerts'))).toBe('alerts');
  });
});
