/**
 * The browser's side of a device subscription (spec §4.2 bis): whether this browser can
 * receive notifications, whether it already does, and the person's act that subscribes it.
 * Browser-only (the components that call it are client components); it imports no value
 * from the server (**[inv: client-imports-no-server-value]**): the route's path is spelled
 * here again, and `push-client.test.ts` keeps it equal to `DEVICES_API`.
 *
 * Subscribing asks the browser's permission first, then subscribes through the service
 * worker with the instance's public key, and posts the subscription to the gateway. Nothing
 * here runs without the person's click.
 */
import { postJson } from '@/lib/http/post-json';
import { NOTIFICATION_WORDS } from '@/lib/vocabulary';

/** `POST` of a subscription (`server/notifications/handlers.ts`, `DEVICES_API`). */
export const DEVICES_ROUTE = '/api/notifications/devices';
/** Where the service worker is served from: its scope is the whole interface. */
export const SERVICE_WORKER_URL = '/sw.js';
/** The per-device "Not now" of the home's proposal (a convenience of this browser only). */
export const NOT_NOW_KEY = 'vaubaan_push_not_now';

/**
 * - `unsupported`: no service worker, no Push API or no Notification API here;
 * - `install-first`: an iPhone or iPad whose page is not opened from the Home Screen,
 *   where Safari offers push only to an installed interface;
 * - `denied`: the person refused notifications for this site in the browser;
 * - `available`: supported, not subscribed;
 * - `subscribed`: this browser holds a subscription the gateway delivers to (its endpoint's
 *   digest is among the person's live devices). A subscription the gateway no longer knows
 *   (removed, dropped, taken over by another person) reads `available`.
 */
export type PushState = 'unsupported' | 'install-first' | 'denied' | 'available' | 'subscribed';

/** The browser facts the state is derived from: a pure function of them, tested alone. */
export interface PushFacts {
  readonly serviceWorker: boolean;
  readonly pushManager: boolean;
  readonly notification: boolean;
  /** An Apple touch device (iPhone, iPad, iPod; an iPad reads as a Mac with touch). */
  readonly appleTouch: boolean;
  /** `navigator.standalone`: `false` in Safari's tab, `true` from the Home Screen. */
  readonly standalone: boolean | undefined;
  readonly permission: NotificationPermission | null;
  readonly subscribed: boolean;
}

export function pushStateOf(facts: PushFacts): PushState {
  if (facts.appleTouch && facts.standalone === false) return 'install-first';
  if (!facts.serviceWorker || !facts.pushManager || !facts.notification) return 'unsupported';
  if (facts.subscribed) return 'subscribed';
  if (facts.permission === 'denied') return 'denied';
  return 'available';
}

/** The first pattern that matches names the system, then the browser (order matters). */
const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
];
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg\//, 'Edge'],
  [/Firefox\/|FxiOS/, 'Firefox'],
  [/Chrome\/|CriOS/, 'Chrome'],
  [/Safari\//, 'Safari'],
];

function firstMatch(
  table: ReadonlyArray<readonly [RegExp, string]>,
  userAgent: string,
): string | null {
  return table.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
}

/** "Chrome on Android", "Safari on iPhone": a first name the person can change. */
export function deviceLabelOf(userAgent: string): string {
  return NOTIFICATION_WORDS.deviceLabel(
    firstMatch(BROWSERS, userAgent),
    firstMatch(SYSTEMS, userAgent),
  );
}

/** SHA-256 of an endpoint, hex: how the gateway names a subscription without holding it. */
export async function endpointDigestOf(endpoint: string): Promise<string> {
  // nosemgrep: vaubaan-encryption-only-in-the-crypto-module -- a SHA-256 digest, no cipher and no key; the store computes the same (`endpointDigest`)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The URL-safe base64 of the public key, as `applicationServerKey` takes it. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isAppleTouch(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' });
  return navigator.serviceWorker.ready;
}

/** Whether this browser's subscription is one of the person's live devices. Never throws. */
async function deliveredTo(knownDigests: readonly string[]): Promise<boolean> {
  try {
    const existing = await navigator.serviceWorker.getRegistration('/');
    const subscription = await existing?.pushManager.getSubscription();
    if (!subscription) return false;
    return knownDigests.includes(await endpointDigestOf(subscription.endpoint));
  } catch {
    // expected: no service worker or push manager here: this browser is not one of the devices
    return false;
  }
}

/** What this browser can do now, given the digests of the person's live devices. */
export async function readPushState(knownDigests: readonly string[]): Promise<PushState> {
  const serviceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const pushManager = typeof window !== 'undefined' && 'PushManager' in window;
  const notification = typeof window !== 'undefined' && 'Notification' in window;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  const subscribed = serviceWorker && pushManager && (await deliveredTo(knownDigests));
  return pushStateOf({
    serviceWorker,
    pushManager,
    notification,
    appleTouch: isAppleTouch(),
    standalone,
    permission: notification ? Notification.permission : null,
    subscribed,
  });
}

export type SubscribeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'denied' }
  | { readonly ok: false; readonly reason: 'failed'; readonly message: string };

/** The sentence of a refused post: the gateway's code in the interface's words. */
function refusalOf(status: number, body: unknown, unreachable: string): string {
  if (status === 0) return unreachable;
  const code =
    typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : null;
  const problems: Readonly<Record<string, string>> = NOTIFICATION_WORDS.problems;
  return typeof code === 'string' && Object.hasOwn(problems, code)
    ? (problems[code] ?? NOTIFICATION_WORDS.failed)
    : NOTIFICATION_WORDS.failed;
}

/** The browser's subscription, made now when it holds none; `null` when it cannot. */
async function subscriptionFor(
  publicKey: string,
): Promise<{ readonly subscription: PushSubscription; readonly createdNow: boolean } | null> {
  try {
    const worker = await registration();
    const existing = await worker.pushManager.getSubscription();
    if (existing) return { subscription: existing, createdNow: false };
    const subscription = await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    });
    return { subscription, createdNow: true };
  } catch {
    // expected: the browser refused the subscription: the caller reports it failed
    return null;
  }
}

/** The person's act: permission, subscription, post. */
export async function subscribeThisDevice(publicKey: string): Promise<SubscribeOutcome> {
  const failed = { ok: false, reason: 'failed', message: NOTIFICATION_WORDS.failed } as const;
  try {
    if ((await Notification.requestPermission()) !== 'granted')
      return { ok: false, reason: 'denied' };
  } catch {
    // expected: the permission prompt is unavailable in this browser: reported as failed
    return failed;
  }
  const held = await subscriptionFor(publicKey);
  if (held === null) return failed;
  const { subscription, createdNow } = held;
  const answer = await postJson(DEVICES_ROUTE, {
    subscription: subscription.toJSON(),
    label: deviceLabelOf(navigator.userAgent),
  });
  if (answer.ok) return { ok: true };
  // A subscription made for this post and refused by the gateway is not kept by the browser.
  if (createdNow) await subscription.unsubscribe().catch(() => false);
  return {
    ok: false,
    reason: 'failed',
    message: refusalOf(answer.status, answer.body, answer.message),
  };
}

/** Whether the person put the home's proposal off on this browser. */
export function proposalPutOff(): boolean {
  try {
    return window.localStorage.getItem(NOT_NOW_KEY) !== null;
  } catch {
    // expected: storage refused: the proposal counts as not put off
    return false;
  }
}

export function putProposalOff(): void {
  try {
    window.localStorage.setItem(NOT_NOW_KEY, new Date().toISOString());
  } catch {
    // expected: a browser that keeps nothing asks again next time: that is all.
  }
}
