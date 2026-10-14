/**
 * Creating a company app from Settings → Administration → Company apps, and
 * what the page shows of it afterwards (spec §4.2 "company apps"; ADR
 * company-app-created-from-a-manifest).
 *
 * `AppCreateForm` is a plain HTML form posting to
 * `/admin/provider-apps/<id>/create`: the owner (an organisation, or the
 * administrator's own account), the name, and one level per permission. The
 * permissions, their words, the sensitive ones and the tools each level serves
 * all come from the plugin's `manifestRegistration` — the page lists nothing
 * of its own. The server checks everything again.
 *
 * `RegisteredAppFacts` shows an app created from the page: its name linking
 * to it at the service, its owner, its permissions, and the next step.
 */
import {
  accessRank,
  defaultPermissionChoice,
  NO_ACCESS,
  toolsLostAt,
  type AppManifestRegistration,
  type AppPermission,
} from '@vaubaan/plugin-sdk';

import styles from '@/components/settings/settings.module.css';
import own from '@/components/settings/app-registration.module.css';
import { Button, ButtonLink, Field, Input, KeyValue, Mono, Radio, Select } from '@/components/ui';
import { ACTIONS, listed } from '@/lib/vocabulary';

/** Form input names: `owner_kind`, `owner_login`, `name`, `permission.<name>`. */
const PERMISSION_PREFIX = 'permission.';

/** A tool in a sentence, from the plugin's titles: "write a file on a branch". */
function toolWords(tool: string, titles: Readonly<Record<string, string>>): string {
  const title = titles[tool] ?? tool;
  return title.charAt(0).toLowerCase() + title.slice(1);
}

/**
 * What stops working at `access`, in one sentence: the tools that stop
 * entirely, then, per condition, the ones that stop for some calls —
 * "read a file and 3 more; write a file on a branch, push files to a branch
 * and 1 more, for a file under .github/workflows/".
 */
function lostSentence(
  permission: AppPermission,
  access: string,
  titles: Readonly<Record<string, string>>,
): { readonly short: string; readonly full: string } | null {
  const lost = toolsLostAt(permission, access);
  if (lost.length === 0) return null;
  const rank = access === NO_ACCESS ? -1 : accessRank(permission, access);
  const above = permission.levels.slice(rank + 1);
  const plain: string[] = [];
  const byCondition = new Map<string, string[]>();
  for (const tool of lost) {
    const words = toolWords(tool, titles);
    // Only the levels given up count: a tool some of them need on every call
    // stops entirely, otherwise it stops for the calls their condition names.
    const unconditional = above.some(
      (level) => level.tools.includes(tool) && level.onlyWhen?.[tool] === undefined,
    );
    const condition = unconditional
      ? undefined
      : above.find((level) => level.onlyWhen?.[tool])?.onlyWhen?.[tool];
    if (condition === undefined) plain.push(words);
    else byCondition.set(condition, [...(byCondition.get(condition) ?? []), words]);
  }
  const parts = plain.length > 0 ? [listed(plain, 3)] : [];
  const full = [...plain];
  for (const [condition, words] of byCondition) {
    parts.push(`${listed(words, 3)}, ${condition}`);
    full.push(...words.map((w) => `${w} (${condition})`));
  }
  return { short: parts.join('; '), full: full.join(', ') };
}

function PermissionChoice({
  permission,
  idPrefix,
  titles,
}: {
  permission: AppPermission;
  idPrefix: string;
  titles: Readonly<Record<string, string>>;
}) {
  const id = `${idPrefix}-${permission.name}`;
  const highest = defaultPermissionChoice([permission])[permission.name];
  const levels = permission.levels;
  const topLabel = levels[levels.length - 1]?.label ?? '';
  // The choice that matters is one step down from what the tools need.
  const below = levels.length > 1 ? levels[levels.length - 2] : undefined;
  const lost = lostSentence(permission, below?.access ?? NO_ACCESS, titles);
  const lead = below ? `${below.label} only stops` : 'Without it';
  return (
    <li className={own.permission} data-testid={`app-permission-${permission.name}`}>
      <div className={own.permissionText}>
        <label htmlFor={id} className={own.permissionName}>
          {permission.label} <Mono>{permission.name}</Mono>
        </label>
        <span className={own.small}>{permission.description}</span>
        {permission.sensitive && (
          <span className={own.sensitive}>
            <strong>Sensitive.</strong> {permission.sensitive}
          </span>
        )}
        {!permission.mandatory && lost && (
          <span className={own.small} title={lost.full}>
            {lead}: {lost.short}.
          </span>
        )}
      </div>
      {permission.mandatory ? (
        <span className={own.fixed}>{topLabel}, always</span>
      ) : (
        <Select
          id={id}
          name={`${PERMISSION_PREFIX}${permission.name}`}
          defaultValue={highest}
          size="sm"
          aria-label={`${permission.label}: access the app requests`}
        >
          <option value={NO_ACCESS}>No access</option>
          {permission.levels.map((level) => (
            <option key={level.access} value={level.access}>
              {level.label}
            </option>
          ))}
        </Select>
      )}
    </li>
  );
}

export function AppCreateForm({
  providerId,
  displayName,
  manifest,
  defaultName,
  toolTitles,
  action,
  manualHref,
  cancelHref,
}: {
  providerId: string;
  displayName: string;
  manifest: AppManifestRegistration;
  defaultName: string;
  toolTitles: Readonly<Record<string, string>>;
  /** `/admin/provider-apps/<id>/create`. */
  action: string;
  /** The same line with the form to enter an app registered by hand. */
  manualHref: string;
  cancelHref: string;
}) {
  const prefix = `create-app-${providerId}`;
  return (
    <form
      method="post"
      action={action}
      className={styles.form}
      data-testid={`app-create-${providerId}`}
    >
      <p className={styles.prose}>
        The app is created at {displayName} under the owner you choose, and belongs to them. Its
        private key and secret come straight to this gateway, stored encrypted and never shown;{' '}
        {displayName} shows you the app and asks you to confirm before creating it.
      </p>
      <Field label="Owner">
        <div className={own.owner}>
          <Radio name="owner_kind" value="organization" defaultChecked>
            An organisation
          </Radio>
          <Input
            className={own.ownerLogin}
            name="owner_login"
            size="sm"
            mono
            pattern={manifest.ownerLoginPattern}
            aria-label="The organisation’s name"
            placeholder="organisation name"
            autoComplete="off"
            spellCheck={false}
          />
          <Radio name="owner_kind" value="personal">
            My own account
          </Radio>
        </div>
      </Field>
      <Field
        label="Name"
        htmlFor={`${prefix}-name`}
        hint={`Shown when someone installs the app; at most ${manifest.nameMaxLength} characters, and unique at ${displayName}.`}
      >
        <Input
          id={`${prefix}-name`}
          name="name"
          defaultValue={defaultName}
          maxLength={manifest.nameMaxLength}
          required
          autoComplete="off"
        />
      </Field>
      <Field
        label="Permissions"
        hint={`What the tools need, by default. ${displayName} refuses the app anything you leave out, whatever a mission allows.`}
      >
        <ul className={own.permissions}>
          {manifest.permissions.map((permission) => (
            <PermissionChoice
              key={permission.name}
              permission={permission}
              idPrefix={prefix}
              titles={toolTitles}
            />
          ))}
        </ul>
      </Field>
      <div className={styles.formActions}>
        <Button type="submit" variant="primary" size="sm">
          Create the {displayName} App
        </Button>
        <ButtonLink href={manualHref} variant="ghost" size="sm">
          Enter an app registered by hand
        </ButtonLink>
        <ButtonLink href={cancelHref} variant="ghost" size="sm">
          {ACTIONS.cancel}
        </ButtonLink>
      </div>
    </form>
  );
}

/** "Contents: read and write · Metadata: read", in the order the plugin declares them. */
export function permissionSummary(
  declared: readonly AppPermission[],
  held: Readonly<Record<string, string>>,
): string {
  const parts: string[] = [];
  for (const permission of declared) {
    const access = held[permission.name];
    if (access === undefined) continue;
    const level = permission.levels.find((l) => l.access === access);
    parts.push(`${permission.label}: ${(level?.label ?? access).toLowerCase()}`);
  }
  const known = new Set(declared.map((p) => p.name));
  for (const [name, access] of Object.entries(held)) {
    if (!known.has(name)) parts.push(`${name}: ${access}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'none';
}

export function RegisteredAppFacts({
  displayName,
  name,
  htmlUrl,
  ownerLogin,
  ownerKind,
  permissions,
  installHref,
}: {
  displayName: string;
  name: string;
  htmlUrl: string;
  ownerLogin: string;
  ownerKind: 'organization' | 'personal';
  /** `permissionSummary` of what the app holds. */
  permissions: string;
  /** The connect flow of this service: installing the app is connecting an account. */
  installHref: string;
}) {
  return (
    <div className={own.facts} data-testid="registered-app">
      <KeyValue
        items={[
          {
            term: 'App',
            value: (
              <a className={styles.reveal} href={htmlUrl} target="_blank" rel="noreferrer noopener">
                {name}
              </a>
            ),
          },
          {
            term: 'Owner',
            value: (
              <>
                <Mono>{ownerLogin}</Mono>
                {ownerKind === 'personal' ? ' · a personal account' : ' · an organisation'}
              </>
            ),
          },
          { term: 'Permissions', value: permissions },
        ]}
      />
      <div className={styles.formActions}>
        <ButtonLink href={installHref} variant="primary" size="sm">
          Install it on your repositories
        </ButtonLink>
        <span className={styles.formHint}>
          Installing it at {displayName} is connecting an account; you choose the repositories
          there.
        </span>
      </div>
    </div>
  );
}
