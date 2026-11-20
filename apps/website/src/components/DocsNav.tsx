/**
 * The docs' navigation, from Fumadocs' page tree, rendered on the server:
 * a column beside the page, and on a phone a disclosure above it. The
 * current page is marked by `aria-current`, not by a colour alone.
 */
import Link from 'next/link';
import type { Folder, Node, Root } from 'fumadocs-core/page-tree';
import type { TOCItemType } from 'fumadocs-core/toc';

/** An entry: a fill and the strong weight when current, never a colour (style guide §4). */
const ENTRY =
  'block rounded-md px-2 py-[3px] text-muted-foreground no-underline hover:bg-accent hover:text-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-semibold aria-[current=page]:text-sidebar-accent-foreground';
const FOLDER_NAME = 'block px-2 pb-0.5 pt-2 text-[0.8125rem] text-muted-foreground';

function Entry({ node, current }: { readonly node: Node; readonly current: string }) {
  if (node.type === 'separator') {
    return <li className={FOLDER_NAME}>{node.name}</li>;
  }
  if (node.type === 'folder') return <FolderEntry folder={node} current={current} />;
  return (
    <li>
      <Link
        href={node.url}
        className={ENTRY}
        prefetch={false}
        aria-current={node.url === current ? 'page' : undefined}
      >
        {node.name}
      </Link>
    </li>
  );
}

function FolderEntry({ folder, current }: { readonly folder: Folder; readonly current: string }) {
  return (
    <li>
      {folder.index ? (
        <Link
          href={folder.index.url}
          className={ENTRY}
          prefetch={false}
          aria-current={folder.index.url === current ? 'page' : undefined}
        >
          {folder.name}
        </Link>
      ) : (
        <span className={FOLDER_NAME}>{folder.name}</span>
      )}
      <ul className="mb-2 ml-2 mt-1 border-l border-border pl-2">
        {folder.children.map((child, i) => (
          <Entry key={child.$id ?? i} node={child} current={current} />
        ))}
      </ul>
    </li>
  );
}

function Tree({ tree, current }: { readonly tree: Root; readonly current: string }) {
  return (
    <ul className="m-0 list-none p-0">
      {tree.children.map((child, i) => (
        <Entry key={child.$id ?? i} node={child} current={current} />
      ))}
    </ul>
  );
}

export function DocsNav({ tree, current }: { readonly tree: Root; readonly current: string }) {
  return (
    <>
      <nav
        className="sticky top-6 hidden max-h-[calc(100vh-3rem)] overflow-y-auto text-sm md:block"
        aria-label="Docs"
      >
        <Tree tree={tree} current={current} />
      </nav>
      <details className="border-b border-border pb-2 text-sm md:hidden">
        <summary className="cursor-pointer py-2 text-muted-foreground">Docs menu</summary>
        <nav aria-label="Docs, menu">
          <Tree tree={tree} current={current} />
        </nav>
      </details>
    </>
  );
}

export function Toc({ items }: { readonly items: readonly TOCItemType[] }) {
  const shown = items.filter((item) => item.depth >= 2 && item.depth <= 3);
  const toc = 'sticky top-6 hidden text-[0.8125rem] xl:block';
  if (shown.length < 2) return <aside className={toc} aria-hidden="true" />;
  return (
    <aside className={toc} aria-label="On this page">
      <p className="mb-2 text-muted-foreground">On this page</p>
      <ul className="m-0 list-none p-0">
        {shown.map((item) => (
          <li key={item.url} className={item.depth === 3 ? 'pl-3' : undefined}>
            <a
              href={item.url}
              className="block py-0.5 text-muted-foreground no-underline hover:text-foreground"
            >
              {item.title}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
