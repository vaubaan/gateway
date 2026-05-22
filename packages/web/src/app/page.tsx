import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase/server';

export default async function HomePage() {
  // Don't require Supabase env vars at build time — gracefully render landing
  // even if envs are missing (e.g. preview deploy with placeholder config).
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
      <h1 style={{ fontSize: 40, marginBottom: 8 }}>Vauban</h1>
      <p style={{ opacity: 0.75, marginTop: 0 }}>Policy-enforcing MCP gateway for coding agents.</p>
      <p>
        Filter and audit each MCP tool call from your Coding Agent (Claude Code, Cursor…) without
        ever giving it a cloud provider token.
      </p>

      <div style={{ marginTop: 32 }}>
        {userEmail ? (
          <Link href="/dashboard">
            <button
              type="button"
              style={{
                padding: '10px 18px',
                background: '#fff',
                color: '#000',
                border: 0,
                borderRadius: 6,
              }}
            >
              Open dashboard
            </button>
          </Link>
        ) : (
          <Link href="/login">
            <button
              type="button"
              style={{
                padding: '10px 18px',
                background: '#fff',
                color: '#000',
                border: 0,
                borderRadius: 6,
              }}
            >
              Sign in
            </button>
          </Link>
        )}
      </div>

      <section style={{ marginTop: 48, opacity: 0.85 }}>
        <h2 style={{ fontSize: 18 }}>How it works</h2>
        <ol style={{ lineHeight: 1.7 }}>
          <li>Connect your cloud providers (GitHub App install — no paste-token).</li>
          <li>Create projects, bind them to specific resources, attach Roles to Bots.</li>
          <li>Each Bot gets a `vbn_live_…` api_key. Drop it in your agent&apos;s `mcp.json`.</li>
          <li>Every tool call passes through `/mcp` : authorize, audit, mint, forward.</li>
        </ol>
      </section>
    </main>
  );
}
