/**
 * The service mark on the site's plugin list (ADR service-icons-declared-by-the-plugin):
 * on `/plugins` before each plugin's name, in the HTML only. The mark itself is the
 * shared page's (`@vaubaan/plugin-page`, tested there).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { pluginListComponents } from '../../../src/components/plugin/PluginListLink';

const PATH = 'M0 0h24v24H0z';

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
