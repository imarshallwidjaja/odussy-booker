import {
  seatRows,
  weekdays,
  type SeatRow,
  type SessionSnapshot,
  type SubscriptionFilters,
  type Weekday,
} from '../domain/types.js'

export type PresentationFilter = 'all' | 'laser' | '70mm'
export type SortOrder = 'soonest' | 'seats'
export type NamedTimePreset = 'morning' | 'afternoon' | 'afterwork' | 'late'
export type TimeSelection =
  | { preset: 'all' }
  | { preset: NamedTimePreset }
  | { preset: 'custom'; from: string; to: string }

export interface DashboardFilters {
  presentation: PresentationFilter
  days: Weekday[]
  time: TimeSelection
  sort: SortOrder
  availableOnly: boolean
}

export const DEFAULT_FILTERS: DashboardFilters = {
  presentation: 'all',
  days: [...weekdays],
  time: { preset: 'all' },
  sort: 'soonest',
  availableOnly: false,
}

export const PRESENTATION_LABELS: Record<PresentationFilter, string> = {
  all: 'All presentations',
  laser: '4K Laser',
  '70mm': 'IMAX 70mm Film',
}

export const TIME_PRESET_LABELS: Record<NamedTimePreset, string> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  afterwork: 'After work 17:00-21:00',
  late: 'Late 21:00+',
}

const SCARCITY_THRESHOLD = 4
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

const presetRanges: Record<NamedTimePreset, readonly [number, number]> = {
  morning: [0, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  afterwork: [17 * 60, 21 * 60],
  late: [21 * 60, 24 * 60],
}

const weekdaySet = new Set<string>(weekdays)

function canonicalDays(days: Weekday[]): Weekday[] {
  const selected = new Set(days)
  return weekdays.filter((day) => selected.has(day))
}

export function parseFilters(search: string): DashboardFilters {
  const params = new URLSearchParams(search)

  const formatParam = params.get('format')
  const presentation: PresentationFilter = formatParam === 'laser' || formatParam === '70mm' ? formatParam : 'all'

  const daysParam = params.get('days')
  const days: Weekday[] = daysParam === null
    ? [...weekdays]
    : canonicalDays(daysParam.split(',').filter((day): day is Weekday => weekdaySet.has(day)))

  const timeParam = params.get('time')
  let time: TimeSelection = { preset: 'all' }
  if (timeParam === 'morning' || timeParam === 'afternoon' || timeParam === 'afterwork' || timeParam === 'late') {
    time = { preset: timeParam }
  } else if (timeParam === 'custom') {
    const from = params.get('from') ?? ''
    const to = params.get('to') ?? ''
    if (TIME_PATTERN.test(from) && TIME_PATTERN.test(to) && from < to) {
      time = { preset: 'custom', from, to }
    }
  }

  const sort: SortOrder = params.get('sort') === 'seats' ? 'seats' : 'soonest'
  const availableOnly = params.get('available') === '1'

  return { presentation, days, time, sort, availableOnly }
}

export function filtersToSearch(filters: DashboardFilters): string {
  const params = new URLSearchParams()
  if (filters.presentation !== 'all') params.set('format', filters.presentation)
  if (filters.days.length !== weekdays.length) {
    params.set('days', canonicalDays(filters.days).join(','))
  }
  if (filters.time.preset === 'custom') {
    params.set('time', 'custom')
    params.set('from', filters.time.from)
    params.set('to', filters.time.to)
  } else if (filters.time.preset !== 'all') {
    params.set('time', filters.time.preset)
  }
  if (filters.sort !== 'soonest') params.set('sort', filters.sort)
  if (filters.availableOnly) params.set('available', '1')
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

export function parseSelectedSession(search: string): string | null {
  const value = new URLSearchParams(search).get('session')
  return value && value.trim() ? value : null
}

export function buildSearch(filters: DashboardFilters, selectedId: string | null): string {
  const base = filtersToSearch(filters)
  if (!selectedId) return base
  const params = new URLSearchParams(base)
  params.set('session', selectedId)
  return `?${params.toString()}`
}

const melbourneMinutes = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Melbourne',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const melbourneWeekday = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Melbourne',
  weekday: 'long',
})

export function minutesInMelbourne(iso: string): number {
  const parts = melbourneMinutes.formatToParts(new Date(iso))
  const hour = Number(parts.find(({ type }) => type === 'hour')?.value ?? 0)
  const minute = Number(parts.find(({ type }) => type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

export function weekdayInMelbourne(iso: string): Weekday {
  return melbourneWeekday.format(new Date(iso)).toLowerCase() as Weekday
}

export function timeRangeMinutes(selection: TimeSelection): readonly [number, number] {
  if (selection.preset === 'all') return [0, 24 * 60]
  if (selection.preset === 'custom') {
    const [fromHours = 0, fromMinutes = 0] = selection.from.split(':').map(Number)
    const [toHours = 0, toMinutes = 0] = selection.to.split(':').map(Number)
    return [fromHours * 60 + fromMinutes, toHours * 60 + toMinutes]
  }
  return presetRanges[selection.preset]
}

export function availableCount(session: SessionSnapshot): number {
  return session.seats.reduce((count, seat) => seat.status === 'available' ? count + 1 : count, 0)
}

export function applyFilters(sessions: SessionSnapshot[], filters: DashboardFilters): SessionSnapshot[] {
  const [from, to] = timeRangeMinutes(filters.time)
  const selectedDays = new Set(filters.days)
  const matches = sessions.filter((session) => {
    if (filters.presentation !== 'all' && session.format !== filters.presentation) return false
    if (!selectedDays.has(weekdayInMelbourne(session.startsAt))) return false
    if (filters.availableOnly && (
      session.listing.status === 'soldout'
      || session.seatData.state !== 'captured'
      || Boolean(session.seatData.lastFailure)
      || availableCount(session) === 0
    )) return false
    const minute = minutesInMelbourne(session.startsAt)
    return minute >= from && minute < to
  })
  return matches.toSorted((a, b) => {
    if (filters.sort === 'seats') {
      const bySeats = availableCount(b) - availableCount(a)
      if (bySeats !== 0) return bySeats
    }
    return a.startsAt.localeCompare(b.startsAt)
  })
}

export interface SessionCardModel {
  rowCounts: Record<SeatRow, number | null>
  total: number | null
  captured: boolean
  full: boolean
  scarce: boolean
  wording: string
}

export function sessionCardModel(session: SessionSnapshot): SessionCardModel {
  const captured = session.seatData.state !== 'unavailable'
  const rowCounts = Object.fromEntries(
    seatRows.map((row) => [
      row,
      captured
        ? session.seats.filter((seat) => seat.row === row && seat.status === 'available').length
        : null,
    ]),
  ) as Record<SeatRow, number | null>
  const total = captured
    ? seatRows.reduce((count, row) => count + (rowCounts[row] ?? 0), 0)
    : null
  const full = captured && session.seats.length > 0 && session.seats.every(({ status }) => status === 'sold')
  const scarce = captured && total !== null && total > 0 && total <= SCARCITY_THRESHOLD
  const wording = !captured
    ? 'J-M seats not captured'
    : full
    ? 'J-M FULL'
    : total === 0
      ? 'No confirmed J-M availability'
    : scarce
      ? `Only ${total} across J-M`
      : `${total} across J-M`
  return { rowCounts, total, captured, full, scarce, wording }
}

export function alertFiltersFromDashboard(
  filters: DashboardFilters,
  configuredFilmIds: string[],
  seats: { minimumSeats: number; adjacentOnly: boolean },
): SubscriptionFilters {
  return {
    filmIds: [...configuredFilmIds],
    format: filters.presentation,
    weekdays: canonicalDays(filters.days),
    time: filters.time.preset === 'custom'
      ? { preset: 'custom', from: filters.time.from, to: filters.time.to }
      : filters.time.preset === 'all'
        ? { preset: 'anytime' }
        : { preset: filters.time.preset },
    minimumSeats: seats.minimumSeats,
    adjacentOnly: seats.adjacentOnly,
  }
}

export function relativeFreshness(now: number, iso: string | null): string {
  if (!iso) return 'No session data observed yet'
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000))
  if (minutes < 1) return 'Updated just now'
  if (minutes === 1) return 'Updated 1 min ago'
  if (minutes < 60) return `Updated ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return `Updated ${hours} h ${minutes % 60} min ago`
}

export function captureAgeText(now: number, iso: string | null): string | null {
  if (!iso) return null
  return relativeFreshness(now, iso).replace(/^Updated /, '')
}

const DAY_SHORT: Record<Weekday, string> = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
}

const WEEKDAYS: Weekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
const WEEKENDS: Weekday[] = ['saturday', 'sunday']

function sameDays(a: Weekday[], b: Weekday[]): boolean {
  return a.length === b.length && canonicalDays(a).every((day, index) => day === canonicalDays(b)[index])
}

export function summarizeFilters(filters: DashboardFilters): string[] {
  const summary: string[] = []
  if (filters.presentation !== 'all') summary.push(PRESENTATION_LABELS[filters.presentation])
  if (filters.days.length === 0) {
    summary.push('No days selected')
  } else if (filters.days.length !== weekdays.length) {
    if (sameDays(filters.days, WEEKDAYS)) summary.push('Weekdays')
    else if (sameDays(filters.days, WEEKENDS)) summary.push('Weekends')
    else summary.push(canonicalDays(filters.days).map((day) => DAY_SHORT[day]).join(', '))
  }
  if (filters.time.preset === 'custom') summary.push(`${filters.time.from}-${filters.time.to}`)
  else if (filters.time.preset !== 'all') summary.push(TIME_PRESET_LABELS[filters.time.preset])
  if (filters.availableOnly) summary.push('Available J-M seats')
  if (filters.sort !== 'soonest') summary.push('Most seats')
  return summary
}

const melbourneDateLabel = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Melbourne',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

const melbourneTimeLabel = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Melbourne',
  hour: 'numeric',
  minute: '2-digit',
})

export function sessionDateLabel(iso: string): string {
  return melbourneDateLabel.format(new Date(iso))
}

export function sessionTimeLabel(iso: string): string {
  return melbourneTimeLabel.format(new Date(iso))
}

export { WEEKDAYS, WEEKENDS, DAY_SHORT }
