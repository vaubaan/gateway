import type { ReactNode } from 'react';

import { IdentityGate } from '@/components/identity/IdentityGate';

/**
 * Layout for routes that require a Supabase session AND an unlocked
 * crypto identity. Empty in this phase — Resources / Access routes
 * land here in later phases. Provided now so the gate has a stable
 * mount point.
 */
export default function ProtectedLayout({ children }: { children: ReactNode }) {
  return <IdentityGate>{children}</IdentityGate>;
}
