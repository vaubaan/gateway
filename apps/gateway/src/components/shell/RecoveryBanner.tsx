/**
 * The banner every page carries for thirty days after the master key was used on a
 * recovery (ADR administrators-live-in-the-instance §9 and its 2026-11-26 amendment): an
 * administrator named, or a sign-in account's password chosen. A use of the key that
 * changes who gets in is never silent.
 */
import { LocalDate } from '@/components/LocalDate';
import { Callout } from '@/components/ui';
import { getRoot } from '@/server/compose';

export async function RecoveryBanner() {
  const record = await (await getRoot()).auth.recovery.banner();
  if (!record) return null;
  const named = record.named;
  if (record.act === 'password') {
    const whose = typeof named.email === 'string' ? `of ${named.email}` : 'of a sign-in account';
    return (
      <Callout
        tone="bad"
        title="A password was chosen with the master key"
        testId="recovery-banner"
      >
        On <LocalDate ts={record.at} />, whoever held this gateway’s master key chose a new password{' '}
        {whose}. If it was not one of you, the key is in other hands: rotate it and review the
        administrators.
      </Callout>
    );
  }
  const what =
    typeof named.email === 'string'
      ? named.email
      : typeof named.group === 'string'
        ? `the group ${named.group}`
        : 'an administrator';
  return (
    <Callout
      tone="bad"
      title="An administrator was named with the master key"
      testId="recovery-banner"
    >
      On <LocalDate ts={record.at} />, whoever held this gateway’s master key named {what}{' '}
      administrator through the recovery page. If it was not one of you, the key is in other hands:
      rotate it and review the administrators.
    </Callout>
  );
}
