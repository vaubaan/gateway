import styles from './Prose.module.css';

interface ProseHeaderProps {
  eyebrow?: string;
  title: string;
  lead?: string;
  updated?: string;
}

export function ProseHeader({ eyebrow, title, lead, updated }: ProseHeaderProps) {
  return (
    <header>
      {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
      <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: '-0.03em', margin: 0 }}>{title}</h1>
      {lead ? <p className={styles.lead}>{lead}</p> : null}
      {updated ? <p className={styles.meta}>Last updated · {updated}</p> : null}
      <hr className={styles.divider} />
    </header>
  );
}

export function ProseWrap({ children }: { children: React.ReactNode }) {
  return (
    <article className={styles.wrap}>
      <div className={styles.prose}>{children}</div>
    </article>
  );
}

interface TocItem {
  id: string;
  label: string;
}

export function Toc({ items }: { items: TocItem[] }) {
  return (
    <nav className={styles.toc} aria-label="On this page">
      <h4>On this page</h4>
      <ol>
        {items.map((it) => (
          <li key={it.id}>
            <a href={`#${it.id}`}>{it.label}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export { styles as proseStyles };
