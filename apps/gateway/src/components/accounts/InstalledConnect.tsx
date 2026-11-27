'use client';

/**
 * The connect form of a service served by Vaubaan's installed-app client (local mode;
 * ADR local-instance-carries-installed-oauth-clients). It takes over the form's submit:
 * the gateway answers where to go (`respond=json`), the window goes there — a browser
 * follows, the desktop app opens the provider's page in the default browser and keeps
 * this page, which then polls `/connections/loopback/status` until the consent is given
 * there and opens the callback that finishes the connection.
 */
import { useEffect, useRef, useState } from 'react';

import { Callout } from '@/components/ui';

const POLL_MS = 1500;
/** As long as the gateway keeps the flow: ten minutes. */
const GIVE_UP_MS = 10 * 60_000;

function locationOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('location' in body)) return null;
  return typeof body.location === 'string' ? body.location : null;
}

function statusOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('status' in body)) return null;
  return typeof body.status === 'string' ? body.status : null;
}

async function postJson(url: string, body?: FormData): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', ...(body ? { body } : {}) });
  return response.json().catch(() => null);
}

export function InstalledConnect({
  formId,
  serviceName,
}: {
  readonly formId: string;
  readonly serviceName: string;
}) {
  const [state, setState] = useState<'idle' | 'waiting' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return undefined;

    async function check(until: number): Promise<void> {
      let body: unknown = null;
      try {
        body = await postJson('/connections/loopback/status');
      } catch {
        // The gateway restarting: the next poll tries again.
      }
      const status = statusOf(body);
      const location = locationOf(body);
      if (status === 'done' && location) {
        window.location.assign(location);
        return;
      }
      if (status === 'none' || Date.now() > until) {
        setState('failed');
        return;
      }
      poll(until);
    }

    function poll(until: number): void {
      timer.current = setTimeout(() => void check(until), POLL_MS);
    }

    async function submit(event: SubmitEvent): Promise<void> {
      event.preventDefault();
      if (!(form instanceof HTMLFormElement)) return;
      const data = new FormData(form);
      data.set('respond', 'json');
      let location: string | null = null;
      try {
        location = locationOf(await postJson(form.action, data));
      } catch {
        // reported below
      }
      if (!location) {
        setState('failed');
        return;
      }
      window.location.assign(location);
      // Only a page the provider opened elsewhere keeps this window: wait for it.
      if (new URL(location, window.location.href).origin !== window.location.origin) {
        setState('waiting');
        poll(Date.now() + GIVE_UP_MS);
      }
    }

    const onSubmit = (event: SubmitEvent) => void submit(event);
    form.addEventListener('submit', onSubmit);
    return () => {
      form.removeEventListener('submit', onSubmit);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [formId]);

  if (state === 'waiting') {
    return (
      <Callout
        tone="neutral"
        title={`Finish with ${serviceName}`}
        testId="installed-connect-waiting"
      >
        If {serviceName} opened in your browser, allow Vaubaan there: this window goes on by itself
        once you have.
      </Callout>
    );
  }
  if (state === 'failed') {
    return (
      <Callout tone="bad" title="Not connected" testId="installed-connect-failed">
        The connection expired or could not start. Try again.
      </Callout>
    );
  }
  return null;
}
