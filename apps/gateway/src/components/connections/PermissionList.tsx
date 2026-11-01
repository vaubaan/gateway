/**
 * The exact permissions behind a count ("12 of 17"): what each lets an agent
 * do in words, its severity, and its id in mono, linked to its entry in the
 * reference. Shown on demand under a row of the accounts pages; the list is
 * always the explicit one that is stored, never a summary of it.
 */
import { Mono, SeverityChip } from '@/components/ui';
import type { SeverityWord } from '@/lib/vocabulary';
import { riskReferencePath } from '@/lib/providers/links';

import styles from './account.module.css';

export interface ListedPermission {
  readonly id: string;
  /** What it allows, in words; the id itself when the catalog no longer has it. */
  readonly label: string;
  readonly level: SeverityWord | null;
  /** `false` when the catalog dropped the entry since the access was given. */
  readonly known: boolean;
}

export function PermissionList({
  permissions,
  head,
  testId,
}: {
  permissions: readonly ListedPermission[];
  /** One quiet line above the list: whose they are. */
  head?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      {head && <p className={styles.detailHead}>{head}</p>}
      <ul className={styles.permissions}>
        {permissions.map((permission) => (
          <li key={permission.id} className={styles.permission} data-permission={permission.id}>
            <span className={styles.permissionLabel}>
              {permission.known ? permission.label : 'No longer in the catalog'}
              {permission.level && <SeverityChip level={permission.level} />}
            </span>
            <Mono quiet href={riskReferencePath(permission.id) ?? undefined}>
              {permission.id}
            </Mono>
          </li>
        ))}
      </ul>
    </div>
  );
}
