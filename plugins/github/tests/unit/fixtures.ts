/**
 * Shared fixtures of the github plugin tests : a throw-away RSA key, the
 * company's app configuration, mission resources and a context builder.
 * No network : every context carries a `mockFetch`.
 */
import type { ConnectionContext, ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockFetch } from '@vaubaan/plugin-sdk/testing';

// PKCS#8 RSA-2048 test key — generated specifically for unit tests, has no
// access to anything. Same convention as @octokit's test fixtures.
export const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDOg7Q7+wHk/p7d
Bme2T3pH7p9NgM31D0epDi0L7tIA+sV0w1KEh1OB7zNCsP2dgU/UDoBWmlttQ8M5
TZJk8XfwT2QvfRRGyQrR5DfMzudWKD1HFAk4zJqMI3SyvPzdM7CmKvSPzaGdyXLM
HBnFEHTrAAYpZJTLLbW2lOECG3ZsuABKQ7sQuU5GLs9CnLeUVQjy1XmwYqLF3uxL
RYNANvf++iIabHTphkPUOPkSMUDA5IfPq6CY+0e+jiosVHKLfQ1ai/CmRTUWMs8+
yQz6N+m+8GD1bqp7tH16fqp8u9eGYNvFP6hZ/9eOgrnFEavRkP86bP4ueWg+iAcZ
v7zSjjJrAgMBAAECggEAVDmwiPgRRPNQR4QAOiOLZX1ZLDGqzWsdtkAdvW1KCl4z
SAAdSWPLU/7vY7eu+T2/n+kJh4DGztYpD5DC/jpkjcrPVgrAh1qcRdJ6JFR/n+/N
WTbcvJYS9MX35qkS+nT6BgY15kuPwQ0YJOhrFGY8zk8/sZxlAGJ7QvBoshlEvJOf
nbXxQDFGM/G7gRRk8tbB1lNiPSe17/uYRjsfTAk9o32Eq6tDLR8e9pTGwlT0Vh+H
v3DSC5RcJ/Mn1bs7wKtytHnsfNgYHkwoEzeQfxIA8AhCkB99rBn9CJyzKKKQpZ06
Ku7sUMVPb/MK4OcyhHRGuW2Vk/3WBhdsfqzMHEXKMQKBgQDt6PUodMRPS+8jmTd5
qLM07VVjbqIH3LowqlBzdwH+ZINFEzsZUBVYUm1msrAPRyHGRfDlh3Z+0a5whtPj
3yWGfLGiOh23QpRC4xj9HC7TKgewWp4PE1mDpDIWLPmqMmJZS7uMLO/MnUYvLEy/
QmQEK52oqHbeJoNcFnUbR/9CtwKBgQDeQ8I3wEv3oH3SrnAVGfb+f0YjxkA0tu5l
QH48jzdHFiZ9Ipdmw6cYY26zh+UrSeJsexBjPnYR8DJa3O7ZbukOXq1c4ndU4dvb
1FOk2NRR3jcjvyiQ7DCx9Bm00pn1JCpAFXa9emR1eU7+KuYIQjvopT4G2EBSrgVf
QZBlafhxTQKBgQCx/9OFZw0/UYpYBnwLDhDDdLPMVoLuoPYDDXwZHGSp3w2c+Trh
EOOLpJ6gz72mIDIb1MKpfgIvUTOzL7vDA1xidLPnNWuBxbyfM/8+T+CHGOPTtdyu
WdoJ3LDr0PFqRYTSU1Q2YESQs6mLDpEcfm3dgRyFkPdN7Qv9MIWfk1H6tQKBgD0K
xfdGRr5MS6t/sgF7XDPYHfYdfRQnXMBGzc2nE3Y9YsP4tT5KKLPpQ7xfDTqVy0w3
4SQYUkpHr1f6FfMJgCUg9KqxlhpVgF8RbgJZyMfvljKIB6kHWGEemkF/oRdMECY2
JLQp1FpopVKDcfRGl6JV4i3rRxXGzhwYNrZN8eIBAoGAR3eN7AaTcZ5++qFTpHpP
+RaC/Z3xkNawTHK60RJoLM7VqgITAa/0kqIWyILJVjf+sZUMc+L3UVwfwzgRWnL3
P3lhCcWoarBQqXQ43RNFmqgF0kBC4O5cMrqRhEf9NwBNw0bpV7Xpr5OvVDpKKaiC
PD9rN0nWMqM6XQqyKQHGCu0=
-----END PRIVATE KEY-----`;

export const APP_ID = '123';
export const INSTALLATION_ID = '12345';

export const appConfig: Readonly<Record<string, string>> = {
  app_id: APP_ID,
  private_key: TEST_PRIVATE_KEY_PEM,
  app_slug: 'vaubaan-gateway',
};

export const appRepo: Resource = {
  provider: 'github',
  ref: 'acme/app',
  displayName: 'acme/app',
};
export const libRepo: Resource = {
  provider: 'github',
  ref: 'acme/lib',
  displayName: 'acme/lib',
};

export const MINT_URL = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`;

/** A route answering the installation-token mint with `ghs_xxx`. */
export const mintRoute = (token = 'ghs_xxx') => ({
  method: 'POST',
  url: MINT_URL,
  body: { token, expires_at: '2026-10-13T11:00:00Z' },
});

export function connectionCtx(
  fetch: MockFetch,
  overrides: Partial<ConnectionContext> = {},
): ConnectionContext {
  return {
    credential: { kind: 'app-install', installationId: INSTALLATION_ID, metadata: {} },
    appConfig,
    fetch,
    ...overrides,
  };
}

export function executeCtx(
  fetch: MockFetch,
  resources: readonly Resource[] = [appRepo],
  overrides: Partial<ExecuteContext> = {},
): ExecuteContext {
  return { ...connectionCtx(fetch), resources, ...overrides };
}
