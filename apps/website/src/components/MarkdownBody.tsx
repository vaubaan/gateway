/**
 * Renders a generated page's Markdown as static HTML on the server: the same
 * string the site serves as the page's `.md` twin. Headings get ids (anchors),
 * tables scroll sideways on a phone instead of the page. Raw HTML in the
 * Markdown is not rendered.
 */
import { Markdown } from 'fumadocs-core/content/md';
import { remarkGfm, remarkHeading } from 'fumadocs-core/mdx-plugins';
import type { ComponentProps } from 'react';

export const MARKDOWN_COMPONENTS = {
  table: (props: ComponentProps<'table'>) => (
    <div className="table-wrap">
      <table {...props} />
    </div>
  ),
};

/** The renderers of the Markdown's elements; a page may add its own (the plugin list's links). */
export type MarkdownComponents = typeof MARKDOWN_COMPONENTS & {
  readonly a?: (props: ComponentProps<'a'>) => React.ReactNode;
};

export function MarkdownBody({
  markdown,
  components = MARKDOWN_COMPONENTS,
}: {
  readonly markdown: string;
  readonly components?: MarkdownComponents;
}) {
  return (
    <Markdown remarkPlugins={[remarkGfm, remarkHeading]} components={components}>
      {markdown}
    </Markdown>
  );
}
