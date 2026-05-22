import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';

import './globals.css';

export const metadata: Metadata = {
  title: 'Cloud Resource Manager',
  description: 'Vauban Cloud Resource Manager — inventory, sealed creds (ZK), MCP exports.',
};

// Sets data-theme on <html> before paint to avoid FOUC. Reads explicit
// override from localStorage (`crm.theme`); absent → prefers-color-scheme
// from globals.css applies.
const themeBootstrap = `(function(){try{var t=localStorage.getItem('crm.theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(_){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
