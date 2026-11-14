/**
 * The plugin list's links, in HTML only: a link to `/plugins/<id>` gets the
 * service's mark before its name (spec website §2.3; ADR
 * service-icons-declared-by-the-plugin). The Markdown twin keeps the plain
 * link: an icon is not text.
 *
 * Imports are relative: the unit tests render these without the `@/` alias.
 */
import type { ComponentProps } from 'react';

import { MARKDOWN_COMPONENTS, type MarkdownComponents } from '../MarkdownBody';
import { ServiceMark } from './Codes';

export interface ListedMark {
  readonly id: string;
  readonly icon: string | null;
  readonly iconColor: string | null;
}

/** The Markdown renderers of `/plugins`: the default ones, and links with their mark. */
export function pluginListComponents(plugins: readonly ListedMark[]): MarkdownComponents {
  const marks = new Map(plugins.map((p) => [`/plugins/${p.id}`, p]));
  return {
    ...MARKDOWN_COMPONENTS,
    a: ({ href, children, ...rest }: ComponentProps<'a'>) => {
      const plugin = href ? marks.get(href) : undefined;
      return (
        <a href={href} {...rest}>
          {plugin?.icon && <ServiceMark path={plugin.icon} color={plugin.iconColor} size="sm" />}
          {children}
        </a>
      );
    },
  };
}
