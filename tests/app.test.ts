import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { MemoryStore } from '../src/domain/store.js'
import type { AlertDelivery, SessionSnapshot, SubscriptionFilters, SubscriptionView } from '../src/domain/types.js'
import { createApp } from '../src/server/app.js'
import { freshnessThresholdMs, resolvePublicBaseUrl, resolveTrustProxy } from '../src/server/config.js'
import { ResendEmailSender, type EmailSender } from '../src/server/email.js'

const filmIds = ['HO00000546', 'HO00000547']
const payload = {
  eventId: 'manual-1',
  sessions: [{
    id: 'session-1',
    filmId: 'HO00000546',
    title: 'Provider supplied title',
    startsAt: '2026-07-18T09:00:00.000Z',
    format: 'laser' as const,
    bookingUrl: 'https://imaxmelbourne.com.au/session/session-1',
    seats: [{ row: 'J', number: 10, status: 'sold' }],
  }],
}
const subscription = {
  email: 'fan@example.com',
  filters: {
    filmIds: [filmIds[0]],
    format: 'all',
    weekdays: ['saturday'],
    time: { preset: 'afterwork' },
    minimumSeats: 1,
    adjacentOnly: false,
  },
}

function setup(email: EmailSender, options: {
  now?: () => number
  rateLimitMaxEntries?: number
  staticRoot?: string
  trustProxy?: boolean
  confirmationCooldownMs?: number
  pendingSubscriptionLimitPerRecipient?: number
} = {}) {
  const {
    confirmationCooldownMs,
    pendingSubscriptionLimitPerRecipient,
    ...appOptions
  } = options
  const store = new MemoryStore({ filmIds, confirmationCooldownMs, pendingSubscriptionLimitPerRecipient })
  const app = createApp({
    store,
    email,
    ingestToken: 'secret-ingest-token',
    ...appOptions,
  })
  return { app, store }
}

describe('Hono API', () => {
  it('reports process readiness without exposing secrets', async () => {
    const { app } = setup({ configured: false, sendConfirmation: async () => {}, sendAlerts: async () => [] })
    const response = await app.request('/health')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      process: 'ok',
      email: { configured: false },
      sessionDiscovery: { state: 'blocked' },
      lumosBootstrap: { state: 'pending' },
      seatCapture: { state: 'pending' },
    })
    expect(JSON.stringify(body)).not.toContain('secret-ingest-token')
  })

  it('reports missing observation freshness explicitly', async () => {
    const { app } = setup({ configured: false, sendConfirmation: async () => {}, sendAlerts: async () => [] })

    const response = await app.request('/api/status')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      degraded: true,
      sessionDiscovery: {
        state: 'blocked',
        freshness: { state: 'missing', lastUpdate: null },
      },
      seatCapture: {
        state: 'pending',
        lastCapture: null,
      },
    })
  })

  it('reports listing discovery, Lumos bootstrap, and exact capture separately without secrets', async () => {
    const { app, store } = setup({ configured: false, sendConfirmation: async () => {}, sendAlerts: async () => [] })
    const attemptedAt = new Date().toISOString()
    store.ingest([{
      ...payload.sessions[0]!,
      id: 'HO00000546-20260718T1900',
      bookingUrl: null,
      seats: [],
      listing: { status: 'soldout', observedAt: attemptedAt, sourceId: null },
      seatData: { state: 'unavailable', capturedAt: null },
    }], 'provider', 'listing-1')
    store.setUpstreamStatus('ok', 'Public listing refresh completed.', {
      attemptedAt,
      nextAttempt: null,
      succeeded: true,
    })
    store.setLumosBootstrapStatus('blocked', 'Public film bootstrap returned a challenge page', {
      attemptedAt,
      nextAttempt: null,
    })
    store.setSeatCaptureStatus('blocked', 'Automatic exact preview is blocked; signed manual ingest remains available.', {
      attemptedAt,
      nextAttempt: null,
    })

    const status = await (await app.request('/api/status')).json()
    const sessions = await (await app.request('/api/sessions')).json()

    expect(status).toMatchObject({
      degraded: true,
      sessionDiscovery: { state: 'ok', freshness: { state: 'fresh' } },
      lumosBootstrap: { state: 'blocked' },
      seatCapture: { state: 'blocked', capturedSessionCount: 0, uncapturedSessionCount: 0 },
    })
    expect(sessions).toMatchObject({
      sessions: [{
        listing: { status: 'soldout' },
        seatData: { state: 'unavailable', capturedAt: null },
        seats: [],
      }],
    })
    expect(JSON.stringify(status)).not.toContain('gasToken')
    expect(JSON.stringify(status)).not.toContain('fixture-signature')
  })

  it('exposes bounded per-stage provider history in the status payload without secrets', async () => {
    const { app, store } = setup({ configured: false, sendConfirmation: async () => {}, sendAlerts: async () => [] })
    store.setUpstreamStatus('ok', 'Public listing refresh completed.', {
      attemptedAt: '2026-07-18T00:00:00.000Z',
      nextAttempt: null,
      succeeded: true,
    })
    store.setSeatCaptureStatus('blocked', 'Automatic exact preview is blocked.', {
      attemptedAt: '2026-07-18T00:01:00.000Z',
      nextAttempt: null,
    })

    const body = await (await app.request('/api/status')).json()

    expect(body.history[0]).toMatchObject({
      at: '2026-07-18T00:01:00.000Z',
      stage: 'seat_preview',
      state: 'blocked',
      detail: 'Automatic exact preview is blocked.',
    })
    expect(body.history[1]).toMatchObject({ stage: 'listing', state: 'ok' })
    expect(JSON.stringify(body)).not.toContain('gasToken')
  })

  it('rejects unauthorized ingest and accepts a valid bearer token', async () => {
    const { app } = setup({ configured: false, sendConfirmation: async () => {}, sendAlerts: async () => [] })
    const unauthorized = await app.request('/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const accepted = await app.request('/api/ingest', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-ingest-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    expect(unauthorized.status).toBe(401)
    expect(accepted.status).toBe(202)
    const sessionsResponse = await app.request('/api/sessions')
    expect(await sessionsResponse.json()).toMatchObject({
      sessions: [{ id: 'session-1', seats: [{ row: 'J' }] }],
    })
  })

  it('returns a clear error without creating a subscription when email is unconfigured', async () => {
    const { app, store } = setup({ configured: false, sendConfirmation: async () => {}, sendAlerts: async () => [] })
    const response = await app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(subscription),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'email_not_configured' })
    expect(store.subscriptionCount).toBe(0)
  })

  it('sends confirmation and supports tokenized confirm, manage, and unsubscribe routes', async () => {
    let created:
      | { subscription: SubscriptionView; confirmationToken: string; manageToken: string; unsubscribeToken: string }
      | undefined
    const email: EmailSender = {
      configured: true,
      async sendConfirmation(value) { created = value },
      async sendAlerts(_deliveries: AlertDelivery[]) { return [] },
    }
    const { app, store } = setup(email)
    const response = await app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.1' },
      body: JSON.stringify(subscription),
    })

    expect(response.status).toBe(202)
    expect(created).toBeDefined()
    const confirmUrl = `/confirm?token=${created?.confirmationToken}`
    const confirmationPage = await app.request(confirmUrl)
    expect(confirmationPage.status).toBe(200)
    expect(await confirmationPage.text()).toContain('Confirm alert')
    expect(store.getManagedSubscription(created?.manageToken ?? '')?.verified).toBe(false)
    expect((await app.request(confirmUrl, { method: 'POST' })).status).toBe(200)
    expect(store.getManagedSubscription(created?.manageToken ?? '')?.verified).toBe(true)
    expect((await app.request(`/manage?token=${created?.manageToken}`)).status).toBe(200)
    const unsubscribeUrl = `/unsubscribe?token=${created?.unsubscribeToken}`
    const confirmation = await app.request(unsubscribeUrl)
    expect(confirmation.status).toBe(200)
    expect(await confirmation.text()).toContain('Confirm unsubscribe')
    expect(store.getManagedSubscription(created?.manageToken ?? '')?.active).toBe(true)

    expect((await app.request(unsubscribeUrl, { method: 'POST' })).status).toBe(200)
    expect(store.getManagedSubscription(created?.manageToken ?? '')?.active).toBe(false)
  })

  it('sets no-referrer and no-store on every token-bearing page and mutation', async () => {
    let created:
      | { confirmationToken: string; manageToken: string; unsubscribeToken: string }
      | undefined
    const { app } = setup({
      configured: true,
      async sendConfirmation(value) { created = value },
      async sendAlerts(deliveries) { return deliveries.map(({ id }) => id) },
    })
    await app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(subscription),
    })
    const requests: Array<[string, RequestInit?]> = [
      [`/confirm?token=${created?.confirmationToken}`],
      [`/confirm?token=${created?.confirmationToken}`, { method: 'POST' }],
      [`/manage?token=${created?.manageToken}`],
      [`/unsubscribe?token=${created?.unsubscribeToken}`],
      [`/unsubscribe?token=${created?.unsubscribeToken}`, { method: 'POST' }],
    ]

    for (const [url, init] of requests) {
      const response = await app.request(url, init)
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('suppresses duplicate pending confirmation sends during cooldown', async () => {
    let now = 1_000_000
    let emailCalls = 0
    let firstToken = ''
    const { app, store } = setup({
      configured: true,
      async sendConfirmation(message) {
        emailCalls += 1
        firstToken ||= message.confirmationToken
      },
      async sendAlerts(deliveries) { return deliveries.map(({ id }) => id) },
    }, {
      now: () => now,
      confirmationCooldownMs: 60_000,
    })
    const submit = (body = subscription) => app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    expect((await submit()).status).toBe(202)
    now += 30_000
    const duplicate = await submit({
      email: 'FAN@example.com',
      filters: { ...subscription.filters, filmIds: [...subscription.filters.filmIds].reverse() },
    })

    expect(duplicate.status).toBe(202)
    expect(await duplicate.json()).toMatchObject({ reused: true, needsConfirmation: true })
    expect(emailCalls).toBe(1)
    expect(store.confirmSubscription(firstToken)).toBe(true)
  })

  it('caps pending filter variants for one recipient before sending more email', async () => {
    let emailCalls = 0
    const { app } = setup({
      configured: true,
      async sendConfirmation() { emailCalls += 1 },
      async sendAlerts(deliveries) { return deliveries.map(({ id }) => id) },
    }, { pendingSubscriptionLimitPerRecipient: 2 })
    const submit = (minimumSeats: number) => app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: minimumSeats === 2 ? 'FAN@example.com' : 'fan@example.com',
        filters: { ...subscription.filters, minimumSeats },
      }),
    })

    expect((await submit(1)).status).toBe(202)
    expect((await submit(2)).status).toBe(202)
    const limited = await submit(3)

    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' })
    expect(emailCalls).toBe(2)
  })

  it('rate limits subscription creation per client IP', async () => {
    const email: EmailSender = {
      configured: true,
      async sendConfirmation() {},
      async sendAlerts() { return [] },
    }
    const { app } = setup(email)
    const submit = () => app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.2' },
      body: JSON.stringify(subscription),
    })

    for (let index = 0; index < 5; index += 1) expect((await submit()).status).toBe(202)
    expect((await submit()).status).toBe(429)
  })

  it('ignores spoofed forwarded headers when the proxy is not trusted', async () => {
    const email: EmailSender = {
      configured: true,
      async sendConfirmation() {},
      async sendAlerts() { return [] },
    }
    const { app, store } = setup(email)
    for (let index = 0; index < 5; index += 1) {
      const response = await app.request('/api/subscriptions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `198.51.100.${index}`,
          'x-real-ip': `203.0.113.${index}`,
        },
        body: '{',
      })
      expect(response.status).toBe(400)
    }

    const limited = await app.request('/api/subscriptions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '192.0.2.44',
        'x-real-ip': '192.0.2.45',
      },
      body: JSON.stringify(subscription),
    })

    expect(limited.status).toBe(429)
    expect(store.subscriptionCount).toBe(0)
  })

  it('uses X-Real-IP and ignores X-Forwarded-For only in trusted proxy mode', async () => {
    const email: EmailSender = {
      configured: true,
      async sendConfirmation() {},
      async sendAlerts(deliveries) { return deliveries.map(({ id }) => id) },
    }
    const { app } = setup(email, { trustProxy: true })
    const submit = (realIp: string, spoofedIp: string) => app.request('/api/subscriptions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': realIp,
        'x-forwarded-for': spoofedIp,
      },
      body: JSON.stringify(subscription),
    })

    for (let index = 0; index < 5; index += 1) {
      expect((await submit('203.0.113.9', `198.51.100.${index}`)).status).toBe(202)
    }
    expect((await submit('203.0.113.9', '192.0.2.44')).status).toBe(429)
    expect((await submit('203.0.113.10', '192.0.2.44')).status).toBe(202)
  })

  it('rejects oversized subscription bodies before creating or emailing', async () => {
    let emailCalls = 0
    const { app, store } = setup({
      configured: true,
      async sendConfirmation() { emailCalls += 1 },
      async sendAlerts() { return [] },
    })

    const response = await app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
      body: JSON.stringify({ ...subscription, padding: 'x'.repeat(20_000) }),
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: 'body_too_large' })
    expect({ emailCalls, subscriptions: store.subscriptionCount }).toEqual({ emailCalls: 0, subscriptions: 0 })
  })

  it('bounds limiter clients and expires old attempts', async () => {
    let now = 1_000_000
    const { app } = setup({ configured: true, async sendConfirmation() {}, async sendAlerts() { return [] } }, {
      now: () => now,
      rateLimitMaxEntries: 2,
      trustProxy: true,
    })
    const submit = (ip: string) => app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': ip },
      body: JSON.stringify(subscription),
    })
    await submit('203.0.113.1')
    await submit('203.0.113.2')
    expect((await submit('203.0.113.3')).status).toBe(429)

    for (let index = 0; index < 4; index += 1) expect((await submit('203.0.113.1')).status).toBe(202)
    expect((await submit('203.0.113.1')).status).toBe(429)

    now += 60 * 60 * 1000 + 1
    expect((await submit('203.0.113.3')).status).toBe(202)
  })

  it('keeps API and operational misses out of the SPA fallback', async () => {
    const staticRoot = fileURLToPath(new URL('../src/client', import.meta.url))
    const { app } = setup({ configured: false, async sendConfirmation() {}, async sendAlerts() { return [] } }, { staticRoot })

    const apiMiss = await app.request('/api/not-a-route')
    const operationalMiss = await app.request('/health/not-a-route')
    const clientRoute = await app.request('/sessions/example')

    expect(apiMiss.status).toBe(404)
    expect(apiMiss.headers.get('content-type')).toContain('application/json')
    expect(await apiMiss.json()).toEqual({ error: 'not_found' })
    expect(operationalMiss.status).toBe(404)
    expect(operationalMiss.headers.get('content-type')).toContain('application/json')
    expect(clientRoute.status).toBe(200)
    expect(await clientRoute.text()).toContain('<div id="root"></div>')
  })

  it('adds standard one-click unsubscribe headers to confirmation and alert email', async () => {
    const requests: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(await new Request(input, init).json() as Record<string, unknown>)
      return Response.json({ id: `email-${requests.length}` })
    })
    try {
      const store = new MemoryStore({ filmIds })
      const created = store.createSubscription('fan@example.com', subscription.filters as SubscriptionFilters)
      const sender = new ResendEmailSender('re_test', 'House Lights <alerts@example.com>', 'https://alerts.example.com')

      await sender.sendConfirmation(created)
      await sender.sendAlerts([{
        id: 'delivery-1',
        subscriptionId: created.subscription.id,
        email: created.subscription.email,
        manageToken: created.manageToken,
        unsubscribeToken: created.unsubscribeToken,
        sessions: [],
      }])
    } finally {
      vi.unstubAllGlobals()
    }

    expect(requests.map(({ headers }) => headers)).toEqual([
      {
        'List-Unsubscribe': expect.stringMatching(/^<https:\/\/alerts\.example\.com\/unsubscribe\?token=.+>$/),
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      {
        'List-Unsubscribe': expect.stringMatching(/^<https:\/\/alerts\.example\.com\/unsubscribe\?token=.+>$/),
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    ])
  })

  it('forwards the scheduler abort signal to Resend alert requests', async () => {
    let observedSignal: AbortSignal | null | undefined
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal
      return Response.json({ id: 'email-1' })
    })
    const controller = new AbortController()
    let sentIds: string[]
    try {
      const sender = new ResendEmailSender('re_test', 'House Lights <alerts@example.com>', 'https://alerts.example.com')
      sentIds = await sender.sendAlerts([{
        id: 'delivery-1',
        subscriptionId: 'subscription-1',
        email: 'fan@example.com',
        manageToken: 'manage-token',
        unsubscribeToken: 'unsubscribe-token',
        sessions: [],
      }], controller.signal)
    } finally {
      vi.unstubAllGlobals()
    }

    expect(observedSignal).toBe(controller.signal)
    expect(sentIds!).toEqual(['delivery-1'])
  })

  it('retries a pending alert with the same idempotency identity after delivery failure', async () => {
    let confirmationToken = ''
    const attemptedDeliveryIds: string[] = []
    const email: EmailSender = {
      configured: true,
      async sendConfirmation(message) { confirmationToken = message.confirmationToken },
      async sendAlerts(deliveries) {
        attemptedDeliveryIds.push(...deliveries.map(({ id }) => id))
        if (attemptedDeliveryIds.length === 1) throw new Error('temporary Resend failure')
        return deliveries.map(({ id }) => id)
      },
    }
    const { app, store } = setup(email)
    await app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...subscription,
        filters: { ...subscription.filters, minimumSeats: 1, adjacentOnly: false },
      }),
    })
    await app.request(`/confirm?token=${confirmationToken}`, { method: 'POST' })
    const seeded = (seats: SessionSnapshot['seats']): SessionSnapshot => ({
      ...payload.sessions[0]!,
      listing: { status: 'unknown', observedAt: null, sourceId: null },
      seatData: { state: 'captured', capturedAt: null },
      seats,
    })
    store.ingest([seeded([{ row: 'J', number: 10, status: 'sold' }])], 'preview', 'preview-baseline')
    store.ingest([seeded([{ row: 'J', number: 10, status: 'available' }])], 'preview', 'preview-update')
    expect(store.getPendingDeliveries()).toHaveLength(1)
    const request = () => app.request('/api/ingest', {
      method: 'POST',
      headers: { authorization: 'Bearer secret-ingest-token', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })

    expect((await request()).status).toBe(502)
    const retried = await request()

    expect(retried.status).toBe(202)
    expect(await retried.json()).toMatchObject({ duplicate: true })
    expect(attemptedDeliveryIds).toHaveLength(2)
    expect(new Set(attemptedDeliveryIds).size).toBe(1)
    expect(store.getPendingDeliveries()).toEqual([])
  })
})

describe('server configuration', () => {
  it('keeps freshness healthy for more than one configured poll cycle and timeout', () => {
    const threshold = freshnessThresholdMs({
      pollIntervalMs: 15 * 60 * 1000,
      previewIntervalMs: 15 * 60 * 1000,
      providerTimeoutMs: 30_000,
      previewTimeoutMs: 30_000,
    })

    expect(threshold).toBeGreaterThan(15 * 60 * 1000 + 30_000)
  })

  it('requires a public origin when production email is enabled', () => {
    expect(resolvePublicBaseUrl({}, 3000, false)).toBe('http://localhost:3000')
    expect(() => resolvePublicBaseUrl({ NODE_ENV: 'production' }, 3000, true)).toThrow(/PUBLIC_BASE_URL/)
    expect(() => resolvePublicBaseUrl({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'http://localhost:3000',
    }, 3000, true)).toThrow(/public origin/i)
    expect(() => resolvePublicBaseUrl({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'http://alerts.example.com',
    }, 3000, true)).toThrow(/HTTPS/i)
    expect(() => resolvePublicBaseUrl({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://alerts.example.com/path',
    }, 3000, true)).toThrow(/origin/i)
    expect(resolvePublicBaseUrl({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://alerts.example.com',
    }, 3000, true)).toBe('https://alerts.example.com')
  })

  it('enables proxy trust only through an explicit production setting', () => {
    expect(resolveTrustProxy({})).toBe(false)
    expect(resolveTrustProxy({ TRUST_PROXY: 'false' })).toBe(false)
    expect(resolveTrustProxy({ NODE_ENV: 'production', TRUST_PROXY: 'true' })).toBe(true)
    expect(() => resolveTrustProxy({ TRUST_PROXY: 'true' })).toThrow(/production/i)
    expect(() => resolveTrustProxy({ NODE_ENV: 'production', TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/i)
  })
})
