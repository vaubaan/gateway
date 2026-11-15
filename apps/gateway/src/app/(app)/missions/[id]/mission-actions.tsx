'use client';

/**
 * Everything a person does to a mission from its page (spec §7.8, §7.9 bis),
 * and the dialogs those acts open. One service around the page holds the
 * dialogs, so that the header, the "···" menu and the rows of "People and
 * keys" open the same ones:
 *
 *   setup kit            the three snippets and the check, with the masked key
 *   add people           the creator picks a teammate among the people who signed in
 *   new machine key      the creator names a key for something that has no account
 *   generate my key      a teammate's first key (nothing stops: no question asked)
 *   replace a key        asks first and states the consequence — the old key
 *                        stops working at once, for whom — then shows the new one, once
 *   revoke a key, remove a teammate, leave the mission, stop the mission
 *                        cannot be undone: the person types a phrase
 *
 * A page offers an act only when the server would take it (the team view and
 * the mission detail say so); the server refuses the rest anyway.
 */
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

import {
  Button,
  ConfirmDialog,
  DangerConfirm,
  Dialog,
  Field,
  Input,
  MenuItem,
  MoreMenu,
  Select,
  useToast,
} from '@/components/ui';
import {
  ACTIONS,
  KEY_WORDS,
  MISSION_ACTIONS,
  MISSION_WORDS,
  possessive,
  ROUTES,
  WAITING,
} from '@/lib/vocabulary';
import type { BootstrapKit } from '@/server/missions/bootstrap-kit';
import type { MissionTeam, TeamTokenView } from '@/server/missions/team-service';
import { TOKEN_NAME_MAX_LENGTH, TOKEN_NAME_RULE } from '@/lib/missions/token-name';

import { KitSteps, RevealDialog, revealedOf, type RevealedKey } from '../bootstrap-kit-view';
import { useAction } from '@/lib/http/post-json';

type Act =
  | { readonly kind: 'kit' }
  | { readonly kind: 'add-people' }
  | { readonly kind: 'machine-key' }
  | { readonly kind: 'replace-mine' }
  | { readonly kind: 'replace-machine'; readonly token: TeamTokenView }
  | { readonly kind: 'revoke-key'; readonly token: TeamTokenView }
  | { readonly kind: 'remove-teammate'; readonly userId: string; readonly email: string }
  | { readonly kind: 'leave' }
  | { readonly kind: 'stop' };

interface MissionActs {
  readonly team: MissionTeam;
  readonly busy: boolean;
  open(act: Act): void;
  /** A first key: nothing stops, so nothing is asked. */
  generateMine(): void;
}

const ActsContext = createContext<MissionActs | null>(null);

export function useMissionActs(): MissionActs {
  const acts = useContext(ActsContext);
  if (!acts) throw new Error('useMissionActs must be used inside MissionActsProvider');
  return acts;
}

export function MissionActsProvider({
  team,
  kit,
  children,
}: {
  team: MissionTeam;
  /** The kit with the masked key; `null` when the reader holds no working key. */
  kit: BootstrapKit | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const [act, setAct] = useState<Act | null>(null);
  const { busy, error, setError, run } = useAction();
  const [revealed, setRevealed] = useState<RevealedKey | null>(null);
  const [candidate, setCandidate] = useState('');
  const [keyName, setKeyName] = useState('');

  const { mission } = team;
  const base = `/api/missions/${encodeURIComponent(mission.id)}`;

  /** The answer of a mission act, `null` when it failed (its sentence is then `error`). */
  const post = useCallback(
    async (path: string, body?: unknown): Promise<unknown> => {
      const answer = await run(`${base}${path}`, body);
      return answer.ok ? (answer.body ?? {}) : null;
    },
    [base, run],
  );

  function close() {
    setAct(null);
    setError(null);
  }

  const open = useCallback((next: Act) => {
    setError(null);
    setAct(next);
  }, []);

  /** The answer that carries a key: shown once, then the page reloads its data. */
  function reveal(answer: unknown, title: string, label?: string): boolean {
    const made = revealedOf(answer);
    if (!made) return false;
    setAct(null);
    setRevealed({ title, label, ...made });
    return true;
  }

  const generateMine = useCallback(() => {
    void (async () => {
      const answer = await post('/tokens/mine');
      const made = revealedOf(answer);
      if (made) setRevealed({ title: `Your key for “${mission.name}”`, ...made });
    })();
  }, [post, mission.name]);

  async function replaceMine() {
    const answer = await post('/tokens/mine');
    reveal(answer, `Your new key for “${mission.name}”`);
  }

  async function createMachineKey(name: string): Promise<boolean> {
    const answer = await post('/tokens', { name });
    return reveal(answer, `Machine key “${name}” for “${mission.name}”`, `The machine key ${name}`);
  }

  async function replaceMachine(token: TeamTokenView) {
    // One act on the server: the old key is retired and the new one issued together.
    const answer = await post(`/tokens/${encodeURIComponent(token.id)}/replace`);
    if (
      !reveal(
        answer,
        `Machine key “${token.holder.label}” for “${mission.name}”`,
        `The machine key ${token.holder.label}`,
      )
    ) {
      router.refresh();
    }
  }

  async function leave() {
    if ((await post('/leave')) === null) return;
    close();
    toast({
      title: `You left “${mission.name}”`,
      description: 'Your key stopped working. The creator can add you again.',
    });
    router.push(ROUTES.missions);
    router.refresh();
  }

  async function revokeKey(token: TeamTokenView) {
    if ((await post(`/tokens/${encodeURIComponent(token.id)}/revoke`)) === null) return;
    close();
    toast({
      title: token.mine ? 'Your key was revoked' : `${keyLabel(token)} was revoked`,
      description: 'Its next call is refused. The other keys keep working.',
    });
    router.refresh();
  }

  async function addTeammate() {
    if ((await post('/members', { email: candidate })) === null) return;
    toast({
      title: `${candidate} can work on this mission`,
      description: 'They sign in and generate their own key; you never see it.',
    });
    setCandidate('');
    close();
    router.refresh();
  }

  async function removeTeammate(userId: string, email: string) {
    if ((await post(`/members/${encodeURIComponent(userId)}/remove`)) === null) return;
    close();
    toast({ title: `${email} was removed`, description: 'Their key stopped working.' });
    router.refresh();
  }

  async function stop() {
    if ((await post('/revoke')) === null) return;
    close();
    toast({ title: 'The mission was stopped', description: 'Every key of it is refused now.' });
    router.refresh();
  }

  const value = useMemo<MissionActs>(
    () => ({ team, busy, open, generateMine }),
    [team, busy, open, generateMine],
  );

  const others = team.tokens.filter((token) => !token.mine).length;
  const machineName = keyName.trim();

  return (
    <ActsContext.Provider value={value}>
      {children}

      <Dialog
        open={act?.kind === 'kit'}
        onClose={close}
        width="lg"
        divided
        title={ACTIONS.setupKit}
        description={kit ? MISSION_WORDS.kitWithoutKey : undefined}
        testId="kit-dialog"
        footer={
          <Button type="button" onClick={close}>
            Close
          </Button>
        }
      >
        {kit ? (
          <KitSteps kit={kit} />
        ) : (
          <p>
            {team.issuable
              ? 'You have no key on this mission yet. Generate one: it comes with the kit.'
              : MISSION_WORDS.notServing}
          </p>
        )}
        {error && act?.kind === 'kit' && <p role="alert">{error}</p>}
      </Dialog>

      <Dialog
        open={act?.kind === 'add-people'}
        onClose={close}
        title={ACTIONS.addPeople}
        description="A teammate works on the mission as it is, with a key of their own that you never see. They cannot change it, add people or answer what its agents ask."
        dismissible={!busy}
        hint={WAITING.recorded}
        testId="add-people-dialog"
        footer={
          <>
            <Button
              type="button"
              variant="primary"
              loading={busy}
              disabled={busy || candidate === ''}
              onClick={() => void addTeammate()}
            >
              Add to the mission
            </Button>
            <Button type="button" variant="ghost" onClick={close} disabled={busy}>
              {ACTIONS.cancel}
            </Button>
          </>
        }
      >
        {team.candidates.length === 0 ? (
          <p>
            Everyone who signed in to this gateway is already on the mission. A person appears here
            once they have signed in.
          </p>
        ) : (
          <Field label="Teammate" htmlFor="mission-teammate" error={error}>
            <Select
              id="mission-teammate"
              value={candidate}
              onChange={(event) => setCandidate(event.target.value)}
              data-testid="member-candidate"
            >
              <option value="">Choose a person…</option>
              {team.candidates.map((user) => (
                <option key={user.id} value={user.email}>
                  {user.email}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </Dialog>

      <Dialog
        open={act?.kind === 'machine-key'}
        onClose={close}
        title={ACTIONS.newMachineKey}
        description="For CI or a shared machine that has no account. Its calls are recorded under the name you give it. The key is shown once, to you: hand it to the machine."
        dismissible={!busy}
        hint={WAITING.recorded}
        testId="machine-key-dialog"
        footer={
          <>
            <Button
              type="button"
              variant="primary"
              loading={busy}
              disabled={busy || !team.issuable || machineName === ''}
              onClick={() => {
                void createMachineKey(machineName).then((made) => {
                  if (made) setKeyName('');
                });
              }}
            >
              Create the key
            </Button>
            <Button type="button" variant="ghost" onClick={close} disabled={busy}>
              {ACTIONS.cancel}
            </Button>
          </>
        }
      >
        <Field
          label="Name"
          htmlFor="mission-machine-key"
          shape={`up to ${TOKEN_NAME_MAX_LENGTH} characters`}
          hint={team.issuable ? TOKEN_NAME_RULE : MISSION_WORDS.notServing}
          error={error}
        >
          <Input
            id="mission-machine-key"
            value={keyName}
            onChange={(event) => setKeyName(event.target.value)}
            placeholder="CI runner"
            maxLength={TOKEN_NAME_MAX_LENGTH}
            autoComplete="off"
            data-testid="named-token-name"
          />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={act?.kind === 'replace-mine'}
        title="Replace your key?"
        consequence={
          <>
            You get a new key, shown once. <strong>Your current key stops working at once</strong>:
            an agent that uses it is refused from its next call, until you give it the new one.
            Nothing else changes: same permissions, same limits, same people.
            {others > 0 &&
              ` The ${others === 1 ? 'other key keeps' : `${others} other keys keep`} working.`}
          </>
        }
        confirmLabel={ACTIONS.replaceKey}
        busy={busy}
        error={error}
        hint={WAITING.recorded}
        onConfirm={() => void replaceMine()}
        onCancel={close}
        testId="replace-key-dialog"
      />

      <ConfirmDialog
        open={act?.kind === 'replace-machine'}
        title={
          act?.kind === 'replace-machine'
            ? `Replace the machine key ${act.token.holder.label}?`
            : ''
        }
        consequence={
          <>
            You get a new key of the same name, shown once.{' '}
            <strong>The current key stops working at once</strong>: the machine that uses it is
            refused from its next call, until you give it the new one. The keys of people keep
            working.
          </>
        }
        confirmLabel={ACTIONS.replaceKey}
        busy={busy}
        error={error}
        hint={WAITING.recorded}
        onConfirm={() => {
          if (act?.kind === 'replace-machine') void replaceMachine(act.token);
        }}
        onCancel={close}
        testId="replace-key-dialog"
      />

      {act?.kind === 'revoke-key' && (
        <DangerConfirm
          title={act.token.mine ? 'Revoke your key?' : `Revoke ${keyLabel(act.token, true)}?`}
          body={
            <>
              The key stops working at once: every call made with it is refused. The mission and the
              other keys do not change.{' '}
              {act.token.holder.kind === 'member'
                ? act.token.mine
                  ? 'You can generate a new key afterwards.'
                  : 'The person stays on the mission and can generate a new key.'
                : 'A machine key cannot be brought back: create a new one for the machine.'}
            </>
          }
          phrase={act.token.holder.label}
          confirmLabel={act.token.mine ? MISSION_ACTIONS.revokeMyKey : 'Revoke the key'}
          busy={busy}
          error={error}
          onCancel={close}
          onConfirm={() => void revokeKey(act.token)}
        />
      )}

      {act?.kind === 'remove-teammate' && (
        <DangerConfirm
          title={`Remove ${act.email} from the mission?`}
          body="Their key stops working at once, and they no longer see this mission. What they did stays in the activity. You can add them again later; they will then generate a new key."
          phrase={act.email}
          confirmLabel="Remove from the mission"
          busy={busy}
          error={error}
          onCancel={close}
          onConfirm={() => void removeTeammate(act.userId, act.email)}
        />
      )}

      {act?.kind === 'leave' && (
        <DangerConfirm
          title="Leave this mission?"
          body={
            <>
              {team.my_token
                ? 'Your key stops working at once: an agent that uses it is refused from its next call. '
                : ''}
              You no longer see this mission. What you did stays in its activity. Only its creator
              can add you again; you would then generate a new key.
            </>
          }
          phrase={mission.name}
          confirmLabel={MISSION_ACTIONS.leave}
          busy={busy}
          error={error}
          onCancel={close}
          onConfirm={() => void leave()}
        />
      )}

      {act?.kind === 'stop' && (
        <DangerConfirm
          title="Stop this mission?"
          body={
            <>
              Every key of the mission stops working at once
              {team.tokens.length > 1 ? ` — all ${team.tokens.length} of them` : ''}: each call is
              refused from now on. This cannot be undone. To continue the work, duplicate the
              mission: the copy gets its own key.
            </>
          }
          phrase={mission.name}
          confirmLabel={MISSION_ACTIONS.stop}
          busy={busy}
          error={error}
          onCancel={close}
          onConfirm={() => void stop()}
        />
      )}

      {revealed && (
        <RevealDialog
          revealed={revealed}
          onDone={() => {
            setRevealed(null);
            router.refresh();
          }}
        />
      )}
      {error && act === null && !revealed && (
        <p role="alert" data-testid="mission-error">
          {error}
        </p>
      )}
    </ActsContext.Provider>
  );
}

/** "Carol’s key", "the machine key CI runner". */
function keyLabel(token: TeamTokenView, lower = false): string {
  const text =
    token.holder.kind === 'member'
      ? `${possessive(token.holder.label)} key`
      : `the ${KEY_WORDS.machineKey} ${token.holder.label}`;
  return lower ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** A button of the page header that opens one of the dialogs. */
export function ActButton({
  act,
  children,
  variant = 'secondary',
}: {
  act: 'kit' | 'add-people' | 'machine-key';
  children: React.ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  const acts = useMissionActs();
  return (
    <Button type="button" variant={variant} onClick={() => acts.open({ kind: act })}>
      {children}
    </Button>
  );
}

/** A teammate's (or a creator's) first key on the mission: the page's primary action then. */
export function GenerateKeyButton() {
  const acts = useMissionActs();
  return (
    <Button type="button" variant="primary" loading={acts.busy} onClick={acts.generateMine}>
      {MISSION_ACTIONS.generateKey}
    </Button>
  );
}

/** The rest, behind "···": each item is there only when the server would take the act. */
export function MissionMenu({
  missionId,
  duplicable,
  stoppable,
}: {
  missionId: string;
  /** The reader created the mission: a copy of it is theirs to make. */
  duplicable: boolean;
  stoppable: boolean;
}) {
  const acts = useMissionActs();
  const { team } = acts;
  const isCreator = team.role === 'creator';
  const mine = team.my_token;
  return (
    <MoreMenu label="More actions" testId="mission-menu">
      <MenuItem href={`${ROUTES.missions}/${missionId}/session`}>
        {MISSION_ACTIONS.activity}
      </MenuItem>
      {isCreator && team.issuable && (
        <MenuItem onSelect={() => acts.open({ kind: 'machine-key' })}>
          {ACTIONS.newMachineKey}
        </MenuItem>
      )}
      {team.issuable && mine && (
        <MenuItem onSelect={() => acts.open({ kind: 'replace-mine' })}>Replace my key</MenuItem>
      )}
      {team.issuable && !mine && (
        <MenuItem onSelect={acts.generateMine}>{MISSION_ACTIONS.generateKey}</MenuItem>
      )}
      {duplicable && (
        <MenuItem href={`${ROUTES.newMission}?from=${encodeURIComponent(missionId)}`}>
          {MISSION_ACTIONS.duplicate}
        </MenuItem>
      )}
      {mine && (
        <MenuItem danger onSelect={() => acts.open({ kind: 'revoke-key', token: mine })}>
          {MISSION_ACTIONS.revokeMyKey}
        </MenuItem>
      )}
      {!isCreator && (
        <MenuItem danger onSelect={() => acts.open({ kind: 'leave' })}>
          {MISSION_ACTIONS.leave}
        </MenuItem>
      )}
      {stoppable && (
        <MenuItem danger onSelect={() => acts.open({ kind: 'stop' })}>
          {MISSION_ACTIONS.stop}
        </MenuItem>
      )}
    </MoreMenu>
  );
}
