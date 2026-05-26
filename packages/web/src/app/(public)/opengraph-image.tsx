import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Vaubaan — Policy-enforcing MCP gateway for coding agents';

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '64px 72px',
        fontFamily: 'system-ui, sans-serif',
        color: '#0a0a0a',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 8,
            background: '#0a0a0a',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 700,
            fontSize: 26,
            letterSpacing: -1,
          }}
        >
          V
        </div>
        <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: -0.5 }}>Vaubaan</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div
          style={{
            fontSize: 64,
            fontWeight: 600,
            letterSpacing: -2,
            lineHeight: 1.05,
            maxWidth: 950,
          }}
        >
          The agent never sees the secret.
        </div>
        <div style={{ fontSize: 26, color: '#525252', maxWidth: 900, lineHeight: 1.35 }}>
          Policy-enforcing MCP gateway for coding agents. Filter and audit every tool call against
          GitHub, Vercel and Supabase.
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 20,
          color: '#737373',
        }}
      >
        <div>vaubaan.com</div>
        <div style={{ display: 'flex', gap: 24 }}>
          <span>github</span>
          <span>vercel</span>
          <span>supabase</span>
        </div>
      </div>
    </div>,
    { ...size },
  );
}
