'use client';

/**
 * Gallery, part two: lists and tables, the meter, permissions, what a mission
 * allows, and what waits for the person.
 */
import { useState } from 'react';

import {
  AgentLabel,
  AllowSummary,
  AnswerList,
  AnswerRow,
  Avatar,
  AvatarStack,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  DataTable,
  DetailOnly,
  DetailScope,
  DetailToggle,
  EnvTag,
  GateMark,
  Hint,
  Input,
  KeyHolder,
  KeyMark,
  KeyValue,
  Meter,
  Mono,
  PermissionGroup,
  PermissionRow,
  PermissionTable,
  Row,
  Rows,
  SectionHeading,
  ServiceMark,
  StatusMark,
  Switch,
  type Column,
} from '@/components/ui';
import {
  ACTIONS,
  asksFirst,
  ASKED_FIRST,
  qualifiers,
  reachedLimit,
  roomLeft,
  waitingFor,
  WAITING,
} from '@/lib/vocabulary';

import styles from './design.module.css';
import { GallerySection, Pile, Specimen } from './specimen';

interface Person {
  readonly id: string;
  readonly name: string;
  readonly kind: 'person' | 'machine';
  readonly role: string;
  readonly qualifier: string;
  readonly key: string;
  readonly agent: string;
  readonly calls: number;
  readonly last: string;
}

const PEOPLE: readonly Person[] = [
  {
    id: 'alice',
    name: 'Alice Chen',
    kind: 'person',
    role: 'Creator',
    qualifier: qualifiers(['you', 'creator']),
    key: 'vbn_live_XU2O…6uT',
    agent: 'claude-code',
    calls: 284,
    last: '2 min',
  },
  {
    id: 'carol',
    name: 'Carol Diaz',
    kind: 'person',
    role: 'Teammate',
    qualifier: qualifiers(['added 13 Oct']),
    key: 'vbn_live_9hRw…Qm2',
    agent: 'codex',
    calls: 211,
    last: '1 min',
  },
  {
    id: 'ci',
    name: 'github-actions',
    kind: 'machine',
    role: 'Machine key',
    qualifier: qualifiers(['machine key']),
    key: 'vbn_live_c4Kd…Ls8',
    agent: 'github-actions',
    calls: 117,
    last: '14 min',
  },
];

const PEOPLE_COLUMNS: readonly Column<Person>[] = [
  {
    id: 'holder',
    header: 'Holder',
    cell: (p) => <KeyHolder name={p.name} kind={p.kind} qualifier={p.qualifier} />,
  },
  { id: 'role', header: 'Role', cell: (p) => p.role, detail: true, nowrap: true },
  { id: 'key', header: 'Key', cell: (p) => <KeyMark>{p.key}</KeyMark>, detail: true },
  { id: 'agent', header: 'Agent', cell: (p) => <AgentLabel>{p.agent}</AgentLabel> },
  {
    id: 'calls',
    header: 'Calls today',
    cell: (p) => p.calls.toLocaleString('en-US'),
    align: 'right',
  },
  { id: 'last', header: 'Last call', cell: (p) => p.last, align: 'right', nowrap: true },
];

interface Call {
  readonly id: string;
  readonly time: string;
  readonly who: string;
  readonly action: string;
  readonly on: string;
  readonly permission: string;
  readonly decision: 'allowed' | 'refused' | 'asked' | 'change';
  readonly reason?: string;
}

const CALLS: readonly Call[] = [
  {
    id: '1',
    time: '11:02:41',
    who: 'Carol Diaz',
    action: 'push_files',
    on: 'acme/web · feature/billing-ui',
    permission: 'Push many files',
    decision: 'allowed',
  },
  {
    id: '2',
    time: '10:58:07',
    who: 'Carol Diaz',
    action: 'merge_pull_request',
    on: 'acme/web',
    permission: 'Write on main',
    decision: 'asked',
  },
  {
    id: '3',
    time: '10:22:03',
    who: 'Carol Diaz',
    action: 'get_file_contents',
    on: 'acme/infra',
    permission: '—',
    decision: 'refused',
    reason: 'repository not in this mission',
  },
  {
    id: '4',
    time: '08:09:30',
    who: 'Carol Diaz',
    action: 'generated her key',
    on: 'Ship the billing page',
    permission: '—',
    decision: 'change',
  },
];

const CALL_COLUMNS: readonly Column<Call>[] = [
  { id: 'time', header: 'Time', cell: (c) => c.time, nowrap: true },
  { id: 'who', header: 'Who', cell: (c) => <KeyHolder name={c.who} size="xs" />, nowrap: true },
  { id: 'action', header: 'Action', cell: (c) => <Mono>{c.action}</Mono> },
  { id: 'on', header: 'On', cell: (c) => <Mono>{c.on}</Mono> },
  { id: 'permission', header: 'Permission', cell: (c) => c.permission, nowrap: true },
  {
    id: 'decision',
    header: 'Decision',
    nowrap: true,
    cell: (c) =>
      c.decision === 'asked' ? (
        <GateMark gate="ask">asked you</GateMark>
      ) : c.decision === 'refused' ? (
        <>
          <span style={{ color: 'var(--bad)' }}>refused</span> · {c.reason}
        </>
      ) : (
        c.decision
      ),
  },
];

export function ListSections() {
  return (
    <>
      <GallerySection
        id="rows"
        title="Quiet list rows"
        rule="A handful of objects of the same kind: a title, one line of facts, and at the end what one can do or the one figure that matters. Hairlines, no card."
      >
        <Specimen
          name="Missions running"
          note="avatars, the one meter near its limit, the last call"
        >
          {() => (
            <Rows label="Missions running">
              <Row
                title="Ship the billing page"
                href="#rows"
                description="GitHub · Supabase · you, Carol, github-actions"
                aside={
                  <>
                    <AvatarStack
                      members={[
                        { name: 'Alice Chen' },
                        { name: 'Carol Diaz' },
                        { name: 'github-actions', kind: 'machine' },
                      ]}
                    />
                    <Meter used={1860} limit={3000} format="percent" label="branch writes" />
                  </>
                }
                end="2 min"
              />
              <Row
                title="Release 2.4 hotfix"
                href="#rows"
                description="GitHub · you"
                aside={
                  <>
                    <AvatarStack members={[{ name: 'Alice Chen' }]} />
                    <Meter used={58} limit={10000} />
                  </>
                }
                end="14 min"
              />
              <Row
                title="Nightly dependency audit"
                href="#rows"
                description="GitHub · machine key nightly"
                aside={<StatusMark tone="bad">Limit reached</StatusMark>}
                end="1 h"
              />
              <Row
                muted
                title="Docs refresh"
                description="Carol · acme/web · expired 9 Oct"
                end="4 d"
              />
            </Rows>
          )}
        </Specimen>
        <Specimen name="With a mark and an action">
          {() => (
            <Rows label="Accounts">
              <Row
                lead={<ServiceMark name="GitHub" />}
                title="GitHub · acme"
                description="4 repositories · 5 missions · you own it with Platform"
                end={
                  <ButtonLink href="#rows" size="sm">
                    Open
                  </ButtonLink>
                }
              />
              <Row
                lead={<ServiceMark name="Stripe" />}
                title="Stripe · Acme payments"
                description="Needs reconnecting · Bob owns it"
                aside={<StatusMark tone="bad">Needs reconnecting</StatusMark>}
              />
            </Rows>
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="table"
        title="Data table"
        rule="Five columns by default; the others are marked as detail and appear on demand, per page, remembered. Row actions show on hover and on keyboard focus. A tint marks the exception row, and the row says why in words."
      >
        <Specimen
          name="Five columns, two on demand"
          note="“Show details” adds Role and Key; the choice is remembered"
        >
          {(theme) => (
            <DetailScope id={`design:people:${theme}`}>
              <SectionHeading
                title="People and keys"
                count={PEOPLE.length}
                note={<DetailToggle />}
              />
              <DataTable
                caption="People and keys of the mission"
                columns={PEOPLE_COLUMNS}
                rows={PEOPLE}
                rowKey={(p) => p.id}
                actions={(p) =>
                  p.kind === 'machine' ? (
                    <Button size="sm" variant="danger">
                      {ACTIONS.revokeKey}
                    </Button>
                  ) : (
                    <Button size="sm">{ACTIONS.replaceKey}</Button>
                  )
                }
              />
              <DetailOnly>
                <Hint>
                  One key each, same permissions and limits; every call is signed by its key.
                </Hint>
              </DetailOnly>
            </DetailScope>
          )}
        </Specimen>
        <Specimen
          name="Exception rows and a row detail"
          note="the activity record: six columns, the documented exception"
        >
          {() => (
            <DataTable
              caption="Activity"
              density="tight"
              columnBudget={6}
              columns={CALL_COLUMNS}
              rows={CALLS}
              rowKey={(c) => c.id}
              rowTone={(c) =>
                c.decision === 'refused'
                  ? 'bad'
                  : c.decision === 'asked'
                    ? 'warn'
                    : c.decision === 'change'
                      ? 'quiet'
                      : undefined
              }
              rowDetail={(c) =>
                c.id === '1' ? (
                  <KeyValue
                    items={[
                      { term: 'Mission', value: 'Ship the billing page · created by Alice Chen' },
                      { term: 'Key', value: <Mono>vbn_live_9hRw…Qm2</Mono> },
                      {
                        term: 'Arguments',
                        value: 'never stored · fingerprint sha256 a9f3 2c1e … c41e',
                      },
                    ]}
                  />
                ) : null
              }
            />
          )}
        </Specimen>
        <Specimen name="Grouped, without a head" note="a short list of a few objects needs no head">
          {() => (
            <DataTable
              caption="Who has access"
              headless
              columns={PEOPLE_COLUMNS.filter((column) => !column.detail).slice(0, 3)}
              groups={[
                { key: 'people', title: 'People', note: '2', rows: PEOPLE.slice(0, 2) },
                { key: 'machines', title: 'Machine keys', note: '1', rows: PEOPLE.slice(2) },
              ]}
              rowKey={(p) => p.id}
            />
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="meter"
        title="Meter"
        rule="Shown only near a limit: below the threshold a dash stands for it, so that a list shows one bar, the one that matters. The detailed view passes a threshold of zero."
      >
        <Specimen name="Far, near, reached" note="default threshold: 60% of the limit">
          {() => (
            <Pile>
              <Meter used={58} limit={10000} label="reads" />
              <Meter used={1860} limit={3000} label="branch writes" />
              <Meter used={5000} limit={5000} label="reads" />
            </Pile>
          )}
        </Specimen>
        <Specimen name="Always drawn, and as a share" note="threshold 0; format percent">
          {() => (
            <Pile>
              <Meter used={9} limit={500} threshold={0} />
              <Meter used={1860} limit={3000} format="percent" label="branch writes" />
              <Meter used={2104} limit={10000} threshold={0.2} label="reads" />
            </Pile>
          )}
        </Specimen>
      </GallerySection>
    </>
  );
}

function EditorSpecimen({ theme }: { theme: string }) {
  const [ask, setAsk] = useState(true);
  const [included, setIncluded] = useState(true);
  return (
    <PermissionTable variant="editor" caption={`Permissions on GitHub · acme (${theme})`}>
      <PermissionGroup title="Reads" note="look without changing anything">
        <PermissionRow
          label="Read code, branches, commits, files"
          id="github.read-code"
          severity="low"
          select={<Checkbox defaultChecked aria-label="Include: Read code" />}
          perDay={<Input size="sm" mono defaultValue="10,000" aria-label="Per day: Read code" />}
          perMinute={<Input size="sm" mono defaultValue="240" aria-label="Per minute: Read code" />}
          gate="free"
          gateControl={<Switch aria-label="Ask me first: Read code" />}
          why={{
            reason: 'Source may contain secrets committed by mistake.',
            tools: ['get_file_contents'],
          }}
        />
      </PermissionGroup>
      <PermissionGroup title="Protected branches, CI and tokens">
        <PermissionRow
          label="Modify a GitHub Actions workflow file"
          id="github.workflow-write-via-file"
          severity="high"
          included={included}
          select={
            <Checkbox
              checked={included}
              onChange={(event) => setIncluded(event.target.checked)}
              aria-label="Include: Modify a workflow file"
            />
          }
          perDay={<Input size="sm" mono defaultValue="50" aria-label="Per day: workflow file" />}
          perMinute={
            <Input size="sm" mono defaultValue="5" aria-label="Per minute: workflow file" />
          }
          gate={ask ? 'ask' : 'free'}
          gateControl={
            <Switch
              checked={ask}
              onChange={(event) => setAsk(event.target.checked)}
              aria-label="Ask me first: workflow file"
            />
          }
          defaultWhyOpen
          why={{
            reason:
              'The CI file defines what runs with the repository’s secrets; a modified workflow can leak them on the next push.',
            cells: {
              reversibility: 'costly',
              blast: 'account',
              data: 'secret',
              cost: 'free',
              visibility: 'internal',
              persistence: 'posture',
            },
            referenceHref: '#permission',
            tools: ['push_files', 'create_or_update_file'],
          }}
        />
        <PermissionRow
          label="Modify branch protection"
          id="github.branch-protection-write"
          severity="high"
          included={false}
          select={<Checkbox aria-label="Include: Modify branch protection" />}
          why={{ reason: 'Removes the guard on main itself.' }}
        />
      </PermissionGroup>
    </PermissionTable>
  );
}

export function PermissionSections() {
  return (
    <>
      <GallerySection
        id="permission"
        title="Permission row"
        rule="What an agent may do, in words; the id in mono under it; one severity word; limits per day and per minute; runs freely or ask me first; and why, one click away. The list is always explicit."
      >
        <Specimen
          name="Editor"
          note="tick to include; the limit and the gate appear; “why?” unfolds the six words"
        >
          {(theme) => <EditorSpecimen theme={theme} />}
        </Specimen>
        <Specimen name="Read" note="what a mission or a preset holds">
          {(theme) => (
            <PermissionTable variant="read" caption={`Permissions of the mission (${theme})`}>
              <PermissionGroup title="GitHub · acme" note="acme/app, acme/web">
                <PermissionRow
                  label="Open a pull request"
                  id="github.create-pr"
                  severity="low"
                  perDay={200}
                  perMinute={10}
                  gate="free"
                  why={{ reason: 'Visible to the team; nothing merges.' }}
                />
                <PermissionRow
                  label="Write on main, master, release-* (merge or direct commit)"
                  id="github.merge-protected"
                  severity="high"
                  perDay={50}
                  perMinute={5}
                  gate="ask"
                  why={{
                    reason: 'Public history, deploys may follow; undo is a revert, not a delete.',
                  }}
                />
              </PermissionGroup>
              <PermissionGroup title="Supabase · Acme" note="acme-staging">
                <PermissionRow
                  label="Apply a migration"
                  tag={<EnvTag env="staging" />}
                  id="supabase[staging].migration-write"
                  severity="medium"
                  perDay={500}
                  perMinute={30}
                  gate="free"
                />
              </PermissionGroup>
            </PermissionTable>
          )}
        </Specimen>
        <Specimen name="Usage" note="a mission, today: the meter is always drawn here">
          {(theme) => (
            <PermissionTable variant="usage" caption={`Permissions and usage (${theme})`}>
              <PermissionGroup title="GitHub · acme" note="7 used of 12">
                <PermissionRow
                  label="Create or modify branches under feature/*, fix/*, chore/*"
                  severity="low"
                  usage={<Meter used={1860} limit={3000} threshold={0} />}
                  perMinute={60}
                  gate="free"
                />
                <PermissionRow
                  label="Read code, branches, commits, files"
                  severity="low"
                  usage={<Meter used={5000} limit={5000} threshold={0} />}
                  perMinute={240}
                  gate="free"
                />
                <PermissionRow
                  label="Write on main, master, release-*"
                  severity="high"
                  usage={<Meter used={1} limit={50} threshold={0} />}
                  perMinute={5}
                  gate="ask"
                />
              </PermissionGroup>
            </PermissionTable>
          )}
        </Specimen>
        <Specimen name="Pick" note="the ceiling given with an access: tick, permission, severity">
          {(theme) => (
            <PermissionTable variant="pick" caption={`Give access to GitHub · acme (${theme})`}>
              <PermissionGroup
                title="Reads"
                note="2 of 2"
                select={<Checkbox defaultChecked aria-label="All reads" />}
              >
                <PermissionRow
                  label="Read code, branches, commits, files"
                  severity="low"
                  select={<Checkbox defaultChecked aria-label="Read code" />}
                />
                <PermissionRow
                  label="Read PRs, issues, releases, workflows"
                  severity="low"
                  select={<Checkbox defaultChecked aria-label="Read PRs" />}
                  why={{ reason: 'Metadata only; shows who works on what.' }}
                />
              </PermissionGroup>
              <PermissionGroup
                title="Releases and the rest"
                note="0 of 1"
                select={<Checkbox aria-label="All releases" />}
              >
                <PermissionRow
                  label="Create a release"
                  severity="medium"
                  included={false}
                  select={<Checkbox aria-label="Create a release" />}
                />
              </PermissionGroup>
            </PermissionTable>
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="allow"
        title="Can / Asks first / Cannot"
        rule="The summary of a mission, read before anything else. It never replaces the explicit list: it says how many permissions it sums up, and the list is one click away."
      >
        <Specimen name="A mission" note="with the one limit near its end">
          {() => (
            <AllowSummary
              can={
                <>
                  Read and search; branch under <b>feature/*</b>, push files, open PRs, comment;
                  migrate and write on <b>staging</b>. 22 permissions.
                </>
              }
              asks={
                <>
                  Merge to <b>main</b> · workflow files · push tokens · RLS policies. 4 permissions.
                </>
              }
              cannot={
                <>
                  Releases, branch protection, <b>acme/infra</b>, anything on <b>acme-prod</b>.
                </>
              }
              limits={
                <>
                  <Meter used={1860} limit={3000} /> branch writes, the only one near its limit ·
                  resets at 00:00 · <a href="#allow">All 26</a>
                </>
              }
            />
          )}
        </Specimen>
        <Specimen
          name="Someone else’s mission; a mission where nothing asks"
          note="the asking line names who is asked, and is left out when empty"
        >
          {() => (
            <Pile>
              <AllowSummary
                asksLabel={asksFirst('Alice')}
                can="Read code and metadata on acme/app. 2 permissions."
                asks="Merge to main. 1 permission."
                cannot="Everything else."
              />
              <AllowSummary
                can="Read code and metadata on acme/app. 2 permissions."
                cannot="Any write."
              />
            </Pile>
          )}
        </Specimen>
        <Specimen name="In the rail" note="compact, inside the one card of the page">
          {() => (
            <div className={styles.rail}>
              <Card>
                <CardHeader>
                  <CardTitle>What this mission will be able to do</CardTitle>
                </CardHeader>
                <CardBody>
                  <AllowSummary
                    compact
                    asksLabel="Asks you"
                    can="Read, branch under feature/*, push, open PRs, comment."
                    asks="Merge to main, workflow files, push tokens."
                    cannot="Releases, branch protection, the other 2 repositories."
                  />
                </CardBody>
                <CardFooter>
                  <Button variant="primary" size="lg">
                    {ACTIONS.createMission}
                  </Button>
                  <Button variant="ghost">{ACTIONS.cancel}</Button>
                </CardFooter>
              </Card>
            </div>
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="answer"
        title="Inline answer row"
        rule="What waits for the person, answerable where they see it: who, what exactly, where, how long ago — then Approve, Refuse or Raise on the same row. As the one filled box of a page when a mission waits for its creator."
      >
        <Specimen name="In a list" note="an approval, then a limit that was reached">
          {() => (
            <AnswerList label="Waiting for you">
              <AnswerRow
                who={<Avatar name="Carol Diaz" size="md" />}
                title={
                  <>
                    Merge pull request #418 into <Mono>main</Mono> on acme/web
                  </>
                }
                age="4 min"
                description={`Carol · codex on Ship the billing page · ${ASKED_FIRST} · ${roomLeft(49, 50)}`}
                answers={
                  <>
                    <Button variant="primary">{ACTIONS.approve}</Button>
                    <Button>{ACTIONS.refuse}</Button>
                    <Button variant="ghost">{ACTIONS.details}</Button>
                  </>
                }
              />
              <AnswerRow
                who={<Avatar name="nightly" kind="machine" size="md" initials="CI" />}
                title={reachedLimit('Nightly dependency audit')}
                age="1 h"
                description="Read code · 5,000 of 5,000 · machine key nightly is stopped until midnight or your answer"
                answers={
                  <>
                    <Button>{ACTIONS.raise}</Button>
                    <Button variant="ghost">{ACTIONS.details}</Button>
                  </>
                }
              />
            </AnswerList>
          )}
        </Specimen>
        <Specimen name="Boxed" note="the banner of a mission; for a teammate it has no button">
          {() => (
            <Pile>
              <AnswerRow
                boxed
                who={<Avatar name="Carol Diaz" size="md" />}
                title={
                  <>
                    Merge pull request #418 into <Mono>main</Mono> on acme/web · {waitingFor(null)}
                  </>
                }
                description={`Carol · codex · 4 min ago · ${roomLeft(49, 50)}`}
                answers={
                  <>
                    <Button variant="primary">{ACTIONS.approve}</Button>
                    <Button>{ACTIONS.refuse}</Button>
                    <Button variant="ghost">{ACTIONS.details}</Button>
                  </>
                }
              />
              <AnswerRow
                boxed
                who={<Avatar name="Carol Diaz" size="md" />}
                title={<>Merge pull request #418 into main · {waitingFor('Alice')}</>}
                description={`You asked 4 min ago · ${WAITING.recorded}`}
              />
            </Pile>
          )}
        </Specimen>
      </GallerySection>
    </>
  );
}
