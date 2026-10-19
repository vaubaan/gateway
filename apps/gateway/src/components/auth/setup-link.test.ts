import { describe, expect, it } from 'vitest';

import { setupLinkWithoutToken, tokenFromSetupLink } from './setup-link';

const PAGE = 'https://gateway.example.com/admin/bootstrap';

describe('the setup link', () => {
  it('reads the token from the fragment, else from the query, else nothing', () => {
    expect(tokenFromSetupLink(`${PAGE}#token=abc123`)).toBe('abc123');
    expect(tokenFromSetupLink(`${PAGE}?token=q`)).toBe('q');
    expect(tokenFromSetupLink(`${PAGE}?token=q#token=f`)).toBe('f');
    expect(tokenFromSetupLink(`${PAGE}#token=%20`)).toBeNull();
    expect(tokenFromSetupLink(`${PAGE}#other=1`)).toBeNull();
    expect(tokenFromSetupLink(PAGE)).toBeNull();
    expect(tokenFromSetupLink('not a url')).toBeNull();
  });

  it('strips the token from both places and keeps the rest of the address', () => {
    expect(setupLinkWithoutToken(`${PAGE}?token=q&error=x#token=f&tab=2`)).toBe(
      `${PAGE}?error=x#tab=2`,
    );
    expect(setupLinkWithoutToken(`${PAGE}#token=f`)).toBe(PAGE);
    expect(setupLinkWithoutToken(PAGE)).toBe(PAGE);
  });
});
