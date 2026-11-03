/**
 * The mail of a notification (spec §4.2 bis): plain text, a short subject, the payload's
 * body and the absolute url; and which addresses a mail can go to.
 */
import { describe, expect, it } from 'vitest';

import type { UserRecord } from '../store/types';
import { mailAddressOf, noticeMailerOf, notificationMail } from './mail-channel';

const PUBLIC_URL = new URL('https://gateway.example.com');

describe('mail notifications', () => {
  it('says what happened in the subject, the body and the absolute url in the text', () => {
    const mail = notificationMail(
      {
        kind: 'request-opened',
        instance: 'Acme',
        request: 'approval',
        mission: 'Release train',
        tool: 'Merge a pull request',
        path: '/r/req-1',
      },
      PUBLIC_URL,
    );
    expect(mail.subject).toBe('Something waits for you');
    expect(mail.text.split('\n').slice(0, 3)).toEqual([
      'Release train asks for your approval to Merge a pull request. Open it to answer.',
      '',
      'https://gateway.example.com/r/req-1',
    ]);
  });

  it('words a stop as such', () => {
    const mail = notificationMail(
      { kind: 'mission-revoked', instance: 'Acme', mission: 'M', path: '/missions/m' },
      PUBLIC_URL,
    );
    expect(mail.subject).toBe('Something stopped without you');
    expect(mail.text).toContain('https://gateway.example.com/missions/m');
  });

  it('takes an address with one @ and no space, and nothing else', () => {
    const user = (email: string) => ({ email }) as UserRecord;
    expect(mailAddressOf(user(' ada@example.com '))).toBe('ada@example.com');
    expect(mailAddressOf(user(''))).toBeNull();
    expect(mailAddressOf(user('ada'))).toBeNull();
    expect(mailAddressOf(user('a b@example.com'))).toBeNull();
  });

  it('is a channel only with a mailer that sends notices', () => {
    expect(noticeMailerOf(undefined)).toBeNull();
    expect(noticeMailerOf({ sendLink: async () => undefined })).toBeNull();
    expect(
      noticeMailerOf({ sendLink: async () => undefined, sendNotice: async () => undefined }),
    ).not.toBeNull();
  });
});
