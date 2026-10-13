/**
 * `/connections/<id>` — one connection: its state, the public key of an SSH
 * connection, and its resources (spec §0 "Resource", §4.2). The owner edits a
 * resource's display name, environment label and hidden flag inline; the
 * label is read-only when the plugin sets it at discovery. Edits survive
 * "Refresh discovery"; a resource that vanished upstream is marked stale.
 *
 * The owner also sees the shares of the connection (target, exact
 * restriction on demand, revoke, the Share dialog) and may transfer the
 * ownership to a group they belong to (spec §7.2, §7.3).
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { NeedsUser } from '@/components/auth/NeedsUser';
import { RevokeConnection } from '@/components/connections/RevokeConnection';
import { ValidationBadge } from '@/components/telemetry/ValidationBadge';
import styles from '@/components/connections/connections.module.css';
import {
  credentialKindLabel,
  ExperimentalBadge,
  NoticeBanner,
  StateBadge,
} from '@/components/connections/parts';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Select,
  Stack,
  Table,
  Tbody,
  Td,
  Textarea,
  Th,
  Thead,
  Tr,
} from '@/components/ui';
import { currentActor, takeNotice, type PageSearchParams } from '@/lib/connections/session';
import {
  connectionPath,
  CONNECTIONS_PATH,
  editableMetadataKeys,
  isConnectError,
  METADATA_PREFIX,
  NEW_CONNECTION_PATH,
  type ConnectionDetail,
} from '@/server/connections';
import { sharePath, type ShareView } from '@/server/shares';
import type { ConnectionResourceRecord } from '@/server/store';

export const dynamic = 'force-dynamic';

const ENV_LABEL_HTML_PATTERN = '[a-z][a-z0-9\\-]*';
const MAX_NAME_LENGTH = 80;

export default async function ConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: PageSearchParams;
}) {
  const session = await currentActor();
  if (!session) return <NeedsUser />;
  const { root, principal, actor } = session;
  const { id } = await params;
  let detail: ConnectionDetail;
  try {
    detail = await root.connections.service.get(actor, id);
  } catch (err) {
    if (isConnectError(err, 'not-found')) notFound();
    throw err;
  }
  const notice = await takeNotice(root, principal.sessionId, await searchParams);
  const { connection, resources } = detail;
  const base = connectionPath(connection.id);
  const revoked = connection.status === 'revoked';
  const unowned = connection.status === 'unowned';
  const fields = Object.entries(detail.fields);
  const { shares, unshareable } = await root.shares.service.contextFor(actor, connection.id);
  // Empty when the connection takes no owner act: the service says which groups `transfer` accepts.
  const transferTargets = root.connections.service.transferTargets(actor, connection);
  // Share, reconnect: the rule is the services' (`ownerActRefusal`, spec §2.3), read from the
  // context this page already loads. `revoked` and `unowned` below only choose what is displayed.
  const ownerActs = unshareable === null;

  return (
    <Stack gap="var(--space-6)">
      <div className={styles.header}>
        <div>
          <p className={styles.muted}>
            <Link href={CONNECTIONS_PATH}>Connections</Link> / {connection.displayName}
          </p>
          <h1>{connection.displayName}</h1>
          <span className={styles.badges}>
            <span>{detail.providerLabel}</span>
            <StateBadge status={connection.status} />
            {detail.experimental && <ExperimentalBadge />}
            <ValidationBadge status={await root.telemetry.stats.statusFor(connection.provider)} />
          </span>
        </div>
        {!revoked && (
          <div className={styles.actions}>
            {ownerActs && (
              <Link
                href={`${NEW_CONNECTION_PATH}/${encodeURIComponent(connection.provider)}?connection=${encodeURIComponent(connection.id)}`}
                className={styles.linkButton}
              >
                Reconnect
              </Link>
            )}
            <RevokeConnection action={`${base}/revoke`} name={connection.displayName} />
          </div>
        )}
      </div>

      <NoticeBanner notice={notice} />

      {connection.status === 'expired' && (
        <Banner tone="warning" title="Expired">
          The provider rejected the stored credential and it could not be refreshed. Every call of
          the missions that carry this connection is refused until you reconnect.
        </Banner>
      )}
      {unowned && (
        <Banner tone="warning" title="No owner">
          This connection cannot be reconnected: an operator must reassign an owner first. The
          missions that carry it keep running meanwhile.
        </Banner>
      )}
      {revoked && (
        <Banner tone="info" title="Revoked">
          This connection was revoked
          {connection.revokedAt ? ` on ${day(connection.revokedAt)}` : ''}; its credential is
          erased. Revocation is final.
        </Banner>
      )}

      <Card>
        <CardBody>
          <dl className={styles.dl}>
            <dt>Owner</dt>
            <dd>{detail.ownerLabel}</dd>
            <dt>Credential</dt>
            <dd>{credentialKindLabel(detail.credentialKind)} — encrypted at rest</dd>
            <dt>Connected</dt>
            <dd>{day(connection.createdAt)}</dd>
            {fields.map(([name, value]) => (
              <FieldFact key={name} name={name} value={value} />
            ))}
            <dt>Last discovery</dt>
            <dd>
              {detail.discovery ? (
                <>
                  {day(detail.discovery.at)} —{' '}
                  {detail.discovery.ok
                    ? `${detail.discovery.count} reachable`
                    : `failed: ${detail.discovery.error ?? 'no reason given'}`}
                </>
              ) : (
                'never'
              )}
            </dd>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Shares</CardTitle>
          {ownerActs && (
            <Link href={sharePath(connection.id)} className={styles.linkButton}>
              Share
            </Link>
          )}
        </CardHeader>
        {shares.length === 0 ? (
          <div className={styles.empty}>
            Not shared. Only its {connection.owner.kind === 'group' ? 'owners' : 'owner'} can issue
            missions on this connection.
          </div>
        ) : (
          <div className={styles.tableWrap}>
            <Table>
              <Thead>
                <Tr>
                  <Th>Shared with</Th>
                  <Th>Restriction</Th>
                  <Th>Since</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {shares.map((view) => (
                  <ShareRow key={view.share.id} view={view} base={base} editable={ownerActs} />
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>

      {transferTargets.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Ownership</CardTitle>
          </CardHeader>
          <CardBody>
            <Stack gap="var(--space-3)">
              <p className={styles.muted}>
                Transfer this connection to a group you belong to: every member of the group, now
                and later, becomes a full owner and may share, reconnect, transfer or revoke it.
                Shares are kept.
              </p>
              <form method="post" action={`${base}/transfer`} className={styles.actions}>
                <Select name="group_id" aria-label="Group to transfer to" required>
                  {transferTargets.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </Select>
                <Button type="submit" variant="secondary" size="sm">
                  Transfer
                </Button>
              </form>
            </Stack>
          </CardBody>
        </Card>
      )}

      {detail.publicKey && !revoked && (
        <Card>
          <CardHeader>
            <CardTitle>Public key to install</CardTitle>
          </CardHeader>
          <CardBody>
            <Stack gap="var(--space-3)">
              <p className={styles.muted}>
                Append this line to <code>~/.ssh/authorized_keys</code> of the login user on the
                host, then use &quot;Refresh discovery&quot; to verify the access. The private key
                never leaves this instance.
              </p>
              <code className={styles.keyBlock}>{detail.publicKey}</code>
            </Stack>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Resources</CardTitle>
          {!revoked && (
            <form method="post" action={`${base}/discover`} className={styles.inlineForm}>
              <Button type="submit" variant="secondary" size="sm">
                Refresh discovery
              </Button>
            </form>
          )}
        </CardHeader>
        {resources.length === 0 ? (
          <div className={styles.empty}>
            No resource discovered yet.
            {!revoked && ' Use "Refresh discovery" once the provider is reachable.'}
          </div>
        ) : (
          <div className={styles.tableWrap}>
            <Table>
              <Thead>
                <Tr>
                  <Th>Ref</Th>
                  <Th>Display name</Th>
                  <Th>Environment</Th>
                  <Th>Hidden</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {resources.map((resource) => (
                  <ResourceRow
                    key={resource.id}
                    resource={resource}
                    action={`${base}/resources/${encodeURIComponent(resource.id)}`}
                    readOnly={revoked}
                  />
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>
    </Stack>
  );
}

/** One share: its target, the exact restriction on demand, edit and revoke. */
function ShareRow({ view, base, editable }: { view: ShareView; base: string; editable: boolean }) {
  const { share } = view;
  const count = share.restriction.length;
  return (
    <Tr>
      <Td>{view.targetLabel}</Td>
      <Td>
        <details className={styles.settings}>
          <summary>
            {count} {count === 1 ? 'risk' : 'risks'}
          </summary>
          <div className={styles.settingsBody}>
            {share.restriction.map((riskId) => (
              <code key={riskId} className={styles.mono}>
                {riskId}
              </code>
            ))}
          </div>
        </details>
      </Td>
      <Td className={styles.muted}>{day(share.createdAt)}</Td>
      <Td>
        <span className={styles.actions}>
          {editable && (
            <Link href={`${sharePath(share.connectionId)}?share=${encodeURIComponent(share.id)}`}>
              Edit
            </Link>
          )}
          <form
            method="post"
            action={`${base}/shares/${encodeURIComponent(share.id)}/revoke`}
            className={styles.inlineForm}
          >
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              aria-label={`Revoke the share to ${view.targetLabel}`}
            >
              Revoke
            </Button>
          </form>
        </span>
      </Td>
    </Tr>
  );
}

function FieldFact({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt>{name.replace(/_/g, ' ')}</dt>
      <dd>
        <code>{value}</code>
      </dd>
    </>
  );
}

/**
 * One resource, edited in place. A `<form>` cannot wrap table cells, so the
 * inputs name their form through the `form` attribute.
 */
function ResourceRow({
  resource,
  action,
  readOnly,
}: {
  resource: ConnectionResourceRecord;
  action: string;
  readOnly: boolean;
}) {
  const formId = `resource-${resource.id}`;
  const listKeys = editableMetadataKeys(resource.metadata);
  const pluginSetsEnv = resource.envSource === 'plugin';
  return (
    <Tr className={resource.staleSince ? styles.staleRow : undefined}>
      <Td>
        <span className={styles.ref}>{resource.ref}</span>{' '}
        {resource.staleSince && (
          <Badge tone="warning">stale since {day(resource.staleSince)}</Badge>
        )}
        {listKeys.length > 0 && (
          <details className={styles.settings}>
            <summary>Settings ({listKeys.length})</summary>
            <div className={styles.settingsBody}>
              {listKeys.map((key) => (
                <Field
                  key={key}
                  label={key.replace(/_/g, ' ')}
                  htmlFor={`${formId}-${key}`}
                  hint="One entry per line, or separated by spaces or commas."
                >
                  <Textarea
                    id={`${formId}-${key}`}
                    form={formId}
                    name={`${METADATA_PREFIX}${key}`}
                    rows={2}
                    disabled={readOnly}
                    spellCheck={false}
                    defaultValue={listOf(resource.metadata?.[key]).join('\n')}
                  />
                </Field>
              ))}
            </div>
          </details>
        )}
      </Td>
      <Td>
        <input
          form={formId}
          name="display_name"
          className={styles.cellInput}
          defaultValue={resource.displayName}
          maxLength={MAX_NAME_LENGTH}
          disabled={readOnly}
          aria-label={`Display name of ${resource.ref}`}
        />
      </Td>
      <Td>
        {pluginSetsEnv ? (
          <span className={styles.badges}>
            <Badge mono>{resource.env ?? '—'}</Badge>
            <span className={styles.muted}>set by the plugin</span>
          </span>
        ) : (
          <input
            form={formId}
            name="env"
            className={styles.envInput}
            defaultValue={resource.env ?? ''}
            placeholder="prod, staging…"
            pattern={ENV_LABEL_HTML_PATTERN}
            title="Lower-case letters, digits and dashes, starting with a letter"
            disabled={readOnly}
            aria-label={`Environment of ${resource.ref}`}
          />
        )}
      </Td>
      <Td>
        <label className={styles.checkbox}>
          <input
            form={formId}
            type="checkbox"
            name="hidden"
            defaultChecked={resource.hidden}
            disabled={readOnly}
          />
          hidden
        </label>
      </Td>
      <Td>
        <form id={formId} method="post" action={action}>
          <input type="hidden" name="hidden_present" value="1" />
          <Button type="submit" variant="secondary" size="sm" disabled={readOnly}>
            Save
          </Button>
        </form>
      </Td>
    </Tr>
  );
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function day(iso: string): string {
  return iso.slice(0, 10);
}
