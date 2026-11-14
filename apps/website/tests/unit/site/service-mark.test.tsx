/**
 * The service mark on the site (ADR service-icons-declared-by-the-plugin): the
 * plugin's path in its brand colour, the dark theme's colour by the gateway's
 * own rule (`serviceMarkColors`), and on `/plugins` before each plugin's name
 * in the HTML only.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { serviceMarkColors } from '@vaubaan/shared/service-mark';

import { ServiceMark } from '../../../src/components/plugin/Codes';
import { pluginListComponents } from '../../../src/components/plugin/PluginListLink';

const PATH = 'M0 0h24v24H0z';

describe('ServiceMark', () => {
  it('draws the path in the brand colour, the dark theme by the shared rule', () => {
    const html = renderToStaticMarkup(<ServiceMark path={PATH} color="#635BFF" />);
    expect(html).toContain(`d="${PATH}"`);
    expect(html).toContain('--mark-color:#635BFF');
    expect(html).toContain('--mark-color-dark:#635BFF');
  });

  it('hands a near-black brand to the ink in the dark theme', () => {
    expect(serviceMarkColors('#181717').dark).toBeNull();
    const html = renderToStaticMarkup(<ServiceMark path={PATH} color="#181717" />);
    expect(html).toContain('--mark-color:#181717');
    expect(html).toContain('--mark-color-dark:var(--ink)');
  });

  it('keeps the ink without a colour, and has a small size for lists', () => {
    const html = renderToStaticMarkup(<ServiceMark path={PATH} color={null} size="sm" />);
    expect(html).not.toContain('--mark-color');
    expect(html).toContain('class="pp-svc pp-svc-sm"');
    expect(html).toContain('width="16"');
  });
});

describe('the plugin list', () => {
  const components = pluginListComponents([
    { id: 'github', icon: PATH, iconColor: '#181717' },
    { id: 'plain', icon: null, iconColor: null },
  ]);
  const A = components.a!;

  it('puts the mark before the name of a plugin it knows', () => {
    const html = renderToStaticMarkup(<A href="/plugins/github">GitHub</A>);
    expect(html).toMatch(
      /^<a href="\/plugins\/github"><span class="pp-svc pp-svc-sm"[^>]*>.*<\/span>GitHub<\/a>$/,
    );
  });

  it('leaves any other link, and a plugin without an icon, as it is', () => {
    expect(renderToStaticMarkup(<A href="/plugins/health">health</A>)).toBe(
      '<a href="/plugins/health">health</a>',
    );
    expect(renderToStaticMarkup(<A href="/plugins/plain">Plain</A>)).toBe(
      '<a href="/plugins/plain">Plain</a>',
    );
  });
});
