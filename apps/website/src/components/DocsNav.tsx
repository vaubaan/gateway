/**
 * The docs' navigation, from Fumadocs' page tree, rendered on the server:
 * a column beside the page, and on a phone a disclosure above it. The
 * current page is marked by `aria-current`, not by a colour alone.
 */
import Link from 'next/link';
import type { Folder, Node, Root } from 'fumadocs-core/page-tree';
import type { TOCItemType } from 'fumadocs-core/toc';

function Entry({ node, current }: { readonly node: Node; readonly current: string }) {
  if (node.type === 'separator') {
    return <li className="folder-name">{node.name}</li>;
  }
  if (node.type === 'folder') return <FolderEntry folder={node} current={current} />;
  return (
    <li>
      <Link
        href={node.url}
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
          prefetch={false}
          aria-current={folder.index.url === current ? 'page' : undefined}
        >
          {folder.name}
        </Link>
      ) : (
        <span className="folder-name">{folder.name}</span>
      )}
      <ul>
        {folder.children.map((child, i) => (
          <Entry key={child.$id ?? i} node={child} current={current} />
        ))}
      </ul>
    </li>
  );
}

function Tree({ tree, current }: { readonly tree: Root; readonly current: string }) {
  return (
    <ul>
      {tree.children.map((child, i) => (
        <Entry key={child.$id ?? i} node={child} current={current} />
      ))}
    </ul>
  );
}

export function DocsNav({ tree, current }: { readonly tree: Root; readonly current: string }) {
  return (
    <>
      <nav className="docs-nav" aria-label="Docs">
        <Tree tree={tree} current={current} />
      </nav>
      <details className="docs-menu">
        <summary>Docs menu</summary>
        <nav aria-label="Docs, menu">
          <Tree tree={tree} current={current} />
        </nav>
      </details>
    </>
  );
}

export function Toc({ items }: { readonly items: readonly TOCItemType[] }) {
  const shown = items.filter((item) => item.depth >= 2 && item.depth <= 3);
  if (shown.length < 2) return <aside className="toc" aria-hidden="true" />;
  return (
    <aside className="toc" aria-label="On this page">
      <p>On this page</p>
      <ul>
        {shown.map((item) => (
          <li key={item.url} className={`depth-${item.depth}`}>
            <a href={item.url}>{item.title}</a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
