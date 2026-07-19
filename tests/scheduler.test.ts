import { describe, expect, it } from 'vitest'

import { PollScheduler } from '../src/server/scheduler.js'
import type { UpstreamProvider } from '../src/server/provider.js'
import type { SeatPreviewProvider } from '../src/server/lumos-provider.js'
import { MemoryStore } from '../src/domain/store.js'
import type { SessionSnapshot, SubscriptionFilters } from '../src/domain/types.js'

const listingSession: SessionSnapshot = {
  id: 'HO00000546-20260718T1900',
  filmId: 'HO00000546',
  title: 'Provider supplied title',
  startsAt: '2026-07-18T09:00:00.000Z',
  format: 'laser',
  bookingUrl: 'https://web.imaxmelbourne.com.au/order/showtimes/IMAX-1/seats',
  listing: { status: 'available', observedAt: '2026-07-17T00:00:00.000Z', sourceId: 'IMAX-1' },
  seatData: { state: 'unavailable', capturedAt: null },
  seats: [],
}

const matchingFilters: SubscriptionFilters = {
  filmIds: ['HO00000546'],
  format: 'all',
  weekdays: ['saturday'],
  time: { preset: 'afterwork' },
  minimumSeats: 1,
  adjacentOnly: false,
}

function queueDelivery(store: MemoryStore): void {
  const created = store.createSubscription('ready@example.com', matchingFilters)
  store.confirmSubscription(created.confirmationToken)
  store.ingest([{
    ...listingSession,
    seatData: { state: 'captured', capturedAt: null },
    seats: [{ row: 'J', number: 10, status: 'sold' }],
  }], 'preview', 'delivery-baseline')
  store.ingest([{
    ...listingSession,
    seatData: { state: 'captured', capturedAt: null },
    seats: [{ row: 'J', number: 10, status: 'available' }],
  }], 'preview', 'delivery-update')
}

function queueDeliveries(store: MemoryStore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const created = store.createSubscription(`ready-${index}@example.com`, matchingFilters)
    store.confirmSubscription(created.confirmationToken)
  }
  store.ingest([{
    ...listingSession,
    seatData: { state: 'captured', capturedAt: null },
    seats: [{ row: 'J', number: 10, status: 'sold' }],
  }], 'preview', 'deliveries-baseline')
  store.ingest([{
    ...listingSession,
    seatData: { state: 'captured', capturedAt: null },
    seats: [{ row: 'J', number: 10, status: 'available' }],
  }], 'preview', 'deliveries-update')
}

describe('PollScheduler', () => {
  it('fails fast on invalid polling bounds', () => {
    const provider: UpstreamProvider = {
      async fetchSessions() { return { kind: 'blocked', reason: 'unconfigured' } },
    }
    const store = new MemoryStore({ filmIds: ['HO00000546'] })
    const options = {
      provider,
      store,
      cooldownMs: 60_000,
      providerTimeoutMs: 30_000,
    }

    expect(() => new PollScheduler({ ...options, cooldownMs: Number.NaN })).toThrow(/cooldown/i)
    expect(() => new PollScheduler({ ...options, providerTimeoutMs: 0 })).toThrow(/timeout/i)
    expect(() => new PollScheduler(options).start(Number.NaN)).toThrow(/interval/i)
  })

  it('runs only one polling pass at a time', async () => {
    let release: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const provider: UpstreamProvider = {
      async fetchSessions() {
        calls += 1
        await waiting
        return { kind: 'blocked', reason: 'upstream contract unavailable' }
      },
    }
    const store = new MemoryStore({ filmIds: ['HO00000546'] })
    const scheduler = new PollScheduler({
      provider,
      store,
      cooldownMs: 0,
    })

    const first = scheduler.runOnce()
    const second = await scheduler.runOnce()
    expect(second).toBe(false)
    release?.()
    expect(await first).toBe(true)
    expect(calls).toBe(1)
  })

  it('backs off after a blocked response instead of hammering upstream', async () => {
    let calls = 0
    const provider: UpstreamProvider = {
      async fetchSessions() {
        calls += 1
        return { kind: 'blocked', reason: 'Cloudflare challenge' }
      },
    }
    const store = new MemoryStore({ filmIds: ['HO00000546'] })
    const scheduler = new PollScheduler({
      provider,
      store,
      cooldownMs: 60_000,
    })

    expect(await scheduler.runOnce()).toBe(true)
    expect(await scheduler.runOnce()).toBe(false)
    expect(calls).toBe(1)
    expect(store.getStatus().sessionDiscovery).toMatchObject({
      state: 'blocked',
      detail: 'Cloudflare challenge',
    })
  })

  it('fails closed when provider work exceeds its timeout', async () => {
    const provider: UpstreamProvider = {
      async fetchSessions() {
        return new Promise(() => {})
      },
    }
    const store = new MemoryStore({ filmIds: ['HO00000546'] })
    const scheduler = new PollScheduler({
      provider,
      store,
      cooldownMs: 60_000,
      providerTimeoutMs: 5,
    })

    expect(await scheduler.runOnce()).toBe(true)
    expect(store.getStatus().sessionDiscovery).toMatchObject({
      state: 'error',
      detail: 'Provider request timed out after 5ms',
    })
  })

  it('requests the all-film public listing only once per polling pass', async () => {
    let calls = 0
    const provider: UpstreamProvider = {
      async fetchSessions() {
        calls += 1
        return { kind: 'ok', sessions: [] }
      },
    }
    const store = new MemoryStore({ filmIds: ['HO00000546', 'HO00000547'] })
    const scheduler = new PollScheduler({
      provider,
      store,
      cooldownMs: 60_000,
    })

    expect(await scheduler.runOnce()).toBe(true)
    expect(calls).toBe(1)
  })

  it('establishes an exact preview baseline without alerting and later delivers a release transition', async () => {
    let pass = 0
    let now = new Date('2026-07-17T00:00:00.000Z')
    const provider: UpstreamProvider = {
      async fetchSessions() { return { kind: 'ok', sessions: [listingSession] } },
    }
    const seatProvider: SeatPreviewProvider = {
      async fetchSeatPreviews(sessions) {
        pass += 1
        return {
          kind: 'ok',
          bootstrap: 'ready',
          detail: 'Exact Lumos preview captured 1 session(s).',
          observations: [{
            ...sessions[0]!,
            seatData: { state: 'captured', capturedAt: now.toISOString() },
            seats: [{ row: 'J', number: 10, status: pass === 1 ? 'sold' : 'available' }],
          }],
          failures: [],
          attemptedAt: now.toISOString(),
          eligibleSessionCount: 1,
          attemptedSessionCount: 1,
        }
      },
    }
    const store = new MemoryStore({ filmIds: ['HO00000546'], now: () => now })
    const created = store.createSubscription('ready@example.com', matchingFilters)
    store.confirmSubscription(created.confirmationToken)
    const deliveries: string[][] = []
    const scheduler = new PollScheduler({
      provider,
      seatProvider,
      store,
      cooldownMs: 0,
      previewCooldownMs: 0,
      now: () => now,
      onDeliveries: async (pending) => {
        deliveries.push(pending.map(({ id }) => id))
        return pending.map(({ id }) => id)
      },
    })

    await scheduler.runOnce()
    expect(store.getStatus()).toMatchObject({ transitionCount: 0, seatCapture: { state: 'fresh' } })
    expect(deliveries).toEqual([])

    now = new Date('2026-07-17T00:01:00.000Z')
    await scheduler.runOnce()

    expect(store.getStatus().transitionCount).toBe(1)
    expect(deliveries).toHaveLength(1)
  })

  it('keeps listing discovery healthy and exact seats last-known when a later preview fails', async () => {
    let pass = 0
    let now = new Date('2026-07-17T00:00:00.000Z')
    const provider: UpstreamProvider = {
      async fetchSessions() { return { kind: 'ok', sessions: [listingSession] } },
    }
    const seatProvider: SeatPreviewProvider = {
      async fetchSeatPreviews(sessions) {
        pass += 1
        if (pass === 1) {
          return {
            kind: 'ok',
            bootstrap: 'ready',
            detail: 'Exact Lumos preview captured 1 session(s).',
            observations: [{
              ...sessions[0]!,
              seatData: { state: 'captured', capturedAt: now.toISOString() },
              seats: [{ row: 'J', number: 10, status: 'sold' }],
            }],
            failures: [],
            attemptedAt: now.toISOString(),
            eligibleSessionCount: 1,
            attemptedSessionCount: 1,
          }
        }
        return {
          kind: 'blocked',
          bootstrap: 'ready',
          detail: 'Lumos seat availability returned HTTP 429',
          observations: [],
          failures: [{
            sessionId: sessions[0]!.id,
            attemptedAt: now.toISOString(),
            kind: 'blocked',
            detail: 'Lumos seat availability returned HTTP 429',
          }],
          attemptedAt: now.toISOString(),
          eligibleSessionCount: 1,
          attemptedSessionCount: 1,
        }
      },
    }
    const store = new MemoryStore({ filmIds: ['HO00000546'], now: () => now })
    const scheduler = new PollScheduler({
      provider,
      seatProvider,
      store,
      cooldownMs: 0,
      previewCooldownMs: 0,
      now: () => now,
    })

    await scheduler.runOnce()
    now = new Date('2026-07-17T00:01:00.000Z')
    await scheduler.runOnce()

    expect(store.getStatus()).toMatchObject({
      sessionDiscovery: { state: 'ok' },
      lumosBootstrap: { state: 'ready' },
      seatCapture: { state: 'blocked', capturedSessionCount: 1, failedSessionCount: 1 },
    })
    expect(store.getSessions()[0]).toMatchObject({
      seats: [{ row: 'J', number: 10, status: 'sold' }],
      seatData: { state: 'captured', source: 'lumos_preview', lastFailure: { kind: 'blocked' } },
    })
  })

  it('reports partial seat capture when the preview budget omits eligible sessions', async () => {
    const provider: UpstreamProvider = {
      async fetchSessions() { return { kind: 'ok', sessions: [listingSession] } },
    }
    const seatProvider: SeatPreviewProvider = {
      async fetchSeatPreviews(sessions) {
        return {
          kind: 'ok',
          bootstrap: 'ready',
          detail: 'Exact Lumos preview captured 1 session(s).',
          observations: [{
            ...sessions[0]!,
            seatData: { state: 'captured', capturedAt: '2026-07-17T00:00:00.000Z' },
            seats: [{ row: 'J', number: 10, status: 'sold' }],
          }],
          failures: [],
          attemptedAt: '2026-07-17T00:00:00.000Z',
          eligibleSessionCount: 2,
          attemptedSessionCount: 1,
        }
      },
    }
    const store = new MemoryStore({ filmIds: ['HO00000546'], now: () => new Date('2026-07-17T00:00:00.000Z') })
    const scheduler = new PollScheduler({ provider, seatProvider, store, cooldownMs: 0, previewCooldownMs: 0 })

    await scheduler.runOnce()

    expect(store.getStatus().seatCapture.state).toBe('partial')
  })

  it('previews preserved sessions and retries outbox delivery when listing refresh fails', async () => {
    const now = new Date('2026-07-17T00:00:00.000Z')
    const store = new MemoryStore({ filmIds: ['HO00000546'], now: () => now })
    store.ingest([listingSession], 'provider', 'initial-listing')
    queueDelivery(store)
    let previewCalls = 0
    let deliveryCalls = 0
    const scheduler = new PollScheduler({
      provider: { async fetchSessions() { return { kind: 'blocked', reason: 'Cloudflare challenge' } } },
      seatProvider: {
        async fetchSeatPreviews(sessions) {
          previewCalls += 1
          expect(sessions.map(({ id }) => id)).toEqual([listingSession.id])
          return {
            kind: 'ok',
            bootstrap: 'not_attempted',
            detail: 'No preview required.',
            observations: [],
            failures: [],
            attemptedAt: now.toISOString(),
            eligibleSessionCount: 0,
            attemptedSessionCount: 0,
          }
        },
      },
      store,
      cooldownMs: 60_000,
      previewCooldownMs: 0,
      now: () => now,
      onDeliveries: async (deliveries) => {
        deliveryCalls += 1
        return deliveries.map(({ id }) => id)
      },
    })

    await scheduler.runOnce()

    expect({ previewCalls, deliveryCalls }).toEqual({ previewCalls: 1, deliveryCalls: 1 })
    expect(store.getSessions()).toHaveLength(1)
    expect(store.getPendingDeliveries()).toEqual([])
    expect(store.getStatus().sessionDiscovery.state).toBe('blocked')
  })

  it('keeps failed email pending without failing or backing off listing work', async () => {
    const now = new Date('2026-07-17T00:00:00.000Z')
    const store = new MemoryStore({ filmIds: ['HO00000546'], now: () => now })
    store.ingest([listingSession], 'provider', 'initial-listing')
    queueDelivery(store)
    let listingCalls = 0
    let deliveryCalls = 0
    const scheduler = new PollScheduler({
      provider: {
        async fetchSessions() {
          listingCalls += 1
          return { kind: 'ok', sessions: [listingSession] }
        },
      },
      store,
      cooldownMs: 0,
      now: () => now,
      onDeliveries: async (deliveries) => {
        deliveryCalls += 1
        if (deliveryCalls === 1) throw new Error('temporary email failure')
        return deliveries.map(({ id }) => id)
      },
    })

    await scheduler.runOnce()
    expect(store.getStatus().sessionDiscovery.state).toBe('ok')
    expect(store.getPendingDeliveries()).toHaveLength(1)

    await scheduler.runOnce()

    expect({ listingCalls, deliveryCalls }).toEqual({ listingCalls: 2, deliveryCalls: 2 })
    expect(store.getPendingDeliveries()).toEqual([])
    expect(store.getStatus().sessionDiscovery.state).toBe('ok')
  })

  it('times out a hung delivery and allows later polling passes to continue', async () => {
    const store = new MemoryStore({ filmIds: ['HO00000546'] })
    queueDelivery(store)
    let listingCalls = 0
    let deliveryCalls = 0
    const scheduler = new PollScheduler({
      provider: {
        async fetchSessions() {
          listingCalls += 1
          return { kind: 'ok', sessions: [listingSession] }
        },
      },
      store,
      cooldownMs: 0,
      deliveryTimeoutMs: 5,
      onDeliveries: async () => {
        deliveryCalls += 1
        if (deliveryCalls === 1) return new Promise<string[]>(() => {})
        return store.getPendingDeliveries().map(({ id }) => id)
      },
    })

    expect(await scheduler.runOnce()).toBe(true)
    expect(store.getPendingDeliveries()).toHaveLength(1)
    expect(await scheduler.runOnce()).toBe(true)

    expect({ listingCalls, deliveryCalls }).toEqual({ listingCalls: 2, deliveryCalls: 2 })
    expect(store.getPendingDeliveries()).toEqual([])
  }, 250)

  it('rotates a bounded outbox batch so one failed delivery cannot monopolize passes', async () => {
    const store = new MemoryStore({ filmIds: ['HO00000546'] })
    queueDeliveries(store, 3)
    const attempted: string[][] = []
    const firstId = store.getPendingDeliveries()[0]?.id
    const scheduler = new PollScheduler({
      provider: { async fetchSessions() { return { kind: 'ok', sessions: [listingSession] } } },
      store,
      cooldownMs: 0,
      deliveryBatchSize: 1,
      onDeliveries: async (deliveries) => {
        attempted.push(deliveries.map(({ id }) => id))
        return deliveries[0]?.id === firstId ? [] : deliveries.map(({ id }) => id)
      },
    })

    await scheduler.runOnce()
    await scheduler.runOnce()
    await scheduler.runOnce()

    expect(attempted).toHaveLength(3)
    expect(attempted.every((batch) => batch.length === 1)).toBe(true)
    expect(new Set(attempted.flat()).size).toBe(3)
    expect(store.getPendingDeliveries().map(({ id }) => id)).toEqual([firstId])
  })

  it('acknowledges only successful IDs from a partial delivery batch', async () => {
    const store = new MemoryStore({ filmIds: ['HO00000546'] })
    queueDeliveries(store, 3)
    const before = store.getPendingDeliveries().map(({ id }) => id)
    const scheduler = new PollScheduler({
      provider: { async fetchSessions() { return { kind: 'ok', sessions: [listingSession] } } },
      store,
      cooldownMs: 0,
      deliveryBatchSize: 3,
      onDeliveries: async (deliveries) => [deliveries[0]!.id],
    })

    await scheduler.runOnce()

    expect(store.getPendingDeliveries().map(({ id }) => id)).toEqual(before.slice(1))
  })
})
