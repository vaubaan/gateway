/**
 * Settings → Notifications, "Mail" (spec §4.2 bis "Mail is a channel when the instance
 * delivers mail, switched on by the person"): the person's own address and a form post
 * that switches it on or off; one sentence when the instance delivers no mail or the
 * account has no address. A server component.
 */
import styles from '@/components/settings/settings.styles';
import { Button, Hint, Section } from '@/components/ui';
import { NOTIFICATION_WORDS } from '@/lib/vocabulary';
import { MAIL_API, MAIL_FIELD, type MailStatus } from '@/server/notifications';

const WORDS = NOTIFICATION_WORDS.mail;

export function MailSwitch({ status }: { status: MailStatus }) {
  return (
    <Section title={WORDS.title} testId="mail-channel">
      {status.kind === 'unavailable' && <Hint>{WORDS.unavailable}</Hint>}
      {status.kind === 'no-address' && <Hint>{WORDS.noAddress}</Hint>}
      {status.kind === 'available' && (
        <form method="post" action={MAIL_API} className={styles.formActions}>
          <span className={styles.namedText}>
            <span className={styles.name}>{WORDS.to(status.address)}</span>
            <span className={styles.sub} data-testid="mail-state">
              {status.on ? WORDS.on : WORDS.off}
            </span>
          </span>
          <Button
            type="submit"
            name={MAIL_FIELD}
            value={status.on ? 'off' : 'on'}
            variant={status.on ? 'secondary' : 'primary'}
            data-testid="mail-switch"
          >
            {status.on ? WORDS.turnOff : WORDS.turnOn}
          </Button>
        </form>
      )}
    </Section>
  );
}
