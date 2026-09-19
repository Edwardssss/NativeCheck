/**
 * Deep-scan network resilience: proxy resolution and bounded retries.
 *
 * Layer 2 is the only part of the tool that touches the network, so it is the
 * only place that has to survive a real corporate network. Two failure modes
 * mattered in practice:
 *
 * 1. Node's global fetch ignores `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`, so a
 *    proxied environment silently degraded every B/C candidate to `unverified`;
 * 2. a transient 429 / 5xx / socket error collapsed straight into `unverified`
 *    instead of being retried, so a single hiccup made a scan non-conclusive.
 *
 * Everything here is injectable (sleep / fetch), so no test waits or talks to the
 * network.
 */
import { describe, expect, it } from 'vitest'
import {
  PROXY_ENV_KEYS,
  requestWithRetry,
  resolveProxyUrl,
  retryDelayMs,
  retryOptionsFromEnv,
} from '../src/adapters/node/network'

interface FakeResponse {
  readonly status: number
  readonly ok: boolean
  readonly body: null
  readonly headers?: { get(name: string): string | null }
}

function response(status: number, retryAfter?: string): FakeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    body: null,
    ...(retryAfter
      ? { headers: { get: (name) => (name === 'retry-after' ? retryAfter : null) } }
      : {}),
  }
}

/** Records every wait so the backoff schedule can be asserted without real delays. */
function recorder(): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = []
  return {
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  }
}

describe('resolveProxyUrl', () => {
  it('reads the standard variables in order, case-insensitively', () => {
    expect(resolveProxyUrl({})).toBeUndefined()
    expect(resolveProxyUrl({ HTTPS_PROXY: 'http://p:8080' })).toBe('http://p:8080')
    expect(resolveProxyUrl({ https_proxy: 'http://lower:8080' })).toBe('http://lower:8080')
    // HTTPS_PROXY wins over HTTP_PROXY (same as curl / npm)
    expect(
      resolveProxyUrl({
        HTTPS_PROXY: 'http://a:1',
        HTTP_PROXY: 'http://b:2',
        NC_PROXY: 'http://c:3',
      }),
    ).toBe('http://a:1')
    expect(resolveProxyUrl({ ALL_PROXY: 'socks5://d:4' })).toBe('socks5://d:4')
    // an empty or whitespace value does not count as configured
    expect(resolveProxyUrl({ HTTP_PROXY: '   ' })).toBeUndefined()
  })

  it('exposes the variable list so docs and diagnostics cannot drift apart', () => {
    // spelled out one by one: the resolution order is a promise to users, so changing it must change this test (the same snapshot discipline the fixtures follow)
    expect([...PROXY_ENV_KEYS]).toEqual([
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
      'ALL_PROXY',
      'all_proxy',
      'NC_PROXY',
    ])
  })
})

describe('retryDelayMs', () => {
  it('no Retry-After → exponential backoff, capped', () => {
    expect(retryDelayMs(null, 1, { baseDelayMs: 100, maxDelayMs: 5_000 })).toBe(100)
    expect(retryDelayMs(null, 2, { baseDelayMs: 100, maxDelayMs: 5_000 })).toBe(200)
    expect(retryDelayMs(null, 3, { baseDelayMs: 100, maxDelayMs: 5_000 })).toBe(400)
    expect(retryDelayMs(null, 9, { baseDelayMs: 100, maxDelayMs: 500 })).toBe(500)
  })

  it('Retry-After accepts seconds and an HTTP date, and never bypasses the cap', () => {
    expect(retryDelayMs('2', 1, { maxDelayMs: 5_000 })).toBe(2_000)
    expect(retryDelayMs('600', 1, { maxDelayMs: 5_000 })).toBe(5_000) // a malicious or absurd value is clamped
    const soon = new Date(Date.now() + 3_000).toUTCString()
    expect(retryDelayMs(soon, 1, { maxDelayMs: 5_000 })).toBeGreaterThan(1_500)
    expect(retryDelayMs('garbage', 2, { baseDelayMs: 100 })).toBe(200) // unparseable → falls back to backoff
  })
})

describe('requestWithRetry', () => {
  it('429 / 5xx are retried and the result is returned once they succeed', async () => {
    const { sleeps, sleep } = recorder()
    let calls = 0
    const res = await requestWithRetry(
      async () => {
        calls++
        return calls < 3 ? response(503) : response(200)
      },
      undefined,
      { attempts: 3, baseDelayMs: 10, sleep },
    )
    expect(res.status).toBe(200)
    expect(calls).toBe(3)
    expect(sleeps).toEqual([10, 20]) // exponential backoff
  })

  it('404 is a verdict, not a failure: no retry', async () => {
    const { sleeps, sleep } = recorder()
    let calls = 0
    const res = await requestWithRetry(
      async () => {
        calls++
        return response(404)
      },
      undefined,
      { attempts: 3, sleep },
    )
    expect(res.status).toBe(404)
    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
  })

  it('persistent 5xx → returns the last response after exhausting the budget (never retries forever)', async () => {
    const { sleeps, sleep } = recorder()
    let calls = 0
    const res = await requestWithRetry(
      async () => {
        calls++
        return response(500)
      },
      undefined,
      { attempts: 3, baseDelayMs: 1, sleep },
    )
    expect(res.status).toBe(500)
    expect(calls).toBe(3)
    expect(sleeps).toHaveLength(2)
  })

  it('Retry-After decides how long to wait', async () => {
    const { sleeps, sleep } = recorder()
    let calls = 0
    await requestWithRetry(
      async () => {
        calls++
        return calls === 1 ? response(429, '3') : response(200)
      },
      undefined,
      { attempts: 3, baseDelayMs: 10, maxDelayMs: 5_000, sleep },
    )
    expect(sleeps).toEqual([3_000])
  })

  it('network errors (a throwing fetch) are retried too, and only rethrown once they persist', async () => {
    const { sleeps, sleep } = recorder()
    let calls = 0
    await expect(
      requestWithRetry(
        async () => {
          calls++
          throw new Error('ECONNRESET')
        },
        undefined,
        { attempts: 3, baseDelayMs: 5, sleep },
      ),
    ).rejects.toThrow('ECONNRESET')
    expect(calls).toBe(3)
    expect(sleeps).toEqual([5, 10])
  })

  it('attempts=1 disables retries entirely (the escape hatch on a slow network)', async () => {
    const { sleeps, sleep } = recorder()
    let calls = 0
    await requestWithRetry(
      async () => {
        calls++
        return response(503)
      },
      undefined,
      { attempts: 1, sleep },
    )
    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
  })

  it('onRetry observes every retry (for logging / diagnostics)', async () => {
    const seen: Array<{ attempt: number; status?: number }> = []
    await requestWithRetry(async () => response(429), undefined, {
      attempts: 2,
      sleep: async () => undefined,
      onRetry: (info) => seen.push({ attempt: info.attempt, status: info.status }),
    })
    expect(seen).toEqual([{ attempt: 1, status: 429 }])
  })
})

describe('retryOptionsFromEnv', () => {
  it('default policy: three attempts (an unset env does not override it)', () => {
    expect(retryOptionsFromEnv({})).toEqual({})
  })

  it('NC_HTTP_RETRIES / NC_HTTP_RETRY_BASE_MS are tunable, and invalid values are ignored', () => {
    expect(retryOptionsFromEnv({ NC_HTTP_RETRIES: '5' })).toEqual({ attempts: 5 })
    expect(retryOptionsFromEnv({ NC_HTTP_RETRY_BASE_MS: '0' })).toEqual({ baseDelayMs: 0 })
    expect(retryOptionsFromEnv({ NC_HTTP_RETRIES: '0' })).toEqual({})
    expect(retryOptionsFromEnv({ NC_HTTP_RETRIES: 'abc' })).toEqual({})
  })
})
