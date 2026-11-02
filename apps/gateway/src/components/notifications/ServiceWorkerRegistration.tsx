'use client';

/**
 * Registers the service worker of notifications (`public/sw.js`) once the shell is shown,
 * so that an installed interface keeps its subscription working. It renders nothing and
 * asks nothing: the browser's permission is asked only by the person's click on
 * "Receive notifications on this device".
 */
import { useEffect } from 'react';

import { SERVICE_WORKER_URL } from '@/lib/notifications/push-client';

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' }).catch(() => {
      // An http instance, a private window: the interface works the same without it.
    });
  }, []);
  return null;
}
