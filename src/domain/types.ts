export const seatRows = ['J', 'K', 'L', 'M'] as const
export const seatStatuses = ['available', 'sold', 'held'] as const
export const supportedFilmIds = ['HO00000546', 'HO00000547'] as const
export const supportedFilmFormats = {
  HO00000546: 'laser',
  HO00000547: '70mm',
} as const
export const weekdays = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const

export type SeatRow = (typeof seatRows)[number]
export type SeatStatus = (typeof seatStatuses)[number]
export type Weekday = (typeof weekdays)[number]
export type FilmFormat = '70mm' | 'laser'
export type SessionListingStatus = 'available' | 'filling' | 'soldout' | 'unknown'
export type SeatDataState = 'captured' | 'last_known' | 'unavailable'
export type SeatCaptureSource = 'lumos_preview' | 'manual' | 'sample'
export type SeatCaptureFailureKind = 'blocked' | 'error'
export type TimePreset = 'anytime' | 'morning' | 'afternoon' | 'afterwork' | 'late' | 'custom'

export interface SeatSnapshot {
  row: SeatRow
  number: number
  status: SeatStatus
}

export interface SessionSnapshot {
  id: string
  filmId: string
  title: string
  startsAt: string
  format: FilmFormat
  bookingUrl: string | null
  listing: {
    status: SessionListingStatus
    observedAt: string | null
    sourceId: string | null
  }
  seatData: {
    state: SeatDataState
    capturedAt: string | null
    source?: SeatCaptureSource | null
    sourceShowtimeId?: string | null
    lastAttempt?: string | null
    lastFailure?: {
      at: string
      kind: SeatCaptureFailureKind
      detail: string
    } | null
  }
  seats: SeatSnapshot[]
}

export type TimeFilter =
  | { preset: Exclude<TimePreset, 'custom'> }
  | { preset: 'custom'; from: string; to: string }

export interface SubscriptionFilters {
  filmIds: string[]
  format: FilmFormat | 'all'
  weekdays: Weekday[]
  time: TimeFilter
  minimumSeats: number
  adjacentOnly: boolean
}

export interface SubscriptionView {
  id: string
  email: string
  filters: SubscriptionFilters
  verified: boolean
  active: boolean
}

export interface Transition {
  sessionId: string
  occurredAt: string
  seat: Pick<SeatSnapshot, 'row' | 'number'>
  from: Exclude<SeatStatus, 'available'>
  to: 'available'
}

export interface AlertSession {
  sessionId: string
  title: string
  startsAt: string
  format: FilmFormat
  bookingUrl: string
  seats: Array<Pick<SeatSnapshot, 'row' | 'number'>>
  availableCount: number
}

export interface AlertDelivery {
  id: string
  subscriptionId: string
  email: string
  manageToken: string
  unsubscribeToken: string
  sessions: AlertSession[]
}

export interface IngestResult {
  duplicate: boolean
  transitions: Transition[]
  deliveries: AlertDelivery[]
}

export type SessionDiscoveryState = 'blocked' | 'error' | 'ok'
export type LumosBootstrapState = 'pending' | 'ready' | 'blocked' | 'error'
export type ExactSeatCaptureState = 'pending' | 'fresh' | 'partial' | 'blocked' | 'error'

export interface AppStatus {
  mode: 'ephemeral'
  sampleData: boolean
  filmIds: string[]
  sessionCount: number
  subscriptionCount: number
  transitionCount: number
  pendingAlertCount: number
  lastManualIngest: string | null
  sessionDiscovery: {
    state: SessionDiscoveryState
    detail: string
    lastAttempt: string | null
    lastSuccess: string | null
    nextAttempt: string | null
  }
  lumosBootstrap: {
    state: LumosBootstrapState
    detail: string
    lastAttempt: string | null
    lastSuccess: string | null
    nextAttempt: string | null
  }
  seatCapture: {
    state: ExactSeatCaptureState
    detail: string
    lastAttempt: string | null
    lastCapture: string | null
    nextAttempt: string | null
    capturedSessionCount: number
    lastKnownSessionCount: number
    uncapturedSessionCount: number
    failedSessionCount: number
  }
}
