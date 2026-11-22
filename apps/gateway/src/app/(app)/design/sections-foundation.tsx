'use client';

/**
 * Gallery, part one: the tokens, the frame of a page, buttons, marks of
 * state, and the marks of who and what.
 */
import {
  AgentLabel,
  Avatar,
  AvatarStack,
  Button,
  ButtonLink,
  Dot,
  EnvTag,
  GateMark,
  Hint,
  KeyHolder,
  KeyMark,
  KeyValue,
  MenuItem,
  Mono,
  MoreMenu,
  PageHeader,
  SectionHeading,
  ServiceMark,
  RowChip,
  Stats,
  StatusMark,
  SubNav,
  SubNavFrame,
  SummaryLine,
  Tag,
} from '@/components/ui';
import { ACTIONS, DOC_PAGES, MISSION_ACTIONS, qualifiers, ROLE_WORDS } from '@/lib/vocabulary';

import styles from './design.styles';
import { type GalleryIcons, GallerySection, Line, Pile, Specimen } from './specimen';

const COLOURS: readonly { token: string; use: string }[] = [
  { token: '--background', use: 'the page: plan paper' },
  { token: '--sidebar', use: 'side navigation, group rows' },
  { token: '--card', use: 'controls, dialogs, the one filled box' },
  { token: '--muted', use: 'quiet fills: inline code, tags' },
  { token: '--accent', use: 'a row under the pointer, the current entry' },
  { token: '--border', use: 'hairlines' },
  { token: '--border-strong', use: 'card edge, control borders' },
  { token: '--foreground', use: 'text' },
  { token: '--muted-foreground', use: 'secondary text, ledes, hints' },
  { token: '--faint', use: 'placeholders only' },
  { token: '--primary', use: 'the primary action, links, focus' },
  { token: '--primary-soft', use: 'where to go next, a selected row' },
  { token: '--approval-bg', use: 'what waits for you: the one filled box' },
  { token: '--refused-fg', use: 'refused, stopped, limit reached' },
  { token: '--refused-bg', use: 'a refused row' },
  { token: '--allowed-fg', use: 'checklist ticks only' },
  { token: '--row-1-bg', use: 'Harmless' },
  { token: '--row-2-bg', use: 'Worth a look' },
  { token: '--row-3-bg', use: 'Repairable, at a price' },
  { token: '--row-4-bg', use: 'Cannot be repaired' },
  { token: '--code', use: 'code blocks' },
];

const TYPE: readonly { token: string; size: string; use: string; strong?: boolean }[] = [
  { token: '--text-title', size: '20 px', use: 'Ship the billing page', strong: true },
  {
    token: '--text-body',
    size: '14 px',
    use: 'Body text, and section headings in the strong weight',
  },
  { token: '--text-small', size: '13 px', use: 'Rows, tables, controls, ledes' },
  { token: '--text-caption', size: '12 px', use: 'Captions, chips, table heads, ids' },
];

const SPACES = [4, 8, 12, 16, 20, 24, 32, 40, 48] as const;
/** Tailwind's spacing step (`--spacing`, 4 px): `gap-1` … `gap-12`. */
const SPACE_TOKEN: Readonly<Record<number, string>> = Object.fromEntries(
  [4, 8, 12, 16, 20, 24, 32, 40, 48].map((px) => [px, `--spacing × ${px / 4}`]),
);

const RADII = ['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl'] as const;

export function TokenSections() {
  return (
    <>
      <GallerySection
        id="colour"
        title="Colour"
        rule="Ink on paper, one blue accent for the primary action, links and what waits for you, and status colour only where a status differs from normal: red is refused or stopped, never orange or yellow. The four rows of risk are light pills, green to deep plum. Green ticks appear on checklists."
      >
        <Specimen name="Palette">
          {() => (
            <div className={styles.swatches}>
              {COLOURS.map(({ token, use }) => (
                <div key={token} className={styles.swatch}>
                  <span className={styles.chip} style={{ background: `var(${token})` }} />
                  <span className={styles.swatchName}>{token}</span>
                  <span className={styles.swatchUse}>{use}</span>
                </div>
              ))}
            </div>
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="type"
        title="Type"
        rule="Four sizes and two weights. Sentence case everywhere; no uppercase tracked label. Contrast comes from weight and ink before size."
      >
        <Specimen name="Scale">
          {() => (
            <div>
              {TYPE.map(({ token, size, use, strong }) => (
                <div key={token} className={styles.typeRow}>
                  <span className={styles.typeName}>
                    {token} · {size}
                  </span>
                  <span
                    style={{
                      fontSize: `var(${token})`,
                      fontWeight: strong ? 600 : 400,
                    }}
                  >
                    {use}
                  </span>
                </div>
              ))}
              <div className={styles.typeRow}>
                <span className={styles.typeName}>font-semibold · 600</span>
                <span className="font-semibold">A name, a title, the current entry</span>
              </div>
              <div className={styles.typeRow}>
                <span className={styles.typeName}>--font-mono</span>
                <Mono>github.merge-protected · acme/web · vbn_live_XU2O…6uT</Mono>
              </div>
            </div>
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="space"
        title="Space, radius, hairlines"
        rule="Whitespace before borders: a region is separated by 36 px of air, a row by a hairline. A filled box is used once per page at most."
      >
        <Specimen name="Space scale" note="a 4 px base">
          {() => (
            <div className={styles.spaces}>
              {SPACES.map((px) => (
                <div key={px} className={styles.space}>
                  <span className={styles.spaceBox} style={{ width: px, height: px }} />
                  {SPACE_TOKEN[px]}
                </div>
              ))}
            </div>
          )}
        </Specimen>
        <Specimen name="Radius">
          {() => (
            <div className={styles.spaces}>
              {RADII.map((token) => (
                <div key={token} className={styles.space}>
                  <span className={styles.radius} style={{ borderRadius: `var(${token})` }} />
                  {token}
                </div>
              ))}
            </div>
          )}
        </Specimen>
      </GallerySection>
    </>
  );
}

export function PageFrameSections({ icons }: { icons: GalleryIcons }) {
  return (
    <>
      <GallerySection
        id="page-header"
        title="Page header"
        rule="Where one is, the title and its (i) to the page of the docs, one sentence of lede at most, one primary action and at most two secondary ones; the rest goes behind “···”."
      >
        <Specimen name="Title and lede">
          {() => (
            <PageHeader
              level={2}
              title="Accounts"
              lede="A cloud account connected once; agents reach it only through a mission key."
              doc={DOC_PAGES.accounts}
              primary={<Button variant="primary">{ACTIONS.connectAccount}</Button>}
            />
          )}
        </Specimen>
        <Specimen
          name="An object"
          note="crumbs, a mark, the exception beside the title, two secondary actions"
        >
          {() => (
            <PageHeader
              level={2}
              crumbs={[
                { label: 'Missions', href: '#page-header' },
                { label: 'Nightly dependency audit' },
              ]}
              title="Nightly dependency audit"
              status={<StatusMark tone="bad">Limit reached</StatusMark>}
              lede="Created by you on 10 Oct · GitHub acme/app, acme/web · limits reset every day · expires 12 Nov"
              secondary={[
                <Button key="kit">{ACTIONS.setupKit}</Button>,
                <Button key="edit">{ACTIONS.editPermissions}</Button>,
              ]}
              primary={<Button variant="primary">{ACTIONS.raise}</Button>}
              more={
                <MoreMenu label="More actions">
                  <MenuItem>{MISSION_ACTIONS.duplicate}</MenuItem>
                </MoreMenu>
              }
            />
          )}
        </Specimen>
        <Specimen name="A service account" note="the mark of the service before the title">
          {() => (
            <PageHeader
              level={2}
              crumbs={[{ label: 'Accounts', href: '#page-header' }, { label: 'GitHub · acme' }]}
              mark={<ServiceMark name="GitHub" icon={icons.github} size="lg" />}
              title="GitHub · acme"
              lede="GitHub App on the acme organisation · owned by the Platform team · checked 2 min ago"
              primary={<Button variant="primary">{ACTIONS.giveAccess}</Button>}
            />
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="section"
        title="Section heading and facts"
        rule="A region is a heading, an optional count and one short note on the right. Counts that lead elsewhere go on a summary line: overview first, details on demand."
      >
        <Specimen name="Heading" note="count and note">
          {() => (
            <Pile>
              <SectionHeading
                title="Waiting for you"
                count={2}
                note="Only you can answer: you created these missions."
              />
              <SectionHeading
                title="Running now"
                count={4}
                note={<a href="#section">All 7 missions</a>}
              />
              <SectionHeading title="Reads" level={3} />
            </Pile>
          )}
        </Specimen>
        <Specimen name="Summary line">
          {() => (
            <SummaryLine
              items={[
                { label: '1,212 calls today' },
                { label: '3 refused in the last hour', href: '#section' },
                { label: '3 accounts, 1 needs its owner', href: '#section' },
              ]}
            />
          )}
        </Specimen>
        <Specimen name="Key and value">
          {() => (
            <KeyValue
              items={[
                { term: 'Rule', value: 'everyone in the group vaubaan-admins' },
                { term: 'Today', value: 'Alice Chen (you) · Dan Kim' },
                { term: 'Tool', value: <Mono>supabase.apply_migration</Mono> },
              ]}
            />
          )}
        </Specimen>
        <Specimen
          name="Stats"
          note="the detailed views only; a figure is coloured when it is the exception"
        >
          {() => (
            <Stats
              items={[
                { label: 'Calls today', value: '612', note: '3 refused' },
                { label: 'Busiest limit', value: '62%', note: 'branch writes', tone: 'warn' },
                { label: 'Refused', value: '7', tone: 'bad' },
                { label: 'Keys', value: '3', note: '2 people · 1 machine' },
              ]}
            />
          )}
        </Specimen>
        <Specimen name="Hint" note="what is not shown, and where it is">
          {() => (
            <Hint>
              Not running: Migration dry-run expired 10 Oct. <a href="#section">Earlier</a>
            </Hint>
          )}
        </Specimen>
        <Specimen
          name="Local navigation"
          note="Settings, the Reference: a short column beside the content"
        >
          {(theme) => (
            <SubNavFrame
              nav={
                <SubNav
                  label={`Example sections (${theme})`}
                  groups={[
                    {
                      label: 'You',
                      items: [{ label: 'Connected apps', href: '#section', current: false }],
                    },
                    {
                      label: 'Administration',
                      items: [
                        { label: 'Setup', href: '#section', current: true },
                        { label: 'People and teams', href: '#section', current: false },
                        {
                          label: 'GitHub',
                          href: '#section',
                          current: false,
                          lead: <ServiceMark name="GitHub" icon={icons.github} />,
                        },
                      ],
                    },
                  ]}
                />
              }
            >
              <SectionHeading title="Setup" note="3 of 5 done" />
              <Hint>The content of the page sits here.</Hint>
            </SubNavFrame>
          )}
        </Specimen>
      </GallerySection>
    </>
  );
}

export function ButtonSections() {
  return (
    <GallerySection
      id="buttons"
      title="Buttons"
      rule="One primary action per screen. Secondary actions are outlined, the rest are ghosts; a destructive action is red words on the neutral surface. A control that navigates is a link with the same look."
    >
      <Specimen name="Variants">
        {() => (
          <Line>
            <Button variant="primary">{ACTIONS.approve}</Button>
            <Button>{ACTIONS.refuse}</Button>
            <Button variant="ghost">{ACTIONS.details}</Button>
            <Button variant="danger">{ACTIONS.revokeKey}</Button>
            <ButtonLink href="#buttons">{ACTIONS.newMission}</ButtonLink>
          </Line>
        )}
      </Specimen>
      <Specimen name="Sizes" note="26, 30 and 36 px; the two small ones answer on 32 px">
        {() => (
          <Line>
            <Button size="sm">{ACTIONS.replaceKey}</Button>
            <Button size="md">{ACTIONS.replaceKey}</Button>
            <Button size="lg" variant="primary">
              {ACTIONS.createMission}
            </Button>
          </Line>
        )}
      </Specimen>
      <Specimen name="Disabled and working">
        {() => (
          <Line>
            <Button variant="primary" disabled>
              {ACTIONS.createMission}
            </Button>
            <Button disabled>{ACTIONS.refuse}</Button>
            <Button variant="primary" loading>
              Working…
            </Button>
            <Button variant="danger" disabled>
              {ACTIONS.revokeKey}
            </Button>
          </Line>
        )}
      </Specimen>
    </GallerySection>
  );
}

export function MarkSections({ icons }: { icons: GalleryIcons }) {
  return (
    <>
      <GallerySection
        id="status"
        title="Status marks"
        rule="The exception is shown, not the rule: nothing is ever labelled “active” or “allowed” in colour. A mark always carries its word."
      >
        <Specimen name="Status mark" note="a pill with a dot">
          {() => (
            <Line>
              <StatusMark tone="bad">Limit reached</StatusMark>
              <StatusMark tone="bad">Needs reconnecting</StatusMark>
              <StatusMark tone="warn">Waiting for you</StatusMark>
              <StatusMark tone="warn" dot={false}>
                2
              </StatusMark>
              <StatusMark>expired 9 Oct</StatusMark>
              <StatusMark tone="info">new</StatusMark>
              <StatusMark tone="ok">done</StatusMark>
            </Line>
          )}
        </Specimen>
        <Specimen name="Dot" note="beside a word that already says the state">
          {() => (
            <Line>
              <span>
                <Dot tone="ok" /> 8 run freely
              </span>
              <span>
                <Dot tone="warn" /> 2 ask you first
              </span>
              <span>
                <Dot /> 5 not included
              </span>
              <span>
                <Dot tone="bad" label="Needs reconnecting" />
              </span>
            </Line>
          )}
        </Specimen>
        <Specimen name="Tags" note="a fact that is not a state: an environment, a short code">
          {() => (
            <Line>
              <EnvTag env="prod" />
              <EnvTag env="live" />
              <EnvTag env="staging" />
              <EnvTag env="test" />
              <EnvTag env={null} />
              <Tag>read only</Tag>
              <Tag mono>GH</Tag>
            </Line>
          )}
        </Specimen>
        <Specimen name="Row and gate" note="the row in words, its reason in quiet type">
          {() => (
            <Line>
              <RowChip row={1} />
              <RowChip row={2} reason="personal-data" />
              <RowChip row={3} reason="costly-to-undo" />
              <RowChip row={4} reason="irreversible" />
              <GateMark gate="free" />
              <GateMark gate="ask" />
              <GateMark gate="off" />
              <GateMark gate="ask">asked you</GateMark>
            </Line>
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="who"
        title="People, machine keys, services, ids"
        rule="A person is a round mark, a machine key a dashed square: the shape says which. Roles are said in words after the name. An id is printed in mono, as the protocol spells it."
      >
        <Specimen
          name="Avatar"
          note="three sizes; a hue from the name; a machine key; a team; someone gone"
        >
          {() => (
            <Line>
              <Avatar name="Alice Chen" size="xs" />
              <Avatar name="Alice Chen" />
              <Avatar name="Alice Chen" size="md" />
              <Avatar name="Bob Martin" />
              <Avatar name="Carol Diaz" />
              <Avatar name="Dan Kim" />
              <Avatar name="github-actions" kind="machine" initials="CI" />
              <Avatar name="nightly" kind="machine" size="md" initials="CI" />
              <Avatar name="Platform team" kind="team" />
              <Avatar name="Eve Novak" muted />
            </Line>
          )}
        </Specimen>
        <Specimen name="Stack">
          {() => (
            <Line>
              <AvatarStack
                members={[
                  { name: 'Alice Chen' },
                  { name: 'Carol Diaz' },
                  { name: 'github-actions', kind: 'machine' },
                ]}
              />
              <AvatarStack
                max={3}
                members={[
                  { name: 'Alice Chen' },
                  { name: 'Bob Martin' },
                  { name: 'Carol Diaz' },
                  { name: 'Dan Kim' },
                  { name: 'Eve Novak' },
                ]}
              />
            </Line>
          )}
        </Specimen>
        <Specimen name="Key holder" note="the name, then what they are here, in words">
          {() => (
            <Pile>
              <KeyHolder
                name="Alice Chen"
                qualifier={qualifiers([ROLE_WORDS.you, ROLE_WORDS.creator])}
              />
              <KeyHolder name="Carol Diaz" qualifier={qualifiers(['added 13 Oct'])} />
              <KeyHolder
                name="github-actions"
                kind="machine"
                qualifier={qualifiers(['machine key'])}
              />
              <KeyHolder
                name="Platform team"
                kind="team"
                qualifier={qualifiers(['owner', 'Bob, you, Dan'])}
              />
              <KeyHolder
                name="Eve Novak"
                muted
                qualifier={qualifiers(['no sign-in since 20 Sep'])}
              />
            </Pile>
          )}
        </Specimen>
        <Specimen
          name="Service, key, agent, id"
          note="the icon a plugin declares, in its brand colour on the neutral fill (a near-black brand takes the ink in the dark theme); two letters on a hue when it declares none"
        >
          {() => (
            <Line>
              <ServiceMark name="GitHub" icon={icons.github} />
              <ServiceMark name="Supabase" icon={icons.supabase} />
              <ServiceMark name="Stripe" icon={icons.stripe} />
              <ServiceMark name="Upstash Redis" icon={icons['upstash-redis']} />
              <ServiceMark name="Acme Cloud" />
              <ServiceMark name="GitHub" icon={icons.github} size="lg" />
              <ServiceMark name="Acme Cloud" size="lg" />
              <KeyMark>vbn_live_XU2O…6uT</KeyMark>
              <AgentLabel>claude-code</AgentLabel>
              <Mono>github.merge-protected</Mono>
              <Mono quiet>github.read-code</Mono>
              <Mono href="#who">acme/web · feature/billing-ui</Mono>
            </Line>
          )}
        </Specimen>
      </GallerySection>
    </>
  );
}
