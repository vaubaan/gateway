import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase/server';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

const problems = [
  {
    title: '10 clouds, 10 security models',
    body: 'GitHub has org/repo permissions. Vercel has team roles. Supabase has service keys. Each cloud has a different IAM model, none designed for autonomous agents. You spend days understanding each one — before writing a single line of agent config.',
  },
  {
    title: 'One token, unbounded blast',
    body: 'Your agent holds a PAT that can read every repo, merge to main, deploy to prod, and subscribe to paid add-ons. The "Allow / Deny" dialog doesn\'t scale when a fleet generates hundreds of calls per hour.',
  },
  {
    title: 'No delegation, no trail',
    body: "Your orchestrator spins up 5 sub-agents with the same credentials. One merges the wrong PR. Another drops a staging table. Who authorized what? When? You're grepping 5 cloud audit logs, correlating timestamps by hand.",
  },
];

const riskChecklist = [
  { id: 'github.read-code', label: 'Read code, branches, commits', checked: true },
  { id: 'github.feature-branch-write', label: 'Create/modify feature/* branches', checked: true },
  { id: 'github.merge-protected', label: 'Write on main / master / release-*', checked: false },
  { id: 'github.workflow-write', label: 'Modify GitHub Actions YAML', checked: false },
  { id: 'github.create-pr', label: 'Open a pull request', checked: true },
];

const steps = [
  {
    title: 'Connect providers',
    body: 'GitHub App install, Vercel OAuth, Supabase PAT. Upstream credentials stay in Vaubaan. The agent never sees them.',
  },
  {
    title: 'Bind resources',
    body: 'Pin each project to specific repos, Vercel projects, Supabase refs. Everything else is invisible to the agent.',
  },
  {
    title: 'Accept risks',
    body: 'Tick a checklist of ~15 human-readable risks per provider. Get a vbn_live_* token. 30 seconds.',
  },
  {
    title: 'Ship your agent',
    body: 'Paste the token in mcp.json. Every call: classify risks, check envelope, JIT-mint upstream token, forward, audit.',
  },
];

const providers = [
  { name: 'GitHub', status: 'GA' as const },
  { name: 'Vercel', status: 'GA' as const },
  { name: 'Supabase', status: 'GA' as const },
  { name: 'Railway', status: 'GA' as const },
  { name: 'Stripe', status: 'GA' as const },
  { name: 'Cloudflare DNS', status: 'GA' as const },
  { name: 'Upstash Redis', status: 'GA' as const },
  { name: 'Gmail', status: 'GA' as const },
  { name: 'Resend', status: 'GA' as const },
  { name: 'SSH', status: 'GA' as const },
  { name: 'Bash', status: 'GA' as const },
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

  const ctaPrimary = userEmail
    ? { href: '/dashboard', label: 'Open dashboard' }
    : { href: '/login', label: 'Start free' };

  return (
    <>
      {/* ─── HERO ─── */}
      <section className={styles.hero}>
        <div className={styles.heroInner}>
          <span className={styles.eyebrow}>
            <span className={styles.dot} />
            <span>
              <strong>Vaubaan</strong> · MCP gateway for agent fleets
            </span>
          </span>
          <h1 className={styles.title}>
            Your agents can build anything. Your cloud&rsquo;s IAM can&rsquo;t keep up.
          </h1>
          <p className={styles.subtitle}>
            You run Claude Code across GitHub, Vercel, Supabase, and more. But cloud permissions
            weren&rsquo;t designed for autonomous agents — they&rsquo;re too coarse, different
            everywhere, and one leaked PAT nukes everything. Vaubaan is one MCP endpoint, one risk
            model, and zero cloud tokens in agent context.
          </p>
          <div className={styles.cta}>
            <Link href={ctaPrimary.href} className={styles.btnPrimary}>
              {ctaPrimary.label}
            </Link>
            <Link href="/docs" className={styles.btnSecondary}>
              Read the docs
            </Link>
          </div>
          <div className={styles.providerBar}>
            <span className={styles.providerLabel}>Live integrations</span>
            <div className={styles.providerChips}>
              {providers.slice(0, 6).map((p) => (
                <span className={styles.providerChip} key={p.name}>
                  <span className={styles.providerDot} /> {p.name}
                </span>
              ))}
              <span className={styles.providerChip}>+{providers.length - 6} more</span>
            </div>
          </div>
        </div>
        <aside className={styles.heroAside} aria-hidden="true">
          <div className={styles.terminal}>
            <span className={styles.muted}>{'→ github__push_files'}</span>
            <br />
            <span className={styles.muted}>{'  repo: acme/website'}</span>
            <br />
            <span className={styles.muted}>{'  branch: feature/new-ui'}</span>
            <br />
            <span className={styles.ok}>{'  risk: github.feature-branch-write'}</span>
            <br />
            <span className={styles.ok}>{'  ALLOW'}</span>
            <br />
            <br />
            <span className={styles.muted}>{'→ vercel__create_deployment'}</span>
            <br />
            <span className={styles.muted}>{'  project: prj_website · env: production'}</span>
            <br />
            <span className={styles.deny}>{'  risk: vercel.deploy-prod'}</span>
            <br />
            <span className={styles.deny}>{'  DENY — risk not accepted'}</span>
            <br />
            <br />
            <span className={styles.muted}>{'→ vercel__create_deployment'}</span>
            <br />
            <span className={styles.muted}>{'  project: prj_website · env: preview'}</span>
            <br />
            <span className={styles.ok}>{'  risk: vercel.deploy-preview'}</span>
            <br />
            <span className={styles.ok}>{'  ALLOW'}</span>
          </div>
        </aside>
      </section>

      {/* ─── THE PROBLEM ─── */}
      <section className={styles.section} id="problem">
        <h2 className={styles.sectionTitle}>Cloud IAM breaks at agent scale</h2>
        <p className={styles.sectionLead}>
          You&rsquo;ve moved past &ldquo;can AI code?&rdquo; The new bottleneck: giving a fleet of
          agents safe access to your infrastructure without spending a week on IAM per cloud.
        </p>
        <div className={styles.problemGrid}>
          {problems.map((p) => (
            <div className={styles.problemCard} key={p.title}>
              <h3 className={styles.problemTitle}>{p.title}</h3>
              <p className={styles.problemBody}>{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ─── RISK MODEL ─── */}
      <section className={styles.section} id="risk-model">
        <h2 className={styles.sectionTitle}>Think in risks, not permissions</h2>
        <p className={styles.sectionLead}>
          Instead of mapping tool &times; resource &times; action matrices across clouds, you check
          a box. ~15 risks per provider. Done in 30 seconds.
        </p>
        <div className={styles.riskCompare}>
          <div className={styles.riskSide}>
            <div className={styles.riskSideLabel}>
              <span className={styles.riskDotGood} />
              Vaubaan — risk checklist
            </div>
            <div className={styles.riskChecklist}>
              {riskChecklist.map((r) => (
                <label className={styles.riskRow} key={r.id}>
                  <span className={r.checked ? styles.checkOn : styles.checkOff}>
                    {r.checked ? '✓' : ' '}
                  </span>
                  <span className={styles.riskId}>{r.id}</span>
                  <span className={styles.riskLabel}>{r.label}</span>
                </label>
              ))}
            </div>
            <p className={styles.riskCaption}>
              Each risk carries a 6D severity vector: reversibility, blast radius, data sensitivity,
              cost, visibility, persistence. The UI sorts by severity — scan in 30 seconds.
            </p>
          </div>
          <div className={styles.riskSide}>
            <div className={styles.riskSideLabel}>
              <span className={styles.riskDotBad} />
              Without Vaubaan — per-cloud IAM
            </div>
            <div className={styles.riskCodeBlock}>
              <pre>
                <code>
                  {`// GitHub Fine-grained PAT
{
  "repositories": ["acme/website"],
  "permissions": {
    "contents": "write",
    "pull_requests": "write",
    "metadata": "read",
    "actions": "none",
    "administration": "none"
    // 18 more fields...
  }
}

// Now do Vercel. Now Supabase.
// Now Railway. Now Stripe.
// Now figure out which combo
// lets the agent deploy previews
// but not prod. Per cloud.`}
                </code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* ─── CHAIN OF DELEGATION ─── */}
      <section className={styles.section} id="delegation">
        <h2 className={styles.sectionTitle}>
          Agents delegate to agents. The envelope only shrinks.
        </h2>
        <p className={styles.sectionLead}>
          Any <code>vbn_live_*</code> token can mint children via{' '}
          <code>POST /api/v1/tokens/mint</code>. Each child gets a strict subset of the
          parent&rsquo;s risks. TTL is monotonically decreasing. Max depth is 5.
        </p>
        <div className={styles.delegationVisual}>
          <div className={styles.terminal}>
            <span className={styles.delegHuman}>{'Human'}</span>
            <span className={styles.muted}>{' (root · 12 risks · TTL 8h)'}</span>
            <br />
            <span className={styles.muted}>{'  └─ '}</span>
            <span className={styles.delegAgent}>{'Orchestrator'}</span>
            <span className={styles.muted}>{' (8 risks · TTL 4h)'}</span>
            <br />
            <span className={styles.muted}>{'       ├─ '}</span>
            <span className={styles.delegAgent}>{'Coder'}</span>
            <span className={styles.muted}>
              {' (3 risks: read-code, feature-branch, create-pr · TTL 1h)'}
            </span>
            <br />
            <span className={styles.muted}>{'       │    └─ '}</span>
            <span className={styles.delegAgent}>{'PR bot'}</span>
            <span className={styles.muted}>{' (1 risk: create-pr · single-use)'}</span>
            <br />
            <span className={styles.muted}>{'       └─ '}</span>
            <span className={styles.delegAgent}>{'Infra agent'}</span>
            <span className={styles.muted}>
              {' (4 risks: deploy-preview, read-logs, env-vars · TTL 1h)'}
            </span>
          </div>
        </div>
        <div className={styles.delegationFeatures}>
          <div className={styles.delegFeature}>
            <strong>Strict subset</strong>
            <p>
              A child can never hold a risk its parent doesn&rsquo;t. Escalation is out-of-band —
              the child asks the parent, not the gateway.
            </p>
          </div>
          <div className={styles.delegFeature}>
            <strong>Cascade revoke</strong>
            <p>
              Revoke a parent token — every descendant is cascade-deleted. One click, full cleanup.
            </p>
          </div>
          <div className={styles.delegFeature}>
            <strong>Full audit chain</strong>
            <p>
              Every audit entry records the full <code>delegation_chain</code> from root to leaf.
              Forensics traces who authorized what, at every level.
            </p>
          </div>
        </div>
      </section>

      {/* ─── ZERO LEAKED SECRETS ─── */}
      <section className={styles.section} id="zero-secrets">
        <h2 className={styles.sectionTitle}>The agent never sees a cloud credential</h2>
        <p className={styles.sectionLead}>
          Your agent authenticates with a <code>vbn_live_*</code> token. For every allowed call,
          Vaubaan mints a JIT upstream token (GitHub installation token, Vercel OAuth token, etc.),
          uses it once, and drops it. The agent&rsquo;s context never contains a real cloud secret.
        </p>
        <div className={styles.flowDiagram}>
          <div className={styles.flowStep}>
            <div className={styles.flowStepIcon}>Agent</div>
            <div className={styles.flowStepLabel}>
              <code>vbn_live_*</code>
            </div>
          </div>
          <div className={styles.flowArrow}>&rarr;</div>
          <div className={styles.flowStep}>
            <div className={styles.flowStepIcon}>Vaubaan</div>
            <div className={styles.flowStepLabel}>classify &rarr; check risks &rarr; audit</div>
          </div>
          <div className={styles.flowArrow}>&rarr;</div>
          <div className={styles.flowStep}>
            <div className={styles.flowStepIcon}>JIT token</div>
            <div className={styles.flowStepLabel}>minted, used once, dropped</div>
          </div>
          <div className={styles.flowArrow}>&rarr;</div>
          <div className={styles.flowStep}>
            <div className={styles.flowStepIcon}>Provider</div>
            <div className={styles.flowStepLabel}>GitHub, Vercel, Supabase&hellip;</div>
          </div>
        </div>
      </section>

      {/* ─── HOW IT WORKS ─── */}
      <section className={styles.section} id="how-it-works">
        <h2 className={styles.sectionTitle}>Four steps to your first audited call</h2>
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

      {/* ─── PROVIDERS ─── */}
      <section className={styles.section} id="providers">
        <h2 className={styles.sectionTitle}>One security model. {providers.length} providers.</h2>
        <p className={styles.sectionLead}>
          You learn one risk model, one token format, one audit schema. We handle the per-cloud
          complexity behind the proxy.
        </p>
        <div className={styles.providerGrid}>
          {providers.map((p) => (
            <div className={styles.providerGridItem} key={p.name}>
              <span className={styles.providerDot} />
              <span>{p.name}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ─── FOR AGENTS ─── */}
      <section className={styles.section} id="for-agents">
        <div className={styles.agentCallout}>
          <h2 className={styles.sectionTitle}>Building multi-agent systems?</h2>
          <p className={styles.sectionLead}>
            Read the agent-facing reference — written for LLMs. How to authenticate, delegate to
            sub-agents, handle denials, and escalate. Drop it in your agent&rsquo;s context.
          </p>
          <div className={styles.cta}>
            <Link href="/for-agents" className={styles.btnSecondary}>
              Agent reference &rarr;
            </Link>
          </div>
        </div>
      </section>

      {/* ─── BOTTOM CTA ─── */}
      <section className={styles.bottomCta}>
        <h2>Stop reverse-engineering IAM docs. Start shipping agents.</h2>
        <p>Free during private beta. No credit card.</p>
        <Link href={ctaPrimary.href} className={styles.btnPrimary}>
          {ctaPrimary.label}
        </Link>
      </section>
    </>
  );
}
