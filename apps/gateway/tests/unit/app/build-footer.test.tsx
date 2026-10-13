/**
 * The footer shows the build stamps of the running gateway: the version of the
 * root `package.json` and the commit, as `/healthz` and telemetry report them.
 * Rendered to static markup, no browser.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BuildFooter } from '@/components/shell/BuildFooter';
import { buildInfoFromEnv } from '@/server/config/build-info';

function stamps(html: string): { version: string | undefined; commit: string | undefined } {
  return {
    version: /data-testid="gateway-version">([^<]*)</.exec(html)?.[1],
    commit: /data-testid="gateway-commit">([^<]*)</.exec(html)?.[1],
  };
}

describe('BuildFooter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('shows the version and the commit it is given', () => {
    const html = renderToStaticMarkup(
      <BuildFooter build={{ version: '2.1.0-rc.1', commit: 'abc1234' }} />,
    );
    expect(html).toMatch(/^<footer[^>]*data-testid="build-footer"/);
    expect(stamps(html)).toEqual({ version: '2.1.0-rc.1', commit: 'abc1234' });
    expect(html).toContain('Vaubaan Gateway');
  });

  it('reads the stamps of the build by default, the ones /healthz answers', () => {
    vi.stubEnv('NEXT_PUBLIC_GATEWAY_VERSION', '2.4.0');
    vi.stubEnv('NEXT_PUBLIC_COMMIT_SHA', '0123abc');
    expect(buildInfoFromEnv()).toEqual({ version: '2.4.0', commit: '0123abc' });
    expect(stamps(renderToStaticMarkup(<BuildFooter />))).toEqual({
      version: '2.4.0',
      commit: '0123abc',
    });
  });

  it('says dev for an unstamped build', () => {
    vi.stubEnv('NEXT_PUBLIC_GATEWAY_VERSION', '');
    vi.stubEnv('NEXT_PUBLIC_COMMIT_SHA', '');
    expect(stamps(renderToStaticMarkup(<BuildFooter />))).toEqual({
      version: 'dev',
      commit: 'dev',
    });
  });
});
