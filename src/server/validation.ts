import { z } from 'zod'

import { seatRows, seatStatuses, supportedFilmFormats, supportedFilmIds, weekdays } from '../domain/types.js'

const time = /^([01]\d|2[0-3]):[0-5]\d$/

export function createSchemas(filmIds: string[]) {
  const filmId = z.string().refine((value) => filmIds.includes(value), 'Film is not configured')
  const seatSchema = z.strictObject({
    row: z.enum(seatRows),
    number: z.number().int().positive(),
    status: z.enum(seatStatuses),
  })
  const sessionSchema = z.strictObject({
    id: z.string().trim().min(1).max(200),
    filmId,
    title: z.string().trim().min(1).max(300),
    startsAt: z.string().datetime({ offset: true }),
    format: z.enum(['70mm', 'laser']),
    bookingUrl: z.url().refine((value) => value.startsWith('https://'), 'Booking URL must use HTTPS'),
    listing: z.strictObject({
      status: z.enum(['available', 'filling', 'soldout', 'unknown']),
      observedAt: z.string().datetime({ offset: true }).nullable(),
      sourceId: z.string().trim().min(1).max(100).nullable(),
    }).default({ status: 'unknown', observedAt: null, sourceId: null }),
    seatData: z.strictObject({
      state: z.literal('captured'),
      capturedAt: z.string().datetime({ offset: true }).nullable(),
    }).default({ state: 'captured', capturedAt: null }),
    seats: z.array(seatSchema).min(1).max(500).superRefine((seats, context) => {
      const seen = new Set<string>()
      for (const [index, seat] of seats.entries()) {
        const key = `${seat.row}-${seat.number}`
        if (seen.has(key)) context.addIssue({ code: 'custom', message: `Duplicate seat ${key}`, path: [index] })
        seen.add(key)
      }
    }),
  }).superRefine((session, context) => {
    const expected = supportedFilmFormats[session.filmId as keyof typeof supportedFilmFormats]
    if (expected && session.format !== expected) {
      context.addIssue({ code: 'custom', message: `Film ${session.filmId} requires ${expected}`, path: ['format'] })
    }
  })
  const ingest = z.strictObject({
    eventId: z.string().trim().min(1).max(200),
    sessions: z.array(sessionSchema).min(1).max(100).superRefine((sessions, context) => {
      const seen = new Set<string>()
      for (const [index, session] of sessions.entries()) {
        if (seen.has(session.id)) context.addIssue({ code: 'custom', message: `Duplicate session ${session.id}`, path: [index] })
        seen.add(session.id)
      }
    }),
  })

  const presetTime = z.strictObject({
    preset: z.enum(['anytime', 'morning', 'afternoon', 'afterwork', 'late']),
  })
  const customTime = z.strictObject({
    preset: z.literal('custom'),
    from: z.string().regex(time),
    to: z.string().regex(time),
  }).refine(({ from, to }) => from < to, 'Custom start time must be before end time')
  const filters = z.strictObject({
    filmIds: z.array(filmId).min(1).max(filmIds.length),
    format: z.enum(['all', '70mm', 'laser']),
    weekdays: z.array(z.enum(weekdays)).min(1).max(7),
    time: z.union([presetTime, customTime]),
    minimumSeats: z.number().int().min(1).max(6),
    adjacentOnly: z.boolean(),
  })
  const subscription = z.strictObject({
    email: z.email().max(320),
    filters,
  })

  return { ingestSchema: ingest, subscriptionSchema: subscription }
}

export const { ingestSchema, subscriptionSchema } = createSchemas([...supportedFilmIds])
