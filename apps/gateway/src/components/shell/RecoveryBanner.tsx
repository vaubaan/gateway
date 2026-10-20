/**
 * The banner every page carries for thirty days after an administrator was named with
 * the master key (ADR administrators-live-in-the-instance §9): the one use of the key
 * that changes who administers is never silent.
 */
import { LocalDate } from '@/components/LocalDate';
import { Callout } from '@/components/ui';
import { getRoot } from '@/server/compose';

export async function RecoveryBanner() {
  const record = await (await getRoot()).auth.recovery.banner();
  if (!record) return null;
  const named = record.named;
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
