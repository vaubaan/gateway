'use client';

/**
 * One trust-raise proposal (risk model §4.7): after enough approvals granted on one
 * macro-action of one resource set, with no refusal since its trust level last changed,
 * the creator is offered to raise it by one. "Raise" opens the ordinary edit at the new
 * level; "Not now" hides the offer until as many approvals again. Nothing is raised here.
 */
import { useRouter } from 'next/navigation';

import { Button, ButtonLink, Callout, useToast } from '@/components/ui';
import { useAction } from '@/lib/http/post-json';
import { ROUTES, TRUST_LEVEL_LABELS, TRUST_RAISE_WORDS } from '@/lib/vocabulary';
import type { TrustLevel } from '@vaubaan/policy-engine';

export interface TrustRaiseOfferView {
  readonly resource_set_id: string;
  readonly resource_set_position: number;
  readonly several_sets: boolean;
  readonly macro_action_id: string;
  readonly macro_action_label: string;
  readonly from: TrustLevel;
  readonly to: TrustLevel;
  readonly approvals: number;
}

/** Where the offer is about: the account, and its set when the account has several. */
export function whereOf(offer: TrustRaiseOfferView, accountName: string): string {
  return TRUST_RAISE_WORDS.where(
    accountName,
    offer.several_sets ? offer.resource_set_position : null,
  );
}

/** The edit page opened at the next level for this macro-action of this set. */
export function raiseHref(missionId: string, offer: TrustRaiseOfferView): string {
  const query = new URLSearchParams({
    raise: offer.resource_set_id,
    action: offer.macro_action_id,
  });
  return `${ROUTES.missions}/${encodeURIComponent(missionId)}/edit?${query.toString()}`;
}

export function TrustRaiseOffer({
  missionId,
  offer,
  accountName,
  missionName,
}: {
  missionId: string;
  offer: TrustRaiseOfferView;
  accountName: string;
  /** Named on the Now page, where offers of several missions sit together. */
  missionName?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const { busy, error, run } = useAction();
  const from = TRUST_LEVEL_LABELS[offer.from];
  const to = TRUST_LEVEL_LABELS[offer.to];
  const testId = `trust-raise-${offer.macro_action_id}-set${offer.resource_set_position}`;

  async function notNow() {
    const answer = await run(`/api/missions/${encodeURIComponent(missionId)}/trust-raise/not-now`, {
      resource_set_id: offer.resource_set_id,
      macro_action_id: offer.macro_action_id,
    });
    if (!answer.ok) return;
    toast({ title: TRUST_RAISE_WORDS.notNow, description: TRUST_RAISE_WORDS.hidden });
    router.refresh();
  }

  return (
    <Callout
      tone="info"
      title={
        missionName
          ? `${missionName}: ${TRUST_RAISE_WORDS.title(offer.macro_action_label, to)}`
          : TRUST_RAISE_WORDS.title(offer.macro_action_label, to)
      }
      testId={testId}
      action={
        <>
          <ButtonLink
            href={raiseHref(missionId, offer)}
            variant="secondary"
            size="sm"
            data-testid={`${testId}-raise`}
          >
            {TRUST_RAISE_WORDS.raise}
          </ButtonLink>{' '}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void notNow()}
            data-testid={`${testId}-not-now`}
          >
            {TRUST_RAISE_WORDS.notNow}
          </Button>
        </>
      }
    >
      <p>
        {TRUST_RAISE_WORDS.because(offer.approvals, whereOf(offer, accountName), from)}{' '}
        {TRUST_RAISE_WORDS.rule}
      </p>
      {error && <p role="alert">{error}</p>}
    </Callout>
  );
}
