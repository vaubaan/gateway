/**
 * Rate limiting — the in-memory sliding window behind the composition root's
 * `RateLimiter` port and the budget's synchronous `SlidingWindows`.
 * Handbook: docs/handbook/budget-and-mission-logs.md.
 */
export {
  SlidingWindowRateLimiter,
  rateWindowKey,
  type MillisClock,
  type SlidingWindowOptions,
  type SlidingWindows,
  type WindowProbe,
} from './sliding-window.ts';
