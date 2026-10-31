/**
 * Reading a posted form, the same way on every handler that takes one
 * (gateway audit 2026-10-31, F3: one helper instead of a copy per handler file).
 */

const BAD_REQUEST = 400;

/** The form of a request, or `null` when the body is not one. */
export async function readForm(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

/** 400: a mutation that takes a form received something else. */
export function notAFormResponse(): Response {
  return new Response(
    JSON.stringify({ error: 'invalid-request', reason: 'a form body is required' }),
    {
      status: BAD_REQUEST,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  );
}

/** A text field, trimmed; `''` when absent or a file. */
export function stringField(form: FormData, name: string): string {
  return rawField(form, name).trim();
}

/**
 * A text field exactly as typed — a password, a code: a space is part of what the
 * person chose; `''` when absent or a file.
 */
export function rawField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** Splits the textarea/env style input: whitespace, comma or newline separated. */
export function splitList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
