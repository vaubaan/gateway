/**
 * How the gateway's requests reach an OAuth broker (ADR
 * oauth-broker-stateless-in-an-attested-enclave D4, D6). Two channels, one
 * shape (`BrokerChannel.send`: a JSON POST, its status and its text):
 *
 *   - `FetchChannel`, for a broker declared `attestation: none`: an ordinary
 *     HTTPS service, certificate checked by the system's authorities.
 *   - `AttestedChannel`, for every other broker. Its TLS key is the
 *     enclave's own and no authority vouches for it, so the certificate chain
 *     is not checked on this connection — and only on it: the socket is the
 *     channel's own (`tls.connect`), never a global agent, and nothing is
 *     written on it before its key is the pinned one. The pin comes from
 *     `POST /attest` (no body) answered on a connection presenting that key,
 *     with evidence carrying the key's SPKI hash, checked by the
 *     `AttestationVerifier`. `/attest` carries no broker key: the key is sent
 *     only on a connection whose key is pinned and verified. A pin lasts
 *     min(evidence expiry, 1 h). A broker that presents another key (it
 *     restarted) is attested again once; a key no attestation carries gets
 *     nothing. One pin per broker: the broker runs as a single replica.
 *
 * Time: every request (the attestation, a call) waits at most
 * `BROKER_REQUEST_TIMEOUT_MS`. The attestation is shared by the calls that
 * need it and runs on its own deadline; each caller waits for it no longer
 * than its own signal allows. A call through an attested channel may thus
 * take an attestation and a request: `budgetMs`.
 *
 * Failures: `BrokerChannelError` (`kind: 'unreachable'` — no answer, too slow
 * —, `'attest-answered'` — `/attest` refused — or `'not-attested'`), whose
 * message is the gateway's own sentence.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

import {
  AttestationRefused,
  MAX_PIN_MS,
  NO_ADMITTED_VERSION,
  spkiHashOf,
  type AdmittedBroker,
  type AttestationVerifier,
} from './broker-attestation';

/** A broker request (the attestation, or a call) that does not answer within this delay is unreachable. */
export const BROKER_REQUEST_TIMEOUT_MS = 15_000;
/** The longest a call through an attested channel may take: an attestation, then the request. */
export const ATTESTED_CALL_BUDGET_MS = 2 * BROKER_REQUEST_TIMEOUT_MS;

/** The largest answer read from a broker; its answers are a few hundred bytes. */
export const MAX_ANSWER_BYTES = 256 * 1024;

export interface ChannelAnswer {
  readonly status: number;
  readonly text: string;
}

export class BrokerChannelError extends Error {
  constructor(
    /**
     * `unreachable`: no answer. `attest-answered`: `/attest` answered another
     * status than 200 (`status`) — down, or refusing the key. `not-attested`:
     * the attestation did not check out.
     */
    readonly kind: 'unreachable' | 'attest-answered' | 'not-attested',
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'BrokerChannelError';
  }
}

export interface BrokerChannel {
  /** POST `body` (JSON) to `<base url><path>` with the broker key; `signal` bounds the whole call. */
  send(path: string, body: string, signal: AbortSignal): Promise<ChannelAnswer>;
  /** The longest `send` may take: the delay its caller's signal should allow. */
  readonly budgetMs: number;
  /** The broker version the current pin admitted; `null` when not attested (yet, or ever). */
  readonly admitted: AdmittedBroker | null;
}

/** The JSON headers: the key as a Bearer when given, a content type when there is a body. */
function headers(key: string | null, withBody = true): Record<string, string> {
  return {
    ...(key === null ? {} : { Authorization: `Bearer ${key}` }),
    Accept: 'application/json',
    ...(withBody ? { 'Content-Type': 'application/json' } : {}),
  };
}

function endpoint(base: URL, path: string): URL {
  return new URL(`${base.href.replace(/\/+$/, '')}${path}`);
}

/** The reason of a transport failure: an error's name, never its text. */
function reasonOf(err: unknown): string {
  return err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'error';
}

/** A broker that is not attested (`attestation: none`): plain HTTPS through `fetch`. */
export class FetchChannel implements BrokerChannel {
  readonly admitted = null;
  readonly budgetMs = BROKER_REQUEST_TIMEOUT_MS;

  constructor(
    private readonly base: URL,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async send(path: string, body: string, signal: AbortSignal): Promise<ChannelAnswer> {
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint(this.base, path).href, {
        method: 'POST',
        headers: headers(this.key),
        body,
        redirect: 'error',
        signal,
      });
    } catch (err) {
      throw new BrokerChannelError('unreachable', `could not be reached (${reasonOf(err)})`);
    }
    return { status: response.status, text: await readCapped(response) };
  }
}

/** The answer's text, read up to `MAX_ANSWER_BYTES`; a longer one is refused. */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ANSWER_BYTES) {
        await reader.cancel();
        throw new BrokerChannelError('unreachable', 'answered more than a broker answers');
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof BrokerChannelError) throw err;
    throw new BrokerChannelError('unreachable', `could not be reached (${reasonOf(err)})`);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `promise`, or a rejection as soon as `signal` aborts: a caller stops waiting, the work goes on. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = (): BrokerChannelError =>
    new BrokerChannelError('unreachable', `could not be reached (${reasonOf(signal.reason)})`);
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** The caller's signal, cut to one request's delay. */
function oneRequest(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS)]);
}

interface Pin {
  readonly spkiHash: string;
  readonly until: number;
  readonly admitted: AdmittedBroker;
}

export interface AttestedChannelDeps {
  readonly verifier: AttestationVerifier;
  readonly now: () => number;
}

/** A broker in an attested enclave: every call over a connection whose key is pinned. */
export class AttestedChannel implements BrokerChannel {
  private pin: Pin | null = null;
  private attesting: Promise<Pin> | null = null;
  readonly budgetMs = ATTESTED_CALL_BUDGET_MS;

  constructor(
    private readonly base: URL,
    private readonly key: string,
    private readonly deps: AttestedChannelDeps,
  ) {}

  get admitted(): AdmittedBroker | null {
    return this.pin && this.pin.until > this.deps.now() ? this.pin.admitted : null;
  }

  async send(path: string, body: string, signal: AbortSignal): Promise<ChannelAnswer> {
    if (!this.deps.verifier.admitsAny) {
      throw new BrokerChannelError('not-attested', NO_ADMITTED_VERSION);
    }
    let pin = await this.currentPin(signal);
    let request = oneRequest(signal);
    let socket = await this.open(request);
    if (spkiOf(socket) !== pin.spkiHash) {
      // Another key than the attested one: the enclave restarted, or someone else answers.
      socket.destroy();
      this.pin = null;
      pin = await this.currentPin(signal);
      request = oneRequest(signal);
      socket = await this.open(request);
      if (spkiOf(socket) !== pin.spkiHash) {
        socket.destroy();
        this.pin = null;
        throw new BrokerChannelError(
          'not-attested',
          'presented a TLS key that no attestation carries',
        );
      }
    }
    return this.exchange(socket, path, body, request, { withKey: true });
  }

  /**
   * The pin in force, or a new one from `POST /attest`. One attestation at a
   * time, on its own deadline, shared by the callers that need it: a caller
   * whose signal aborts stops waiting without cutting it short for the others.
   */
  private async currentPin(signal: AbortSignal): Promise<Pin> {
    if (this.pin && this.pin.until > this.deps.now()) return this.pin;
    this.attesting ??= this.attest(AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS)).finally(() => {
      this.attesting = null;
    });
    return untilAborted(this.attesting, signal);
  }

  private async attest(signal: AbortSignal): Promise<Pin> {
    const socket = await this.open(signal);
    const spkiHash = spkiOf(socket);
    // No broker key: this connection's key is not verified yet, and the key goes
    // only where an attestation vouches for who listens.
    const answer = await this.exchange(socket, '/attest', '', signal, {
      withKey: false,
    });
    if (answer.status !== 200) {
      throw new BrokerChannelError(
        'attest-answered',
        `answered ${answer.status} to attest`,
        answer.status,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.text);
    } catch {
      parsed = null;
    }
    const now = this.deps.now();
    let admitted: AdmittedBroker;
    try {
      admitted = await this.deps.verifier.verify(parsed, {
        spkiHash,
        now: new Date(now),
      });
    } catch (err) {
      if (err instanceof AttestationRefused)
        throw new BrokerChannelError('not-attested', err.message);
      throw err;
    }
    const pin: Pin = { spkiHash, until: Math.min(admitted.expiresAt, now + MAX_PIN_MS), admitted };
    this.pin = pin;
    return pin;
  }

  /**
   * A TLS connection of its own to the broker, handshake done, nothing written.
   * The chain is not checked here (the enclave's key is self-issued): the
   * caller compares the presented key with the pin before it writes a byte.
   */
  private open(signal: AbortSignal): Promise<TLSSocket> {
    const host = this.base.hostname.replace(/^\[|\]$/g, '');
    const port = Number(this.base.port || 443);
    return new Promise<TLSSocket>((resolve, reject) => {
      if (signal.aborted) {
        reject(
          new BrokerChannelError(
            'unreachable',
            `could not be reached (${reasonOf(signal.reason)})`,
          ),
        );
        return;
      }
      const socket = tlsConnect({
        host,
        port,
        ...(isIP(host) ? {} : { servername: host }),
        // Verified by the pin instead, before anything is written: see `send`.
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
      });
      const onAbort = (): void => {
        socket.destroy();
        reject(
          new BrokerChannelError(
            'unreachable',
            `could not be reached (${reasonOf(signal.reason)})`,
          ),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      socket.once('secureConnect', () => {
        signal.removeEventListener('abort', onAbort);
        resolve(socket);
      });
      socket.once('error', (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(new BrokerChannelError('unreachable', `could not be reached (${reasonOf(err)})`));
      });
    });
  }

  /**
   * One HTTP/1.1 request on a socket; the socket closes after it. The broker
   * key is sent only on a socket whose key is the pinned one (`withKey`).
   */
  private exchange(
    socket: TLSSocket,
    path: string,
    body: string,
    signal: AbortSignal,
    options: { readonly withKey: boolean },
  ): Promise<ChannelAnswer> {
    const url = endpoint(this.base, path);
    return new Promise<ChannelAnswer>((resolve, reject) => {
      const fail = (err: unknown): void => {
        socket.destroy();
        reject(
          err instanceof BrokerChannelError
            ? err
            : new BrokerChannelError('unreachable', `could not be reached (${reasonOf(err)})`),
        );
      };
      const req = httpRequest({
        host: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          ...headers(options.withKey ? this.key : null, body !== ''),
          'Content-Length': String(Buffer.byteLength(body)),
          Host: url.host,
          Connection: 'close',
        },
        createConnection: () => socket,
        signal,
      });
      req.once('error', fail);
      req.once('response', (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ANSWER_BYTES) {
            res.destroy();
            fail(new BrokerChannelError('unreachable', 'answered more than a broker answers'));
            return;
          }
          chunks.push(chunk);
        });
        res.once('error', fail);
        res.once('end', () => {
          socket.end();
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req.end(body);
    });
  }
}

function spkiOf(socket: TLSSocket): string {
  const certificate = socket.getPeerX509Certificate();
  if (!certificate) {
    socket.destroy();
    throw new BrokerChannelError('not-attested', 'presented no TLS certificate');
  }
  return spkiHashOf(certificate);
}
