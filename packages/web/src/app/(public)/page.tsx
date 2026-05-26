import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase/server';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

const features = [
  {
    icon: 'K',
    title: 'No tokens to the agent',
    body: 'The agent only holds a vbn_live_… key. Every upstream token is minted server-side, used once, and dropped.',
  },
  {
    icon: 'P',
    title: 'Default-deny policy',
    body: 'Every tool call is gated by per-token roles. Dangerous ops (merge to main, delete file, drop table) are deny-listed by default.',
  },
  {
    icon: 'A',
    title: 'Full audit log',
    body: 'Access token id, tool, target, policy decision and timing on every call — including denies. Streamable in the dashboard.',
  },
  {
    icon: 'R',
    title: 'Resource binding',
    body: 'Pin a project to specific repos / Vercel projects / Supabase project_refs. The agent never sees the others.',
  },
  {
    icon: 'B',
    title: 'Composable roles',
    body: 'Attach builtin (github:developer, vercel:viewer) and custom roles to a token. Roles union for allows, deny-lists override.',
  },
  {
    icon: 'O',
    title: 'OAuth-grade installs',
    body: 'GitHub App install flow. Vercel and Supabase via team-scoped PATs, encrypted at rest with AES-256-GCM.',
  },
];

const steps = [
  {
    title: 'Connect providers',
    body: 'GitHub App install · Vercel team token · Supabase Mgmt PAT. No paste-to-agent, no plaintext at rest.',
  },
  {
    title: 'Bind resources',
    body: 'Pin each project to specific repos, Vercel projects and Supabase project_refs. Default-deny on anything else.',
  },
  {
    title: 'Compose Roles → Access token',
    body: 'Pick builtin roles (github:developer, vercel:viewer…) or write custom. Attach N roles to an access token.',
  },
  {
    title: 'Drop key, ship',
    body: 'Paste the vbn_live_… key in mcp.json. Every call: authorize, mint JIT, forward, audit.',
  },
];

export default async function HomePage() {
  let userEmail: string | null = null;
  try {
    const supabase = await getSupabaseServer();
    const { data } = await supabase.auth.getUser();
    userEmail = data.user?.email ?? null;
  } catch {
    userEmail = null;
  }

  return (
    <>
      <section className={styles.hero}>
        <div className={styles.heroInner}>
          <span className={styles.eyebrow}>
            <span className={styles.dot} />
            <span>
              <strong>Vaubaan</strong> · MCP gateway for coding agents
            </span>
          </span>
          <h1 className={styles.title}>The agent never sees the secret.</h1>
          <p className={styles.subtitle}>
            Policy-enforcing MCP gateway in front of GitHub, Vercel and Supabase. Filter and audit
            every tool call from Claude Code, Cursor and the rest — without ever giving an agent a
            cloud provider token.
          </p>
          <div className={styles.cta}>
            {userEmail ? (
              <Link href="/dashboard" className={styles.btnPrimary}>
                Open dashboard →
              </Link>
            ) : (
              <Link href="/login" className={styles.btnPrimary}>
                Start free
              </Link>
            )}
            <a
              href="https://github.com/sbw-vaubaan/mcp-proxy"
              target="_blank"
              rel="noreferrer noopener"
              className={styles.btnSecondary}
            >
              View on GitHub
            </a>
          </div>
          <div style={{ marginTop: 'var(--space-8)' }}>
            <div className={styles.providers}>
              <span
                style={{
                  fontSize: 'var(--text-xs)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                }}
              >
                Live integrations
              </span>
              <span className={styles.providerChip}>
                <span className={styles.providerDot} /> GitHub
              </span>
              <span className={styles.providerChip}>
                <span className={styles.providerDot} /> Vercel
              </span>
              <span className={styles.providerChip}>
                <span className={styles.providerDot} /> Supabase
              </span>
            </div>
          </div>
        </div>
        <aside className={styles.heroAside} aria-hidden="true">
          <div className={styles.terminal}>
            <span className={styles.muted}>$ </span>
            <span className={styles.cmd}>claude code commit</span>
            <br />
            <span className={styles.muted}>{`→ tool: github__create_pull_request`}</span>
            <br />
            <span
              className={styles.muted}
            >{`  target: sbw-vaubaan/mcp-proxy#feature/sidebar`}</span>
            <br />
            <span className={styles.ok}>{`  policy: github:developer · ALLOW`}</span>
            <br />
            <span className={styles.muted}>{`  upstream: 201 created`}</span>
            <br />
            <br />
            <span className={styles.muted}>{`→ tool: github__merge_pull_request`}</span>
            <br />
            <span className={styles.muted}>{`  target: sbw-vaubaan/mcp-proxy#main`}</span>
            <br />
            <span className={styles.deny}>
              {`  policy: github:developer · DENY (merge_blocked_on_default)`}
            </span>
          </div>
        </aside>
      </section>

      <section className={styles.section} id="why">
        <h2 className={styles.sectionTitle}>What you get</h2>
        <p className={styles.sectionLead}>
          Six properties that turn a free-for-all agent into one you actually want in production.
        </p>
        <div className={styles.featureGrid}>
          {features.map((f) => (
            <div className={styles.feature} key={f.title}>
              <div className={styles.featureIcon} aria-hidden>
                {f.icon}
              </div>
              <div className={styles.featureTitle}>{f.title}</div>
              <p className={styles.featureBody}>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section} id="how-it-works">
        <h2 className={styles.sectionTitle}>How it works</h2>
        <p className={styles.sectionLead}>Four steps from sign-up to your first audited call.</p>
        <div className={styles.stepGrid}>
          {steps.map((s, i) => (
            <div className={styles.step} key={s.title}>
              <span className={styles.stepNum}>{i + 1}</span>
              <h3 className={styles.stepTitle}>{s.title}</h3>
              <p className={styles.stepBody}>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.bottomCta}>
        <h2>Run your agent like a junior dev with a paper trail.</h2>
        <p>Free during private beta. No credit card.</p>
        {userEmail ? (
          <Link href="/dashboard" className={styles.btnPrimary}>
            Open dashboard
          </Link>
        ) : (
          <Link href="/login" className={styles.btnPrimary}>
            Get started
          </Link>
        )}
      </section>
    </>
  );
}
