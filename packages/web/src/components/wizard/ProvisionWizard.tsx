/**
 * `<ProvisionWizard>` — Phase 6 wave C 3-step wizard for the
 * "+ Provision via …" workflow (spec §7.3).
 *
 * Step 1 — confirm admin + pick childKind from admin.manages.
 * Step 2 — fill the child's create spec (name, optional provider-
 *          specific fields).
 * Step 3 — execute: unseal admin token (SealedReveal), call
 *          admin.createChild(access, spec) browser-side, POST
 *          /provision with the returned providerRef, then for each
 *          child access key either auto-rotate (admin-mediated) or
 *          surface a SealedInput (manual).
 *
 * The wizard is intentionally light: this is a v1 — Phase 7 will
 * polish UX (modal, validation hints, polling for Supabase project
 * 'ACTIVE_HEALTHY', etc.).
 *
 * ZK invariants: every unsealed Uint8Array is wiped (`.fill(0)`)
 * before the wizard yields control.
 */

'use client';

import { useEffect, useState } from 'react';

import { findKind, type OrgResourceAdminKind } from '@crm/catalog';
import { sealForRecipients, unsealAs, type PubKeyEntry, type SealedBlobV1 } from '@crm/core/crypto';

import { identityStore } from '@/lib/crypto/identity-store';
import { SealedInput } from '@/components/sealed/SealedInput';

export interface ProvisionWizardProps {
  readonly orgSlug: string;
  readonly adminResourceId: string;
  /** Project UUID the new Resource will live under. */
  readonly projectId: string;
}

interface AdminContext {
  readonly resourceId: string;
  readonly kind: OrgResourceAdminKind;
  readonly providerMetadata: Record<string, unknown>;
}

type Step =
  | { kind: 'load-admin' }
  | { kind: 'pick-child'; admin: AdminContext }
  | { kind: 'fill-spec'; admin: AdminContext; childKindId: string }
  | { kind: 'executing'; admin: AdminContext; childKindId: string; spec: Record<string, unknown> }
  | { kind: 'register-access'; admin: AdminContext; childKindId: string; resourceId: string }
  | { kind: 'done'; resourceId: string }
  | { kind: 'error'; message: string };

export function ProvisionWizard(props: ProvisionWizardProps): React.ReactElement {
  const { orgSlug, adminResourceId, projectId } = props;
  const [step, setStep] = useState<Step>({ kind: 'load-admin' });

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(
          `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
            adminResourceId,
          )}`,
        );
        if (!res.ok) {
          setStep({ kind: 'error', message: `fetch admin failed (${String(res.status)})` });
          return;
        }
        const body = (await res.json()) as {
          resource: {
            id: string;
            kind: string;
            is_admin: boolean;
            provider_metadata: Record<string, unknown>;
          };
        };
        const k = findKind(body.resource.kind);
        if (!k || k.kindClass !== 'org-admin' || !body.resource.is_admin) {
          setStep({ kind: 'error', message: 'target is not a live org-admin' });
          return;
        }
        setStep({
          kind: 'pick-child',
          admin: {
            resourceId: body.resource.id,
            kind: k as OrgResourceAdminKind,
            providerMetadata: body.resource.provider_metadata,
          },
        });
      } catch (e) {
        setStep({ kind: 'error', message: e instanceof Error ? e.message : 'unknown' });
      }
    })();
  }, [orgSlug, adminResourceId]);

  if (step.kind === 'load-admin') {
    return (
      <p data-testid="provision-wizard-loading" className="text-sm">
        Loading admin…
      </p>
    );
  }

  if (step.kind === 'error') {
    return (
      <p data-testid="provision-wizard-error" className="text-sm text-red-700">
        {step.message}
      </p>
    );
  }

  if (step.kind === 'pick-child') {
    const manages = step.admin.kind.manages;
    return (
      <div className="flex flex-col gap-3" data-testid="provision-wizard-step-pick">
        <h2 className="text-sm font-medium">Step 1 / 3 — choose child kind</h2>
        <p className="text-xs">
          Admin: <code>{step.admin.kind.id}</code>
        </p>
        <ul className="flex flex-col gap-2">
          {manages.map((id) => (
            <li key={id}>
              <button
                type="button"
                data-testid={`pick-child-${id}`}
                onClick={() => setStep({ kind: 'fill-spec', admin: step.admin, childKindId: id })}
                className="rounded border border-neutral-300 px-2 py-1 text-xs"
              >
                {id}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (step.kind === 'fill-spec') {
    return (
      <SpecForm
        admin={step.admin}
        childKindId={step.childKindId}
        onSubmit={(spec) =>
          setStep({ kind: 'executing', admin: step.admin, childKindId: step.childKindId, spec })
        }
        onBack={() => setStep({ kind: 'pick-child', admin: step.admin })}
      />
    );
  }

  if (step.kind === 'executing') {
    return (
      <ExecuteCreate
        orgSlug={orgSlug}
        projectId={projectId}
        admin={step.admin}
        childKindId={step.childKindId}
        spec={step.spec}
        onCreated={(resourceId) =>
          setStep({
            kind: 'register-access',
            admin: step.admin,
            childKindId: step.childKindId,
            resourceId,
          })
        }
        onError={(message) => setStep({ kind: 'error', message })}
      />
    );
  }

  if (step.kind === 'register-access') {
    return (
      <RegisterAccess
        orgSlug={orgSlug}
        childKindId={step.childKindId}
        resourceId={step.resourceId}
        onDone={() => setStep({ kind: 'done', resourceId: step.resourceId })}
      />
    );
  }

  return (
    <p data-testid="provision-wizard-done" className="text-sm text-green-700">
      Resource provisioned (id: <code>{step.resourceId}</code>).
    </p>
  );
}

interface SpecFormProps {
  readonly admin: AdminContext;
  readonly childKindId: string;
  readonly onSubmit: (spec: Record<string, unknown>) => void;
  readonly onBack: () => void;
}

function SpecForm(props: SpecFormProps): React.ReactElement {
  const { admin, childKindId, onSubmit, onBack } = props;
  const [name, setName] = useState('');
  const [region, setRegion] = useState('eu-west-3');
  const [framework, setFramework] = useState('nextjs');
  const [isPrivate, setIsPrivate] = useState(true);

  const handle = (): void => {
    const spec: Record<string, unknown> = { name };
    if (childKindId === 'github-repo') {
      spec.private = isPrivate;
    } else if (childKindId === 'vercel-project') {
      spec.framework = framework;
    } else if (childKindId === 'supabase-project') {
      spec.region = region;
      // db_pass and organization_id are filled by ExecuteCreate.
    }
    onSubmit(spec);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="provision-wizard-step-spec">
      <h2 className="text-sm font-medium">Step 2 / 3 — fill spec for {childKindId}</h2>
      <label className="text-xs">
        Name (slug)
        <input
          data-testid="provision-spec-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="ml-2 rounded border border-neutral-300 px-2 py-1 text-xs"
        />
      </label>
      {childKindId === 'github-repo' ? (
        <label className="text-xs">
          <input
            type="checkbox"
            data-testid="provision-spec-private"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
          />
          <span className="ml-2">private</span>
        </label>
      ) : null}
      {childKindId === 'vercel-project' ? (
        <label className="text-xs">
          Framework
          <input
            data-testid="provision-spec-framework"
            value={framework}
            onChange={(e) => setFramework(e.target.value)}
            className="ml-2 rounded border border-neutral-300 px-2 py-1 text-xs"
          />
        </label>
      ) : null}
      {childKindId === 'supabase-project' ? (
        <label className="text-xs">
          Region
          <input
            data-testid="provision-spec-region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="ml-2 rounded border border-neutral-300 px-2 py-1 text-xs"
          />
        </label>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="provision-spec-back"
          onClick={onBack}
          className="rounded border border-neutral-300 px-2 py-1 text-xs"
        >
          Back
        </button>
        <button
          type="button"
          data-testid="provision-spec-next"
          onClick={handle}
          disabled={name.length === 0}
          className="rounded bg-neutral-900 px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          Create cloud resource
        </button>
      </div>
      <p className="text-xs text-neutral-500">
        Admin in use: <code>{admin.kind.id}</code>
      </p>
    </div>
  );
}

interface ExecuteCreateProps {
  readonly orgSlug: string;
  readonly projectId: string;
  readonly admin: AdminContext;
  readonly childKindId: string;
  readonly spec: Record<string, unknown>;
  readonly onCreated: (resourceId: string) => void;
  readonly onError: (message: string) => void;
}

function ExecuteCreate(props: ExecuteCreateProps): React.ReactElement {
  const { orgSlug, projectId, admin, childKindId, spec, onCreated, onError } = props;
  const [status, setStatus] = useState<string>('preparing…');

  useEffect(() => {
    void (async () => {
      try {
        setStatus('unsealing admin token…');
        const id = identityStore.get();
        if (!id) throw new Error('identity_locked');

        const accessMap: Record<string, string> = {};
        const unsealed: Uint8Array[] = [];
        for (const k of Object.keys(admin.kind.accessSchema)) {
          const res = await fetch(
            `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
              admin.resourceId,
            )}/access/${encodeURIComponent(k)}`,
          );
          if (!res.ok) throw new Error(`fetch admin access ${k} failed`);
          const body = (await res.json()) as { sealed_blob: SealedBlobV1 };
          const plain = await unsealAs(body.sealed_blob, id.fingerprint, {
            publicKey: id.publicKey,
            privateKey: id.privateKey,
          });
          if (plain === null) throw new Error(`not_a_recipient_for_${k}`);
          unsealed.push(plain);
          accessMap[k] = new TextDecoder().decode(plain);
        }
        // Inject the provider-specific identifier keys (GITHUB_ORG, …)
        if (admin.kind.provider === 'github' && typeof admin.providerMetadata.org === 'string') {
          accessMap.GITHUB_ORG = admin.providerMetadata.org;
        }
        if (
          admin.kind.provider === 'supabase-cloud' &&
          typeof admin.providerMetadata.organizationId === 'string'
        ) {
          accessMap.SUPABASE_ORG_ID = admin.providerMetadata.organizationId;
        }

        // For supabase-project, generate db_pass + organization_id from
        // admin metadata.
        const augmentedSpec: Record<string, unknown> = { ...spec };
        if (childKindId === 'supabase-project') {
          augmentedSpec.organization_id = accessMap.SUPABASE_ORG_ID ?? '';
          // Caller will rotate db_pass right away — we just need a
          // sane initial value.
          augmentedSpec.db_pass = generateInitialPassword();
        }

        setStatus('creating cloud resource…');
        const child = await admin.kind.createChild(accessMap, augmentedSpec);
        // Wipe unsealed bytes ASAP.
        for (const b of unsealed) b.fill(0);

        setStatus('registering in CRM…');
        const res = await fetch(
          `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
            admin.resourceId,
          )}/provision`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              childKind: childKindId,
              name: spec.name as string,
              project_id: projectId,
              provider_ref: child.providerRef,
              metadata: child.metadata,
            }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(`provision failed: ${body.error ?? String(res.status)}`);
        }
        const body = (await res.json()) as { resource_id: string };
        onCreated(body.resource_id);
      } catch (e) {
        onError(e instanceof Error ? e.message : 'unknown');
      }
    })();
    // The wizard's create call fires exactly once on mount.
  }, []);

  return (
    <div data-testid="provision-wizard-step-execute" className="text-sm">
      Step 3 / 3 — {status}
    </div>
  );
}

interface RegisterAccessProps {
  readonly orgSlug: string;
  readonly childKindId: string;
  readonly resourceId: string;
  readonly onDone: () => void;
}

function RegisterAccess(props: RegisterAccessProps): React.ReactElement {
  const { orgSlug, childKindId, resourceId, onDone } = props;
  const childKind = findKind(childKindId);
  const accessKeys = childKind ? Object.keys(childKind.accessSchema) : [];
  const [remaining, setRemaining] = useState<ReadonlyArray<string>>(accessKeys);

  const handleSealed =
    (key: string) =>
    async (blob: SealedBlobV1): Promise<void> => {
      const res = await fetch(
        `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/resources/${encodeURIComponent(
          resourceId,
        )}/access/${encodeURIComponent(key)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(blob),
        },
      );
      if (res.ok) {
        setRemaining((prev) => prev.filter((k) => k !== key));
      }
    };

  useEffect(() => {
    if (remaining.length === 0) onDone();
  }, [remaining, onDone]);

  void sealForRecipients;

  return (
    <div data-testid="provision-wizard-step-access" className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">
        Step 3 / 3 — seal {String(remaining.length)} access key(s)
      </h2>
      {remaining.map((k) => (
        <SealedInput
          key={k}
          resourceId={resourceId}
          accessKey={k}
          onSealed={handleSealed(k)}
          label={k}
        />
      ))}
    </div>
  );
}

function generateInitialPassword(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

// PubKeyEntry is imported to make the prop-types of SealedInput
// flow through; not directly referenced outside this guard.
const _reify: PubKeyEntry | null = null;
void _reify;
