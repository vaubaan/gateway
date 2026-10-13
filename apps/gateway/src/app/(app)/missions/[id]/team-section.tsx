'use client';

/**
 * "Members and tokens" of a mission (spec §4.2 "Missions", §7.9 bis).
 *
 * One section, two readers:
 *
 *   the creator   adds a member (picked by email among the active users),
 *                 removes one, creates a named token for a machine, revokes
 *                 any token, and sees for each token its holder, its kind,
 *                 when it was created and when it was last used;
 *   a member      generates, rotates or revokes their OWN token and reads the
 *                 rest. Nothing else is offered to them, and the server
 *                 refuses it anyway.
 *
 * A secret is shown once, in the reveal dialog, to whoever generated it: a
 * member's token never appears on the creator's screen, and no list of this
 * section carries more than a prefix.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { LocalDate } from '@/components/LocalDate';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Input,
  Select,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui';
import type { BootstrapKit } from '@/server/missions/bootstrap-kit';
import type { MissionTeam, TeamTokenView } from '@/server/missions/team-service';
import { TOKEN_NAME_MAX_LENGTH, TOKEN_NAME_RULE } from '@/server/missions/token-name';

import { RevealDialog } from '../bootstrap-kit-view';
import { messageOf } from '../message-of';
import styles from './team.module.css';

interface Revealed {
  readonly title: string;
  readonly kit: BootstrapKit;
}

function kitOf(body: unknown): BootstrapKit | null {
  if (typeof body !== 'object' || body === null || !('kit' in body)) return null;
  return body.kit as BootstrapKit;
}

/** `vbn_live_<prefix>_…`: what a list shows of a token. Never more. */
function masked(prefix: string): string {
  return `vbn_live_${prefix}_…`;
}

export function TeamSection({ team }: { team: MissionTeam }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [candidate, setCandidate] = useState('');
  const [tokenName, setTokenName] = useState('');

  const { mission, role } = team;
  const isCreator = role === 'creator';
  const base = `/api/missions/${encodeURIComponent(mission.id)}`;

  async function post(path: string, body?: unknown): Promise<unknown> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const answer: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(messageOf(answer, res.status));
        return null;
      }
      return answer ?? {};
    } catch {
      setError('The instance could not be reached.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function generateMine() {
    const answer = await post('/tokens/mine');
    const kit = kitOf(answer);
    if (kit) setRevealed({ title: `Your token for “${mission.name}”`, kit });
  }

  async function createNamed() {
    const name = tokenName.trim();
    const answer = await post('/tokens', { name });
    const kit = kitOf(answer);
    if (kit) {
      setTokenName('');
      setRevealed({ title: `Token “${name}” for “${mission.name}”`, kit });
    }
  }

  async function addMember() {
    if ((await post('/members', { email: candidate })) !== null) {
      setCandidate('');
      router.refresh();
    }
  }

  async function removeMember(userId: string) {
    if ((await post(`/members/${encodeURIComponent(userId)}/remove`)) !== null) router.refresh();
  }

  async function revoke(token: TeamTokenView) {
    if ((await post(`/tokens/${encodeURIComponent(token.id)}/revoke`)) !== null) router.refresh();
  }

  return (
    <Card data-testid="team-section">
      <CardHeader>
        <CardTitle>Members and tokens</CardTitle>
        <span className={styles.muted}>
          Each token has one holder, so every call is attributed. All tokens share the mission’s
          resources, policy and one budget.
        </span>
      </CardHeader>

      <CardBody>
        <div className={styles.own} data-testid="my-token">
          <div>
            <strong>Your token</strong>{' '}
            {team.my_token ? (
              <>
                <Code>{masked(team.my_token.prefix)}</Code>{' '}
                <span className={styles.muted}>
                  generated <LocalDate ts={team.my_token.created_at} />, last used{' '}
                  <LastUsed at={team.my_token.last_used_at} />
                </span>
              </>
            ) : (
              <span className={styles.muted}>
                you have none yet. It is shown once, to you alone
                {isCreator ? '' : ': the creator of the mission never sees it'}.
              </span>
            )}
          </div>
          <div className={styles.buttons}>
            {team.issuable && (
              <Button type="button" variant="primary" onClick={generateMine} disabled={busy}>
                {team.my_token ? 'Rotate my token' : 'Generate my token'}
              </Button>
            )}
            {team.my_token && (
              <Button
                type="button"
                variant="danger"
                onClick={() => team.my_token && revoke(team.my_token)}
                disabled={busy}
              >
                Revoke my token
              </Button>
            )}
          </div>
        </div>
        {!team.issuable && (
          <p className={styles.muted}>
            No token can be generated now: the mission does not serve calls.
          </p>
        )}
        {error && (
          <p className={styles.refused} role="alert" data-testid="team-error">
            {error}
          </p>
        )}
      </CardBody>

      <h3 className={styles.subhead}>Members</h3>
      <Table data-testid="team-members">
        <Thead>
          <Tr>
            <Th>Member</Th>
            <Th>Role</Th>
            <Th>Added</Th>
            <Th>Token</Th>
            {isCreator && <Th>Action</Th>}
          </Tr>
        </Thead>
        <Tbody>
          {team.members.map((member) => (
            <Tr key={member.user_id} data-member={member.email}>
              <Td>
                {member.email} {!member.active && <Badge tone="danger">deactivated</Badge>}
              </Td>
              <Td>
                {member.role === 'creator' ? (
                  <>
                    creator <span className={styles.muted}>— answers the requests</span>
                  </>
                ) : (
                  'member'
                )}
              </Td>
              <Td>{member.added_at ? <LocalDate ts={member.added_at} dateOnly /> : '—'}</Td>
              <Td>{member.has_token ? 'generated' : 'not generated yet'}</Td>
              {isCreator && (
                <Td>
                  {member.role === 'member' && (
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      onClick={() => removeMember(member.user_id)}
                      disabled={busy}
                      aria-label={`Remove ${member.email}`}
                    >
                      Remove
                    </Button>
                  )}
                </Td>
              )}
            </Tr>
          ))}
        </Tbody>
      </Table>
      {isCreator && (
        <CardBody>
          <form
            className={styles.inlineForm}
            onSubmit={(event) => {
              event.preventDefault();
              void addMember();
            }}
          >
            <label className={styles.field}>
              <span>Add a member</span>
              <Select
                value={candidate}
                onChange={(event) => setCandidate(event.target.value)}
                aria-label="User to add as a member"
                data-testid="member-candidate"
              >
                <option value="">choose a user…</option>
                {team.candidates.map((user) => (
                  <option key={user.id} value={user.email}>
                    {user.email}
                  </option>
                ))}
              </Select>
            </label>
            <Button type="submit" disabled={busy || candidate === ''}>
              Add member
            </Button>
          </form>
          <p className={styles.muted}>
            {team.candidates.length === 0
              ? 'Every active user of this instance is already on the mission. A user exists here once they have signed in.'
              : 'A member uses the mission as it is and generates their own token; you never see it. They cannot change the mission, add members or answer its requests. Removing a member revokes their token.'}
          </p>
        </CardBody>
      )}

      <h3 className={styles.subhead}>Tokens that work now</h3>
      {team.tokens.length === 0 ? (
        <div className={styles.empty}>No token works on this mission now.</div>
      ) : (
        <Table data-testid="team-tokens">
          <Thead>
            <Tr>
              <Th>Holder</Th>
              <Th>Kind</Th>
              <Th>Token</Th>
              <Th>Created</Th>
              <Th>Last used</Th>
              {isCreator && <Th>Action</Th>}
            </Tr>
          </Thead>
          <Tbody>
            {team.tokens.map((token) => (
              <Tr key={token.id} data-holder={token.holder.label}>
                <Td>
                  {token.holder.label} {token.mine && <Badge tone="info">you</Badge>}
                </Td>
                <Td>{token.holder.kind === 'member' ? 'member token' : 'named token'}</Td>
                <Td>
                  <Code>{masked(token.prefix)}</Code>
                </Td>
                <Td>
                  <LocalDate ts={token.created_at} />
                  {token.holder.kind === 'named' && (
                    <div className={styles.muted}>by {token.created_by}</div>
                  )}
                </Td>
                <Td>
                  <LastUsed at={token.last_used_at} />
                </Td>
                {isCreator && (
                  <Td>
                    {token.revocable && (
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        onClick={() => revoke(token)}
                        disabled={busy}
                        aria-label={`Revoke the token of ${token.holder.label}`}
                      >
                        Revoke
                      </Button>
                    )}
                  </Td>
                )}
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
      {isCreator && (
        <CardBody>
          <form
            className={styles.inlineForm}
            onSubmit={(event) => {
              event.preventDefault();
              void createNamed();
            }}
          >
            <label className={styles.field}>
              <span>Named token, for something that has no account</span>
              <Input
                value={tokenName}
                onChange={(event) => setTokenName(event.target.value)}
                placeholder="CI runner"
                maxLength={TOKEN_NAME_MAX_LENGTH}
                title={TOKEN_NAME_RULE}
                autoComplete="off"
                aria-label="Name of the token"
                data-testid="named-token-name"
              />
            </label>
            <Button type="submit" disabled={busy || !team.issuable || tokenName.trim() === ''}>
              Create named token
            </Button>
          </form>
          <p className={styles.muted}>
            For a CI runner or a shared machine. Its calls are attributed to the name you give. The
            token is shown once, to you: hand it to the machine. To replace it, revoke it and create
            one with the same name.
          </p>
        </CardBody>
      )}

      {revealed && (
        <RevealDialog
          title={revealed.title}
          kit={revealed.kit}
          onDone={() => {
            setRevealed(null);
            router.refresh();
          }}
        />
      )}
    </Card>
  );
}

function LastUsed({ at }: { at: string | null }) {
  return at ? <LocalDate ts={at} /> : <>never</>;
}
