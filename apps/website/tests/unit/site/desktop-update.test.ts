/**
 * `/desktop/latest.json` sends the desktop app to the update manifest of the released
 * gateway, pre-release included, and never to a version the release preparation did not write.
 */
import { describe, expect, it } from 'vitest';

import releases from '../../../src/content/releases.json';
import { DESKTOP_UPDATE_PATH, desktopUpdateRedirect } from '../../../src/site/desktop-update';

describe('desktop update redirect', () => {
  it('points at the latest.json of the released version, temporarily', () => {
    expect(desktopUpdateRedirect('2.0.0-alpha.33')).toEqual({
      source: DESKTOP_UPDATE_PATH,
      destination:
        'https://github.com/vaubaan/gateway/releases/download/v2.0.0-alpha.33/latest.json',
      permanent: false,
    });
  });

  it('takes the version releases.json names', () => {
    expect(desktopUpdateRedirect(releases.gateway).destination).toContain(
      `/v${releases.gateway}/latest.json`,
    );
  });

  it('refuses what is not a release version', () => {
    expect(() => desktopUpdateRedirect('../x')).toThrow(/not a release version/);
  });
});
