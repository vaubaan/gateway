/**
 * Next.js instrumentation hook: runs once when the server starts, before it
 * serves a request. Builds the composition root (fail-fast on configuration
 * errors) on the Node runtime only; `next build` also evaluates this file,
 * hence the phase guard. Then Next's own `console.error` / `console.warn` go
 * through the redactor, error messages withheld (`server/logging/console-guard.ts`).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { bootOrExit, guardFrameworkLogging } = await import('./server/compose/boot');
  await bootOrExit();
  await guardFrameworkLogging();
}
