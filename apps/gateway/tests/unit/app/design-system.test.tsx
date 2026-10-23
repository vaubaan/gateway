/**
 * The components of the design system, rendered to static markup (no
 * browser): what each one promises to a page and to assistive technology.
 * How they look is judged on the gallery (`/design`).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  AllowSummary,
  AnswerRow,
  Avatar,
  AvatarStack,
  Button,
  ButtonLink,
  Callout,
  checkColumnBudget,
  ChoiceChip,
  ChoiceRow,
  CodeBlock,
  DataTable,
  DialogPanel,
  Disclosure,
  EmptyState,
  EnvTag,
  Field,
  FormStep,
  FormWithRail,
  GateMark,
  hueOf,
  initialsOf,
  Input,
  KeyHolder,
  MenuItem,
  Meter,
  meterState,
  MoreMenu,
  Mono,
  PageHeader,
  PermissionGroup,
  PermissionRow,
  PermissionTable,
  Row,
  Rows,
  SecretBox,
  Section,
  serviceLetters,
  SeverityChip,
  Skeleton,
  StatusMark,
  SummaryLine,
  Switch,
  WhyCells,
  type Column,
} from '@/components/ui';

vi.mock('next/navigation', () => ({ usePathname: () => '/design' }));

const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('PageHeader', () => {
  it('renders the title as the one h1, the lede and the actions; the crumbs go to the path bar', () => {
    const html = renderToStaticMarkup(
      <PageHeader
        title="Accounts"
        lede="A cloud account connected once."
        crumbs={[{ label: 'Home', href: '/' }, { label: 'Accounts' }]}
        primary={<Button variant="primary">Connect an account</Button>}
        secondary={[<Button key="a">Refresh</Button>]}
      />,
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('A cloud account connected once.');
    // The crumbs are not drawn in the header: the path bar of the shell says them
    // (ADR shadcn-near-default-skin-and-path-bar).
    expect(html).not.toContain('aria-label="Breadcrumb"');
    expect(html).not.toContain('Home');
    // Secondary actions come before the primary one.
    expect(html.indexOf('Refresh')).toBeLessThan(html.indexOf('Connect an account'));
  });

  it('lets the page choose the measure of its column, and is an h2 inside another page', () => {
    expect(renderToStaticMarkup(<PageHeader title="T" width="wide" />)).toContain(
      'data-page-width="wide"',
    );
    const nested = renderToStaticMarkup(<PageHeader title="T" level={2} width="wide" />);
    expect(nested).toContain('<h2');
    expect(nested).not.toContain('data-page-width');
  });
});

describe('Section and SummaryLine', () => {
  it('names a section by its heading and prints its count', () => {
    const html = renderToStaticMarkup(
      <Section id="people" title="People and keys" count={1212} note="One key each.">
        <p>body</p>
      </Section>,
    );
    expect(html).toMatch(/<section id="people"[^>]*aria-labelledby="people-title"/);
    expect(html).toMatch(/<h2[^>]*id="people-title"[^>]*>People and keys<span[^>]*>1,212<\/span>/);
  });

  it('links the counts that lead somewhere and not the others', () => {
    const html = renderToStaticMarkup(
      <SummaryLine items={[{ label: '4 running', href: '/missions' }, { label: '1,212 calls' }]} />,
    );
    expect(html).toContain('href="/missions"');
    expect(html.match(/<a /g)).toHaveLength(1);
  });
});

describe('Meter', () => {
  it('is drawn only near the limit: the threshold is the caller’s', () => {
    expect(meterState(58, 10_000)).toBe('far');
    expect(meterState(1860, 3000)).toBe('near');
    expect(meterState(5000, 5000)).toBe('reached');
    expect(meterState(2104, 10_000, 0.2)).toBe('near');
    expect(meterState(0, 0)).toBe('reached');

    const far = renderToStaticMarkup(<Meter used={58} limit={10_000} label="reads" />);
    expect(far).not.toContain('role="meter"');
    expect(far).toContain('—');
    // The dash still says the figure to assistive technology.
    expect(text(far)).toContain('reads: 58 / 10,000, far from the limit');
    expect(renderToStaticMarkup(<Meter used={58} limit={10_000} placeholder="none" />)).toBe('');
  });

  it('says the figure, in words too, and never by colour alone', () => {
    const near = renderToStaticMarkup(<Meter used={1860} limit={3000} label="branch writes" />);
    expect(near).toContain('role="meter"');
    expect(near).toContain('aria-valuenow="1860"');
    expect(near).toContain('aria-valuemax="3000"');
    expect(near).toContain('aria-valuetext="1,860 / 3,000 branch writes"');
    expect(near).toContain('width:62%');

    const reached = renderToStaticMarkup(<Meter used={5200} limit={5000} />);
    expect(reached).toContain('width:100%');
    expect(text(reached)).toContain('Limit reached');

    const always = renderToStaticMarkup(<Meter used={9} limit={500} threshold={0} />);
    expect(always).toContain('role="meter"');
    expect(renderToStaticMarkup(<Meter used={1860} limit={3000} format="percent" />)).toContain(
      '62%',
    );
  });
});

interface Line {
  readonly id: string;
  readonly name: string;
  readonly calls: number;
}

const LINES: readonly Line[] = [
  { id: 'a', name: 'Alice', calls: 284 },
  { id: 'b', name: 'Bob', calls: 0 },
];

const COLUMNS: readonly Column<Line>[] = [
  { id: 'name', header: 'Name', cell: (line) => line.name },
  { id: 'calls', header: 'Calls', cell: (line) => line.calls, align: 'right' },
  { id: 'key', header: 'Key', cell: () => 'vbn_live_…', detail: true },
];

describe('DataTable', () => {
  it('holds five columns by default and seven with details, and refuses more', () => {
    const column = (id: string, detail = false) => ({ id, detail });
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => column(id));
    expect(() => checkColumnBudget(five)).not.toThrow();
    expect(() => checkColumnBudget([...five, column('f')])).toThrow(/6 columns by default/);
    expect(() => checkColumnBudget([...five, column('f', true), column('g', true)])).not.toThrow();
    expect(() =>
      checkColumnBudget([...five, column('f', true), column('g', true), column('h', true)]),
    ).toThrow(/8 columns with details/);
    // The activity record is the documented exception.
    expect(() => checkColumnBudget([...five, column('f')], 6)).not.toThrow();
    expect(() =>
      renderToStaticMarkup(
        <DataTable
          caption="Too wide"
          rows={LINES}
          rowKey={(line) => line.id}
          columns={['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
            id,
            header: id,
            cell: () => id,
          }))}
        />,
      ),
    ).toThrow(/budget is 5/);
  });

  it('is a captioned table whose detail columns follow the scope, and whose rows say their state', () => {
    const html = renderToStaticMarkup(
      <DataTable
        caption="People"
        columns={COLUMNS}
        rows={LINES}
        rowKey={(line) => line.id}
        rowTone={(line) => (line.calls === 0 ? 'quiet' : undefined)}
        actions={() => <Button size="sm">Replace key</Button>}
      />,
    );
    expect(html).toContain('<caption class="vbn-sr-only">People</caption>');
    expect(html.match(/<th role="columnheader" scope="col"/g)).toHaveLength(4);
    expect(html).toContain('<span class="vbn-sr-only">Actions</span>');
    expect(html).not.toContain('data-details');
    expect(html).toMatch(/<td role="cell" class="[^"]*detail[^"]*" data-column="key"/);
    expect(html).toMatch(/<tr role="row" class="[^"]*row_quiet[^"]*" data-row="b">/);
    // On a phone a row is drawn as a block: every cell after the first carries the name
    // of its column, and the roles keep the table a table whatever its drawing.
    expect(html).toMatch(/<table role="table" class="[^"]*stack[^"]*"/);
    const firstRow = html.slice(html.indexOf('data-row="a"'), html.indexOf('data-row="b"'));
    const labels = [...firstRow.matchAll(/data-column="([a-z]+)"(?: data-label="([^"]*)")?/g)].map(
      (match) => [match[1], match[2]],
    );
    expect(labels[0]?.[1]).toBeUndefined();
    expect(labels.slice(1).every(([, label]) => typeof label === 'string' && label !== '')).toBe(
      true,
    );
    // The actions of a row are in the document for every device; only their drawing waits for a pointer.
    expect(firstRow).toContain('Replace key');

    const grid = renderToStaticMarkup(
      <DataTable
        caption="People"
        columns={COLUMNS}
        rows={LINES}
        rowKey={(l) => l.id}
        narrow="scroll"
      />,
    );
    expect(grid).not.toMatch(/<table role="table" class="[^"]*stack/);

    const open = renderToStaticMarkup(
      <DataTable caption="People" columns={COLUMNS} rows={LINES} rowKey={(l) => l.id} details />,
    );
    expect(open).toContain('data-details="open"');
  });

  it('says what is the case when there is no row, and groups rows under a title', () => {
    const empty = renderToStaticMarkup(
      <DataTable
        caption="People"
        columns={COLUMNS}
        rows={[]}
        rowKey={(l) => l.id}
        empty={<EmptyState title="Nobody yet." />}
      />,
    );
    expect(empty).not.toContain('<table');
    expect(empty).toContain('Nobody yet.');

    const grouped = renderToStaticMarkup(
      <DataTable
        caption="People"
        headless
        columns={COLUMNS}
        groups={[{ key: 'g', title: 'People', note: '2', rows: LINES }]}
        rowKey={(l) => l.id}
      />,
    );
    expect(grouped).toContain('scope="rowgroup"');
    expect(grouped).toContain('<thead role="rowgroup" class="vbn-sr-only">');
  });
});

describe('Rows', () => {
  it('is a list whose title may lead to the object', () => {
    const html = renderToStaticMarkup(
      <Rows label="Missions">
        <Row
          title="Ship the billing page"
          href="/missions/1"
          description="GitHub · you"
          end="2 min"
        />
        <Row title="Docs refresh" muted />
      </Rows>,
    );
    expect(html).toMatch(/^<ul[^>]*aria-label="Missions"/);
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain('href="/missions/1"');
  });
});

describe('marks', () => {
  it('always carries its word: a status, an environment, a severity, a gate', () => {
    expect(text(renderToStaticMarkup(<StatusMark tone="bad">Limit reached</StatusMark>))).toBe(
      'Limit reached',
    );
    expect(text(renderToStaticMarkup(<EnvTag env="prod" />))).toBe('prod');
    expect(text(renderToStaticMarkup(<EnvTag env={null} />))).toBe('no label');
    expect(renderToStaticMarkup(<SeverityChip level="high" />)).toContain('data-severity="high"');
    expect(text(renderToStaticMarkup(<GateMark gate="free" />))).toBe('runs freely');
    expect(text(renderToStaticMarkup(<GateMark gate="ask" />))).toBe('ask me first');
    expect(text(renderToStaticMarkup(<GateMark gate="off" />))).toBe('not included');
  });

  it('labels the six cells in words and leaves out the axes it was not given', () => {
    const html = renderToStaticMarkup(
      <WhyCells values={{ reversibility: 'costly', blast: 'account', data: 'secret' }} />,
    );
    expect(html.match(/<dt>/g)).toHaveLength(3);
    expect(html).toContain('<dt>Blast radius</dt><dd>whole account</dd>');
    expect(html).toContain('<dt>Data</dt><dd>secrets</dd>');
  });

  it('draws a person, a machine key and a team differently, and the same person the same way', () => {
    expect(initialsOf('Alice Chen')).toBe('AC');
    expect(initialsOf('alice@acme.example')).toBe('AL');
    expect(initialsOf('github-actions')).toBe('GA');
    expect(initialsOf('')).toBe('?');
    expect(serviceLetters('GitHub')).toBe('GH');
    expect(serviceLetters('Upstash Redis')).toBe('UR');
    expect(serviceLetters('Supabase')).toBe('SU');
    expect(hueOf('Alice Chen')).toBe(hueOf('Alice Chen'));
    for (const name of ['Alice Chen', 'Bob', 'x']) {
      expect(hueOf(name)).toBeGreaterThanOrEqual(1);
      expect(hueOf(name)).toBeLessThanOrEqual(5);
    }
    const machine = renderToStaticMarkup(<Avatar name="nightly" kind="machine" />);
    expect(machine).toContain('data-hue="0"');
    expect(machine).toMatch(/class="[^"]*machine/);
    expect(renderToStaticMarkup(<Avatar name="Eve" muted />)).toContain('data-hue="0"');

    const stack = renderToStaticMarkup(
      <AvatarStack max={2} members={[{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }]} />,
    );
    expect(stack).toContain('aria-label="Alice, Bob, Carol"');
    expect(stack).toContain('+1');

    const holder = renderToStaticMarkup(
      <KeyHolder name="github-actions" kind="machine" qualifier="· machine key" />,
    );
    expect(text(holder)).toBe('GAgithub-actions · machine key');
  });

  it('prints an id as the protocol spells it, wrapping between its words', () => {
    const html = renderToStaticMarkup(<Mono>github__get_file_contents</Mono>);
    expect(html).toContain('github__<wbr/>get_<wbr/>file_<wbr/>contents');
    expect(text(html)).toBe('github__get_file_contents');
    expect(renderToStaticMarkup(<Mono href="/reference/github">github.read-code</Mono>)).toMatch(
      /^<a href="\/reference\/github"/,
    );
  });
});

describe('PermissionRow', () => {
  const row = (variant: 'editor' | 'read' | 'usage' | 'pick', included = true) =>
    renderToStaticMarkup(
      <PermissionTable variant={variant} caption="Permissions on GitHub">
        <PermissionGroup title="Reads" note="2 of 2">
          <PermissionRow
            label="Write on main"
            id="github.merge-protected"
            severity="high"
            included={included}
            perDay={3000}
            perMinute={5}
            gate="ask"
            why={{
              reason: 'Public history.',
              cells: { reversibility: 'costly' },
              referenceHref: '/reference/github#risk-github.merge-protected',
              tools: ['merge_pull_request'],
            }}
          />
        </PermissionGroup>
      </PermissionTable>,
    );

  it('shows the label, the id in mono, the severity, the limits and the gate', () => {
    const html = row('read');
    expect(html).toContain('<caption class="vbn-sr-only">Permissions on GitHub</caption>');
    expect(html).toContain('data-permission="github.merge-protected"');
    expect(html).toMatch(/<code[^>]*>github\.merge-protected<\/code>/);
    expect(html).toContain('data-severity="high"');
    expect(html).toContain('3,000');
    expect(text(html)).toContain('ask me first');
    expect(html.match(/<th scope="col"/g)).toHaveLength(5);
  });

  it('keeps "why?" one click away: closed, with the reason, the six words and the reference behind it', () => {
    const html = row('read');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>why\?<\/button>/);
    const panel = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`id="${panel}"`);
    expect(html).toMatch(/<tr[^>]*hidden=""/);
    expect(html).toContain('<dt>Undo</dt><dd>costly</dd>');
    expect(html).toContain('href="/reference/github#risk-github.merge-protected"');
    expect(html).toContain('tools: merge_pull_request');
  });

  it('chooses its columns from the variant', () => {
    expect(row('editor').match(/<th scope="col"/g)).toHaveLength(6);
    expect(row('usage').match(/<th scope="col"/g)).toHaveLength(4);
    expect(row('usage')).toContain('Used today');
    const pick = row('pick');
    expect(pick.match(/<th scope="col"/g)).toHaveLength(3);
    // Without a gate column, "why?" sits beside the severity.
    expect(pick).toContain('why?');
  });

  it('lists a permission that is not included as such, without a limit', () => {
    const html = row('read', false);
    expect(text(html)).toContain('not included');
    expect(html).not.toContain('3,000');
  });
});

describe('AllowSummary and AnswerRow', () => {
  it('reads Can, Asks you first, Cannot, and leaves the asking line out when nothing asks', () => {
    const full = renderToStaticMarkup(
      <AllowSummary can="Read." asks="Merge to main." cannot="Releases." limits="1,860 / 3,000" />,
    );
    expect(full.match(/<dt>[^<]+<\/dt>/g)).toEqual([
      '<dt>Can</dt>',
      '<dt>Asks you first</dt>',
      '<dt>Cannot</dt>',
      '<dt>Limits today</dt>',
    ]);
    const none = renderToStaticMarkup(<AllowSummary can="Read." cannot="Any write." />);
    expect(none).not.toContain('Asks');
    expect(
      renderToStaticMarkup(
        <AllowSummary can="Read." asks="Merge." cannot="x" asksLabel="Asks Alice first" />,
      ),
    ).toContain('<dt>Asks Alice first</dt>');
  });

  it('puts the answers on the row of what is asked', () => {
    const html = renderToStaticMarkup(
      <AnswerRow
        who={<Avatar name="Carol" size="md" />}
        title="Merge pull request #418"
        age="4 min"
        description="Carol · codex"
        answers={<Button variant="primary">Approve</Button>}
      />,
    );
    expect(html).toMatch(/^<li/);
    expect(text(html)).toContain('Merge pull request #4184 min');
    expect(html).toContain('Approve');
    expect(renderToStaticMarkup(<AnswerRow boxed who={null} title="x" />)).toMatch(/^<div/);
  });
});

describe('Field', () => {
  it('says the expected shape in the label, and ties the error to the control', () => {
    const html = renderToStaticMarkup(
      <Field
        label="Restricted key"
        shape="starts with rk_"
        htmlFor="k"
        error="This is a secret key."
      >
        <Input id="k" name="key" />
      </Field>,
    );
    expect(text(html)).toContain('Restricted key · starts with rk_');
    const note = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(note).toBeTruthy();
    expect(html).toContain('aria-invalid="true"');
    expect(html).toMatch(
      new RegExp(`<div[^>]*id="${note}"[^>]*role="alert"[^>]*>This is a secret key\\.`),
    );
  });

  it('ties the hint to the control, says "optional", and marks nothing invalid without an error', () => {
    const html = renderToStaticMarkup(
      <Field label="Team id" optional htmlFor="t" hint="From the service’s settings.">
        <Input id="t" name="team" />
      </Field>,
    );
    expect(text(html)).toContain('Team id · optional');
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).not.toContain('aria-invalid');
  });

  it('labels a switch by what happens', () => {
    const html = renderToStaticMarkup(<Switch defaultChecked>Ask me first</Switch>);
    expect(html).toContain('role="switch"');
    expect(html).toMatch(/^<label/);
  });
});

describe('the rest', () => {
  it('gives a link the look of a button without making it one', () => {
    const html = renderToStaticMarkup(
      <ButtonLink href="/missions/new" variant="primary">
        New mission
      </ButtonLink>,
    );
    expect(html).toMatch(/^<a [^>]*href="\/missions\/new"/);
    expect(renderToStaticMarkup(<Button loading>Working…</Button>)).toContain('aria-busy="true"');
  });

  it('states the consequence of a dialog under its title', () => {
    const html = renderToStaticMarkup(
      <DialogPanel
        title="Replace your key?"
        titleId="t"
        description="You get a new key, shown once."
        descriptionId="d"
        footer={<Button variant="primary">Replace key</Button>}
        hint="Recorded in the activity."
      />,
    );
    expect(html).toContain('<h2 class="_title_');
    expect(html).toMatch(/id="d"[^>]*>You get a new key, shown once\./);
    expect(html.indexOf('shown once')).toBeLessThan(html.indexOf('Replace key</button>'));
  });

  it('renders a disclosure closed, with a link that says what will appear', () => {
    const html = renderToStaticMarkup(
      <Disclosure id="test:unused" show="Show the 14 unused" hide="Hide them">
        <p>The rest.</p>
      </Disclosure>,
    );
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Show the 14 unused<\/button>/);
    expect(html).toMatch(/<div[^>]*hidden=""[^>]*><p>The rest\.<\/p>/);
  });

  it('copies exactly what a code block says it copies', () => {
    const html = renderToStaticMarkup(<CodeBlock label="Environment">export A=1</CodeBlock>);
    expect(html).toContain('aria-label="Environment"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('Copy');
    expect(renderToStaticMarkup(<CodeBlock copy={false}>x</CodeBlock>)).not.toContain('<button');
  });

  it('gives a callout the role of a note and a tone it also says with an icon', () => {
    const html = renderToStaticMarkup(
      <Callout tone="warn" title="This account needs an owner">
        Nobody can give access.
      </Callout>,
    );
    expect(html).toContain('role="note"');
    expect(html).toContain('data-tone="warn"');
    expect(html).toContain('<svg');
    // The tone names of the first interface still resolve.
    expect(renderToStaticMarkup(<Callout tone="danger">x</Callout>)).toContain('data-tone="bad"');
  });

  it('announces a skeleton once', () => {
    expect(renderToStaticMarkup(<Skeleton />)).toContain('role="status"');
    expect(renderToStaticMarkup(<Skeleton label="" />)).toContain('aria-hidden="true"');
  });
});

describe('the components added with the mission pages', () => {
  it('keeps the rest behind a named button, closed, and writes a stopping act in words', () => {
    const html = renderToStaticMarkup(
      <MoreMenu label="More actions">
        <MenuItem href="/missions/m1/session">Activity</MenuItem>
        <MenuItem danger>Stop the mission</MenuItem>
        <MenuItem disabled note="Its creator alone can copy it">
          Duplicate
        </MenuItem>
      </MoreMenu>,
    );
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="More actions"');
    expect(html).toMatch(/role="menu"[^>]* hidden=""/);
    expect(html).toMatch(/<a [^>]*role="menuitem"[^>]*href="\/missions\/m1\/session"/);
    expect(html.match(/role="menuitem"/g)).toHaveLength(3);
    expect(html).toContain('Its creator alone can copy it');
  });

  it('draws a choice that would yield nothing as unavailable, with its reason in words', () => {
    const html = renderToStaticMarkup(
      <ChoiceRow legend="Preset for GitHub · acme">
        <ChoiceChip
          name="p"
          value="developer"
          checked
          onChange={() => {}}
          label="Developer"
          hint="10"
        />
        <ChoiceChip
          name="p"
          value="operator"
          checked={false}
          onChange={() => {}}
          label="Migration operator"
          hint="8"
          unavailable="needs a prod project: none selected"
        />
      </ChoiceRow>,
    );
    expect(html).toMatch(/<fieldset[^>]*><legend[^>]*>Preset for GitHub · acme<\/legend>/);
    expect(html).toMatch(/data-choice="developer"[^>]*>.*?<input[^>]*checked=""/);
    const operator = html.slice(html.indexOf('data-choice="operator"'));
    expect(operator).toContain('data-unavailable="true"');
    expect(operator).toMatch(/<input[^>]*disabled=""/);
    // The reason replaces the count: nobody reads "8" on a choice that yields nothing.
    expect(text(`<label ${operator}`)).toBe(
      'Migration operatorneeds a prod project: none selected',
    );
  });

  it('shows a key whole in a named box, with a button that copies it', () => {
    const html = renderToStaticMarkup(<SecretBox label="Your key" value="vbn_live_abc_def" />);
    expect(html).toMatch(/role="group"[^>]*aria-label="Your key"/);
    expect(html).toContain('<code');
    expect(text(html)).toBe('vbn_live_abc_defCopy');
  });

  it('numbers the steps of a form and puts the rail in a complementary landmark', () => {
    const html = renderToStaticMarkup(
      <FormWithRail rail={<p>What it will be able to do</p>}>
        <FormStep n={1} title="Name" hint="How you will find it again." id="step-name">
          <input aria-label="Mission name" />
        </FormStep>
      </FormWithRail>,
    );
    expect(html).toMatch(/<section[^>]*aria-labelledby="step-name-title"/);
    expect(html).toMatch(/<h2[^>]*id="step-name-title"[^>]*>Name<\/h2>/);
    expect(html).toContain('<aside');
    expect(text(html)).toContain('1NameHow you will find it again.');
  });
});
