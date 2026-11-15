/**
 * What a log line may say about an unexpected error: its class and where it was
 * thrown — never its message, which can quote a call's arguments or a service's
 * answer (and so a credential the service echoed).
 */
import { upstreamErrorClassName } from '@vaubaan/gateway-core';

const STACK_FRAMES_LOGGED = 12;

/** The `at …` lines of an error's stack — where it was thrown, without its message. */
export function stackFramesOf(error: unknown): string[] {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return [];
  return error.stack
    .split('\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('at '))
    .slice(0, STACK_FRAMES_LOGGED);
}

/** `error_class` and `stack_frames` of a log line about an error nobody foresaw. */
export function errorFields(error: unknown): {
  readonly error_class: string;
  readonly stack_frames: string[];
} {
  return { error_class: upstreamErrorClassName(error), stack_frames: stackFramesOf(error) };
}
