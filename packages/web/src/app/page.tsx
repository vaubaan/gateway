import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Button, Card, CardBody, CardHeader, CardTitle, Stack } from '@/components/ui';

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
    <main>
      <section style={{ paddingTop: 'var(--space-12)', maxWidth: 720 }}>
        <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: '-0.03em' }}>Vauban</h1>
        <p
          style={{
            color: 'var(--text-muted)',
            fontSize: 'var(--text-lg)',
            marginTop: 'var(--space-2)',
          }}
        >
          Policy-enforcing MCP gateway for coding agents.
        </p>
        <p style={{ color: 'var(--text-muted)', marginTop: 'var(--space-4)' }}>
          Filter and audit each MCP tool call from Claude Code, Cursor and the rest — without ever
          giving them a cloud provider token.
        </p>
        <div style={{ marginTop: 'var(--space-6)' }}>
          {userEmail ? (
            <Link href="/dashboard">
              <Button variant="primary">Open dashboard</Button>
            </Link>
          ) : (
            <Link href="/login">
              <Button variant="primary">Sign in</Button>
            </Link>
          )}
        </div>
      </section>

      <section style={{ marginTop: 'var(--space-16)' }}>
        <h2>How it works</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 'var(--space-3)',
            marginTop: 'var(--space-3)',
          }}
        >
          {steps.map((s, i) => (
            <Card key={i}>
              <CardHeader>
                <CardTitle>
                  <span style={{ color: 'var(--text-subtle)', marginRight: 8 }}>0{i + 1}</span>
                  {s.title}
                </CardTitle>
              </CardHeader>
              <CardBody>
                <Stack gap="var(--space-2)">
                  <p style={{ color: 'var(--text-muted)', margin: 0 }}>{s.body}</p>
                </Stack>
              </CardBody>
            </Card>
          ))}
        </div>
      </section>
    </main>
  );
}

const steps = [
  {
    title: 'Connect providers',
    body: 'GitHub App install · Vercel team token · Supabase Mgmt PAT. No paste-token, no agent ever sees the secret.',
  },
  {
    title: 'Bind resources',
    body: 'Pin each project to specific repos / Vercel projects / Supabase project_refs.',
  },
  {
    title: 'Compose Roles → Bot',
    body: 'Builtins (github:developer, vercel:viewer…) or custom — attach N to a Bot. Get a vbn_live_… api_key visible once.',
  },
  {
    title: 'Drop key, ship',
    body: 'Paste in your agent’s mcp.json. Every call → authorize, mint JIT, forward, audit.',
  },
];
