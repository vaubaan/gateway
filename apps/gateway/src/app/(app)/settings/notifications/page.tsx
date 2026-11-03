/**
 * `/settings/notifications` — the channels that receive my notifications (spec §4.2 bis):
 * this device first (subscribe it, or why it cannot be), then every device I subscribed,
 * with when it was added and last delivered to, or that it was dropped and why; rename and
 * remove, asked first. Then my messaging addresses (added after a test message, never shown
 * back) and mail (a switch, when the instance delivers mail). Nothing here answers a
 * request: a notification only leads to one.
 *
 * `?rename=<id>` unfolds the rename form of one device; `?done=` and `?problem=` (with
 * `&status=` after a refused test message) report the outcome of a form (codes, never a
 * message or an address in the URL).
 */
import Link from 'next/link';

import { LocalDate } from '@/components/LocalDate';
import { NeedsUser } from '@/components/auth/NeedsUser';
import { MailSwitch } from '@/components/notifications/MailSwitch';
import { MessagingAddresses } from '@/components/notifications/MessagingAddresses';
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
  ADDRESS_PROBLEMS,
  DONE_PARAM,
  LABEL_FIELD,
  MAIL_PROBLEMS,
  STATUS_PARAM,
  LABEL_MAX,
  NOTIFICATIONS_PAGE,
  PROBLEM_PARAM,
  deviceActionPath,
  isDeviceProblem,
  isDoneAct,
  type DoneAct,
  type AddressProblem,
  type DeviceProblem,
  type DeviceView,
  type MailProblem,
} from '@/server/notifications';

export const dynamic = 'force-dynamic';

const RENAME_PARAM = 'rename';

const PROBLEMS: Readonly<Record<DeviceProblem, string>> = NOTIFICATION_WORDS.problems;
type ChannelProblem = AddressProblem | MailProblem;
const CHANNEL_PROBLEMS: Readonly<Record<ChannelProblem, string>> =
  NOTIFICATION_WORDS.channelProblems;

function isChannelProblem(value: string | null): value is ChannelProblem {
  return (
    value !== null && ([...ADDRESS_PROBLEMS, ...MAIL_PROBLEMS] as readonly string[]).includes(value)
  );
}

/** `?status=` of a refused test message: an HTTP status, or `null` (no answer). */
function statusOf(raw: string | null): number | null {
  if (raw === null || !/^\d{3}$/.test(raw)) return null;
  return Number(raw);
}

const DONE_WORDS: Readonly<Record<DoneAct, { testId: string; words: string }>> = {
  renamed: { testId: 'device-renamed', words: NOTIFICATION_WORDS.renamed },
  removed: { testId: 'device-removed', words: NOTIFICATION_WORDS.removed },
  'address-added': { testId: 'address-added', words: NOTIFICATION_WORDS.addresses.added },
  'address-removed': { testId: 'address-removed', words: NOTIFICATION_WORDS.addresses.removed },
  'mail-on': { testId: 'mail-on', words: NOTIFICATION_WORDS.mail.switchedOn },
  'mail-off': { testId: 'mail-off', words: NOTIFICATION_WORDS.mail.switchedOff },
};

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
  const [devices, publicKey, knownDigests, addresses, mail] = await Promise.all([
    session.root.notifications.devices.list(session.user),
    session.root.notifications.vapid.publicKey(),
    session.root.notifications.devices.liveEndpointDigests(session.user),
    session.root.notifications.addresses.list(session.user),
    session.root.notifications.mail.status(session.user),
  ]);
  const unfolded = firstParam(params[RENAME_PARAM]);
  const doneParam = firstParam(params[DONE_PARAM]);
  const done = isDoneAct(doneParam) ? DONE_WORDS[doneParam] : undefined;
  const problem = firstParam(params[PROBLEM_PARAM]);
  const channelProblem = isChannelProblem(problem) ? problem : null;

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

      {(done !== undefined || isDeviceProblem(problem) || channelProblem !== null) && (
        <div className={styles.notes}>
          {done !== undefined && (
            <Callout tone="ok" testId={done.testId}>
              {done.words}
            </Callout>
          )}
          {isDeviceProblem(problem) && (
            <Callout tone="warn" testId="device-problem">
              {PROBLEMS[problem]}
            </Callout>
          )}
          {channelProblem !== null && (
            <Callout tone="warn" testId="channel-problem">
              {channelProblem === 'test-failed'
                ? NOTIFICATION_WORDS.testFailedWith(statusOf(firstParam(params[STATUS_PARAM])))
                : CHANNEL_PROBLEMS[channelProblem]}
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

      <MessagingAddresses addresses={addresses} />

      <MailSwitch status={mail} />
    </>
  );
}
