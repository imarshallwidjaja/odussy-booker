import { describe, expect, it } from 'vitest'

import { ingestSchema, subscriptionSchema } from '../src/server/validation.js'

describe('HTTP payload validation', () => {
  it('strictly accepts normalized J-M ingest payloads', () => {
    const result = ingestSchema.safeParse({
      eventId: 'capture-20260718-1',
      sessions: [{
        id: 'session-1',
        filmId: 'HO00000546',
        title: 'Supplied title',
        startsAt: '2026-07-18T09:00:00.000Z',
        format: 'laser',
        bookingUrl: 'https://imaxmelbourne.com.au/session/session-1',
        seats: [{ row: 'M', number: 1, status: 'held' }],
      }],
    })

    expect(result.success).toBe(true)
    expect(ingestSchema.safeParse({
      ...result.data,
      extra: true,
    }).success).toBe(false)
  })

  it('rejects invalid rows, unknown films, and unsafe booking links', () => {
    const base = {
      eventId: 'event',
      sessions: [{
        id: 'session-1',
        filmId: 'HO00000546',
        title: 'Supplied title',
        startsAt: '2026-07-18T09:00:00.000Z',
        format: '70mm',
        bookingUrl: 'javascript:alert(1)',
        seats: [{ row: 'I', number: 1, status: 'available' }],
      }],
    }

    expect(ingestSchema.safeParse(base).success).toBe(false)
  })

  it('rejects duplicate sessions and seats as malformed observations', () => {
    const session = {
      id: 'session-1',
      filmId: 'HO00000546',
      title: 'Supplied title',
      startsAt: '2026-07-18T09:00:00.000Z',
      format: 'laser',
      bookingUrl: 'https://imaxmelbourne.com.au/session/session-1',
      seats: [
        { row: 'J', number: 10, status: 'sold' },
        { row: 'J', number: 10, status: 'available' },
      ],
    }

    expect(ingestSchema.safeParse({ eventId: 'duplicate-seats', sessions: [session] }).success).toBe(false)
    expect(ingestSchema.safeParse({
      eventId: 'duplicate-sessions',
      sessions: [{ ...session, seats: session.seats.slice(0, 1) }, { ...session, seats: session.seats.slice(1) }],
    }).success).toBe(false)
  })

  it('rejects empty exact maps and film-format mismatches', () => {
    const session = {
      id: 'session-1',
      filmId: 'HO00000546',
      title: 'Supplied title',
      startsAt: '2026-07-18T09:00:00.000Z',
      format: 'laser',
      bookingUrl: 'https://imaxmelbourne.com.au/session/session-1',
      seats: [{ row: 'J', number: 10, status: 'sold' }],
    }

    expect(ingestSchema.safeParse({ eventId: 'empty', sessions: [{ ...session, seats: [] }] }).success).toBe(false)
    expect(ingestSchema.safeParse({
      eventId: 'wrong-laser-format',
      sessions: [{ ...session, format: '70mm' }],
    }).success).toBe(false)
    expect(ingestSchema.safeParse({
      eventId: 'wrong-film-format',
      sessions: [{ ...session, filmId: 'HO00000547', format: 'laser' }],
    }).success).toBe(false)
  })

  it('normalizes valid subscription filters and bounds minimum seats', () => {
    const result = subscriptionSchema.safeParse({
      email: 'fan@example.com',
      filters: {
        filmIds: ['HO00000547'],
        format: 'laser',
        weekdays: ['monday', 'friday'],
        time: { preset: 'custom', from: '17:30', to: '21:15' },
        minimumSeats: 6,
        adjacentOnly: true,
      },
    })

    expect(result.success).toBe(true)
    expect(subscriptionSchema.safeParse({
      email: 'fan@example.com',
      filters: { ...result.data?.filters, minimumSeats: 7 },
    }).success).toBe(false)
  })

  it('accepts the anytime preset so all-day dashboard filters are inheritable', () => {
    const result = subscriptionSchema.safeParse({
      email: 'fan@example.com',
      filters: {
        filmIds: ['HO00000546', 'HO00000547'],
        format: 'all',
        weekdays: ['saturday', 'sunday'],
        time: { preset: 'anytime' },
        minimumSeats: 1,
        adjacentOnly: false,
      },
    })

    expect(result.success).toBe(true)
  })
})
