/**
 * Next.js instrumentation hook: runs once when the server starts, before it
 * serves a request. Builds the composition root (fail-fast on configuration
 * errors) on the Node runtime only; `next build` also evaluates this file,
 * hence the phase guard.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { bootOrExit } = await import('./server/compose/boot');
  await bootOrExit();
}
