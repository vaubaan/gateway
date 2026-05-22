/**
 * `<RegisterWizard>` — three-step orchestrator for registering an
 * OrgResource or ProjectResource. Spec §7.1, §11.1.
 *
 * Steps:
 *   1. KindPicker         → pick a kind from the catalog.
 *   2. SetupDocsDisplay   → show kind.setupDocs + collect name/variant/provider_ref.
 *      → POST /api/crm/v1/orgs/:slug/resources to create the row (status='pending').
 *   3. AccessSealForm     → for each access key, seal client-side + PUT
 *      /api/crm/v1/orgs/:slug/resources/:rId/access/:key.
 */

'use client';

import { useState } from 'react';

import { KindPicker } from './KindPicker';
import { SetupDocsDisplay, type ResourceRegisterFormData } from './SetupDocsDisplay';
import { AccessSealForm } from './AccessSealForm';
import type { SerializedKind } from '@/lib/catalog/serialize';

export interface RegisterWizardProps {
  readonly orgSlug: string;
  readonly kinds: ReadonlyArray<SerializedKind>;
}

type Step = 'pick' | 'setup' | 'seal' | 'done';

interface RegisteredResource {
  readonly id: string;
}

export function RegisterWizard(props: RegisterWizardProps): React.ReactElement {
  const { orgSlug, kinds } = props;
  const [step, setStep] = useState<Step>('pick');
  const [picked, setPicked] = useState<SerializedKind | null>(null);
  const [registered, setRegistered] = useState<RegisteredResource | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handlePick = (k: SerializedKind): void => {
    setPicked(k);
    setStep('setup');
  };

  const handleSetup = async (data: ResourceRegisterFormData): Promise<void> => {
    if (!picked) return;
    setSubmitError(null);
    try {
      const res = await fetch(`/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: picked.id,
          name: data.name,
          variant: data.variant,
          provider_ref: data.providerRef.length > 0 ? data.providerRef : null,
          console_url: data.consoleUrl.length > 0 ? data.consoleUrl : null,
          metadata: data.metadata,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        resource?: { id: string };
        error?: string;
        message?: string;
      };
      if (!res.ok || !body.resource) {
        setSubmitError(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
        return;
      }
      setRegistered({ id: body.resource.id });
      setStep('seal');
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'network_error');
    }
  };

  const handleDone = (): void => {
    if (registered) {
      window.location.href = `/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(registered.id)}`;
    } else {
      setStep('done');
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="register-wizard" data-step={step}>
      <ol className="flex items-center gap-2 text-xs text-muted">
        <li className={step === 'pick' ? 'font-semibold text-foreground' : ''}>1. Kind</li>
        <li>·</li>
        <li className={step === 'setup' ? 'font-semibold text-foreground' : ''}>2. Metadata</li>
        <li>·</li>
        <li className={step === 'seal' ? 'font-semibold text-foreground' : ''}>3. Seal</li>
      </ol>

      {step === 'pick' ? <KindPicker kinds={kinds} onPick={handlePick} /> : null}

      {step === 'setup' && picked ? (
        <>
          <SetupDocsDisplay
            kind={picked}
            onSubmit={(d) => void handleSetup(d)}
            onBack={() => {
              setStep('pick');
              setPicked(null);
            }}
          />
          {submitError ? (
            <span data-testid="wizard-submit-error" className="text-xs text-danger-foreground">
              {submitError}
            </span>
          ) : null}
        </>
      ) : null}

      {step === 'seal' && picked && registered ? (
        <AccessSealForm
          orgSlug={orgSlug}
          resourceId={registered.id}
          kind={picked}
          onDone={handleDone}
          onBack={() => {
            setStep('setup');
          }}
        />
      ) : null}
    </div>
  );
}
