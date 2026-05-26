import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vaubaan — MCP gateway for coding agents',
  description:
    'Policy-enforcing MCP gateway. Filter and audit each MCP tool call from Claude Code, Cursor and the rest — without ever giving them a cloud provider token.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
