/**
 * "What the colours mean": every kind of object with its glyph and its
 * colour, as the slug that names it everywhere. Reached from a help block.
 */
import { ITEM_KINDS, ITEM_KIND_WORDS } from './kinds.ts';
import styles from './KindLegend.module.css';
import { Slug } from './Slug.tsx';

export function KindLegend() {
  return (
    <dl className={styles.legend} data-testid="kind-legend">
      {ITEM_KINDS.map((kind) => (
        <div key={kind} className={styles.row}>
          <dt>
            <Slug kind={kind} mono={false}>
              {ITEM_KIND_WORDS[kind].label}
            </Slug>
          </dt>
          <dd>{ITEM_KIND_WORDS[kind].meaning}</dd>
        </div>
      ))}
    </dl>
  );
}
