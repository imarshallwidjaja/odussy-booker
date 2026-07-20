import { describe, expect, it } from 'vitest'

import { MemoryStore } from '../src/domain/store.js'
import type { SessionSnapshot, SubscriptionFilters } from '../src/domain/types.js'

const filmId = 'HO00000546'
const startsAt = '2026-07-18T09:00:00.000Z'

function session(
  seats: SessionSnapshot['seats'],
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    id: 'session-1',
    filmId,
    title: 'Provider supplied title',
    startsAt,
    format: 'laser',
    bookingUrl: 'https://imaxmelbourne.com.au/session/session-1',
    listing: { status: 'unknown', observedAt: null, sourceId: null },
    seatData: { state: 'captured', capturedAt: null },
    seats,
    ...overrides,
  }
}

const filters: SubscriptionFilters = {
  filmIds: [filmId],
  format: 'all',
  weekdays: ['saturday'],
  time: { preset: 'afterwork' },
  minimumSeats: 2,
  adjacentOnly: true,
}

describe('MemoryStore ingest pipeline', () => {
  it('only accepts the fixed supported film IDs as configuration', () => {
    expect(() => new MemoryStore({ filmIds: ['HO00000999'] })).toThrow(/supported film/i)
    expect(() => new MemoryStore({ filmIds: [] })).toThrow(/film ID/i)
  })

  it('establishes a baseline and only emits non-available to available transitions', () => {
    const store = new MemoryStore({ filmIds: [filmId] })

    const baseline = store.ingest(
      [session([
        { row: 'J', number: 10, status: 'sold' },
        { row: 'J', number: 11, status: 'held' },
      ])],
      'preview',
      'event-1',
    )
    const update = store.ingest(
      [session([
        { row: 'J', number: 10, status: 'available' },
        { row: 'J', number: 11, status: 'available' },
      ])],
      'preview',
      'event-2',
    )

    expect(baseline.transitions).toEqual([])
    expect(update.transitions.map((transition) => transition.seat)).toEqual([
      { row: 'J', number: 10 },
      { row: 'J', number: 11 },
    ])
  })

  it('does not alert for a newly discovered session or repeat an ingest event', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const snapshot = session([{ row: 'K', number: 4, status: 'available' }])

    const first = store.ingest([snapshot], 'manual', 'same-event')
    const repeated = store.ingest([snapshot], 'manual', 'same-event')

    expect(first.transitions).toHaveLength(0)
    expect(repeated).toMatchObject({ duplicate: true, transitions: [], deliveries: [] })
  })

  it('preserves exact seats and emits no transition when discovery refreshes session metadata', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    store.ingest([session([{ row: 'K', number: 4, status: 'sold' }])], 'manual', 'manual-baseline')

    const discovery = store.ingest([session([], {
      id: 'listing-stable-id',
      title: 'Live listing title',
      bookingUrl: null,
      listing: { status: 'soldout', observedAt: '2026-07-18T01:00:00.000Z', sourceId: null },
      seatData: { state: 'unavailable', capturedAt: null },
    } as Partial<SessionSnapshot>)], 'provider', 'listing-refresh')

    expect(discovery).toMatchObject({ transitions: [], deliveries: [] })
    expect(store.getSessions()).toEqual([
      expect.objectContaining({
        id: 'session-1',
        title: 'Live listing title',
        seats: [{ row: 'K', number: 4, status: 'sold' }],
        seatData: expect.objectContaining({ state: 'captured' }),
        listing: expect.objectContaining({ status: 'soldout' }),
      }),
    ])
  })

  it('starts a new exact-seat baseline when the Vista source showtime changes', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const listing = session([], {
      id: 'listing-stable-id',
      listing: { status: 'available', observedAt: '2026-07-18T01:00:00.000Z', sourceId: 'IMAX-1' },
      seatData: { state: 'unavailable', capturedAt: null },
    })
    store.ingest([listing], 'provider', 'listing-1')
    store.ingest([session([{ row: 'J', number: 10, status: 'sold' }])], 'preview', 'preview-1')
    const created = store.createSubscription('ready@example.com', { ...filters, minimumSeats: 1, adjacentOnly: false })
    store.confirmSubscription(created.confirmationToken)

    store.ingest([{
      ...listing,
      listing: { ...listing.listing, sourceId: 'IMAX-2' },
      bookingUrl: 'https://web.imaxmelbourne.com.au/order/showtimes/IMAX-2/seats',
    }], 'provider', 'listing-2')
    const newBaseline = store.ingest([session([
      { row: 'J', number: 10, status: 'available' },
    ])], 'preview', 'preview-2')

    expect(newBaseline).toMatchObject({ transitions: [], deliveries: [] })
    expect(store.getPendingDeliveries()).toEqual([])
    expect(store.getSessions()[0]).toMatchObject({
      listing: { sourceId: 'IMAX-2' },
      seatData: { state: 'captured', sourceShowtimeId: 'IMAX-2' },
      seats: [{ row: 'J', number: 10, status: 'available' }],
    })
  })

  it('marks retained exact seats last-known when the Vista source disappears', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const listing = session([], {
      id: 'listing-stable-id',
      listing: { status: 'available', observedAt: '2026-07-18T01:00:00.000Z', sourceId: 'IMAX-1' },
      seatData: { state: 'unavailable', capturedAt: null },
    })
    store.ingest([listing], 'provider', 'listing-1')
    store.ingest([session([{ row: 'J', number: 10, status: 'sold' }])], 'preview', 'preview-1')
    store.setSeatCaptureStatus('fresh', 'Exact Lumos preview captured 1 session(s).', {
      attemptedAt: '2026-07-18T02:00:00.000Z',
      nextAttempt: null,
    })

    store.ingest([{
      ...listing,
      bookingUrl: null,
      listing: { ...listing.listing, sourceId: null },
    }], 'provider', 'listing-2')

    expect(store.getSessions()[0]).toMatchObject({
      listing: { sourceId: null },
      seatData: { state: 'last_known', sourceShowtimeId: 'IMAX-1' },
      seats: [{ row: 'J', number: 10, status: 'sold' }],
    })
    expect(store.getStatus().seatCapture).toMatchObject({
      state: 'partial',
      capturedSessionCount: 0,
      lastKnownSessionCount: 1,
      uncapturedSessionCount: 0,
    })
  })

  it('keeps restored source seats last-known until that source is captured again', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const listing = session([], {
      id: 'listing-stable-id',
      listing: { status: 'available', observedAt: '2026-07-18T01:00:00.000Z', sourceId: 'IMAX-1' },
      seatData: { state: 'unavailable', capturedAt: null },
    })
    store.ingest([listing], 'provider', 'listing-1')
    store.ingest([session([{ row: 'J', number: 10, status: 'sold' }])], 'preview', 'preview-1')
    store.ingest([{ ...listing, bookingUrl: null, listing: { ...listing.listing, sourceId: null } }], 'provider', 'listing-2')

    store.ingest([listing], 'provider', 'listing-3')

    expect(store.getSessions()[0]?.seatData.state).toBe('last_known')
    const restored = store.ingest([session([{ row: 'J', number: 10, status: 'sold' }])], 'preview', 'preview-2')
    expect(restored.transitions).toEqual([])
    expect(store.getSessions()[0]?.seatData).toMatchObject({ state: 'captured', sourceShowtimeId: 'IMAX-1' })
  })

  it('does not establish seat baselines or alerts from discovery-only updates', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const discovered = session([], {
      id: 'listing-stable-id',
      listing: { status: 'filling', observedAt: '2026-07-18T01:00:00.000Z', sourceId: 'IMAX-1' },
      seatData: { state: 'unavailable', capturedAt: null },
    } as Partial<SessionSnapshot>)

    const first = store.ingest([discovered], 'provider', 'listing-1')
    const second = store.ingest([{
      ...discovered,
      listing: { ...discovered.listing, status: 'soldout' },
      bookingUrl: null,
    }], 'provider', 'listing-2')

    expect(first).toMatchObject({ transitions: [], deliveries: [] })
    expect(second).toMatchObject({ transitions: [], deliveries: [] })
    expect(store.getStatus()).toMatchObject({
      transitionCount: 0,
      seatCapture: { state: 'pending', capturedSessionCount: 0, uncapturedSessionCount: 0 },
    })
  })

  it('does not classify sold-out sessions without a showtime ID as missing exact previews', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const active = session([], {
      id: 'active-session',
      listing: { status: 'available', observedAt: '2026-07-18T01:00:00.000Z', sourceId: 'IMAX-1' },
      seatData: { state: 'unavailable', capturedAt: null },
    })
    const soldOut = session([], {
      id: 'sold-out-session',
      startsAt: '2026-07-18T10:00:00.000Z',
      bookingUrl: null,
      listing: { status: 'soldout', observedAt: '2026-07-18T01:00:00.000Z', sourceId: null },
      seatData: { state: 'unavailable', capturedAt: null },
    })
    store.ingest([active, soldOut], 'provider', 'listing')
    store.ingest([{
      ...active,
      seatData: { state: 'captured', capturedAt: '2026-07-18T02:00:00.000Z' },
      seats: [{ row: 'J', number: 10, status: 'sold' }],
    }], 'preview', 'preview')
    store.setSeatCaptureStatus('fresh', 'Exact Lumos preview captured 1 session(s).', {
      attemptedAt: '2026-07-18T02:00:00.000Z',
      nextAttempt: null,
    })

    expect(store.getStatus()).toMatchObject({
      sessionCount: 2,
      seatCapture: {
        state: 'fresh',
        capturedSessionCount: 1,
        lastKnownSessionCount: 0,
        uncapturedSessionCount: 0,
      },
    })
  })

  it('does not classify retained seats as last-known coverage after the session sells out', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const listing = session([], {
      id: 'active-session',
      listing: { status: 'available', observedAt: '2026-07-18T01:00:00.000Z', sourceId: 'IMAX-1' },
      seatData: { state: 'unavailable', capturedAt: null },
    })
    store.ingest([listing], 'provider', 'listing-1')
    store.ingest([{
      ...listing,
      seatData: { state: 'captured', capturedAt: '2026-07-18T02:00:00.000Z' },
      seats: [{ row: 'J', number: 10, status: 'available' }],
    }], 'preview', 'preview')
    store.setSeatCaptureStatus('fresh', 'Exact Lumos preview captured 1 session(s).', {
      attemptedAt: '2026-07-18T02:00:00.000Z',
      nextAttempt: null,
    })

    store.ingest([{
      ...listing,
      bookingUrl: null,
      listing: { status: 'soldout', observedAt: '2026-07-18T03:00:00.000Z', sourceId: null },
    }], 'provider', 'listing-2')

    expect(store.getSessions()[0]).toMatchObject({
      listing: { status: 'soldout', sourceId: null },
      seatData: { state: 'last_known' },
      seats: [{ row: 'J', number: 10, status: 'available' }],
    })
    expect(store.getStatus().seatCapture).toMatchObject({
      state: 'fresh',
      capturedSessionCount: 0,
      lastKnownSessionCount: 0,
      uncapturedSessionCount: 0,
    })
  })

  it('preserves last-known exact seats and records a per-session preview failure', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    store.ingest([session([{ row: 'J', number: 10, status: 'sold' }])], 'preview', 'preview-baseline')

    store.recordSeatPreviewFailures([{
      sessionId: 'session-1',
      attemptedAt: '2026-07-18T10:00:00.000Z',
      kind: 'blocked',
      detail: 'Lumos seat availability returned HTTP 429',
    }])

    expect(store.getSessions()).toEqual([
      expect.objectContaining({
        seats: [{ row: 'J', number: 10, status: 'sold' }],
        seatData: expect.objectContaining({
          state: 'captured',
          source: 'lumos_preview',
          lastAttempt: '2026-07-18T10:00:00.000Z',
          lastFailure: {
            at: '2026-07-18T10:00:00.000Z',
            kind: 'blocked',
            detail: 'Lumos seat availability returned HTTP 429',
          },
        }),
      }),
    ])
  })

  it('keeps the discovered identity when later exact-seat updates trigger alerts', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const created = store.createSubscription('ready@example.com', {
      ...filters,
      minimumSeats: 1,
      adjacentOnly: false,
    })
    store.confirmSubscription(created.confirmationToken)
    store.ingest([session([], {
      id: 'HO00000546-20260718T1900',
      listing: { status: 'available', observedAt: '2026-07-18T01:00:00.000Z', sourceId: 'IMAX-1' },
      seatData: { state: 'unavailable', capturedAt: null },
    })], 'provider', 'listing')
    const baseline = store.ingest([session([
      { row: 'J', number: 10, status: 'sold' },
    ], { id: 'preview-capture-1' })], 'preview', 'preview-1')

    const update = store.ingest([session([
      { row: 'J', number: 10, status: 'available' },
    ], { id: 'preview-capture-2' })], 'preview', 'preview-2')

    expect(baseline.transitions).toEqual([])
    expect(update.deliveries).toHaveLength(1)
    expect(update.deliveries[0]?.sessions[0]?.sessionId).toBe('HO00000546-20260718T1900')
    expect(store.getSessions()).toHaveLength(1)
  })

  it('updates the dashboard from manual ingest without emitting transitions or alert deliveries', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const created = store.createSubscription('ready@example.com', { ...filters, minimumSeats: 1, adjacentOnly: false })
    store.confirmSubscription(created.confirmationToken)
    store.ingest([session([{ row: 'J', number: 10, status: 'sold' }])], 'preview', 'preview-baseline')

    const manual = store.ingest([session([{ row: 'J', number: 10, status: 'available' }])], 'manual', 'manual-update')

    expect(manual).toMatchObject({ transitions: [], deliveries: [] })
    expect(store.getPendingDeliveries()).toEqual([])
    expect(store.getStatus().transitionCount).toBe(0)
    expect(store.getSessions()[0]).toMatchObject({
      seats: [{ row: 'J', number: 10, status: 'available' }],
      seatData: { state: 'captured', source: 'manual' },
    })
  })

  it('never emits transitions or alert deliveries from sample data', () => {
    const store = new MemoryStore({ filmIds: [filmId], sampleData: true })
    const created = store.createSubscription('ready@example.com', { ...filters, minimumSeats: 1, adjacentOnly: false })
    store.confirmSubscription(created.confirmationToken)
    store.ingest([session([{ row: 'J', number: 10, status: 'sold' }])], 'preview', 'preview-baseline')

    const sample = store.ingest([session([{ row: 'J', number: 10, status: 'available' }])], 'sample', 'sample-update')

    expect(sample).toMatchObject({ transitions: [], deliveries: [] })
    expect(store.getPendingDeliveries()).toEqual([])
    expect(store.getSessions()[0]).toMatchObject({
      seats: [{ row: 'J', number: 10, status: 'available' }],
      seatData: { state: 'captured', source: 'sample' },
    })
  })

  it('records bounded per-stage status history newest-first', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    store.setUpstreamStatus('ok', 'Listing refreshed.', {
      attemptedAt: '2026-07-18T00:00:00.000Z',
      nextAttempt: null,
      succeeded: true,
    })
    store.setLumosBootstrapStatus('blocked', 'Public film bootstrap returned HTTP 403', {
      attemptedAt: '2026-07-18T00:01:00.000Z',
      nextAttempt: null,
    })
    store.setSeatCaptureStatus('parked', 'Automatic preview parked.', {
      attemptedAt: '2026-07-18T00:02:00.000Z',
      nextAttempt: '2026-07-18T12:02:00.000Z',
    })

    expect(store.getStatus().history).toEqual([
      { at: '2026-07-18T00:02:00.000Z', stage: 'seat_preview', state: 'parked', detail: 'Automatic preview parked.' },
      { at: '2026-07-18T00:01:00.000Z', stage: 'bootstrap', state: 'blocked', detail: 'Public film bootstrap returned HTTP 403' },
      { at: '2026-07-18T00:00:00.000Z', stage: 'listing', state: 'ok', detail: 'Listing refreshed.' },
    ])

    for (let index = 0; index < 60; index += 1) {
      store.setUpstreamStatus('error', `Listing failure ${index}`, {
        attemptedAt: `2026-07-18T01:${String(index).padStart(2, '0')}:00.000Z`,
        nextAttempt: null,
      })
    }
    const history = store.getStatus().history
    expect(history).toHaveLength(50)
    expect(history[0]).toMatchObject({ stage: 'listing', detail: 'Listing failure 59' })
  })

  it('rejects seats outside rows J-M', () => {
    const store = new MemoryStore({ filmIds: [filmId] })

    expect(() => store.ingest([
      session([{ row: 'I' as 'J', number: 1, status: 'available' }]),
    ], 'manual', 'event')).toThrow(/rows J-M/i)
  })

  it('rejects duplicate session IDs before changing the baseline', () => {
    const store = new MemoryStore({ filmIds: [filmId] })

    expect(() => store.ingest([
      session([{ row: 'J', number: 10, status: 'sold' }]),
      session([{ row: 'J', number: 10, status: 'available' }]),
    ], 'provider', 'event')).toThrow(/duplicate session/i)
    expect(store.getSessions()).toEqual([])
  })

  it('rejects film-format mismatches before changing stored sessions', () => {
    const store = new MemoryStore({ filmIds: [filmId] })

    expect(() => store.ingest([
      session([{ row: 'J', number: 1, status: 'sold' }], { format: '70mm' }),
    ], 'manual', 'wrong-format')).toThrow(/format/i)
    expect(store.getSessions()).toEqual([])
  })

  it('rejects an empty exact manual snapshot', () => {
    const store = new MemoryStore({ filmIds: [filmId] })

    expect(() => store.ingest([session([])], 'manual', 'empty-manual')).toThrow(/seat/i)
    expect(store.getSessions()).toEqual([])
  })

  it('reconciles cancelled and rescheduled provider-owned sessions', () => {
    const now = new Date('2026-07-17T00:00:00.000Z')
    const store = new MemoryStore({ filmIds: [filmId], now: () => now })
    const first = session([], {
      id: 'provider-first',
      seatData: { state: 'unavailable', capturedAt: null },
    })
    const cancelled = session([], {
      id: 'provider-cancelled',
      startsAt: '2026-07-18T10:00:00.000Z',
      seatData: { state: 'unavailable', capturedAt: null },
    })
    store.ingest([first, cancelled], 'provider', 'listing-1')

    const rescheduled = { ...first, id: 'provider-rescheduled', startsAt: '2026-07-18T11:00:00.000Z' }
    store.ingest([rescheduled], 'provider', 'listing-2')

    expect(store.getSessions().map(({ id }) => id)).toEqual(['provider-rescheduled'])
  })

  it('treats an empty successful listing as authoritative for provider-owned sessions', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    store.ingest([session([], { seatData: { state: 'unavailable', capturedAt: null } })], 'provider', 'listing-1')

    store.ingest([], 'provider', 'listing-2')

    expect(store.getSessions()).toEqual([])
  })

  it('preserves manually sourced sessions during provider reconciliation', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const manual = session([{ row: 'J', number: 1, status: 'sold' }], {
      id: 'manual-session',
      startsAt: '2026-07-19T09:00:00.000Z',
    })
    store.ingest([manual], 'manual', 'manual-1')
    store.ingest([session([], { seatData: { state: 'unavailable', capturedAt: null } })], 'provider', 'listing-1')

    store.ingest([], 'provider', 'listing-2')

    expect(store.getSessions().map(({ id }) => id)).toEqual(['manual-session'])
  })
})

describe('MemoryStore subscriptions', () => {
  it('normalizes duplicate email and filters into one subscription', () => {
    const store = new MemoryStore({ filmIds: [filmId] })

    const first = store.createSubscription('  FAN@Example.com ', filters)
    const duplicate = store.createSubscription('fan@example.com', {
      ...filters,
      filmIds: [...filters.filmIds].reverse(),
    })

    expect(duplicate.subscription.id).toBe(first.subscription.id)
    expect(store.subscriptionCount).toBe(1)
    expect(duplicate.reused).toBe(true)
  })

  it('does not rotate or resend an unexpired pending confirmation during cooldown', () => {
    let now = new Date('2026-07-18T00:00:00.000Z')
    const store = new MemoryStore({ filmIds: [filmId], now: () => now, confirmationCooldownMs: 60_000 })
    const first = store.createSubscription('fan@example.com', filters)
    now = new Date('2026-07-18T00:00:30.000Z')

    const duplicate = store.createSubscription(' FAN@example.com ', {
      ...filters,
      filmIds: [...filters.filmIds].reverse(),
    })

    expect(duplicate).toMatchObject({ reused: true, needsConfirmation: true, confirmationIssued: false })
    expect(duplicate.confirmationToken).toBe('')
    expect(store.confirmSubscription(first.confirmationToken)).toBe(true)

    const expiryStore = new MemoryStore({ filmIds: [filmId], now: () => now, confirmationCooldownMs: 60_000 })
    const expiring = expiryStore.createSubscription('expiry@example.com', filters)
    now = new Date('2026-07-18T00:00:45.000Z')
    expiryStore.createSubscription('expiry@example.com', filters)
    now = new Date('2026-07-19T00:00:30.001Z')
    expect(expiryStore.confirmSubscription(expiring.confirmationToken)).toBe(false)
  })

  it('caps pending filter variants for one normalized recipient', () => {
    const store = new MemoryStore({ filmIds: [filmId], pendingSubscriptionLimitPerRecipient: 2 })
    store.createSubscription('fan@example.com', { ...filters, minimumSeats: 1 })
    store.createSubscription(' FAN@example.com ', { ...filters, minimumSeats: 2 })

    expect(() => store.createSubscription('fan@example.com', { ...filters, minimumSeats: 3 }))
      .toThrow(/pending alert limit/i)
    expect(store.subscriptionCount).toBe(2)
  })

  it('requires confirmation, enforces expiry, and uses tokenized unsubscribe', () => {
    let now = new Date('2026-07-18T00:00:00.000Z')
    const store = new MemoryStore({ filmIds: [filmId], now: () => now })
    const created = store.createSubscription('fan@example.com', filters)

    expect(store.confirmSubscription('wrong-token')).toBe(false)
    now = new Date('2026-07-19T00:00:00.000Z')
    expect(store.confirmSubscription(created.confirmationToken)).toBe(false)

    const fresh = store.createSubscription('fan@example.com', filters)
    expect(store.confirmSubscription(fresh.confirmationToken)).toBe(true)
    expect(store.getManagedSubscription(fresh.manageToken)?.email).toBe('fan@example.com')
    expect(store.unsubscribe(fresh.unsubscribeToken)).toBe(true)
    expect(store.getManagedSubscription(fresh.manageToken)?.active).toBe(false)
  })

  it('alerts only confirmed matching subscriptions and bundles matching transitions', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const unverified = store.createSubscription('waiting@example.com', filters)
    const confirmed = store.createSubscription('ready@example.com', filters)
    store.confirmSubscription(confirmed.confirmationToken)
    expect(unverified.subscription.verified).toBe(false)

    store.ingest([session([
      { row: 'J', number: 10, status: 'sold' },
      { row: 'J', number: 11, status: 'sold' },
    ])], 'preview', 'baseline')
    const update = store.ingest([session([
      { row: 'J', number: 10, status: 'available' },
      { row: 'J', number: 11, status: 'available' },
    ])], 'preview', 'update')

    expect(update.deliveries).toHaveLength(1)
    expect(update.deliveries[0]).toMatchObject({
      email: 'ready@example.com',
      sessions: [{ sessionId: 'session-1', seats: [{ row: 'J', number: 10 }, { row: 'J', number: 11 }] }],
    })
  })

  it('requires adjacent available seats when adjacency is enabled', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const created = store.createSubscription('ready@example.com', filters)
    store.confirmSubscription(created.confirmationToken)
    store.ingest([session([
      { row: 'J', number: 10, status: 'sold' },
      { row: 'J', number: 12, status: 'sold' },
    ])], 'preview', 'baseline')

    const update = store.ingest([session([
      { row: 'J', number: 10, status: 'available' },
      { row: 'J', number: 12, status: 'available' },
    ])], 'preview', 'update')

    expect(update.deliveries).toHaveLength(0)
  })

  it('keeps alert deliveries pending with stable IDs until acknowledged', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const created = store.createSubscription('ready@example.com', {
      ...filters,
      minimumSeats: 1,
      adjacentOnly: false,
    })
    store.confirmSubscription(created.confirmationToken)
    store.ingest([session([
      { row: 'J', number: 10, status: 'sold' },
    ])], 'preview', 'baseline')

    const update = store.ingest([session([
      { row: 'J', number: 10, status: 'available' },
    ])], 'preview', 'update')

    expect(store.getPendingDeliveries()).toEqual(update.deliveries)
    expect(store.getPendingDeliveries()[0]?.id).toBe(update.deliveries[0]?.id)
    store.markDeliveriesSent(update.deliveries.map(({ id }) => id))
    expect(store.getPendingDeliveries()).toEqual([])
  })

  it('requires fresh confirmation before reactivating an unsubscribed alert', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const created = store.createSubscription('ready@example.com', filters)
    store.confirmSubscription(created.confirmationToken)
    store.unsubscribe(created.unsubscribeToken)

    const reused = store.createSubscription('READY@example.com', filters)

    expect(reused).toMatchObject({ reused: true, needsConfirmation: true })
    expect(store.getManagedSubscription(created.manageToken)).toMatchObject({ active: true, verified: false })
    expect(store.confirmSubscription(reused.confirmationToken)).toBe(true)
  })

  it('removes pending alert email when its subscription unsubscribes', () => {
    const store = new MemoryStore({ filmIds: [filmId] })
    const created = store.createSubscription('ready@example.com', {
      ...filters,
      minimumSeats: 1,
      adjacentOnly: false,
    })
    store.confirmSubscription(created.confirmationToken)
    store.ingest([session([{ row: 'J', number: 10, status: 'sold' }])], 'preview', 'baseline')
    store.ingest([session([{ row: 'J', number: 10, status: 'available' }])], 'preview', 'update')
    expect(store.getPendingDeliveries()).toHaveLength(1)

    store.unsubscribe(created.unsubscribeToken)

    expect(store.getPendingDeliveries()).toEqual([])
  })
})
