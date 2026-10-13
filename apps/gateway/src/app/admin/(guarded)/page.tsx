/**
 * `/admin` — the Administration index: instance identity, IdP and bootstrap
 * state, the admin rule. Other sections (provider apps, telemetry, groups,
 * connections without owner) have their own page; retention arrives with its
 * feature.
 */
import Link from 'next/link';

import { LocalDate } from '@/components/LocalDate';
import styles from '@/components/auth/auth.module.css';
import { Badge, Card, CardBody, CardHeader, CardTitle, Stack } from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { describeAdminRule } from '@/server/auth';

export const dynamic = 'force-dynamic';

export default async function AdminIndexPage() {
  const { root } = await requireOperator();
  const idp = await root.auth.idp.current();
  const bootstrap = await root.auth.bootstrap.state();

  return (
    <Stack gap="var(--space-6)">
      <div>
        <h1>Administration</h1>
        <p className={styles.muted}>
          Public URL <code>{root.config.publicUrl.href}</code> · build {root.build.version} (
          {root.build.commit})
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Identity provider</CardTitle>
          {idp ? (
            <Badge tone="success">Configured</Badge>
          ) : (
            <Badge tone="warning">Not configured</Badge>
          )}
        </CardHeader>
        <CardBody>
          <dl className={styles.dl}>
            <dt>Issuer</dt>
            <dd>{idp ? <code>{idp.settings.issuer.href}</code> : '—'}</dd>
            <dt>Source</dt>
            <dd>{idp ? (idp.source === 'file' ? 'mounted configuration' : 'Admin page') : '—'}</dd>
            <dt>Admin rule</dt>
            <dd>{describeAdminRule(root.config.admin)}</dd>
            <dt>Bootstrap token</dt>
            <dd>
              {bootstrap.status === 'active' && <Badge tone="warning">active</Badge>}
              {bootstrap.status === 'revoked' && (
                <Badge tone="success">
                  revoked <LocalDate ts={bootstrap.revokedAt} />
                </Badge>
              )}
              {bootstrap.status === 'unavailable' && <Badge>not configured</Badge>}
            </dd>
          </dl>
          <p style={{ marginTop: 'var(--space-4)', marginBottom: 0 }}>
            <Link href="/admin/identity-provider">Configure the identity provider →</Link>
          </p>
        </CardBody>
      </Card>
    </Stack>
  );
}
