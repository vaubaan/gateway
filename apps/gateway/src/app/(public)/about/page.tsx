import type { Metadata } from 'next';
import { ProseHeader, ProseWrap } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'About — Vaubaan',
  description: 'Why Vaubaan exists, who builds it, and what we believe about agent security.',
};

export default function AboutPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Company"
        title="About Vaubaan"
        lead="A policy-enforcing MCP gateway. Built by people who ship code with agents every day."
      />

      <h2>Why we exist</h2>
      <p>
        Coding agents are productive. They are also remarkably good at making one-shot mistakes —
        force-pushing to <code>main</code>, deleting a Vercel project, dropping a Supabase table —
        the moment you hand them a long-lived token. Vaubaan sits between the agent and the
        provider, so the agent never holds a secret, every tool call passes through a policy, and
        every action is auditable after the fact.
      </p>

      <h2>What we believe</h2>
      <ul>
        <li>
          <strong>Defense in depth, not in dialogue.</strong> Approval prompts get tuned out;
          policies don&rsquo;t.
        </li>
        <li>
          <strong>Tokens are not credentials.</strong> They are short-lived capabilities. We mint
          them just in time, and they expire faster than a human can notice.
        </li>
        <li>
          <strong>The audit log is the product.</strong> Without it, &ldquo;the agent did it&rdquo;
          is unprovable; with it, every diff has a paper trail.
        </li>
        <li>
          <strong>Boring infra wins.</strong> Postgres, edge functions, and a tight contract per
          provider. No magic.
        </li>
      </ul>

      <h2>Where we&rsquo;re based</h2>
      <p>
        Vaubaan operates from Paris, France. Data is processed in EU regions by default. See{' '}
        <a href="/subprocessors">/subprocessors</a> for the full list.
      </p>

      <h2>Get in touch</h2>
      <p>
        Sales, partnerships, press: <a href="mailto:hello@vaubaan.com">hello@vaubaan.com</a>
        <br />
        Security: <a href="mailto:security@vaubaan.com">security@vaubaan.com</a>
      </p>
    </ProseWrap>
  );
}
