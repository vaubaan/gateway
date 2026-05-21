/**
 * `<ConnectInfisicalWizard>` — 3-step client wizard to register a new
 * Infisical SecretManager for an org.
 *
 * Steps :
 *
 * 1. **Workspace + machine-identity** — the admin fills `workspace_id`,
 *    `endpoint`, `environment`, plus the `(clientId, clientSecret)` pair
 *    they got from the Infisical UI.
 * 2. **Recipients + seal** — the wizard shows the list of recipients
 *    (org_admins ∪ runner_pk, passed in via props). The admin can
 *    uncheck a recipient (rare; usually the default list is fine), then
 *    clicks "Seal & continue". The client:
 *      a. JSON-stringify the `(clientId, clientSecret)` pair,
 *      b. `sealForRecipients` of the JSON bytes for the selected
 *         recipients,
 *      c. wipe the cleartext bytes (`.fill(0)`),
 *      d. wipe the form state for the secret pair (the clientId stays
 *         visible — it's a UUID, not a credential).
 * 3. **Submit** — POST `/api/crm/v1/orgs/:orgSlug/secret-managers` with
 *    the sealed blob + the config + the optional `is_default` flag.
 *    On 201 redirect to the SM list.
 *
 * ZK invariants :
 *
 * - `clientSecret` never lands in `localStorage` / `sessionStorage` /
 *   `document.cookie` / `IndexedDB`. The seal happens in-tab, the
 *   cleartext bytes are overwritten right after, and the form state
 *   is reset.
 * - The POST body carries the sealed `auth_sealed_blob` only, never
 *   the cleartext pair.
 */

'use client';

import { useCallback, useMemo, useState } from 'react';

import { sealForRecipients, type PubKeyEntry, type SealedBlobV1 } from '@crm/core/crypto';

export interface WizardRecipient {
  readonly user_id?: string;
  readonly fingerprint: string;
  readonly public_key_b64: string;
  readonly label?: string;
}

export interface ConnectInfisicalWizardProps {
  readonly orgSlug: string;
  readonly recipients: ReadonlyArray<WizardRecipient>;
}

type Step = 'config' | 'seal' | 'submit';

interface ConfigState {
  workspaceId: string;
  endpoint: string;
  environment: string;
  name: string;
  clientId: string;
  clientSecret: string;
  isDefault: boolean;
}

function decodePub(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function ConnectInfisicalWizard(props: ConnectInfisicalWizardProps): React.ReactElement {
  const [step, setStep] = useState<Step>('config');
  const [config, setConfig] = useState<ConfigState>({
    workspaceId: '',
    endpoint: 'https://eu.infisical.com',
    environment: 'prod',
    name: 'default',
    clientId: '',
    clientSecret: '',
    isDefault: false,
  });
  const [disabledFps, setDisabledFps] = useState<ReadonlySet<string>>(new Set());
  const [sealedBlob, setSealedBlob] = useState<SealedBlobV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decodedRecipients = useMemo<ReadonlyArray<PubKeyEntry>>(
    () =>
      props.recipients
        .filter((r) => !disabledFps.has(r.fingerprint))
        .map((r) => ({ publicKey: decodePub(r.public_key_b64), fingerprint: r.fingerprint })),
    [props.recipients, disabledFps],
  );

  const toggleFp = useCallback((fp: string, checked: boolean) => {
    setDisabledFps((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(fp);
      else next.add(fp);
      return next;
    });
  }, []);

  const goToSeal = useCallback(() => {
    setError(null);
    if (config.workspaceId.length === 0) {
      setError('workspace_id is required');
      return;
    }
    if (!/^https?:\/\//.test(config.endpoint)) {
      setError('endpoint must be an http(s) URL');
      return;
    }
    if (config.clientId.length === 0 || config.clientSecret.length === 0) {
      setError('clientId and clientSecret are required');
      return;
    }
    if (!/^[a-z0-9](-?[a-z0-9])*$/.test(config.name)) {
      setError('name must be a valid slug');
      return;
    }
    setStep('seal');
  }, [config]);

  const handleSeal = useCallback(async (): Promise<void> => {
    setError(null);
    if (decodedRecipients.length === 0) {
      setError('at least one recipient required to seal');
      return;
    }
    setBusy(true);
    let bytes: Uint8Array | null = null;
    try {
      const pair = JSON.stringify({ clientId: config.clientId, clientSecret: config.clientSecret });
      bytes = new TextEncoder().encode(pair);
      const blob = await sealForRecipients(bytes, decodedRecipients);
      bytes.fill(0);
      bytes = null;
      // Wipe the cleartext credentials from form state. We keep the
      // workspaceId/endpoint/name (not secrets) so the admin can review.
      setConfig((prev) => ({ ...prev, clientSecret: '' }));
      setSealedBlob(blob);
      setStep('submit');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'seal_failed');
    } finally {
      if (bytes) bytes.fill(0);
      setBusy(false);
    }
  }, [config.clientId, config.clientSecret, decodedRecipients]);

  const handleSubmit = useCallback(async (): Promise<void> => {
    setError(null);
    if (!sealedBlob) return;
    setBusy(true);
    try {
      const body = {
        kind: 'infisical' as const,
        name: config.name,
        config: {
          workspace_id: config.workspaceId,
          endpoint: config.endpoint,
          ...(config.environment.length > 0 ? { environment: config.environment } : {}),
        },
        auth_sealed_blob: sealedBlob,
        is_default: config.isDefault,
      };
      const res = await fetch(
        `/api/crm/v1/orgs/${encodeURIComponent(props.orgSlug)}/secret-managers`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        setError(errBody.message ?? errBody.error ?? `HTTP ${String(res.status)}`);
        return;
      }
      if (typeof window !== 'undefined') {
        window.location.href = `/orgs/${props.orgSlug}/secret-managers`;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'submit_failed');
    } finally {
      setBusy(false);
    }
  }, [sealedBlob, config, props.orgSlug]);

  return (
    <div
      data-testid="connect-infisical-wizard"
      data-step={step}
      className="flex flex-col gap-4 rounded-md border border-neutral-300 p-4"
    >
      <ol className="flex gap-2 text-xs uppercase text-neutral-600">
        <li data-testid="wizard-progress-config" data-active={step === 'config'}>
          1. Config
        </li>
        <li>·</li>
        <li data-testid="wizard-progress-seal" data-active={step === 'seal'}>
          2. Seal
        </li>
        <li>·</li>
        <li data-testid="wizard-progress-submit" data-active={step === 'submit'}>
          3. Submit
        </li>
      </ol>

      {error ? (
        <p data-testid="wizard-error" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {step === 'config' ? (
        <div data-testid="wizard-step-config" className="flex flex-col gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span>Name (slug)</span>
            <input
              data-testid="wizard-input-name"
              value={config.name}
              onChange={(e) => setConfig({ ...config, name: e.target.value })}
              className="rounded border border-neutral-300 px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Infisical endpoint</span>
            <input
              data-testid="wizard-input-endpoint"
              value={config.endpoint}
              onChange={(e) => setConfig({ ...config, endpoint: e.target.value })}
              className="rounded border border-neutral-300 px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Workspace ID</span>
            <input
              data-testid="wizard-input-workspace"
              value={config.workspaceId}
              onChange={(e) => setConfig({ ...config, workspaceId: e.target.value })}
              className="rounded border border-neutral-300 px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Environment</span>
            <input
              data-testid="wizard-input-environment"
              value={config.environment}
              onChange={(e) => setConfig({ ...config, environment: e.target.value })}
              className="rounded border border-neutral-300 px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Machine Identity — Client ID (UUID)</span>
            <input
              data-testid="wizard-input-clientid"
              value={config.clientId}
              onChange={(e) => setConfig({ ...config, clientId: e.target.value })}
              autoComplete="off"
              className="rounded border border-neutral-300 px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Machine Identity — Client Secret</span>
            <input
              data-testid="wizard-input-clientsecret"
              type="password"
              value={config.clientSecret}
              onChange={(e) => setConfig({ ...config, clientSecret: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              className="rounded border border-neutral-300 px-2 py-1 font-mono"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              data-testid="wizard-input-is-default"
              type="checkbox"
              checked={config.isDefault}
              onChange={(e) => setConfig({ ...config, isDefault: e.target.checked })}
            />
            <span>Set as default SecretManager for the org</span>
          </label>
          <button
            type="button"
            data-testid="wizard-button-next-seal"
            onClick={goToSeal}
            className="self-start rounded bg-neutral-900 px-3 py-1 text-sm text-white"
          >
            Continue — Seal
          </button>
        </div>
      ) : null}

      {step === 'seal' ? (
        <div data-testid="wizard-step-seal" className="flex flex-col gap-2 text-sm">
          <p className="text-neutral-700">
            The client secret is about to be sealed multi-recipient for the org_admins ∪ runner.
            Uncheck any recipient that should not have access (rare).
          </p>
          <fieldset data-testid="wizard-recipient-list" className="flex flex-col gap-1 text-xs">
            <legend className="font-medium text-neutral-700">
              Recipients ({String(decodedRecipients.length)} / {String(props.recipients.length)})
            </legend>
            {props.recipients.length === 0 ? (
              <span data-testid="wizard-no-recipients">
                No recipients available — every org admin must have a registered keypair before you
                can seal a SecretManager credential.
              </span>
            ) : null}
            {props.recipients.map((r) => {
              const checked = !disabledFps.has(r.fingerprint);
              return (
                <label key={r.fingerprint} className="flex items-center gap-2 font-mono">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => toggleFp(r.fingerprint, e.target.checked)}
                    data-testid={`wizard-recipient-${r.fingerprint}`}
                  />
                  <span>
                    {r.label ?? r.user_id ?? ''} {r.label || r.user_id ? '· ' : ''}
                    {r.fingerprint}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="wizard-button-back-to-config"
              onClick={() => setStep('config')}
              className="rounded border border-neutral-300 px-3 py-1 text-sm"
            >
              Back
            </button>
            <button
              type="button"
              data-testid="wizard-button-seal"
              disabled={busy || decodedRecipients.length === 0}
              onClick={() => void handleSeal()}
              className="rounded bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              {busy ? 'Sealing…' : 'Seal & continue'}
            </button>
          </div>
        </div>
      ) : null}

      {step === 'submit' ? (
        <div data-testid="wizard-step-submit" className="flex flex-col gap-2 text-sm">
          <p className="text-neutral-700">
            Sealed for {sealedBlob ? String(sealedBlob.recipients.length) : '0'} recipients. The
            client secret has been wiped from this browser session.
          </p>
          <ul className="font-mono text-xs text-neutral-700">
            <li>name: {config.name}</li>
            <li>endpoint: {config.endpoint}</li>
            <li>workspace: {config.workspaceId}</li>
            <li>environment: {config.environment || '(default prod)'}</li>
            <li>is_default: {config.isDefault ? 'true' : 'false'}</li>
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="wizard-button-back-to-seal"
              onClick={() => setStep('seal')}
              className="rounded border border-neutral-300 px-3 py-1 text-sm"
            >
              Back
            </button>
            <button
              type="button"
              data-testid="wizard-button-submit"
              disabled={busy}
              onClick={() => void handleSubmit()}
              className="rounded bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              {busy ? 'Submitting…' : 'Submit'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
