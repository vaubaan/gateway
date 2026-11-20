/**
 * The landing (website spec §2.1), nine sections: the hero with its call log,
 * a mission not a token, the mission, ask me first, today for you, then your
 * team, the services, for the person who says yes, the questions. `/` opens
 * on the developer's project, `/consultants` on the consultant's.
 */
import Link from 'next/link';

import { ServiceMark } from '@vaubaan/plugin-page';

import { GITHUB_REPO, SITE_ORIGIN } from '../../site/constants';
import { PROJECTS, type Project } from '../../site/drawings';
import {
  DOES_NOT,
  HERO_LOG,
  LANDING_LEDE,
  LANDING_SECTIONS,
  LOG_TITLE,
  PRE_RELEASE,
  PROTECTS,
  TODAY_STEPS,
  type Faq,
  type LogLine,
} from '../../site/landing';
import { JsonLd } from '../JsonLd';
import { MarkdownBody } from '../MarkdownBody';
import { buttonVariants } from '../ui/button';
import { ForProject, ProjectSwitch } from './Project';
import { SectionView, StatusTag } from './ProductPageView';

export interface LandingService {
  readonly id: string;
  readonly name: string;
  readonly icon: string | null;
  readonly iconColor: string | null;
}

const GLYPH: Readonly<
  Record<LogLine['outcome'], { readonly mark: string; readonly word: string; readonly cls: string }>
> = {
  runs: { mark: '✓', word: 'runs', cls: 'text-code-ok' },
  refused: { mark: '✕', word: 'refused', cls: 'text-code-stop' },
  waits: { mark: '◆', word: 'waits for you', cls: 'text-code-accent' },
};

function CallLog({ project }: { readonly project: Project }) {
  return (
    <div className="overflow-hidden rounded-xl bg-code text-code-fg">
      <p className="border-b border-code-border px-4 py-2.5 font-mono text-xs text-code-muted">
        {LOG_TITLE[project]}
      </p>
      <ul className="space-y-2.5 px-4 py-4 font-mono text-[0.8125rem] leading-snug">
        {HERO_LOG[project].map((line) => {
          const g = GLYPH[line.outcome];
          return (
            <li key={line.call} className="grid grid-cols-[1rem_1fr] gap-x-2">
              <span aria-hidden="true" className={g.cls}>
                {g.mark}
              </span>
              <span className="min-w-0 break-words">
                <span className="sr-only">{g.word}: </span>
                {line.call}
                {line.outcome !== 'runs' && <span className={`block ${g.cls}`}>{line.note}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mx-4 mb-4 rounded-lg bg-card px-4 py-3 text-card-foreground">
        <p className="text-xs text-muted-foreground">Waiting for you</p>
        <p className="mt-0.5 font-semibold">
          {project === 'dev' ? 'Merge #142 into main?' : 'Send the recap to Jane?'}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {project === 'dev'
            ? 'acme/api · pull request #142 · squash'
            : 'jane@acme.com · “Acme, week 47” · 2 attachments'}
        </p>
      </div>
    </div>
  );
}

function H2({ id, children }: { readonly id: string; readonly children: React.ReactNode }) {
  return (
    <h2 id={id} className="text-2xl font-semibold tracking-[-0.02em] text-balance">
      {children}
    </h2>
  );
}

export function Landing({
  initial,
  services,
  faq,
}: {
  readonly initial: Project;
  readonly services: readonly LandingService[];
  readonly faq: readonly Faq[];
}) {
  const { NOT_A_TOKEN, THE_MISSION, ASK_ME_FIRST, THEN_YOUR_TEAM } = LANDING_SECTIONS;
  return (
    <div className="mx-auto max-w-page px-4 md:px-6">
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'SoftwareApplication',
          name: 'Vaubaan Gateway',
          description: LANDING_LEDE,
          applicationCategory: 'DeveloperApplication',
          operatingSystem: 'Docker',
          license: 'https://www.apache.org/licenses/LICENSE-2.0',
          codeRepository: GITHUB_REPO,
          url: SITE_ORIGIN,
          isAccessibleForFree: true,
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        }}
      />
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: faq.map((f) => ({
            '@type': 'Question',
            name: f.question,
            acceptedAnswer: { '@type': 'Answer', text: f.answer },
          })),
        }}
      />

      {/* 1 · Hero */}
      <section
        aria-labelledby="title"
        className="relative isolate -mx-4 grid gap-10 border-b border-border px-4 pb-12 pt-10 md:-mx-6 md:px-6 md:pt-16 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start"
      >
        {/* The plan grid, the one illustration device (style guide); it fades before the text ends. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(var(--border)_1px,transparent_1px),linear-gradient(90deg,var(--border)_1px,transparent_1px)] bg-[size:32px_32px] opacity-60 [mask-image:linear-gradient(to_bottom,black,transparent)]"
        />
        <div className="min-w-0">
          <p className="inline-flex rounded-full bg-primary-soft px-3 py-1 font-mono text-xs text-primary-ink">
            open-source MCP gateway · you run it
          </p>
          <h1
            id="title"
            className="mt-6 text-display font-semibold tracking-[-0.04em] text-balance"
          >
            Let your agent work alone.{' '}
            <span className="text-primary">It stops where you said.</span>
          </h1>
          <p className="mt-6 max-w-measure text-lg text-muted-foreground">{LANDING_LEDE}</p>
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
            <Link className={buttonVariants({ size: 'lg' })} href="/try" prefetch={false}>
              Try it
            </Link>
            <Link className="font-semibold" href="/how-it-works" prefetch={false}>
              How it works →
            </Link>
          </div>
          <p className="mt-6 max-w-measure text-sm text-muted-foreground">
            {PRE_RELEASE}{' '}
            <Link href="/docs/known-limitations" prefetch={false}>
              What is not done
            </Link>
          </p>
        </div>
        <div className="min-w-0">
          <ProjectSwitch initial={initial} />
          <div className="mt-4">
            {PROJECTS.map((p) => (
              <ForProject key={p} project={p}>
                <CallLog project={p} />
              </ForProject>
            ))}
          </div>
        </div>
      </section>

      {/* 2, 3, 4 · A mission not a token, the mission, ask me first */}
      <SectionView section={NOT_A_TOKEN} />
      <SectionView section={THE_MISSION} />
      <SectionView section={ASK_ME_FIRST} />

      {/* 5 · Today, for you */}
      <section aria-labelledby="today" className="border-t border-border py-12">
        <div className="max-w-measure">
          <H2 id="today">Today, for you</H2>
          <ol className="mt-6 space-y-3">
            {TODAY_STEPS.map((step, i) => (
              <li key={step.text} className="grid grid-cols-[1.75rem_1fr_auto] items-start gap-x-3">
                <span className="mt-0.5 inline-flex size-6 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary-ink">
                  {i + 1}
                </span>
                <div className="prose min-w-0 [&_p]:!m-0">
                  <MarkdownBody markdown={step.text} />
                </div>
                <StatusTag status={step.status} />
              </li>
            ))}
          </ol>
          <p className="mt-8">
            <Link className={buttonVariants({ size: 'lg' })} href="/try" prefetch={false}>
              Try it
            </Link>
          </p>
        </div>
      </section>

      {/* 6 · Then your team */}
      <SectionView section={THEN_YOUR_TEAM} />

      {/* 7 · Services */}
      <section aria-labelledby="services" className="border-t border-border py-12">
        <div className="max-w-measure">
          <H2 id="services">{services.length} services, each modelled the same way</H2>
          <p className="mt-4 text-muted-foreground">
            Each has a page generated from its catalog: its model, its verbs, the map of its
            permissions and how to connect an account.
          </p>
        </div>
        <ul className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
          {services.map((s) => (
            <li key={s.id}>
              <Link
                href={`/plugins/${s.id}`}
                prefetch={false}
                className="inline-flex items-center gap-2 py-1 text-foreground no-underline hover:underline"
              >
                {s.icon && <ServiceMark path={s.icon} color={s.iconColor} size="sm" />}
                {s.name}
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-6 font-semibold">
          <Link href="/plugins" prefetch={false}>
            Every service and its health →
          </Link>{' '}
          <span className="font-normal text-muted-foreground">
            Yours is missing?{' '}
            <Link href="/write-a-plugin" prefetch={false}>
              Write its plugin
            </Link>
            .
          </span>
        </p>
      </section>

      {/* 8 · For the person who says yes */}
      <section aria-labelledby="who-says-yes" className="border-t border-border py-12">
        <H2 id="who-says-yes">For the person who says yes</H2>
        <div className="mt-6 grid gap-8 md:grid-cols-2">
          <div>
            <h3 className="font-semibold">It protects</h3>
            <ul className="mt-3 divide-y divide-border">
              {PROTECTS.map((line) => (
                <li key={line} className="py-2.5">
                  {line}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-semibold">It does not</h3>
            <ul className="mt-3 divide-y divide-border">
              {DOES_NOT.map((line) => (
                <li key={line} className="py-2.5">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-6 font-semibold">
          <Link href="/trust" prefetch={false}>
            The trust center: every claim and the code behind it →
          </Link>
        </p>
      </section>

      {/* 9 · Questions */}
      <section aria-labelledby="questions" className="border-t border-border py-12">
        <H2 id="questions">Questions and answers</H2>
        <dl className="mt-2 max-w-measure">
          {faq.map((f) => (
            <div key={f.question}>
              <dt className="mt-6 font-semibold">{f.question}</dt>
              <dd className="mt-1 text-muted-foreground">{f.answer}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
