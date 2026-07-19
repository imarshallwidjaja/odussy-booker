import type { SessionSnapshot } from '../domain/types.js'
import { parse } from 'node-html-parser'
import { readBoundedText } from './http.js'

const LISTING_URL = 'https://prod.imaxmelbourne.com.au/html/movie_sessions/'
const USER_AGENT = 'HouseLights/0.1 (+https://github.com/imarshallwidjaja/odussy-booker)'
const LISTING_BODY_LIMIT = 1_000_000
const BOOKING_PATH = /^\/order\/showtimes\/(IMAX-[0-9]+)\/seats$/

const presentations = [
  {
    slug: '/movie/the-odyssey-4k-laser',
    filmId: 'HO00000546',
    title: 'THE ODYSSEY - 4K LASER PRESENTATION [m]',
    format: 'laser',
  },
  {
    slug: '/movie/the-odyssey-imax-1570-film-presentation',
    filmId: 'HO00000547',
    title: 'THE ODYSSEY - IMAX 70MM FILM PRESENTATION [m]',
    format: '70mm',
  },
] as const

const monthNumbers: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
}

const weekdayNumbers: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}

const melbourneDateTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Australia/Melbourne',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

interface LocalDateTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function localParts(value: Date): LocalDateTime {
  const parts = Object.fromEntries(
    melbourneDateTime.formatToParts(value)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value: part }) => [type, Number(part)]),
  )
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
  }
}

function localInstant(parts: LocalDateTime): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  let timestamp = target
  for (let pass = 0; pass < 3; pass += 1) {
    const rendered = localParts(new Date(timestamp))
    const renderedTimestamp = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
    )
    const correction = target - renderedTimestamp
    if (correction === 0) return new Date(timestamp)
    timestamp += correction
  }
  throw new Error('Session time does not resolve in Australia/Melbourne')
}

function parseDateLabel(label: string, fetchedAt: Date): Pick<LocalDateTime, 'year' | 'month' | 'day'> {
  const fetched = localParts(fetchedAt)
  if (label === 'Today' || label === 'Tomorrow') {
    const offset = label === 'Tomorrow' ? 1 : 0
    const date = new Date(Date.UTC(fetched.year, fetched.month - 1, fetched.day + offset))
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
  }

  const match = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) ([A-Za-z]+) (\d{1,2})$/.exec(label)
  if (!match) throw new Error(`Unsupported listing date: ${label}`)
  const [, weekdayLabel, monthLabel, dayLabel] = match
  if (!weekdayLabel || !monthLabel || !dayLabel) throw new Error(`Invalid listing date: ${label}`)
  const weekday = weekdayNumbers[weekdayLabel.toLowerCase()]
  const month = monthNumbers[monthLabel.toLowerCase()]
  const day = Number(dayLabel)
  if (weekday === undefined || month === undefined || day < 1 || day > 31) {
    throw new Error(`Invalid listing date: ${label}`)
  }

  const fetchedDay = Date.UTC(fetched.year, fetched.month - 1, fetched.day)
  const candidates = [fetched.year - 1, fetched.year, fetched.year + 1]
    .map((year) => ({ year, timestamp: Date.UTC(year, month - 1, day) }))
    .filter(({ timestamp }) => {
      const date = new Date(timestamp)
      return date.getUTCMonth() === month - 1 && date.getUTCDate() === day && date.getUTCDay() === weekday
    })
    .sort((a, b) => Math.abs(a.timestamp - fetchedDay) - Math.abs(b.timestamp - fetchedDay))
  const selected = candidates[0]
  if (!selected) throw new Error(`Listing weekday does not match date: ${label}`)
  return { year: selected.year, month, day }
}

function parseTimeLabel(label: string): Pick<LocalDateTime, 'hour' | 'minute'> {
  const match = /^(\d{1,2}):(\d{2})(am|pm)$/i.exec(label)
  if (!match) throw new Error(`Unsupported listing time: ${label}`)
  const [, hourLabel, minuteLabel, meridiem] = match
  if (!hourLabel || !minuteLabel || !meridiem) throw new Error(`Invalid listing time: ${label}`)
  const rawHour = Number(hourLabel)
  const minute = Number(minuteLabel)
  if (rawHour < 1 || rawHour > 12 || minute > 59) throw new Error(`Invalid listing time: ${label}`)
  return {
    hour: rawHour % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0),
    minute,
  }
}

function stableSessionId(filmId: string, parts: LocalDateTime): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${filmId}-${parts.year}${pad(parts.month)}${pad(parts.day)}T${pad(parts.hour)}${pad(parts.minute)}`
}

function parseBookingUrl(rawUrl: string | undefined): { bookingUrl: string | null; sourceId: string | null } {
  if (!rawUrl) return { bookingUrl: null, sourceId: null }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { bookingUrl: null, sourceId: null }
  }
  const match = BOOKING_PATH.exec(url.pathname)
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'web.imaxmelbourne.com.au'
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || !match?.[1]
  ) {
    return { bookingUrl: null, sourceId: null }
  }
  return { bookingUrl: url.href, sourceId: match[1] }
}

export type ProviderResult =
  | { kind: 'ok'; sessions: SessionSnapshot[] }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; message: string }

export interface UpstreamProvider {
  fetchSessions(signal: AbortSignal): Promise<ProviderResult>
}

export function parseImaxMelbourneListing(html: string, fetchedAt: Date): SessionSnapshot[] {
  const root = parse(html)
  const sessions: SessionSnapshot[] = []
  let matchedSections = 0

  for (const presentation of presentations) {
    const anchor = root.querySelectorAll(`a[href="${presentation.slug}"]`).find((candidate) =>
      candidate.querySelector('h3.movie')?.textContent.trim() === presentation.title,
    )
    if (!anchor) continue
    const sessionList = anchor.nextElementSibling
    if (!sessionList || sessionList.tagName !== 'OL' || !sessionList.classList.contains('session-list')) {
      throw new Error(`Session list missing for ${presentation.slug}`)
    }
    matchedSections += 1

    for (const block of sessionList.querySelectorAll('div.session-block')) {
      const dateLabel = block.querySelector('span.date')?.textContent.trim()
      if (!dateLabel) throw new Error(`Session date missing for ${presentation.slug}`)
      const date = parseDateLabel(dateLabel, fetchedAt)
      for (const timeElement of block.querySelectorAll('span.time')) {
        const timeLabel = timeElement.querySelector('span.label-time')?.textContent.trim()
        if (!timeLabel) throw new Error(`Session time missing for ${presentation.slug}`)
        const local = { ...date, ...parseTimeLabel(timeLabel) }
        const bookingAnchor = timeElement.closest('a') ?? timeElement.querySelector('a')
        const { bookingUrl, sourceId } = parseBookingUrl(bookingAnchor?.getAttribute('href'))
        const status = timeElement.classList.contains('soldout')
          ? 'soldout'
          : timeElement.classList.contains('filling')
            ? 'filling'
            : 'available'
        sessions.push({
          id: stableSessionId(presentation.filmId, local),
          filmId: presentation.filmId,
          title: presentation.title,
          startsAt: localInstant(local).toISOString(),
          format: presentation.format,
          bookingUrl,
          listing: { status, observedAt: fetchedAt.toISOString(), sourceId },
          seatData: { state: 'unavailable', capturedAt: null },
          seats: [],
        })
      }
    }
  }

  if (matchedSections === 0) throw new Error('Odyssey session sections were not found in the public listing')
  return sessions
}

interface ListingProviderOptions {
  filmIds: string[]
  fetchImpl?: typeof fetch
  now?: () => Date
}

export class ImaxMelbourneListingProvider implements UpstreamProvider {
  private readonly allowedFilmIds: Set<string>
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(options: ListingProviderOptions) {
    this.allowedFilmIds = new Set(options.filmIds)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  async fetchSessions(signal: AbortSignal): Promise<ProviderResult> {
    try {
      const response = await this.fetchImpl(LISTING_URL, {
        signal,
        redirect: 'manual',
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': USER_AGENT,
        },
      })
      if (response.status >= 300 && response.status < 400) {
        return { kind: 'error', message: `Public listing returned HTTP ${response.status}` }
      }
      if (!response.ok) return { kind: 'error', message: `Public listing returned HTTP ${response.status}` }
      const fetchedAt = this.now()
      const sessions = parseImaxMelbourneListing(
        await readBoundedText(response, LISTING_BODY_LIMIT, 'Public listing'),
        fetchedAt,
      )
        .filter(({ filmId, startsAt }) =>
          this.allowedFilmIds.has(filmId) && new Date(startsAt).getTime() > fetchedAt.getTime())
      return { kind: 'ok', sessions }
    } catch (error) {
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unknown public listing error',
      }
    }
  }
}
