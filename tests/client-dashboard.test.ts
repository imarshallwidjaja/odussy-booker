// @vitest-environment jsdom

import { readFile } from 'node:fs/promises'

import { createElement, createRef, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, render as renderClient, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../src/client/App.js'
import { AlertDialog } from '../src/client/components/AlertDialog.js'
import { FiltersPanel } from '../src/client/components/FiltersPanel.js'
import { SeatMap } from '../src/client/components/SeatMap.js'
import { SessionCard } from '../src/client/components/SessionCard.js'
import {
  DEFAULT_FILTERS,
  alertFiltersFromDashboard,
  applyFilters,
  buildSearch,
  filtersToSearch,
  parseFilters,
  parseSelectedSession,
  relativeFreshness,
  sessionCardModel,
  summarizeFilters,
  type DashboardFilters,
} from '../src/client/model.js'
import type { SeatSnapshot, SessionSnapshot } from '../src/domain/types.js'

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
})

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

function seats(available: Array<[SeatSnapshot['row'], number]>): SeatSnapshot[] {
  const taken = new Set(available.map(([row, number]) => `${row}-${number}`))
  return (['J', 'K', 'L', 'M'] as const).flatMap((row) =>
    Array.from({ length: 14 }, (_, index) => ({
      row,
      number: index + 1,
      status: taken.has(`${row}-${index + 1}`) ? 'available' as const : 'sold' as const,
    })),
  )
}

function makeSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 'session-1',
    filmId: 'HO00000546',
    title: 'THE ODYSSEY - 4K LASER PRESENTATION',
    startsAt: '2026-07-20T09:00:00.000Z', // 19:00 Melbourne, Monday 20 July
    format: 'laser',
    bookingUrl: 'https://imaxmelbourne.com.au/session/session-1',
    listing: { status: 'unknown', observedAt: null, sourceId: null },
    seatData: { state: 'captured', capturedAt: '2026-07-19T12:00:00.000Z' },
    seats: seats([['J', 1], ['J', 2], ['K', 5], ['M', 14]]),
    ...overrides,
  }
}

describe('URL filter state', () => {
  it('parses an empty query into defaults and omits defaults when serializing', () => {
    expect(parseFilters('')).toEqual(DEFAULT_FILTERS)
    expect(parseFilters('?')).toEqual(DEFAULT_FILTERS)
    expect(filtersToSearch(DEFAULT_FILTERS)).toBe('')
  })

  it('round-trips a fully customized filter set through the URL', () => {
    const filters: DashboardFilters = {
      presentation: 'laser',
      days: ['monday', 'wednesday', 'friday'],
      time: { preset: 'custom', from: '09:30', to: '12:45' },
      sort: 'seats',
    }
    const search = filtersToSearch(filters)
    expect(search).toContain('format=laser')
    expect(search).toContain('days=monday%2Cwednesday%2Cfriday')
    expect(search).toContain('time=custom')
    expect(search).toContain('from=09%3A30')
    expect(search).toContain('to=12%3A45')
    expect(search).toContain('sort=seats')
    expect(parseFilters(search)).toEqual(filters)
  })

  it('canonicalizes day order and drops unknown values', () => {
    expect(parseFilters('?days=friday,monday,notaday').days).toEqual(['monday', 'friday'])
    expect(parseFilters('?format=bogus&time=nope&sort=x')).toEqual(DEFAULT_FILTERS)
  })

  it('keeps an explicit empty day selection instead of restoring defaults', () => {
    expect(parseFilters('?days=').days).toEqual([])
    expect(filtersToSearch({ ...DEFAULT_FILTERS, days: [] })).toContain('days=')
  })

  it('falls back to all-day when custom time bounds are malformed or inverted', () => {
    expect(parseFilters('?time=custom&from=25:00&to=12:00').time).toEqual({ preset: 'all' })
    expect(parseFilters('?time=custom&from=18:00&to=18:00').time).toEqual({ preset: 'all' })
    expect(parseFilters('?time=custom&from=21:00&to=17:00').time).toEqual({ preset: 'all' })
  })

  it('round-trips the selected session through the URL only when present', () => {
    expect(buildSearch(DEFAULT_FILTERS, null)).toBe('')
    const search = buildSearch(DEFAULT_FILTERS, 'session-9')
    expect(search).toContain('session=session-9')
    expect(parseSelectedSession(search)).toBe('session-9')
    expect(parseSelectedSession('')).toBeNull()
  })
})

describe('session filtering and sorting', () => {
  const laserMondayEvening = makeSession()
  const seventySundayLate = makeSession({
    id: 'session-2',
    filmId: 'HO00000547',
    title: 'THE ODYSSEY - IMAX 70MM FILM PRESENTATION',
    format: '70mm',
    startsAt: '2026-07-19T13:30:00.000Z', // 23:30 Melbourne, Sunday 19 July
    seats: seats([['L', 7]]),
  })
  const laserSaturdayMorning = makeSession({
    id: 'session-3',
    startsAt: '2026-07-18T01:00:00.000Z', // 11:00 Melbourne, Saturday 18 July
    seats: seats([['J', 1], ['K', 1], ['L', 1], ['M', 1], ['M', 2]]),
  })
  const all = [laserMondayEvening, seventySundayLate, laserSaturdayMorning]

  it('filters by presentation format', () => {
    const result = applyFilters(all, { ...DEFAULT_FILTERS, presentation: '70mm' })
    expect(result.map(({ id }) => id)).toEqual(['session-2'])
  })

  it('filters by Melbourne weekday, not UTC weekday', () => {
    const result = applyFilters(all, { ...DEFAULT_FILTERS, days: ['sunday'] })
    expect(result.map(({ id }) => id)).toEqual(['session-2'])
  })

  it('applies Melbourne-local time presets with an exclusive end bound', () => {
    expect(applyFilters(all, { ...DEFAULT_FILTERS, time: { preset: 'afterwork' } }).map(({ id }) => id))
      .toEqual(['session-1'])
    expect(applyFilters(all, { ...DEFAULT_FILTERS, time: { preset: 'late' } }).map(({ id }) => id))
      .toEqual(['session-2'])
    expect(applyFilters(all, { ...DEFAULT_FILTERS, time: { preset: 'morning' } }).map(({ id }) => id))
      .toEqual(['session-3'])
    expect(applyFilters(all, { ...DEFAULT_FILTERS, time: { preset: 'custom', from: '17:00', to: '21:00' } })
      .map(({ id }) => id)).toEqual(['session-1'])
  })

  it('sorts by soonest or by most seats with a chronological tie-break', () => {
    const soonest = applyFilters(all, { ...DEFAULT_FILTERS, sort: 'soonest' })
    expect(soonest.map(({ id }) => id)).toEqual(['session-3', 'session-2', 'session-1'])
    const mostSeats = applyFilters(all, { ...DEFAULT_FILTERS, sort: 'seats' })
    expect(mostSeats.map(({ id }) => id)).toEqual(['session-3', 'session-1', 'session-2'])
  })

  it('shows nothing when no days are selected', () => {
    expect(applyFilters(all, { ...DEFAULT_FILTERS, days: [] })).toEqual([])
  })
})

describe('session card glance model', () => {
  it('exposes per-row J-M available counts and total', () => {
    const model = sessionCardModel(makeSession())
    expect(model.rowCounts).toEqual({ J: 2, K: 1, L: 0, M: 1 })
    expect(model.total).toBe(4)
    expect(model.full).toBe(false)
    expect(model.wording).toBe('Only 4 across J-M')
  })

  it('always exposes all four rows even when a row has no seats', () => {
    const session = makeSession({ seats: [{ row: 'K', number: 9, status: 'available' }] })
    const model = sessionCardModel(session)
    expect(Object.keys(model.rowCounts).sort()).toEqual(['J', 'K', 'L', 'M'])
    expect(model.rowCounts.K).toBe(1)
    expect(model.rowCounts.J).toBe(0)
  })

  it('marks full sessions with explicit J-M full wording', () => {
    const fullSession = makeSession({
      seats: [
        { row: 'J', number: 1, status: 'sold' },
        { row: 'K', number: 1, status: 'sold' },
        { row: 'L', number: 1, status: 'sold' },
        { row: 'M', number: 1, status: 'sold' },
      ],
      seatData: { state: 'captured', capturedAt: '2026-07-19T12:00:00.000Z' },
    } as Partial<SessionSnapshot>)
    const model = sessionCardModel(fullSession)
    expect(model.full).toBe(true)
    expect(model.wording).toBe('J-M FULL')
    expect(model.total).toBe(0)
  })

  it('uses neutral wording for empty and held-only captured maps', () => {
    const maps: SessionSnapshot['seats'][] = [[], [{ row: 'J', number: 1, status: 'held' }]]
    for (const seats of maps) {
      const model = sessionCardModel(makeSession({ seats }))

      expect(model).toMatchObject({ full: false, scarce: false, total: 0 })
      expect(model.wording).toBe('No confirmed J-M availability')
    }
  })

  it('renders unavailable exact seats as dashes instead of J-M full', () => {
    const session = makeSession({
      bookingUrl: null,
      seats: [],
      listing: { status: 'soldout', observedAt: '2026-07-19T12:00:00.000Z', sourceId: null },
      seatData: { state: 'unavailable', capturedAt: null },
    } as Partial<SessionSnapshot>)

    const model = sessionCardModel(session)
    const markup = renderToStaticMarkup(createElement(SessionCard, {
      session,
      freshnessText: 'Sessions updated just now',
      sampleData: false,
      selected: false,
      onSelect: () => undefined,
    }))

    expect(model).toMatchObject({ full: false, wording: 'J-M seats not captured' })
    expect(markup).toContain('J-M seats not captured')
    expect(markup).toContain('<b>J</b> –')
    expect(markup).toContain('Session sold out')
    expect(markup).not.toContain('J-M FULL')
    expect(markup).not.toContain('Official booking')
  })

  it('uses neutral wording above the scarcity threshold', () => {
    const session = makeSession({ seats: seats([['J', 1], ['J', 2], ['K', 1], ['L', 1], ['M', 1]]) })
    expect(sessionCardModel(session).wording).toBe('5 across J-M')
  })

  it('shows the exact-seat capture age alongside listing freshness only when captured', () => {
    const now = new Date('2026-07-19T12:05:00.000Z').getTime()
    const captured = renderToStaticMarkup(createElement(SessionCard, {
      session: makeSession({
        seatData: { state: 'captured', capturedAt: '2026-07-19T12:00:00.000Z', source: 'lumos_preview' },
      }),
      freshnessText: 'Sessions updated just now',
      sampleData: false,
      selected: false,
      onSelect: () => undefined,
      now,
    }))
    const uncaptured = renderToStaticMarkup(createElement(SessionCard, {
      session: makeSession({ seats: [], seatData: { state: 'unavailable', capturedAt: null } }),
      freshnessText: 'Sessions updated just now',
      sampleData: false,
      selected: false,
      onSelect: () => undefined,
      now,
    }))

    expect(captured).toContain('Sessions updated just now · J-M captured 5 min ago')
    expect(uncaptured).not.toContain('J-M captured')
  })

  it('renders sample status on each card alongside its freshness', () => {
    const markup = renderToStaticMarkup(createElement(SessionCard, {
      session: makeSession(),
      freshnessText: 'Updated 5 min ago',
      sampleData: true,
      selected: false,
      onSelect: () => undefined,
    }))

    expect(markup).toContain('SAMPLE DATA · Updated 5 min ago')
  })

  it('labels exact preview seats as fresh, last-known, or blocked without claiming availability', () => {
    const render = (session: SessionSnapshot) => renderToStaticMarkup(createElement(SessionCard, {
      session,
      freshnessText: 'Sessions updated just now',
      sampleData: false,
      selected: false,
      onSelect: () => undefined,
    }))
    const fresh = makeSession({
      seatData: {
        state: 'captured',
        capturedAt: '2026-07-19T12:00:00.000Z',
        source: 'lumos_preview',
        lastAttempt: '2026-07-19T12:00:00.000Z',
        lastFailure: null,
      },
    })
    const lastKnown = makeSession({
      seatData: {
        ...fresh.seatData,
        lastAttempt: '2026-07-19T12:05:00.000Z',
        lastFailure: { at: '2026-07-19T12:05:00.000Z', kind: 'error', detail: 'Preview failed' },
      },
    })
    const blocked = makeSession({
      seats: [],
      seatData: {
        state: 'unavailable',
        capturedAt: null,
        source: null,
        lastAttempt: '2026-07-19T12:05:00.000Z',
        lastFailure: { at: '2026-07-19T12:05:00.000Z', kind: 'blocked', detail: 'Challenge page' },
      },
    })

    expect(render(fresh)).toContain('J-M FRESH')
    expect(render(lastKnown)).toContain('J-M LAST-KNOWN')
    expect(render(blocked)).toContain('J-M BLOCKED')
    expect(render(blocked)).toContain('J-M seats not captured')
    expect(render(blocked)).not.toContain('J-M FULL')
  })
})

describe('dashboard controls', () => {
  it('renders the filter panel collapsed by default so sessions stay primary', () => {
    const markup = renderToStaticMarkup(createElement(FiltersPanel, {
      filters: DEFAULT_FILTERS,
      onChange: () => undefined,
      onReset: () => undefined,
    }))

    expect(markup).toContain('<details class="filters">')
    expect(markup).not.toContain('<details class="filters" open="">')
  })

  it('names alert fields for browser autofill and form semantics', () => {
    const markup = renderToStaticMarkup(createElement(AlertDialog, {
      open: true,
      onClose: () => undefined,
      filters: DEFAULT_FILTERS,
      configuredFilmIds: ['HO00000546', 'HO00000547'],
      emailConfigured: true,
    }))

    expect(markup).toContain('name="email"')
    expect(markup).toContain('name="minimumSeats"')
  })

  it('renders an accessible hidden caption and grouped seat legend', async () => {
    const markup = renderToStaticMarkup(createElement(SeatMap, { session: makeSession({
      seats: [
        { row: 'J', number: 1, status: 'available' },
        { row: 'J', number: 2, status: 'held' },
      ],
    }) }))
    const unavailable = renderToStaticMarkup(createElement(SeatMap, { session: makeSession({
      seats: [],
      seatData: { state: 'unavailable', capturedAt: null },
    }) }))

    expect(markup).toContain('<table')
    expect(markup).toContain('<caption class="visually-hidden">')
    expect(markup).toContain('<th')
    expect(markup).toContain('scope="row"')
    expect(markup).toContain('aria-label="Seat 1, available"')
    expect(markup.match(/Seat 1, available/g)).toHaveLength(1)
    expect(markup).not.toContain('role="img"')
    expect(markup).toContain('class="seat-legend" role="group" aria-label="Seat status legend"')
    expect(unavailable).toContain('role="status"')
    const css = await readFile('src/client/styles.css', 'utf8')
    expect(css).toMatch(/\.visually-hidden\s*\{[^}]*clip:/s)
  })

  it('explains disabled alert submission while film configuration loads or is absent', () => {
    const loading = renderToStaticMarkup(createElement(AlertDialog, {
      open: true,
      onClose: () => undefined,
      filters: DEFAULT_FILTERS,
      configuredFilmIds: [],
      filmConfigurationLoading: true,
      emailConfigured: true,
    }))
    const absent = renderToStaticMarkup(createElement(AlertDialog, {
      open: true,
      onClose: () => undefined,
      filters: DEFAULT_FILTERS,
      configuredFilmIds: [],
      filmConfigurationLoading: false,
      emailConfigured: true,
    }))

    expect(loading).toContain('Film configuration is still loading')
    expect(absent).toContain('No supported films are configured for alerts')
    expect(loading).toContain('disabled=""')
    expect(absent).toContain('disabled=""')
  })

  it('submits inherited filters and reports success', async () => {
    const user = userEvent.setup()
    let submitted: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body))
      return Response.json({ accepted: true, needsConfirmation: true }, { status: 202 })
    })
    renderClient(createElement(AlertDialog, {
      open: true,
      onClose: () => undefined,
      filters: {
        presentation: '70mm',
        days: ['friday', 'saturday'],
        time: { preset: 'custom', from: '13:00', to: '16:30' },
        sort: 'seats',
      },
      configuredFilmIds: ['HO00000546', 'HO00000547'],
      emailConfigured: true,
    }))

    await user.type(screen.getByLabelText('Email'), 'fan@example.com')
    await user.selectOptions(screen.getByLabelText('Minimum available seats'), '3')
    await user.click(screen.getByLabelText('Seats must be adjacent in one row'))
    await user.click(screen.getByRole('button', { name: 'Email me a confirmation link' }))

    expect(await screen.findByText(/Confirmation link sent to fan@example.com/)).toBeTruthy()
    expect(submitted).toEqual({
      email: 'fan@example.com',
      filters: {
        filmIds: ['HO00000546', 'HO00000547'],
        format: '70mm',
        weekdays: ['friday', 'saturday'],
        time: { preset: 'custom', from: '13:00', to: '16:30' },
        minimumSeats: 3,
        adjacentOnly: false,
      },
    })
  })

  it('reports alert submission errors without losing the form state', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', async () => Response.json({ error: 'rate_limited' }, { status: 429 }))
    renderClient(createElement(AlertDialog, {
      open: true,
      onClose: () => undefined,
      filters: DEFAULT_FILTERS,
      configuredFilmIds: ['HO00000546', 'HO00000547'],
      emailConfigured: true,
    }))

    const email = screen.getByLabelText('Email')
    await user.type(email, 'fan@example.com')
    await user.click(screen.getByRole('button', { name: 'Email me a confirmation link' }))

    expect(await screen.findByText('Too many attempts. Wait an hour and try again.')).toBeTruthy()
    expect(email).toHaveProperty('value', 'fan@example.com')
  })

  it('returns focus to the Create alert trigger after button and Escape closes', async () => {
    const triggerRef = createRef<HTMLButtonElement>()
    function Harness() {
      const [open, setOpen] = useState(false)
      return createElement('div', null,
        createElement('button', { ref: triggerRef, onClick: () => setOpen(true) }, 'Create alert'),
        createElement(AlertDialog, {
          open,
          onClose: () => setOpen(false),
          returnFocusRef: triggerRef,
          filters: DEFAULT_FILTERS,
          configuredFilmIds: ['HO00000546'],
          emailConfigured: true,
        }),
      )
    }
    const user = userEvent.setup()
    renderClient(createElement(Harness))

    await user.click(screen.getByRole('button', { name: 'Create alert' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(document.activeElement).toBe(triggerRef.current))

    await user.click(screen.getByRole('button', { name: 'Create alert' }))
    const dialog = screen.getByRole('dialog') as HTMLDialogElement
    dialog.close()
    await waitFor(() => expect(document.activeElement).toBe(triggerRef.current))
  })
})

describe('dashboard behavior', () => {
  function mockDashboard(sessions: SessionSnapshot[], seatCaptureState = 'partial') {
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input)
      if (url === '/api/sessions') return Response.json({ sessions, timezone: 'Australia/Melbourne' })
      if (url === '/health') return Response.json({ email: { configured: true } })
      if (url === '/api/status') {
        return Response.json({
          mode: 'ephemeral',
          sampleData: false,
          filmIds: ['HO00000546', 'HO00000547'],
          sessionCount: sessions.length,
          subscriptionCount: 0,
          transitionCount: 0,
          pendingAlertCount: 0,
          lastManualIngest: null,
          degraded: true,
          sessionDiscovery: {
            state: 'ok',
            detail: 'Listing refreshed.',
            lastAttempt: '2026-07-20T00:00:00.000Z',
            lastSuccess: '2026-07-20T00:00:00.000Z',
            nextAttempt: null,
            freshness: { state: 'fresh', lastUpdate: '2026-07-20T00:00:00.000Z', ageMs: 0, staleAfterMs: 990_000 },
          },
          lumosBootstrap: { state: 'ready', detail: 'Ready.', lastAttempt: null, lastSuccess: null, nextAttempt: null },
          seatCapture: {
            state: seatCaptureState,
            detail: 'One session remains.',
            lastAttempt: null,
            lastCapture: null,
            nextAttempt: null,
            capturedSessionCount: 1,
            uncapturedSessionCount: 1,
            failedSessionCount: 0,
          },
          note: 'Ephemeral.',
        })
      }
      throw new Error(`Unexpected request ${url}`)
    })
  }

  it('uses the first session only as desktop detail fallback until selection is explicit', async () => {
    history.replaceState(null, '', '/?session=missing')
    const sessions = [
      makeSession({ id: 'first', title: 'FIRST SESSION' }),
      makeSession({ id: 'second', title: 'SECOND SESSION', startsAt: '2026-07-20T10:00:00.000Z' }),
    ]
    mockDashboard(sessions)
    const user = userEvent.setup()
    const { container } = renderClient(createElement(App))

    await screen.findAllByText('FIRST SESSION')
    await waitFor(() => expect(location.search).toBe(''))
    expect(container.querySelectorAll('.session-selected')).toHaveLength(0)
    expect(container.querySelector('.desktop-detail')?.textContent).toContain('FIRST SESSION')

    const secondCard = screen.getByText('SECOND SESSION').closest('article')
    expect(secondCard).not.toBeNull()
    await user.click(within(secondCard as HTMLElement).getByRole('button', { name: 'Inspect Rows J-M' }))
    expect(secondCard?.classList.contains('session-selected')).toBe(true)
    expect(container.querySelectorAll('.session-selected')).toHaveLength(1)
  })

  it('replaces stale session state after filtering and popstate navigation', async () => {
    history.replaceState(null, '', '/?session=first')
    const sessions = [
      makeSession({ id: 'first', title: 'FIRST SESSION' }),
      makeSession({
        id: 'second',
        title: 'SECOND SESSION',
        filmId: 'HO00000547',
        format: '70mm',
        startsAt: '2026-07-20T10:00:00.000Z',
      }),
    ]
    mockDashboard(sessions)
    const user = userEvent.setup()
    const { container } = renderClient(createElement(App))
    await screen.findAllByText('FIRST SESSION')

    await user.click(screen.getByLabelText('IMAX 70mm Film'))
    await waitFor(() => {
      expect(location.search).toContain('format=70mm')
      expect(location.search).not.toContain('session=')
    })
    expect(container.querySelector('.desktop-detail')?.textContent).toContain('SECOND SESSION')

    history.pushState(null, '', '/?format=70mm&session=first')
    dispatchEvent(new PopStateEvent('popstate'))
    await waitFor(() => expect(location.search).toBe('?format=70mm'))
    expect(container.querySelectorAll('.session-selected')).toHaveLength(0)
  })

  it('puts a visible-on-focus skip link first and exposes status badges', async () => {
    mockDashboard([makeSession()])
    renderClient(createElement(App))

    expect(await screen.findByText('J-M PARTIAL')).toBeTruthy()
    expect(screen.getByText('LIVE SESSIONS')).toBeTruthy()
    const skip = screen.getByRole('link', { name: 'Skip to sessions' })
    expect(document.querySelector('a, button, input, select, textarea, [tabindex]')).toBe(skip)
    expect(skip.getAttribute('href')).toBe('#sessions')
    expect(document.querySelector('#sessions')).not.toBeNull()
  })

  it('exposes a parked badge and notice while automatic exact preview is parked', async () => {
    mockDashboard([makeSession()], 'parked')
    renderClient(createElement(App))

    expect(await screen.findByText('J-M PARKED')).toBeTruthy()
    expect(await screen.findByText(/Automatic exact J-M preview is parked/)).toBeTruthy()
    expect(screen.queryByText('J-M BLOCKED')).toBeNull()
  })
})

describe('alert filter inheritance', () => {
  const configured = ['HO00000546', 'HO00000547']

  it('maps the default dashboard state to an exact all-day alert payload', () => {
    expect(alertFiltersFromDashboard(DEFAULT_FILTERS, configured, { minimumSeats: 2, adjacentOnly: true }))
      .toEqual({
        filmIds: configured,
        format: 'all',
        weekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
        time: { preset: 'anytime' },
        minimumSeats: 2,
        adjacentOnly: true,
      })
  })

  it('inherits presentation, day subset, and custom time exactly', () => {
    const filters: DashboardFilters = {
      presentation: '70mm',
      days: ['friday', 'saturday'],
      time: { preset: 'custom', from: '13:00', to: '16:30' },
      sort: 'seats',
    }
    expect(alertFiltersFromDashboard(filters, configured, { minimumSeats: 4, adjacentOnly: false }))
      .toEqual({
        filmIds: configured,
        format: '70mm',
        weekdays: ['friday', 'saturday'],
        time: { preset: 'custom', from: '13:00', to: '16:30' },
        minimumSeats: 4,
        adjacentOnly: false,
      })
  })

  it('passes named time presets through unchanged', () => {
    const filters: DashboardFilters = { ...DEFAULT_FILTERS, presentation: 'laser', time: { preset: 'afterwork' } }
    const payload = alertFiltersFromDashboard(filters, configured, { minimumSeats: 1, adjacentOnly: true })
    expect(payload.time).toEqual({ preset: 'afterwork' })
    expect(payload.format).toBe('laser')
  })
})

describe('freshness and summary text', () => {
  const now = new Date('2026-07-19T12:00:00.000Z').getTime()

  it('describes missing, recent, minute-old, and hour-old observations', () => {
    expect(relativeFreshness(now, null)).toBe('No session data observed yet')
    expect(relativeFreshness(now, '2026-07-19T11:59:40.000Z')).toBe('Updated just now')
    expect(relativeFreshness(now, '2026-07-19T11:55:00.000Z')).toBe('Updated 5 min ago')
    expect(relativeFreshness(now, '2026-07-19T10:30:00.000Z')).toBe('Updated 1 h 30 min ago')
  })

  it('summarizes only the active, non-default filters', () => {
    expect(summarizeFilters(DEFAULT_FILTERS)).toEqual([])
    expect(summarizeFilters({
      presentation: '70mm',
      days: ['saturday', 'sunday'],
      time: { preset: 'custom', from: '13:00', to: '16:30' },
      sort: 'seats',
    })).toEqual(['IMAX 70mm Film', 'Weekends', '13:00-16:30', 'Most seats'])
    expect(summarizeFilters({ ...DEFAULT_FILTERS, days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] }))
      .toEqual(['Weekdays'])
    expect(summarizeFilters({ ...DEFAULT_FILTERS, days: [] })).toEqual(['No days selected'])
    expect(summarizeFilters({ ...DEFAULT_FILTERS, time: { preset: 'afterwork' } }))
      .toEqual(['After work 17:00-21:00'])
  })
})
