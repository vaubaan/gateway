'use client';

/**
 * Gallery, part three: empty and first-run states, callouts, dialogs,
 * details on demand, filters, forms, code, toasts, and the primitives kept
 * for the pages written before the redesign.
 */
import { useState } from 'react';

import {
  Button,
  ButtonLink,
  Callout,
  CheckMark,
  Checkbox,
  Code,
  CodeBlock,
  CodeTone,
  ConfirmDialog,
  CopyButton,
  DangerConfirm,
  DialogPanel,
  Disclosure,
  EmptyState,
  Field,
  FilterChips,
  Hint,
  Input,
  Lede,
  ModelDiagram,
  OptionCard,
  Radio,
  Row,
  Rows,
  SearchField,
  Segmented,
  Select,
  Skeleton,
  StepMark,
  SummaryLine,
  Switch,
  TabList,
  TabPanel,
  Textarea,
  ToastCard,
  useToast,
} from '@/components/ui';
import { ACTIONS, WAITING } from '@/lib/vocabulary';

import styles from './design.module.css';
import { GallerySection, Line, Pile, Specimen } from './specimen';

export function StateSections() {
  return (
    <>
      <GallerySection
        id="empty"
        title="Empty and first-run states"
        rule="An empty page says what is the case and what comes next, in a sentence, with one action. A first run says what the product is, draws the model, and gives the steps."
      >
        <Specimen name="Nothing needs you" note="what a page becomes when nothing waits">
          {() => (
            <EmptyState
              title="Nothing needs you. 4 missions are running."
              links={
                <SummaryLine
                  centered
                  items={[
                    { label: 'Missions', href: '#empty' },
                    { label: 'Activity', href: '#empty' },
                    { label: 'Accounts', href: '#empty' },
                  ]}
                />
              }
            />
          )}
        </Specimen>
        <Specimen name="Nothing yet" note="one sentence and the one thing to do">
          {() => (
            <EmptyState
              title="No account is connected yet."
              action={
                <ButtonLink href="#empty" variant="primary">
                  {ACTIONS.connectAccount}
                </ButtonLink>
              }
            >
              Connect GitHub first, usually. You own it; give colleagues access to the part they
              need.
            </EmptyState>
          )}
        </Specimen>
        <Specimen name="First run" note="what the product is, the model, the steps">
          {() => (
            <>
              <Lede>
                Vaubaan lets AI agents use your company’s cloud accounts without ever holding a
                credential. A person connects an <b>account</b> once; a <b>mission</b> gives an
                agent a <b>key</b> that allows an explicit list of permissions, within daily limits,
                some only after a human yes.
              </Lede>
              <ModelDiagram
                label="How the gateway works"
                nodes={[
                  { name: 'Account', note: 'GitHub, Supabase, Stripe…' },
                  { name: 'Mission', note: 'permissions · limits · ask first' },
                  { name: 'Key', note: 'one per person or machine' },
                  { name: 'Agent', note: 'Claude Code, Codex, CI…' },
                  { name: 'Activity', note: 'every call, every change' },
                ]}
              />
              <Rows label="Get started">
                <Row
                  lead={<StepMark n={1} state="done" />}
                  title="An account you can use"
                  description="Bob gave you access to GitHub · acme (12 of 15 permissions)."
                />
                <Row
                  lead={<StepMark n={2} state="next" />}
                  title="Give an agent a mission"
                  description="Name it, pick the repositories, tick what it may do at a trust level, read the three-line summary, create."
                  end={
                    <ButtonLink href="#empty" size="sm" variant="primary">
                      {ACTIONS.newMission}
                    </ButtonLink>
                  }
                />
                <Row
                  lead={<StepMark n={3} state="later" />}
                  title="Paste the kit into your agent"
                  description="Three snippets that come with the key. Then watch it work here."
                />
              </Rows>
            </>
          )}
        </Specimen>
        <Specimen
          name="Setup checklist"
          note="done, partly done, to do — the one place green appears"
        >
          {() => (
            <Rows label="Setup">
              <Row
                lead={<CheckMark state="done" />}
                title="Sign-in through your identity provider"
                description="People and teams come from it. No password is stored here."
                end="done"
              />
              <Row
                lead={<CheckMark state="todo" />}
                title="OAuth clients"
                description="Gmail is not declared: nobody can connect a Gmail account until it is."
                end={<Button size="sm">Declare Gmail</Button>}
              />
              <Row
                lead={<CheckMark state="todo" />}
                title="Telemetry"
                description="Off until you decide; the exact payload is shown first."
                end={<Button size="sm">Review</Button>}
              />
            </Rows>
          )}
        </Specimen>
        <Specimen
          name="Skeleton"
          note="the shape of what is loading; reduced motion stops the breathing"
        >
          {() => (
            <div style={{ maxWidth: 520 }}>
              <Skeleton height="title" width="40%" />
              <Skeleton width="72%" label="" />
              <Skeleton height="row" label="" />
              <Skeleton height="row" label="" />
            </div>
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="callout"
        title="Callout"
        rule="A note that interrupts on purpose. One filled box per page at most, for the thing that needs the person; never a tinted paragraph of help. Done is said in the accent, never in green: green is for checklist ticks only."
      >
        <Specimen name="Tones">
          {() => (
            <Pile>
              <Callout title="Shown once">
                Lost it? Replace it from the mission page; the mission does not change.
              </Callout>
              <Callout tone="info" title="Shared with you">
                Alice added you. Generate your own key to work on it; Alice never sees it.
              </Callout>
              <Callout
                tone="warn"
                title="This account needs an owner"
                action={<Button size="sm">Name an owner</Button>}
              >
                Its missions keep running, but nobody can give access or reconnect it.
              </Callout>
              <Callout tone="bad" title="Needs reconnecting">
                Bob’s Stripe credential expired at 10:10; only an owner can reconnect it.
              </Callout>
              <Callout tone="ok">Connected. A mission can use it right away.</Callout>
            </Pile>
          )}
        </Specimen>
      </GallerySection>
    </>
  );
}

function ReplaceKeySpecimen({ theme }: { theme: string }) {
  const [open, setOpen] = useState(false);
  const [how, setHow] = useState('now');
  const [danger, setDanger] = useState(false);
  const toast = useToast();
  return (
    <Pile>
      <div className={styles.dialogPreview}>
        <DialogPanel
          title="Replace your key?"
          description="You get a new key, shown once. Nothing else changes: same permissions, same limits, same people. Carol’s key and the machine key keep working."
          footer={
            <>
              <Button variant="primary">{ACTIONS.replaceKey}</Button>
              <Button variant="ghost">{ACTIONS.cancel}</Button>
            </>
          }
          hint={WAITING.recorded}
        >
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <OptionCard
              name={`preview-${theme}`}
              value="now"
              checked
              onChange={() => undefined}
              label={
                <>
                  Stop the current key <b>now</b>
                </>
              }
              description="claude-code used it 2 minutes ago. Its next call is refused with “key replaced”."
            />
            <OptionCard
              name={`preview-${theme}`}
              value="hour"
              checked={false}
              onChange={() => undefined}
              label={
                <>
                  Keep the current key working for <b>1 hour</b>
                </>
              }
              description="Time to swap the key in your agent without a refused call."
            />
          </div>
        </DialogPanel>
      </div>
      <Line>
        <Button onClick={() => setOpen(true)}>Open the confirmation</Button>
        <Button variant="danger" onClick={() => setDanger(true)}>
          Open a type-to-confirm
        </Button>
      </Line>
      <ConfirmDialog
        open={open}
        title="Replace your key?"
        consequence="You get a new key, shown once. Nothing else changes: same permissions, same limits, same people."
        options={[
          {
            value: 'now',
            label: 'Stop the current key now',
            description: 'Its next call is refused with “key replaced”.',
          },
          {
            value: 'hour',
            label: 'Keep the current key working for 1 hour',
            description: 'Both keys count against the same limits.',
          },
        ]}
        value={how}
        onChange={setHow}
        confirmLabel={ACTIONS.replaceKey}
        hint={WAITING.recorded}
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          toast({
            title: 'Key replaced',
            description: 'The new key is shown once, on the mission.',
          });
        }}
      />
      {danger && (
        <DangerConfirm
          title="Disconnect GitHub · acme?"
          body="The credential is destroyed and the 4 running missions stop for good, with the reason in every refusal."
          phrase="GitHub · acme"
          confirmLabel="Disconnect"
          onCancel={() => setDanger(false)}
          onConfirm={() => setDanger(false)}
        />
      )}
    </Pile>
  );
}

function ToastSpecimen() {
  const toast = useToast();
  return (
    <Pile>
      <div style={{ display: 'grid', gap: 'var(--space-2)', maxWidth: 360 }}>
        <ToastCard title="Copied" />
        <ToastCard
          tone="ok"
          title="Access given"
          description="Frank may allow up to 10 permissions."
          onDismiss={() => undefined}
        />
        <ToastCard
          tone="bad"
          title="Not saved"
          description="The gateway answered 503. Nothing was changed."
          onDismiss={() => undefined}
        />
      </div>
      <Line>
        <Button onClick={() => toast({ title: 'Copied' })}>Show a toast</Button>
        <Button
          onClick={() =>
            toast({ tone: 'bad', title: 'Not saved', description: 'Nothing was changed.' })
          }
        >
          Show a failure
        </Button>
      </Line>
    </Pile>
  );
}

type Period = 'today' | 'yesterday' | 'week';
type Facet = 'allowed' | 'refused' | 'asked';
type TabId = 'permissions' | 'tools' | 'model';

function FilterSpecimen({ theme }: { theme: string }) {
  const [period, setPeriod] = useState<Period>('today');
  const [facets, setFacets] = useState<readonly Facet[]>(['refused']);
  const [tab, setTab] = useState<TabId>('permissions');
  const base = `design-tabs-${theme}`;
  return (
    <Pile>
      <Line>
        <Segmented
          label="Period"
          value={period}
          onChange={setPeriod}
          options={[
            { value: 'today', label: 'Today' },
            { value: 'yesterday', label: 'Yesterday' },
            { value: 'week', label: '7 days' },
          ]}
        />
        <FilterChips
          label="Decision"
          selected={facets}
          onToggle={(value) =>
            setFacets(
              facets.includes(value) ? facets.filter((f) => f !== value) : [...facets, value],
            )
          }
          options={[
            { value: 'allowed', label: 'Allowed', count: 211 },
            { value: 'refused', label: 'Refused', count: 2 },
            { value: 'asked', label: 'Asked you', count: 1 },
          ]}
        />
        <SearchField label="Tool or resource" />
        <SearchField label="Search" shortcut="/" defaultValue="merge" />
      </Line>
      <div>
        <TabList<TabId>
          base={base}
          label="Sections of the reference"
          active={tab}
          onSelect={setTab}
          tabs={[
            { id: 'permissions', label: 'Permissions', count: 15 },
            { id: 'tools', label: 'Tools', count: 26 },
            { id: 'model', label: 'How it is modelled' },
          ]}
        />
        <TabPanel base={base} id={tab}>
          <Hint>The panel of “{tab}”. Arrows, Home and End move between tabs.</Hint>
        </TabPanel>
      </div>
    </Pile>
  );
}

export function OverlaySections() {
  return (
    <>
      <GallerySection
        id="dialog"
        title="Dialog"
        rule="One question, the consequence stated before anything happens, the button named after the act, and a way out. Acts that cannot be undone ask the person to type a phrase."
      >
        <Specimen name="Confirmation with a stated consequence" note="shown in place, then live">
          {(theme) => <ReplaceKeySpecimen theme={theme} />}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="disclosure"
        title="Show details"
        rule="The default view shows what a person acts on; the rest is one click away, per page, and the page remembers. There is no global density setting."
      >
        <Specimen name="Disclosure" note="the link says what will appear; the state is remembered">
          {(theme) => (
            <Pile>
              <Disclosure
                id={`design:unused:${theme}`}
                show="Show the 14 unused"
                hide="Hide the 14 unused"
              >
                <Hint>
                  Releases, branch protection, tags, deployments… each with its id and why.
                </Hint>
              </Disclosure>
              <Disclosure
                id={`design:editor:${theme}`}
                show="Edit the permissions one by one"
                hide="Hide the permissions"
                defaultOpen
                remember={false}
              >
                <Hint>The granular editor unfolds here, under the macro-actions.</Hint>
              </Disclosure>
            </Pile>
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="filters"
        title="Tabs, filters, search"
        rule="Segments for one choice among a few, chips for facets that add up, a quiet search field. Tabs are for peers of a reference, never to hide the one thing a newcomer needs."
      >
        <Specimen name="Narrowing a list">{(theme) => <FilterSpecimen theme={theme} />}</Specimen>
      </GallerySection>

      <GallerySection
        id="toast"
        title="Toast"
        rule="Confirms what the person just did, and leaves. A failure stays until dismissed. Never the only copy of something that matters. A success carries the accent, not green."
      >
        <Specimen name="Tones, then live">{() => <ToastSpecimen />}</Specimen>
      </GallerySection>
    </>
  );
}

export function FormSections() {
  return (
    <>
      <GallerySection
        id="forms"
        title="Form fields"
        rule="A field says the shape it expects before the person types, and says it again in the error with what to do. Required unless it says optional. No success state."
      >
        <Specimen
          name="Text fields"
          note="expected shape in the label; hint; inline error; optional; disabled"
        >
          {(theme) => (
            <div className={styles.fields}>
              <Field label="Name" shape="how it appears in missions" htmlFor={`f-name-${theme}`}>
                <Input id={`f-name-${theme}`} defaultValue="Acme payments" />
              </Field>
              <Field
                label="Restricted key"
                shape={
                  <>
                    starts with <Code>rk_test_</Code> or <Code>rk_live_</Code>, 32 characters or
                    more
                  </>
                }
                htmlFor={`f-key-${theme}`}
                error={
                  <>
                    This is a secret key. Create a restricted key at Stripe › Developers › API keys;
                    it starts with <Code>rk_</Code>. A secret key is never stored.
                  </>
                }
              >
                <Input id={`f-key-${theme}`} mono defaultValue="sk_test_4eC39Hq…" />
              </Field>
              <Field
                label="Mode of this key"
                htmlFor={`f-mode-${theme}`}
                hint="Connect the live key as a second resource later, from the account page."
              >
                <Select id={`f-mode-${theme}`} defaultValue="test">
                  <option value="test">Test</option>
                  <option value="live">Live</option>
                </Select>
              </Field>
              <Field label="Team id" optional htmlFor={`f-team-${theme}`}>
                <Input id={`f-team-${theme}`} placeholder="team_…" />
              </Field>
              <Field label="Set by the mounted configuration" htmlFor={`f-ro-${theme}`}>
                <Input id={`f-ro-${theme}`} defaultValue="gateway.example.com" disabled />
              </Field>
              <Field
                label="Agent’s proposal"
                shape="the JSON the agent printed"
                htmlFor={`f-json-${theme}`}
              >
                <Textarea id={`f-json-${theme}`} mono rows={3} placeholder='{ "name": "…" }' />
              </Field>
            </div>
          )}
        </Specimen>
        <Specimen
          name="Choices"
          note="native controls with their words; a switch is labelled by what happens"
        >
          {(theme) => (
            <Line>
              <Checkbox defaultChecked>Read code</Checkbox>
              <Checkbox>Create a release</Checkbox>
              <Checkbox disabled>Not available to you</Checkbox>
              <Radio name={`r-${theme}`} defaultChecked>
                Developer
              </Radio>
              <Radio name={`r-${theme}`}>Read-only</Radio>
              <Switch defaultChecked>Ask me first</Switch>
              <Switch>Ask me first</Switch>
              <Switch disabled>Ask me first</Switch>
            </Line>
          )}
        </Specimen>
        <Specimen name="Small controls" note="inside a table row">
          {() => (
            <Line>
              <Input
                size="sm"
                mono
                defaultValue="3,000"
                aria-label="Per day"
                style={{ width: 84 }}
              />
              <Select
                size="sm"
                aria-label="TrustLevel"
                defaultValue="trusting"
                style={{ width: 160 }}
              >
                <option value="careful">Careful · ×1</option>
                <option value="trusting">Trusting · ×3</option>
              </Select>
            </Line>
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="code"
        title="Code"
        rule="Inline for a name; a block for what a person copies, with a button that copies exactly that. Dark in both themes. A secret is shown once."
      >
        <Specimen name="Block with copy">
          {() => (
            <Pile>
              <CodeBlock
                label="Environment variable"
                copy={'export VAUBAAN_KEY="vbn_live_XU2O5mGKq8tR3vLm9nWe2dPx7cYhBz4kA1sFj6uT"'}
              >
                <CodeTone tone="key">export</CodeTone> VAUBAAN_KEY=
                <CodeTone tone="string">
                  &quot;vbn_live_XU2O5mGKq8tR3vLm9nWe2dPx7cYhBz4kA1sFj6uT&quot;
                </CodeTone>
              </CodeBlock>
              <CodeBlock label="Agent instructions" wrap>
                {
                  '# Mission: Ship the billing page (via Vaubaan)\nYou reach GitHub and Supabase only through the "vaubaan" MCP server. If a call is refused for "limit reached" or "not allowed", stop and report the reason and the link. Never work around a refusal.'
                }
              </CodeBlock>
            </Pile>
          )}
        </Specimen>
        <Specimen name="Inline, and a copy button on its own">
          {() => (
            <Line>
              <span>
                Merge into <Code>main</Code> with <Code>merge_pull_request</Code>
              </span>
              <CopyButton text="vbn_live_XU2O…6uT" label="Copy the masked key" />
            </Line>
          )}
        </Specimen>
      </GallerySection>
    </>
  );
}
