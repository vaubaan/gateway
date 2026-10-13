import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vaubaan Gateway',
  description:
    'Self-hosted MCP gateway: agents call provider tools with a mission token; every call is checked against the accepted risks and budget of the mission, executed with a credential that stays on the instance, and audited.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
