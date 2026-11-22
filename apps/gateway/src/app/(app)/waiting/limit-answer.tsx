'use client';

/**
 * The answers to a limit that was reached: one choice among the ways of
 * answering, each with what it does, then one button named after the choice.
 *
 * A plain form post to `POST /api/requests/<id>/decide`: the server checks the
 * answer again and redirects back to the request. Only the fields of the
 * chosen answer are sent (the endpoint refuses any other), and a date is sent
 * as the instant the person meant in their own time zone. The radios and the
 * visible fields carry no name the form would send: they validate, the hidden
 * fields are what is posted.
 */
import { useId, useState } from 'react';

import { Button, DecideBar, Input, OptionCard } from '@/components/ui';
import { ANSWERS, formatNumber } from '@/lib/vocabulary';

import styles from './waiting.styles';

export type LimitResolution = 'reset-period' | 'extend-quota' | 'extend-expiry' | 'refuse';

export interface LimitChoice {
  readonly resolution: LimitResolution;
  /** What choosing it does, in a sentence (rendered by the server). */
  readonly description: React.ReactNode;
  /** Why it cannot be chosen now; `null` when it can. */
  readonly unavailable: string | null;
  /** `extend-quota`: the largest number accepted. */
  readonly maxAmount?: number;
  /** `extend-expiry`: the new end must be after this instant. */
  readonly after?: string;
}

/** `2026-11-01T10:00`, in the browser's time zone: what a `datetime-local` field holds. */
function localMinute(iso: string): string {
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function instantOf(localValue: string): string | null {
  const ms = new Date(localValue).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function LimitAnswer({
  requestId,
  choices,
  leaveLabel,
}: {
  requestId: string;
  choices: readonly LimitChoice[];
  /** How "refuse" is said for a limit: "Leave it until the reset". */
  leaveLabel: string;
}) {
  const firstAvailable = choices.find((choice) => choice.unavailable === null);
  const [chosen, setChosen] = useState<LimitResolution>(firstAvailable?.resolution ?? 'refuse');
  const quota = choices.find((choice) => choice.resolution === 'extend-quota');
  const [amount, setAmount] = useState(String(quota?.maxAmount ?? 1));
  const [end, setEnd] = useState('');
  const formId = useId();
  const amountId = useId();
  const endId = useId();

  const labelOf = (resolution: LimitResolution): string =>
    resolution === 'refuse' ? leaveLabel : ANSWERS[resolution].label;

  const endInstant = instantOf(end);
  const submitLabel =
    chosen === 'extend-quota' && Number(amount) > 0
      ? `Give back ${formatNumber(Number(amount))} ${Number(amount) === 1 ? 'call' : 'calls'}`
      : labelOf(chosen);

  return (
    <div data-testid="limit-answer">
      {/* The choice is outside the form: the endpoint refuses any field it does not expect. */}
      <fieldset className={styles.choices} aria-label="How to answer">
        {choices.map((choice) => {
          const disabled = choice.unavailable !== null;
          return (
            <div key={choice.resolution} data-testid={`answer-${choice.resolution}`}>
              <OptionCard
                name="choice"
                value={choice.resolution}
                checked={chosen === choice.resolution}
                onChange={() => setChosen(choice.resolution)}
                disabled={disabled}
                label={labelOf(choice.resolution)}
                description={
                  <>
                    {choice.description}
                    {choice.unavailable && (
                      <span className={styles.notPossible}>
                        Not possible now: {choice.unavailable}
                      </span>
                    )}
                  </>
                }
              />
              {chosen === 'extend-quota' && choice.resolution === 'extend-quota' && !disabled && (
                <p className={styles.choiceInput}>
                  <label htmlFor={amountId}>Calls to give back</label>
                  <Input
                    id={amountId}
                    type="number"
                    size="sm"
                    min={1}
                    max={choice.maxAmount}
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    form={formId}
                    required
                    className={styles.amount}
                  />
                </p>
              )}
              {chosen === 'extend-expiry' && choice.resolution === 'extend-expiry' && !disabled && (
                <p className={styles.choiceInput}>
                  <label htmlFor={endId}>New end, in your time zone</label>
                  <Input
                    id={endId}
                    type="datetime-local"
                    size="sm"
                    min={choice.after ? localMinute(choice.after) : undefined}
                    value={end}
                    onChange={(event) => setEnd(event.target.value)}
                    form={formId}
                    required
                    className={styles.end}
                  />
                </p>
              )}
            </div>
          );
        })}
      </fieldset>
      <form id={formId} method="post" action={`/api/requests/${requestId}/decide`}>
        <input type="hidden" name="resolution" value={chosen} />
        {chosen === 'extend-quota' && <input type="hidden" name="amount" value={amount} />}
        {chosen === 'extend-expiry' && endInstant && (
          <input type="hidden" name="expires_at" value={endInstant} />
        )}
        <DecideBar>
          <Button type="submit" variant={chosen === 'refuse' ? 'secondary' : 'primary'} size="lg">
            {submitLabel}
          </Button>
        </DecideBar>
      </form>
    </div>
  );
}
