import { type IncomingMessage, type ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 16 * 1024;

/** An answer the handlers give by throwing it: `{error, message}` with a status. */
export class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...NO_STORE,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendError(res: ServerResponse, error: HttpError): void {
  if (error.status === 401) res.setHeader('www-authenticate', 'Bearer');
  sendJson(res, error.status, { error: error.code, message: error.message });
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, NO_STORE);
  res.end();
}

export function sendRedirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { ...NO_STORE, location, 'referrer-policy': 'no-referrer' });
  res.end();
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    ...NO_STORE,
    'content-type': 'text/plain; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** The JSON object of a request body, at most MAX_BODY_BYTES. */
export async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new HttpError(415, 'invalid_request', 'Content-Type must be application/json');
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'invalid_request', 'body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'invalid_request', 'body too large');
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_request', 'body is not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_request', 'body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

/** A string field matching `pattern` (which bounds its length), or undefined. */
export function field(
  body: Record<string, unknown>,
  name: string,
  pattern: RegExp,
): string | undefined {
  const value = body[name];
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}
