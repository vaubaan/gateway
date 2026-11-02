/**
 * `/settings/notifications` — the devices that receive my notifications (spec §4.2 bis):
 * this device first (subscribe it, or why it cannot be), then every device I subscribed,
 * with when it was added and last delivered to, or that it was dropped and why; rename and
 * remove, asked first. Nothing here answers a request: a notification only leads to one.
 *
 * `?rename=<id>` unfolds the rename form of one device; `?done=` and `?problem=` report the
 * outcome of a form (codes, never a message in the URL).
 */
import Link from 'next/link';

import { LocalDate } from '@/components/LocalDate';
import { NeedsUser } from '@/components/auth/NeedsUser';
import { ThisDevice } from '@/components/notifications/ThisDevice';
import styles from '@/components/settings/settings.module.css';
import {
  Button,
  Callout,
  ConfirmSubmit,
  DataTable,
  EmptyState,
  Field,
  Hint,
  Input,
  PageHeader,
  Section,
  StatusMark,
  type Column,
} from '@/components/ui';
import { currentUser } from '@/lib/auth/session';
import { firstParam, type PageSearchParams } from '@/lib/connections/session';
import { NOTIFICATION_WORDS, SETTINGS_PAGES } from '@/lib/vocabulary';
import {
  DONE_PARAM,
  LABEL_FIELD,
  LABEL_MAX,
  NOTIFICATIONS_PAGE,
  PROBLEM_PARAM,
  deviceActionPath,
  isDeviceProblem,
  type DeviceProblem,
  type DeviceView,
} from '@/server/notifications';

export const dynamic = 'force-dynamic';

const RENAME_PARAM = 'rename';

const PROBLEMS: Readonly<Record<DeviceProblem, string>> = NOTIFICATION_WORDS.problems;

function RenameForm({ device }: { device: DeviceView }) {
  const id = `rename-${device.id}`;
  return (
    <form
      method="post"
      action={deviceActionPath(device.id, 'rename')}
      className={styles.lineForm}
      data-testid="device-rename-form"
    >
      <Field label={NOTIFICATION_WORDS.label} htmlFor={id}>
        <Input
          id={id}
          name={LABEL_FIELD}
          defaultValue={device.label}
          required
          maxLength={LABEL_MAX}
          autoComplete="off"
        />
      </Field>
      <Button type="submit">{NOTIFICATION_WORDS.rename}</Button>
    </form>
  );
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const params = await searchParams;
  const [devices, publicKey, knownDigests] = await Promise.all([
    session.root.notifications.devices.list(session.user),
    session.root.notifications.vapid.publicKey(),
    session.root.notifications.devices.liveEndpointDigests(session.user),
  ]);
  const unfolded = firstParam(params[RENAME_PARAM]);
  const done = firstParam(params[DONE_PARAM]);
  const problem = firstParam(params[PROBLEM_PARAM]);

  const columns: readonly Column<DeviceView>[] = [
    {
      id: 'device',
      header: NOTIFICATION_WORDS.device,
      cell: (device) => (
        <span className={styles.namedText}>
          <span className={styles.name}>{device.label}</span>
          <span className={styles.sub}>
            {NOTIFICATION_WORDS.addedOn} <LocalDate ts={device.created_at} dateOnly />
          </span>
        </span>
      ),
    },
    {
      id: 'delivered',
      header: NOTIFICATION_WORDS.lastDelivered,
      nowrap: true,
      cell: (device) =>
        device.dropped_reason !== null ? (
          <StatusMark tone="bad">{NOTIFICATION_WORDS.dropped[device.dropped_reason]}</StatusMark>
        ) : device.last_delivered_at ? (
          <LocalDate ts={device.last_delivered_at} />
        ) : (
          <span className={styles.quiet}>{NOTIFICATION_WORDS.never}</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title={SETTINGS_PAGES.notifications.title}
        lede={SETTINGS_PAGES.notifications.lede}
      />

      {(done !== null || isDeviceProblem(problem)) && (
        <div className={styles.notes}>
          {done === 'renamed' && (
            <Callout tone="ok" testId="device-renamed">
              {NOTIFICATION_WORDS.renamed}
            </Callout>
          )}
          {done === 'removed' && (
            <Callout tone="ok" testId="device-removed">
              {NOTIFICATION_WORDS.removed}
            </Callout>
          )}
          {isDeviceProblem(problem) && (
            <Callout tone="warn" testId="device-problem">
              {PROBLEMS[problem]}
            </Callout>
          )}
        </div>
      )}

      <Section first title={NOTIFICATION_WORDS.thisDevice} testId="this-device">
        <ThisDevice publicKey={publicKey} knownDigests={knownDigests} />
      </Section>

      <Section title={NOTIFICATION_WORDS.yourDevices} testId="your-devices">
        {devices.length === 0 ? (
          <EmptyState title={NOTIFICATION_WORDS.noDevice} testId="no-device">
            {NOTIFICATION_WORDS.noDeviceHint}
          </EmptyState>
        ) : (
          <>
            <DataTable
              caption={NOTIFICATION_WORDS.yourDevices}
              columns={columns}
              rows={devices}
              rowKey={(device) => device.id}
              rowTone={(device) => (device.dropped_reason !== null ? 'quiet' : undefined)}
              actions={(device) => (
                <span className={styles.inline}>
                  <Link
                    href={
                      unfolded === device.id
                        ? NOTIFICATIONS_PAGE
                        : `${NOTIFICATIONS_PAGE}?${RENAME_PARAM}=${encodeURIComponent(device.id)}`
                    }
                    scroll={false}
                    aria-expanded={unfolded === device.id}
                    aria-label={`${NOTIFICATION_WORDS.rename} ${device.label}`}
                    className={styles.reveal}
                    data-testid="device-rename"
                  >
                    {NOTIFICATION_WORDS.rename}
                  </Link>
                  <ConfirmSubmit
                    action={deviceActionPath(device.id, 'remove')}
                    label={NOTIFICATION_WORDS.remove}
                    ariaLabel={`${NOTIFICATION_WORDS.remove} ${device.label}`}
                    variant="danger"
                    tone="danger"
                    title={NOTIFICATION_WORDS.removeTitle(device.label)}
                    consequence={NOTIFICATION_WORDS.removeConsequence}
                    confirmLabel={NOTIFICATION_WORDS.remove}
                    testId="device-remove"
                  />
                </span>
              )}
              rowDetail={(device) =>
                unfolded === device.id ? <RenameForm device={device} /> : null
              }
              testId="devices"
            />
            <Hint>{NOTIFICATION_WORDS.listHint}</Hint>
          </>
        )}
      </Section>
    </>
  );
}
