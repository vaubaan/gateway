import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vauban — MCP Proxy',
  description: 'Policy-enforcing MCP gateway for coding agents.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
