/**
 * Settings → Notifications, "Messaging addresses" (spec §4.2 bis): the person's addresses —
 * kind, name, when added, last delivered, last failure; never the URL — each removed after
 * a confirmation, and the form that adds one (a test message leaves before it is kept).
 * A server component: every act is a form post.
 */
import { LocalDate } from '@/components/LocalDate';
import styles from '@/components/settings/settings.module.css';
import {
  Button,
  ConfirmSubmit,
  DataTable,
  EmptyState,
  Field,
  Hint,
  Input,
  Section,
  Select,
  StatusMark,
  type Column,
} from '@/components/ui';
import { NOTIFICATION_WORDS } from '@/lib/vocabulary';
import {
  ADDRESS_FIELDS,
  ADDRESS_KINDS,
  ADDRESS_URL_MAX,
  ADDRESSES_API,
  LABEL_MAX,
  addressRemovePath,
  type AddressView,
} from '@/server/notifications';

const WORDS = NOTIFICATION_WORDS.addresses;

function AddForm() {
  return (
    <form
      method="post"
      action={ADDRESSES_API}
      className={styles.lineForm}
      data-testid="address-add-form"
    >
      <Field label={WORDS.kind} htmlFor="address-kind">
        <Select id="address-kind" name={ADDRESS_FIELDS.kind} required defaultValue="slack">
          {ADDRESS_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {WORDS.kinds[kind]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={WORDS.label} htmlFor="address-label">
        <Input
          id="address-label"
          name={ADDRESS_FIELDS.label}
          required
          maxLength={LABEL_MAX}
          autoComplete="off"
        />
      </Field>
      <Field label={WORDS.url} htmlFor="address-url">
        <Input
          id="address-url"
          name={ADDRESS_FIELDS.url}
          type="url"
          required
          maxLength={ADDRESS_URL_MAX}
          autoComplete="off"
          spellCheck={false}
          placeholder="https://"
        />
      </Field>
      <Button type="submit">{WORDS.add}</Button>
    </form>
  );
}

export function MessagingAddresses({ addresses }: { addresses: readonly AddressView[] }) {
  const columns: readonly Column<AddressView>[] = [
    {
      id: 'address',
      header: WORDS.address,
      cell: (address) => (
        <span className={styles.namedText}>
          <span className={styles.name}>{address.label}</span>
          <span className={styles.sub}>
            {WORDS.kinds[address.kind]} · {NOTIFICATION_WORDS.addedOn}{' '}
            <LocalDate ts={address.created_at} dateOnly />
          </span>
        </span>
      ),
    },
    {
      id: 'delivered',
      header: NOTIFICATION_WORDS.lastDelivered,
      nowrap: true,
      cell: (address) =>
        address.last_delivered_at ? (
          <LocalDate ts={address.last_delivered_at} />
        ) : (
          <span className={styles.quiet}>{NOTIFICATION_WORDS.never}</span>
        ),
    },
    {
      id: 'failure',
      header: WORDS.lastFailure,
      nowrap: true,
      cell: (address) =>
        address.last_failure_at ? (
          <span className={styles.namedText}>
            <StatusMark tone="bad">{WORDS.failedWith(address.last_failure_status)}</StatusMark>
            <span className={styles.sub}>
              <LocalDate ts={address.last_failure_at} />
            </span>
          </span>
        ) : (
          <span className={styles.quiet}>{NOTIFICATION_WORDS.never}</span>
        ),
    },
  ];

  return (
    <Section title={WORDS.title} testId="messaging-addresses">
      <Hint>{WORDS.lede}</Hint>
      {addresses.length === 0 ? (
        <EmptyState title={WORDS.empty} testId="no-address">
          {WORDS.emptyHint}
        </EmptyState>
      ) : (
        <>
          <DataTable
            caption={WORDS.title}
            columns={columns}
            rows={addresses}
            rowKey={(address) => address.id}
            actions={(address) => (
              <ConfirmSubmit
                action={addressRemovePath(address.id)}
                label={NOTIFICATION_WORDS.remove}
                ariaLabel={`${NOTIFICATION_WORDS.remove} ${address.label}`}
                variant="danger"
                tone="danger"
                title={WORDS.removeTitle(address.label)}
                consequence={WORDS.removeConsequence}
                confirmLabel={NOTIFICATION_WORDS.remove}
                testId="address-remove"
              />
            )}
            testId="addresses"
          />
          <Hint>{WORDS.listHint}</Hint>
        </>
      )}
      <AddForm />
      <Hint>{WORDS.urlHint}</Hint>
      <Hint>{WORDS.genericHint}</Hint>
    </Section>
  );
}
