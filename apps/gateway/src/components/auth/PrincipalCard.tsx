/**
 * Who is signed in, with the operator marker derived from the admin rule
 * (spec §0 "Operator"). Server component; the sign-out is a plain form POST
 * so the origin check applies.
 */
import Link from 'next/link';

import type { Principal } from '@/server/auth';
import { Badge, Button, Card, CardBody } from '@/components/ui';
import styles from './auth.module.css';

export function OperatorBadge({ principal }: { principal: Principal }) {
  if (principal.kind === 'bootstrap') return <Badge tone="warning">Bootstrap operator</Badge>;
  return principal.isOperator ? <Badge tone="success">Operator</Badge> : <Badge>User</Badge>;
}

export function SignOutButton() {
  return (
    <form method="post" action="/logout" className={styles.inlineForm}>
      <Button type="submit" variant="secondary" size="sm">
        Sign out
      </Button>
    </form>
  );
}

export function PrincipalCard({ principal }: { principal: Principal }) {
  return (
    <Card>
      <CardBody>
        <div className={styles.identity}>
          <div>
            {principal.kind === 'user' ? (
              <>
                <div className={styles.email}>{principal.user.email}</div>
                <div className={styles.muted}>
                  {principal.groups.length === 0
                    ? 'No group'
                    : `Groups: ${principal.groups.map((g) => g.name).join(', ')}`}
                </div>
              </>
            ) : (
              <>
                <div className={styles.email}>Bootstrap token</div>
                <div className={styles.muted}>
                  Configure the identity provider, then sign in through it.
                </div>
              </>
            )}
          </div>
          <div className={styles.actions}>
            <OperatorBadge principal={principal} />
            {principal.kind === 'user' && <Link href="/connections">Connections</Link>}
            {(principal.kind === 'bootstrap' || principal.isOperator) && (
              <Link href="/admin">Administration</Link>
            )}
            <SignOutButton />
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
