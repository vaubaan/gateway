/**
 * Landing page — v1 init placeholder.
 *
 * Confirms the scaffold builds, runs, and serves a route. Real UI lands
 * in later phases (resources listing, secret managers, exports).
 */

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">CRM init OK</h1>
      <p className="text-lg text-neutral-400">
        Cloud Resource Manager scaffold is live. UI lands in later phases — see{' '}
        <code className="rounded bg-neutral-800 px-1.5 py-0.5 text-sm">
          docs/spec/cloud-resource-manager.md
        </code>{' '}
        for the roadmap.
      </p>
    </main>
  );
}
