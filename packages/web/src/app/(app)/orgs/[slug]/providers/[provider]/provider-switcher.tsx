'use client';

/**
 * Tiny client-side dropdown for jumping between provider info pages
 * without going through the providers list. Lives in the header of
 * /orgs/[slug]/providers/[provider] (the per-provider rings docs page).
 */

import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui';

export interface ProviderOption {
  slug: string;
  displayName: string;
}

export function ProviderSwitcher({
  orgSlug,
  current,
  options,
}: {
  orgSlug: string;
  current: string;
  options: ProviderOption[];
}) {
  const router = useRouter();
  return (
    <Select
      value={current}
      onChange={(e) => {
        const next = e.target.value;
        if (next && next !== current) {
          router.push(`/orgs/${orgSlug}/providers/${next}`);
        }
      }}
      style={{ width: 'auto' }}
      aria-label="Switch provider"
    >
      {options.map((p) => (
        <option key={p.slug} value={p.slug}>
          {p.displayName}
        </option>
      ))}
    </Select>
  );
}
