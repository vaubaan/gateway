import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { TopBar } from '@/components/topbar';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vauban — MCP Proxy',
  description: 'Policy-enforcing MCP gateway for coding agents.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <TopBar />
        {children}
      </body>
    </html>
  );
}
