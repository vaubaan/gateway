/**
 * The landing (website spec §2.1): the problem, missions, the shape, the
 * services (from the plugin list), the licence, two calls to action, and
 * the questions people ask an assistant (§2.6).
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { JsonLd } from '@/components/JsonLd';
import { buttonVariants } from '@/components/ui/button';
import { GITHUB_REPO, LICENSE_NAME, SITE_ORIGIN } from '@/site/constants';
import { siteData } from '@/site/data';
import {
  LANDING_LEDE,
  LANDING_PROBLEM,
  MISSION_POINTS,
  SHAPE_POINTS,
  landingFaq,
} from '@/site/landing';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: { absolute: 'Vaubaan Gateway — missions for coding agents, not credentials' },
  description: LANDING_LEDE,
  alternates: { canonical: '/', types: { 'text/markdown': '/index.md' } },
};

export default function Home() {
  const { plugins } = siteData();
  const faq = landingFaq(plugins.map((p) => p.name));

  return (
    <div className="mx-auto max-w-page px-4 pt-6 md:px-6 md:pt-10">
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

      <section
        className="relative isolate -mx-4 border-b border-border px-4 pb-12 pt-10 md:-mx-6 md:px-6 md:pt-16"
        aria-labelledby="title"
      >
        {/* The plan grid, the one illustration device (style guide); it fades before the text ends. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(var(--border)_1px,transparent_1px),linear-gradient(90deg,var(--border)_1px,transparent_1px)] bg-[size:32px_32px] opacity-60 [mask-image:linear-gradient(to_bottom,black,transparent)]"
        />
        <div className="max-w-measure">
          <h1 id="title" className="text-display font-semibold tracking-[-0.04em] text-balance">
            Vaubaan Gateway
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">{LANDING_LEDE}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              className={buttonVariants({ size: 'lg' })}
              href="/docs/quick-look"
              prefetch={false}
            >
              Try the demo
            </Link>
            <Link
              className={buttonVariants({ variant: 'secondary', size: 'lg' })}
              href="/docs/install"
              prefetch={false}
            >
              Install
            </Link>
          </div>
          <p className="mt-6 text-sm text-muted-foreground">
            Pre-release: 2.0.0-alpha versions are tagged; expect breaking changes until v2.0.0.{' '}
            <Link href="/trust" prefetch={false}>
              What protects your credentials
            </Link>{' '}
            · <a href={GITHUB_REPO}>Source on GitHub</a>
          </p>
        </div>
      </section>

      <div className="prose mt-4">
        <h2>The problem</h2>
        <p>{LANDING_PROBLEM}</p>

        <h2>The answer: missions</h2>
        <p>A person creates a mission, and the gateway holds the agent to it:</p>
        <ul className="!list-none !pl-0">
          {MISSION_POINTS.map((point) => (
            <li key={point.term} className="!m-0 border-b border-border py-2">
              <strong>{point.term}</strong>: {point.text}
            </li>
          ))}
        </ul>

        <h2>The shape</h2>
        <ul className="!list-none !pl-0">
          {SHAPE_POINTS.map((point) => (
            <li key={point} className="!m-0 border-b border-border py-2">
              {point}
            </li>
          ))}
        </ul>

        <h2>Supported services</h2>
        <p>
          One plugin per service, from the catalog:{' '}
          {plugins.map((p, i) => (
            <span key={p.id}>
              {i > 0 ? ', ' : ''}
              <Link href={`/plugins/${p.id}`} prefetch={false}>
                {p.name}
              </Link>
            </span>
          ))}
          . Each is a catalog of named permissions grouped into macro-actions, generated here from
          the repository.
        </p>

        <h2>Open source</h2>
        <p>
          {LICENSE_NAME}. Read the code, the specification, the threat model and every decision on{' '}
          <a href={GITHUB_REPO}>GitHub</a>; report a vulnerability privately through{' '}
          <a href={`${GITHUB_REPO}/security/advisories/new`}>GitHub</a>.
        </p>

        <h2 id="questions">Questions and answers</h2>
        <dl>
          {faq.map((f) => (
            <div key={f.question}>
              <dt className="mt-6 font-semibold">{f.question}</dt>
              <dd className="mt-1 text-muted-foreground">{f.answer}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
