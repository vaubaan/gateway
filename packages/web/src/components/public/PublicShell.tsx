import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase/server';
import styles from './PublicShell.module.css';

const YEAR = new Date().getFullYear();

export async function PublicShell({ children }: { children: React.ReactNode }) {
  let email: string | null = null;
  try {
    const supabase = await getSupabaseServer();
    const { data } = await supabase.auth.getUser();
    email = data.user?.email ?? null;
  } catch {
    email = null;
  }
  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.brand}>
          <span className={styles.brandMark}>V</span>
          <span>Vaubaan</span>
        </Link>
        <nav className={styles.nav}>
          <Link href="/security" className={styles.navLink}>
            Security
          </Link>
          <Link href="/privacy" className={styles.navLink}>
            Privacy
          </Link>
          <Link href="/terms" className={styles.navLink}>
            Terms
          </Link>
          <a
            href="https://github.com/sbw-vaubaan/mcp-proxy"
            target="_blank"
            rel="noreferrer noopener"
            className={styles.navLink}
          >
            GitHub
          </a>
          {email ? (
            <Link href="/dashboard" className={styles.cta}>
              Dashboard
            </Link>
          ) : (
            <Link href="/login" className={styles.cta}>
              Sign in
            </Link>
          )}
        </nav>
      </header>
      <main className={styles.content}>{children}</main>
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            <Link href="/" className={styles.brand}>
              <span className={styles.brandMark}>V</span>
              <span>Vaubaan</span>
            </Link>
            <p className={styles.footerTag}>
              Policy-enforcing MCP gateway for coding agents. Filter and audit each tool call —
              without ever giving an agent a cloud provider token.
            </p>
          </div>
          <div className={styles.footerCol}>
            <h4>Product</h4>
            <ul>
              <li>
                <Link href="/#how-it-works">How it works</Link>
              </li>
              <li>
                <Link href="/security">Security</Link>
              </li>
              <li>
                <Link href="/integrations">Integrations</Link>
              </li>
              <li>
                <Link href="/changelog">Changelog</Link>
              </li>
            </ul>
          </div>
          <div className={styles.footerCol}>
            <h4>Company</h4>
            <ul>
              <li>
                <Link href="/about">About</Link>
              </li>
              <li>
                <Link href="/contact">Contact</Link>
              </li>
              <li>
                <Link href="/brand">Brand</Link>
              </li>
              <li>
                <a href="https://github.com/sbw-vaubaan" target="_blank" rel="noreferrer noopener">
                  GitHub
                </a>
              </li>
            </ul>
          </div>
          <div className={styles.footerCol}>
            <h4>Legal</h4>
            <ul>
              <li>
                <Link href="/privacy">Privacy</Link>
              </li>
              <li>
                <Link href="/terms">Terms</Link>
              </li>
              <li>
                <Link href="/dpa">DPA</Link>
              </li>
              <li>
                <Link href="/subprocessors">Subprocessors</Link>
              </li>
            </ul>
          </div>
        </div>
        <div className={styles.copyline}>
          <span>© {YEAR} Vaubaan. All rights reserved.</span>
          <span>vaubaan.com</span>
        </div>
      </footer>
    </div>
  );
}
