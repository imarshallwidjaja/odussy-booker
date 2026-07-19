import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  ImaxMelbourneListingProvider,
  parseImaxMelbourneListing,
} from '../src/server/provider.js'
import {
  LumosPreviewSeatProvider,
  extractLumosBootstrap,
  findVistaConnectUrl,
  normalizeLumosSeats,
  validateLumosServiceUrl,
} from '../src/server/lumos-provider.js'
import type { SessionSnapshot } from '../src/domain/types.js'

const fixtureUrl = new URL('./fixtures/imax-movie-sessions.html', import.meta.url)
const lumosFilmUrl = new URL('./fixtures/lumos-film.html', import.meta.url)
const lumosCmsUrl = new URL('./fixtures/lumos-cms-configuration.json', import.meta.url)
const lumosLayoutUrl = new URL('./fixtures/lumos-seat-layout.json', import.meta.url)
const lumosMissingNumberLayoutUrl = new URL('./fixtures/lumos-seat-layout-missing-number.json', import.meta.url)
const lumosAvailabilityUrl = new URL('./fixtures/lumos-seat-availability.json', import.meta.url)
const fetchedAt = new Date('2026-12-31T00:00:00.000Z')

const publicFilmUrl = 'https://web.imaxmelbourne.com.au/films/HO00000547'
const cmsApiUrl = 'https://imax-melbourne-cms-api.app.vista.co'
const digitalApiUrl = 'https://imax-melbourne-digital-api.app.vista.co'

function linkedSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 'HO00000547-20260721T1900',
    filmId: 'HO00000547',
    title: 'THE ODYSSEY - IMAX 70MM FILM PRESENTATION [m]',
    startsAt: '2026-07-21T09:00:00.000Z',
    format: '70mm',
    bookingUrl: 'https://web.imaxmelbourne.com.au/order/showtimes/IMAX-22854/seats',
    listing: { status: 'available', observedAt: '2026-07-20T00:00:00.000Z', sourceId: 'IMAX-22854' },
    seatData: { state: 'unavailable', capturedAt: null },
    seats: [],
    ...overrides,
  }
}

function jwt(exp: number, marker = 'fixture'): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ scope: 'CXM_JourneyViewer', exp, marker })}.fixture`
}

function filmHtml(token: string): string {
  return `<!doctype html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { environment: { gasToken: token }, cmsConfig: { apiUrl: cmsApiUrl } } },
  })}</script>`
}

async function lumosFixtures() {
  const [film, cms, layout, availability] = await Promise.all([
    readFile(lumosFilmUrl, 'utf8'),
    readFile(lumosCmsUrl, 'utf8'),
    readFile(lumosLayoutUrl, 'utf8'),
    readFile(lumosAvailabilityUrl, 'utf8'),
  ])
  return { film, cms, layout, availability }
}

describe('IMAX Melbourne public listing provider', () => {
  it('maps only the exact Odyssey sections and every listed session state', async () => {
    const html = await readFile(fixtureUrl, 'utf8')

    const sessions = parseImaxMelbourneListing(html, fetchedAt)

    expect(sessions).toHaveLength(5)
    expect(new Set(sessions.map(({ filmId }) => filmId))).toEqual(new Set(['HO00000546', 'HO00000547']))
    expect(sessions.filter(({ format }) => format === 'laser')).toHaveLength(3)
    expect(sessions.filter(({ format }) => format === '70mm')).toHaveLength(2)
    expect(sessions.map(({ startsAt }) => startsAt)).toEqual([
      '2026-12-31T02:50:00.000Z',
      '2027-01-01T06:25:00.000Z',
      '2027-01-02T10:00:00.000Z',
      '2026-12-30T23:15:00.000Z',
      '2027-01-01T02:50:00.000Z',
    ])
    expect(sessions.map(({ listing }) => listing.status)).toEqual([
      'available',
      'filling',
      'soldout',
      'soldout',
      'available',
    ])
    expect(sessions[0]).toMatchObject({
      id: 'HO00000546-20261231T1350',
      title: 'THE ODYSSEY - 4K LASER PRESENTATION [m]',
      bookingUrl: 'https://web.imaxmelbourne.com.au/order/showtimes/IMAX-22854/seats',
      listing: { sourceId: 'IMAX-22854', observedAt: fetchedAt.toISOString() },
      seatData: { state: 'unavailable', capturedAt: null },
      seats: [],
    })
    expect(sessions[2]).toMatchObject({
      bookingUrl: null,
      listing: { status: 'soldout', sourceId: null },
    })
  })

  it('keeps identity stable when booking links and listing status change', async () => {
    const html = await readFile(fixtureUrl, 'utf8')
    const changed = html
      .replace(
        `<a href="https://web.imaxmelbourne.com.au/order/showtimes/IMAX-22855/seats">
              <span class="time filling"><span class="label-time">5:25pm</span></span>
            </a>`,
        '<span class="time soldout"><span class="label-time">5:25pm</span></span>',
      )

    const before = parseImaxMelbourneListing(html, fetchedAt)
    const after = parseImaxMelbourneListing(changed, fetchedAt)

    expect(after.map(({ id }) => id)).toEqual(before.map(({ id }) => id))
    expect(before[1]).toMatchObject({
      bookingUrl: 'https://web.imaxmelbourne.com.au/order/showtimes/IMAX-22855/seats',
      listing: { status: 'filling', sourceId: 'IMAX-22855' },
    })
    expect(after[1]).toMatchObject({
      bookingUrl: null,
      listing: { status: 'soldout', sourceId: null },
    })
  })

  it('makes one honest public listing request and filters configured films locally', async () => {
    const html = await readFile(fixtureUrl, 'utf8')
    const requests: Array<{ input: string; init?: RequestInit }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ input: String(input), init })
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
    }
    const provider = new ImaxMelbourneListingProvider({
      filmIds: ['HO00000547'],
      fetchImpl,
      now: () => fetchedAt,
    })

    const result = await provider.fetchSessions(new AbortController().signal)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.input).toBe('https://prod.imaxmelbourne.com.au/html/movie_sessions/')
    expect(requests[0]?.init?.redirect).toBe('manual')
    expect(new Headers(requests[0]?.init?.headers).get('user-agent')).toContain('github.com/imarshallwidjaja/odussy-booker')
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(result.sessions.every(({ filmId }) => filmId === 'HO00000547')).toBe(true)
  })

  it.each([
    'http://127.0.0.1:3000/internal',
    'https://attacker.example/phishing',
  ])('rejects a public listing redirect to %s without a second request', async (location) => {
    const requests: Array<{ input: string; init?: RequestInit }> = []
    const provider = new ImaxMelbourneListingProvider({
      filmIds: ['HO00000546'],
      fetchImpl: async (input, init) => {
        requests.push({ input: String(input), init })
        return new Response(null, { status: 302, headers: { location } })
      },
      now: () => fetchedAt,
    })

    const result = await provider.fetchSessions(new AbortController().signal)

    expect(result).toEqual({ kind: 'error', message: 'Public listing returned HTTP 302' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.init?.redirect).toBe('manual')
  })

  it.each([
    'https://attacker.example/order/showtimes/IMAX-22854/seats',
    'https://web.imaxmelbourne.com.au/order/showtimes/IMAX-22854/seats?return=https://attacker.example',
    'https://user@web.imaxmelbourne.com.au/order/showtimes/IMAX-22854/seats',
    'javascript:alert(1)',
  ])('drops untrusted booking link %s and its source ID', async (untrustedUrl) => {
    const html = (await readFile(fixtureUrl, 'utf8')).replace(
      'https://web.imaxmelbourne.com.au/order/showtimes/IMAX-22854/seats',
      untrustedUrl,
    )

    const [session] = parseImaxMelbourneListing(html, fetchedAt)

    expect(session).toMatchObject({ bookingUrl: null, listing: { sourceId: null } })
  })

  it('rejects an oversized streamed public listing response', async () => {
    const provider = new ImaxMelbourneListingProvider({
      filmIds: ['HO00000546'],
      fetchImpl: async () => new Response('x'.repeat(1_000_001)),
      now: () => fetchedAt,
    })

    const result = await provider.fetchSessions(new AbortController().signal)

    expect(result).toEqual({ kind: 'error', message: 'Public listing response exceeded the body limit' })
  })

  it('excludes sessions that are no longer upcoming from a successful listing', async () => {
    const html = await readFile(fixtureUrl, 'utf8')
    const provider = new ImaxMelbourneListingProvider({
      filmIds: ['HO00000546', 'HO00000547'],
      fetchImpl: async () => new Response(html),
      now: () => fetchedAt,
    })

    const result = await provider.fetchSessions(new AbortController().signal)

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.sessions.map(({ startsAt }) => startsAt)).toEqual([
        '2026-12-31T02:50:00.000Z',
        '2027-01-01T06:25:00.000Z',
        '2027-01-02T10:00:00.000Z',
        '2027-01-01T02:50:00.000Z',
      ])
    }
  })
})

describe('Lumos read-only seat preview provider', () => {
  it('strictly extracts the guest bootstrap and rejects challenge HTML', async () => {
    const { film } = await lumosFixtures()

    expect(extractLumosBootstrap(film)).toEqual({
      gasToken: expect.stringContaining('fixture-signature'),
      cmsApiUrl,
      expiresAt: new Date('2030-01-01T00:00:00.000Z').getTime(),
    })
    expect(() => extractLumosBootstrap('<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x.js"></script>'))
      .toThrow(/challenge/i)
    expect(() => extractLumosBootstrap('<script id="__NEXT_DATA__">{"props":{}}</script>'))
      .toThrow(/bootstrap/i)
  })

  it('accepts only HTTPS tenant or Vista service hosts', async () => {
    const { cms } = await lumosFixtures()

    expect(validateLumosServiceUrl(digitalApiUrl, ['imaxmelbourne.com.au', 'vista.co']).href)
      .toBe(`${digitalApiUrl}/`)
    expect(validateLumosServiceUrl('https://digital-api.imaxmelbourne.com.au', ['imaxmelbourne.com.au']).hostname)
      .toBe('digital-api.imaxmelbourne.com.au')
    expect(() => validateLumosServiceUrl('http://app.vista.co', ['vista.co'])).toThrow(/HTTPS/i)
    expect(() => validateLumosServiceUrl('https://127.0.0.1', ['vista.co'])).toThrow(/host/i)
    expect(() => validateLumosServiceUrl('https://attacker.example', ['vista.co'])).toThrow(/host/i)
    expect(() => findVistaConnectUrl({
      configuration: {
        languageVariantConfiguration: {
          en: { shared: { initial: { services: { vistaConnect: { url: `${digitalApiUrl}/orders` } } } } },
        },
      },
    }, ['vista.co'])).toThrow(/allowed Vista Connect URL/i)
    expect(findVistaConnectUrl(JSON.parse(cms), ['imaxmelbourne.com.au', 'vista.co']).href)
      .toBe(`${digitalApiUrl}/`)
  })

  it('rejects CMS and Digital API bases with route prefixes before fetching them', async () => {
    const fixtures = await lumosFixtures()
    const token = jwt(1_893_456_000)
    const cases = [
      {
        film: filmHtml(token).replace(cmsApiUrl, `${cmsApiUrl}/orders`),
        cms: fixtures.cms,
        expectedRequests: [publicFilmUrl],
      },
      {
        film: filmHtml(token),
        cms: fixtures.cms.replace(digitalApiUrl, `${digitalApiUrl}/orders`),
        expectedRequests: [publicFilmUrl, `${cmsApiUrl}/api/v1/sales-channels/web/configuration`],
      },
    ]

    for (const testCase of cases) {
      const requests: string[] = []
      const provider = new LumosPreviewSeatProvider({
        filmUrl: publicFilmUrl,
        fetchImpl: async (input) => {
          const url = String(input)
          requests.push(url)
          if (url === publicFilmUrl) return new Response(testCase.film)
          if (url === `${cmsApiUrl}/api/v1/sales-channels/web/configuration`) {
            return Response.json(JSON.parse(testCase.cms))
          }
          throw new Error(`Unexpected request ${url}`)
        },
        now: () => new Date('2026-07-20T00:00:00.000Z'),
      })

      const result = await provider.fetchSeatPreviews([linkedSession()], new AbortController().signal)

      expect(result).toMatchObject({ kind: 'error', observations: [] })
      expect(requests).toEqual(testCase.expectedRequests)
      expect(requests.every((url) => !new URL(url).pathname.startsWith('/orders'))).toBe(true)
    }
  })

  it('normalizes J-M across all areas with conservative status mapping and deterministic fallback numbering', async () => {
    const { layout, availability } = await lumosFixtures()

    expect(normalizeLumosSeats(JSON.parse(layout), JSON.parse(availability))).toEqual([
      { row: 'J', number: 10, status: 'available' },
      { row: 'J', number: 11, status: 'held' },
      { row: 'K', number: 1, status: 'sold' },
      { row: 'L', number: 2, status: 'held' },
      { row: 'M', number: 3, status: 'held' },
    ])
  })

  it('fails malformed duplicate seat IDs and row-number collisions', async () => {
    const { layout, availability } = await lumosFixtures()
    const duplicateId = JSON.parse(layout)
    duplicateId.seatLayout.areas[0].rows[1].seats[1].id = 'J-10'
    const duplicateNumber = JSON.parse(layout)
    duplicateNumber.seatLayout.areas[0].rows[1].seats[1].label = '10'

    expect(() => normalizeLumosSeats(duplicateId, JSON.parse(availability))).toThrow(/duplicate seat ID/i)
    expect(() => normalizeLumosSeats(duplicateNumber, JSON.parse(availability))).toThrow(/duplicate seat J-10/i)
  })

  it('rejects a seat without a numeric label or Vista column position', async () => {
    const [layout, availability] = await Promise.all([
      readFile(lumosMissingNumberLayoutUrl, 'utf8'),
      readFile(lumosAvailabilityUrl, 'utf8'),
    ])

    expect(() => normalizeLumosSeats(JSON.parse(layout), JSON.parse(availability))).toThrow(/physical number/i)
  })

  it('uses the exact queue-free endpoint sequence and never calls an order endpoint', async () => {
    const fixtures = await lumosFixtures()
    const requests: Array<{ url: string; authorization: string | null; accept: string | null }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      requests.push({ url, authorization: headers.get('authorization'), accept: headers.get('accept') })
      if (url === publicFilmUrl) return new Response(fixtures.film, { headers: { 'content-type': 'text/html' } })
      if (url === `${cmsApiUrl}/api/v1/sales-channels/web/configuration`) return Response.json(JSON.parse(fixtures.cms))
      if (url === `${digitalApiUrl}/ocapi/v1/showtimes/IMAX-22854/seat-layout`) return Response.json(JSON.parse(fixtures.layout))
      if (url === `${digitalApiUrl}/ocapi/v1/showtimes/IMAX-22854/seat-availability?preview=true`) {
        return Response.json(JSON.parse(fixtures.availability))
      }
      throw new Error(`Unexpected request ${url}`)
    }
    const provider = new LumosPreviewSeatProvider({
      filmUrl: publicFilmUrl,
      fetchImpl,
      now: () => new Date('2026-07-20T00:00:00.000Z'),
      concurrency: 1,
      sessionBudget: 5,
    })

    const result = await provider.fetchSeatPreviews([linkedSession()], new AbortController().signal)

    expect(result).toMatchObject({
      kind: 'ok',
      observations: [{
        id: 'HO00000547-20260721T1900',
        seatData: { state: 'captured' },
        seats: [
          { row: 'J', number: 10, status: 'available' },
          { row: 'J', number: 11, status: 'held' },
          { row: 'K', number: 1, status: 'sold' },
          { row: 'L', number: 2, status: 'held' },
          { row: 'M', number: 3, status: 'held' },
        ],
      }],
      failures: [],
    })
    expect(requests.map(({ url }) => url)).toEqual([
      publicFilmUrl,
      `${cmsApiUrl}/api/v1/sales-channels/web/configuration`,
      `${digitalApiUrl}/ocapi/v1/showtimes/IMAX-22854/seat-layout`,
      `${digitalApiUrl}/ocapi/v1/showtimes/IMAX-22854/seat-availability?preview=true`,
    ])
    expect(requests.slice(1).map(({ url }) => {
      const parsed = new URL(url)
      return { pathname: parsed.pathname, search: parsed.search }
    })).toEqual([
      { pathname: '/api/v1/sales-channels/web/configuration', search: '' },
      { pathname: '/ocapi/v1/showtimes/IMAX-22854/seat-layout', search: '' },
      { pathname: '/ocapi/v1/showtimes/IMAX-22854/seat-availability', search: '?preview=true' },
    ])
    expect(requests.every(({ url }) => !url.includes('/orders'))).toBe(true)
    expect(requests.slice(1).every(({ authorization }) => authorization?.startsWith('Bearer '))).toBe(true)
    expect(requests.slice(1).every(({ accept }) => accept === 'application/json')).toBe(true)
  })

  it('polls only future sessions with proven IMAX showtime IDs within the request budget', async () => {
    const fixtures = await lumosFixtures()
    const digitalRequests: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url === publicFilmUrl) return new Response(fixtures.film)
      if (url.includes('/configuration')) return Response.json(JSON.parse(fixtures.cms))
      digitalRequests.push(url)
      if (url.endsWith('/seat-layout')) return Response.json(JSON.parse(fixtures.layout))
      return Response.json(JSON.parse(fixtures.availability))
    }
    const provider = new LumosPreviewSeatProvider({
      filmUrl: publicFilmUrl,
      fetchImpl,
      now: () => new Date('2026-07-20T00:00:00.000Z'),
      concurrency: 2,
      sessionBudget: 1,
    })

    const result = await provider.fetchSeatPreviews([
      linkedSession({ id: 'unlinked', listing: { ...linkedSession().listing, sourceId: 'OTHER-1' } }),
      linkedSession({ id: 'past', startsAt: '2026-07-19T09:00:00.000Z' }),
      linkedSession(),
      linkedSession({ id: 'later', startsAt: '2026-07-22T09:00:00.000Z', listing: { ...linkedSession().listing, sourceId: 'IMAX-22855' } }),
    ], new AbortController().signal)

    expect(result.observations.map(({ id }) => id)).toEqual(['HO00000547-20260721T1900'])
    expect(digitalRequests).toHaveLength(2)
    expect(digitalRequests.every((url) => url.includes('IMAX-22854'))).toBe(true)
  })

  it('visits every eligible session across budget-one passes', async () => {
    const fixtures = await lumosFixtures()
    let now = new Date('2026-07-20T00:00:00.000Z')
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url === publicFilmUrl) return new Response(fixtures.film)
      if (url.includes('/configuration')) return Response.json(JSON.parse(fixtures.cms))
      if (url.endsWith('/seat-layout')) return Response.json(JSON.parse(fixtures.layout))
      return Response.json(JSON.parse(fixtures.availability))
    }
    const provider = new LumosPreviewSeatProvider({
      filmUrl: publicFilmUrl,
      fetchImpl,
      now: () => now,
      concurrency: 1,
      sessionBudget: 1,
    })
    let sessions = [
      linkedSession(),
      linkedSession({
        id: 'HO00000547-20260722T1900',
        startsAt: '2026-07-22T09:00:00.000Z',
        listing: { ...linkedSession().listing, sourceId: 'IMAX-22855' },
      }),
    ]

    const first = await provider.fetchSeatPreviews(sessions, new AbortController().signal)
    sessions = sessions.map((session) => first.observations.find(({ id }) => id === session.id) ?? session)
    now = new Date('2026-07-20T00:01:00.000Z')
    const second = await provider.fetchSeatPreviews(sessions, new AbortController().signal)

    expect(first.observations.map(({ id }) => id)).toEqual(['HO00000547-20260721T1900'])
    expect(second.observations.map(({ id }) => id)).toEqual(['HO00000547-20260722T1900'])
    expect(first).toMatchObject({ eligibleSessionCount: 2, attemptedSessionCount: 1 })
    expect(second).toMatchObject({ eligibleSessionCount: 2, attemptedSessionCount: 1 })
  })

  it('rotates budget-one attempts after the earliest session fails', async () => {
    const fixtures = await lumosFixtures()
    const layoutRequests: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url === publicFilmUrl) return new Response(fixtures.film)
      if (url.includes('/configuration')) return Response.json(JSON.parse(fixtures.cms))
      if (url.endsWith('/seat-layout')) {
        layoutRequests.push(url)
        return url.includes('IMAX-22854')
          ? Response.json({ seatLayout: { areas: [] } })
          : Response.json(JSON.parse(fixtures.layout))
      }
      return Response.json(JSON.parse(fixtures.availability))
    }
    const provider = new LumosPreviewSeatProvider({
      filmUrl: publicFilmUrl,
      fetchImpl,
      now: () => new Date('2026-07-20T00:00:00.000Z'),
      concurrency: 1,
      sessionBudget: 1,
    })
    const sessions = [
      linkedSession(),
      linkedSession({
        id: 'HO00000547-20260722T1900',
        startsAt: '2026-07-22T09:00:00.000Z',
        listing: { ...linkedSession().listing, sourceId: 'IMAX-22855' },
      }),
    ]

    const first = await provider.fetchSeatPreviews(sessions, new AbortController().signal)
    const second = await provider.fetchSeatPreviews(sessions, new AbortController().signal)

    expect(first).toMatchObject({ failures: [{ sessionId: sessions[0]?.id }], attemptedSessionCount: 1 })
    expect(second).toMatchObject({ observations: [{ id: sessions[1]?.id }], attemptedSessionCount: 1 })
    expect(layoutRequests.map((url) => new URL(url).pathname)).toEqual([
      '/ocapi/v1/showtimes/IMAX-22854/seat-layout',
      '/ocapi/v1/showtimes/IMAX-22855/seat-layout',
    ])
  })

  it('caches layouts and refreshes bootstrap safely before token expiry', async () => {
    const fixtures = await lumosFixtures()
    let now = new Date('2026-07-20T00:00:00.000Z')
    const counts = { film: 0, cms: 0, layout: 0, availability: 0 }
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url === publicFilmUrl) {
        counts.film += 1
        return new Response(filmHtml(jwt(Math.floor(now.getTime() / 1000) + 120, `token-${counts.film}`)))
      }
      if (url.includes('/configuration')) {
        counts.cms += 1
        return Response.json(JSON.parse(fixtures.cms))
      }
      if (url.endsWith('/seat-layout')) {
        counts.layout += 1
        return Response.json(JSON.parse(fixtures.layout))
      }
      counts.availability += 1
      return Response.json(JSON.parse(fixtures.availability))
    }
    const provider = new LumosPreviewSeatProvider({ filmUrl: publicFilmUrl, fetchImpl, now: () => now })
    const signal = new AbortController().signal

    await provider.fetchSeatPreviews([linkedSession()], signal)
    now = new Date('2026-07-20T00:00:30.000Z')
    await provider.fetchSeatPreviews([linkedSession()], signal)
    now = new Date('2026-07-20T00:01:01.000Z')
    await provider.fetchSeatPreviews([linkedSession()], signal)

    expect(counts).toEqual({ film: 2, cms: 2, layout: 1, availability: 3 })
  })

  it('invalidates bootstrap and retries exactly once after a 401', async () => {
    const fixtures = await lumosFixtures()
    const requests: string[] = []
    const availabilityAuthorization: string[] = []
    let bootstrapCount = 0
    let availabilityCount = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      requests.push(url)
      if (url === publicFilmUrl) {
        bootstrapCount += 1
        return new Response(filmHtml(jwt(1_893_456_000, `token-${bootstrapCount}`)))
      }
      if (url.includes('/configuration')) return Response.json(JSON.parse(fixtures.cms))
      if (url.endsWith('/seat-layout')) return Response.json(JSON.parse(fixtures.layout))
      availabilityCount += 1
      availabilityAuthorization.push(new Headers(init?.headers).get('authorization') ?? '')
      if (availabilityCount === 1) return new Response(null, { status: 401 })
      return Response.json(JSON.parse(fixtures.availability))
    }
    const provider = new LumosPreviewSeatProvider({
      filmUrl: publicFilmUrl,
      fetchImpl,
      now: () => new Date('2026-07-20T00:00:00.000Z'),
    })

    const result = await provider.fetchSeatPreviews([linkedSession()], new AbortController().signal)

    expect(result.kind).toBe('ok')
    expect(requests).toEqual([
      publicFilmUrl,
      `${cmsApiUrl}/api/v1/sales-channels/web/configuration`,
      `${digitalApiUrl}/ocapi/v1/showtimes/IMAX-22854/seat-layout`,
      `${digitalApiUrl}/ocapi/v1/showtimes/IMAX-22854/seat-availability?preview=true`,
      publicFilmUrl,
      `${cmsApiUrl}/api/v1/sales-channels/web/configuration`,
      `${digitalApiUrl}/ocapi/v1/showtimes/IMAX-22854/seat-availability?preview=true`,
    ])
    expect(new Set(availabilityAuthorization).size).toBe(2)
  })

  it('refreshes the bootstrap once for CMS 401 and does not loop', async () => {
    let filmRequests = 0
    let cmsRequests = 0
    const provider = new LumosPreviewSeatProvider({
      filmUrl: publicFilmUrl,
      fetchImpl: async (input) => {
        const url = String(input)
        if (url === publicFilmUrl) {
          filmRequests += 1
          return new Response(filmHtml(jwt(1_893_456_000, `token-${filmRequests}`)))
        }
        if (url.includes('/configuration')) {
          cmsRequests += 1
          return new Response(null, { status: 401 })
        }
        throw new Error(`Unexpected request ${url}`)
      },
      now: () => new Date('2026-07-20T00:00:00.000Z'),
    })

    const result = await provider.fetchSeatPreviews([linkedSession()], new AbortController().signal)

    expect(result).toMatchObject({ kind: 'error', bootstrap: 'error', observations: [] })
    expect({ filmRequests, cmsRequests }).toEqual({ filmRequests: 2, cmsRequests: 2 })
  })

  it('continues other sessions after one malformed preview response', async () => {
    const fixtures = await lumosFixtures()
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url === publicFilmUrl) return new Response(fixtures.film)
      if (url.includes('/configuration')) return Response.json(JSON.parse(fixtures.cms))
      if (url.includes('IMAX-22854/seat-layout')) return Response.json({ seatLayout: { areas: [] } })
      if (url.endsWith('/seat-layout')) return Response.json(JSON.parse(fixtures.layout))
      return Response.json(JSON.parse(fixtures.availability))
    }
    const provider = new LumosPreviewSeatProvider({
      filmUrl: publicFilmUrl,
      fetchImpl,
      now: () => new Date('2026-07-20T00:00:00.000Z'),
      concurrency: 1,
    })

    const result = await provider.fetchSeatPreviews([
      linkedSession(),
      linkedSession({
        id: 'HO00000547-20260722T1900',
        startsAt: '2026-07-22T09:00:00.000Z',
        listing: { ...linkedSession().listing, sourceId: 'IMAX-22855' },
      }),
    ], new AbortController().signal)

    expect(result).toMatchObject({
      kind: 'ok',
      bootstrap: 'ready',
      observations: [{ id: 'HO00000547-20260722T1900' }],
      failures: [{ sessionId: 'HO00000547-20260721T1900', kind: 'error' }],
    })
  })

  it('returns one typed blocked result without retrying a challenge page', async () => {
    let calls = 0
    const provider = new LumosPreviewSeatProvider({
      filmUrl: publicFilmUrl,
      fetchImpl: async () => {
        calls += 1
        return new Response('<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x.js"></script>')
      },
      now: () => new Date('2026-07-20T00:00:00.000Z'),
    })

    const result = await provider.fetchSeatPreviews([linkedSession()], new AbortController().signal)

    expect(result).toMatchObject({
      kind: 'blocked',
      observations: [],
      failures: [{
        sessionId: 'HO00000547-20260721T1900',
        kind: 'blocked',
        detail: 'Public film bootstrap returned a challenge page',
      }],
    })
    expect(JSON.stringify(result)).not.toContain('fixture-signature')
    expect(calls).toBe(1)
  })
})
