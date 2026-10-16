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

export function MarkdownBody({ markdown }: { readonly markdown: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm, remarkHeading]} components={MARKDOWN_COMPONENTS}>
      {markdown}
    </Markdown>
  );
}
