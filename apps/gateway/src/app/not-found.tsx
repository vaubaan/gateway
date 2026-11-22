/**
 * "Not found", outside the application shell: an address that matches no page
 * (and a page of Administration asked by someone who does not administer this
 * gateway). It says nothing about what exists.
 */
import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.styles';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { ButtonLink } from '@/components/ui';
import { ROUTES } from '@/lib/vocabulary';

export default function NotFound() {
  return (
    <AuthPage footer={<BuildFooter />}>
      <AuthHeading title="This page does not exist">
        The address may be mistyped, or it may lead to something that is not yours to see.
      </AuthHeading>
      <div className={styles.act}>
        <ButtonLink href={ROUTES.home} variant="primary" size="lg">
          Go to Now
        </ButtonLink>
      </div>
    </AuthPage>
  );
}
