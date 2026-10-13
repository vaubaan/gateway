/**
 * `npm run demo` — the whole web interface in a normal browser, without an
 * OIDC client or a provider app to register (handbook demo-mode).
 *
 *   DEMO_PORT=<port>      listen on another port (default 3210)
 *   DEMO_KEEP=1           keep the SQLite file and the log on exit
 *   DEMO_SKIP_BUILD=1     serve the existing build as it is, whatever it was built from
 *
 * The application is built on the first start and again only when a file a
 * build reads has changed since (`build-stamp.ts`).
 *
 * Never part of the image: this file lives under `tests/`, and it refuses to
 * start in a production environment or next to a real configuration
 * (`guards.ts`).
 */
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIsFresh, sourceDigest, writeBuildStamp } from './build-stamp';
import { BUILD_DIR, hasBuild, startDemo, type RunningDemo } from './demo-instance';
import { assertDemoAllowed, demoPort, DemoRefusal } from './guards';
import { DEMO_BANNER, tourText } from './tour';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const say = (line: string): void => void process.stdout.write(`${line}\n`);

/**
 * The last line of defence of "no data leaves this machine": whatever in this
 * process reaches for the global `fetch` towards another host is refused, and
 * says so. The instance's own outbound calls never get here — they are routed
 * to the simulated providers and the demo IdP by the composition root.
 */
function refuseNonLoopbackFetch(): void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      const message = `demo mode: outbound request to ${url.origin} refused — nothing leaves this machine`;
      process.stderr.write(`\n${message}\n`);
      throw new Error(message);
    }
    return original(input, init);
  };
}

function build(): void {
  const result = spawnSync('npm', ['run', 'build', '--workspace', '@vaubaan/gateway-app'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('the build failed; see the output above');
}

/**
 * Serves the build that is there when it is the build of the sources as they
 * are; builds otherwise, and stamps what it built. `DEMO_SKIP_BUILD=1` serves
 * whatever build exists without looking.
 */
function ensureBuild(env: NodeJS.ProcessEnv): void {
  if (env.DEMO_SKIP_BUILD === '1' && hasBuild()) {
    say('Serving the existing build as it is (DEMO_SKIP_BUILD=1).');
    return;
  }
  // The digest is taken before the build: a file edited while it runs makes
  // the next start build again.
  const digest = sourceDigest(REPO_ROOT);
  if (buildIsFresh(BUILD_DIR, digest)) {
    say('The web application is already built from these sources.');
    return;
  }
  say(
    hasBuild()
      ? 'The sources changed since the last build: building the web application…'
      : 'Building the web application…',
  );
  build();
  writeBuildStamp(BUILD_DIR, digest);
}

async function main(): Promise<void> {
  // Before anything is built or opened.
  assertDemoAllowed(process.env);
  const port = demoPort(process.env);
  say(DEMO_BANNER);

  ensureBuild(process.env);
  // Next's own anonymous usage reports are an outbound call too.
  process.env.NEXT_TELEMETRY_DISABLED = '1';
  refuseNonLoopbackFetch();

  let demo: RunningDemo;
  try {
    demo = await startDemo({
      port,
      keepStore: process.env.DEMO_KEEP === '1',
      progress: (line) => say(`  … ${line}`),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new DemoRefusal(
        `port ${port} is taken. Choose another one: DEMO_PORT=<port> npm run demo`,
      );
    }
    throw err;
  }
  say(tourText({ ...demo, host: hostname() }));

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    say('\nStopping the demo…');
    demo
      .close()
      .then(() => {
        say(
          demo.kept ? `Data kept in ${demo.directory}` : `Data deleted (${demo.directory}). Bye.`,
        );
        process.exit(0);
      })
      .catch((err: unknown) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => {
  const refusal = err instanceof DemoRefusal;
  process.stderr.write(
    `${err instanceof Error ? (refusal ? err.message : (err.stack ?? err.message)) : String(err)}\n`,
  );
  process.exit(refusal ? 2 : 1);
});
