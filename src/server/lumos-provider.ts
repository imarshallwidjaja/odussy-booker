import { isIP } from 'node:net'

import { parse } from 'node-html-parser'

import { seatRows, type SeatRow, type SeatSnapshot, type SessionSnapshot } from '../domain/types.js'
import { readBoundedText } from './http.js'

const USER_AGENT = 'HouseLights/0.1 (+https://github.com/imarshallwidjaja/odussy-booker)'
const DEFAULT_ALLOWED_HOSTS = ['imaxmelbourne.com.au', 'vista.co']
const SHOWTIME_ID = /^IMAX-[0-9]+$/
const BOOTSTRAP_BODY_LIMIT = 1_000_000
const JSON_BODY_LIMIT = 2_000_000
const CMS_CONFIGURATION_PATH = '/api/v1/sales-channels/web/configuration'
const LAYOUT_PATH = /^\/ocapi\/v1\/showtimes\/IMAX-[0-9]+\/seat-layout$/
const AVAILABILITY_PATH = /^\/ocapi\/v1\/showtimes\/IMAX-[0-9]+\/seat-availability$/

type PreviewResultKind = 'ok' | 'blocked' | 'error'

export interface SeatPreviewFailure {
  sessionId: string
  attemptedAt: string
  kind: Exclude<PreviewResultKind, 'ok'>
  detail: string
}

export interface SeatPreviewResult {
  kind: PreviewResultKind
  bootstrap: 'not_attempted' | 'ready' | 'blocked' | 'error'
  detail: string
  observations: SessionSnapshot[]
  failures: SeatPreviewFailure[]
  attemptedAt: string
  eligibleSessionCount: number
  attemptedSessionCount: number
  retryAfterMs?: number
}

export interface SeatPreviewProvider {
  fetchSeatPreviews(sessions: SessionSnapshot[], signal: AbortSignal): Promise<SeatPreviewResult>
}

interface LumosPreviewSeatProviderOptions {
  filmUrl: string
  allowedHosts?: string[]
  fetchImpl?: typeof fetch
  now?: () => Date
  concurrency?: number
  sessionBudget?: number
  tokenRefreshSkewMs?: number
}

interface BootstrapData {
  gasToken: string
  cmsApiUrl: string
  expiresAt: number
}

interface CachedBootstrap extends BootstrapData {
  digitalApiUrl: string
  refreshAt: number
}

class LumosFailure extends Error {
  constructor(
    readonly kind: Exclude<PreviewResultKind, 'ok'>,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

const RETRY_AFTER_CAP_MS = 24 * 60 * 60 * 1000

function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS)
  const dateMs = Date.parse(value)
  if (Number.isFinite(dateMs)) return Math.min(Math.max(0, dateMs - nowMs), RETRY_AFTER_CAP_MS)
  return undefined
}

function blockedFailure(label: string, response: Response, nowMs: number): LumosFailure {
  const ray = response.headers.get('cf-ray')
  return new LumosFailure(
    'blocked',
    `${label} returned HTTP ${response.status}${ray ? ` (CF-Ray ${ray})` : ''}`,
    parseRetryAfterMs(response.headers.get('retry-after'), nowMs),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message)
  return value
}

function requireArray(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(message)
  return value
}

function challengeDetected(html: string): boolean {
  const lower = html.toLowerCase()
  return [
    'cdn-cgi/challenge-platform',
    'cf-chl-',
    'cf-ray',
    'cloudflare ray id',
    'just a moment...',
    'attention required! | cloudflare',
    'queue-it.net',
    'queueittoken',
  ].some((marker) => lower.includes(marker))
}

function decodeTokenExpiry(token: string): number {
  const payload = token.split('.')[1]
  if (!payload || token.length > 16_384) throw new Error('Lumos bootstrap bearer token is malformed')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Lumos bootstrap bearer token is malformed')
  }
  const exp = isRecord(parsed) ? parsed.exp : undefined
  if (!Number.isInteger(exp) || (exp as number) < 1) {
    throw new Error('Lumos bootstrap bearer token has no valid expiry')
  }
  return (exp as number) * 1000
}

export function extractLumosBootstrap(html: string): BootstrapData {
  if (challengeDetected(html)) throw new LumosFailure('blocked', 'Public film bootstrap returned a challenge page')
  const script = parse(html).querySelector('script#__NEXT_DATA__')
  if (!script) throw new Error('Lumos bootstrap data is missing')
  let data: unknown
  try {
    data = JSON.parse(script.textContent)
  } catch {
    throw new Error('Lumos bootstrap data is invalid JSON')
  }
  const props = requireRecord(requireRecord(data, 'Lumos bootstrap data is malformed').props, 'Lumos bootstrap props are missing')
  const pageProps = requireRecord(props.pageProps, 'Lumos bootstrap page props are missing')
  const environment = requireRecord(pageProps.environment, 'Lumos bootstrap environment is missing')
  if (typeof environment.gasToken !== 'string' || environment.gasToken.length === 0) {
    throw new Error('Lumos bootstrap bearer token is missing')
  }
  let cmsConfig: Record<string, unknown>
  let expiresAt: number
  try {
    expiresAt = decodeTokenExpiry(environment.gasToken)
  } catch {
    throw new Error('Lumos bootstrap bearer token is malformed')
  }
  try {
    cmsConfig = requireRecord(pageProps.cmsConfig, 'Lumos bootstrap CMS configuration is missing')
  } catch {
    cmsConfig = requireRecord(environment.cmsConfig, 'Lumos bootstrap CMS configuration is missing in environment')
  }
  if (typeof cmsConfig.apiUrl !== 'string' || cmsConfig.apiUrl.length === 0) {
    throw new Error('Lumos bootstrap CMS API URL is missing')
  }
  return {
    gasToken: environment.gasToken,
    cmsApiUrl: cmsConfig.apiUrl,
    expiresAt,
  }
}

export function validateLumosServiceUrl(rawUrl: string, allowedHosts = DEFAULT_ALLOWED_HOSTS): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Lumos service URL is invalid')
  }
  if (url.protocol !== 'https:') throw new Error('Lumos service URL must use HTTPS')
  if (url.username || url.password || url.port && url.port !== '443') {
    throw new Error('Lumos service URL contains unsupported authority data')
  }
  if (url.search || url.hash || isIP(url.hostname) !== 0) throw new Error('Lumos service URL host is not allowed')
  const hostname = url.hostname.toLowerCase()
  const allowed = allowedHosts.some((candidate) => {
    const normalized = candidate.trim().toLowerCase().replace(/^\./, '')
    return normalized.length > 0 && (hostname === normalized || hostname.endsWith(`.${normalized}`))
  })
  if (!allowed) throw new Error('Lumos service URL host is not allowed')
  return url
}

function validateLumosApiBaseUrl(rawUrl: string, allowedHosts: string[]): URL {
  const url = validateLumosServiceUrl(rawUrl, allowedHosts)
  if (url.pathname !== '/') throw new Error('Lumos service URL base path is not allowed')
  return url
}

function buildLumosRequestUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl)
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password) {
    throw new Error('Lumos service URL base path is not allowed')
  }
  const url = new URL(path, base)
  const isCmsConfiguration = url.pathname === CMS_CONFIGURATION_PATH && url.search === ''
  const isLayout = LAYOUT_PATH.test(url.pathname) && url.search === ''
  const isAvailability = AVAILABILITY_PATH.test(url.pathname)
    && url.search === '?preview=true'
  if (url.hash || !isCmsConfiguration && !isLayout && !isAvailability) {
    throw new Error('Lumos request URL path is not allowed')
  }
  return url.href
}

export function findVistaConnectUrl(configuration: unknown, allowedHosts = DEFAULT_ALLOWED_HOSTS): URL {
  const root = requireRecord(configuration, 'Lumos CMS configuration is malformed')
  const config = requireRecord(root.configuration, 'Lumos CMS configuration is missing')
  const variants = requireRecord(config.languageVariantConfiguration, 'Lumos language configuration is missing')
  for (const variant of Object.values(variants)) {
    if (!isRecord(variant) || !isRecord(variant.shared) || !isRecord(variant.shared.initial)) continue
    const services = variant.shared.initial.services
    if (!isRecord(services) || !isRecord(services.vistaConnect) || typeof services.vistaConnect.url !== 'string') continue
    try {
      return validateLumosApiBaseUrl(services.vistaConnect.url, allowedHosts)
    } catch {
      continue
    }
  }
  throw new Error('Lumos CMS configuration has no allowed Vista Connect URL')
}

function physicalSeatNumber(seat: Record<string, unknown>): number {
  if (typeof seat.label === 'string') {
    const label = seat.label.trim()
    if (/^[1-9][0-9]{0,2}$/.test(label)) return Number(label)
  }
  if (isRecord(seat.position) && Number.isInteger(seat.position.columnIndex)) {
    const columnIndex = seat.position.columnIndex as number
    if (columnIndex >= 0 && columnIndex < 999) return columnIndex + 1
  }
  throw new Error('Lumos seat has no valid physical number')
}

export function normalizeLumosSeats(layoutPayload: unknown, availabilityPayload: unknown): SeatSnapshot[] {
  const layoutRoot = requireRecord(layoutPayload, 'Lumos seat layout is malformed')
  const seatLayout = requireRecord(layoutRoot.seatLayout, 'Lumos seat layout is missing')
  const areas = requireArray(seatLayout.areas, 'Lumos seat layout areas are missing')
  const availabilityRoot = requireRecord(availabilityPayload, 'Lumos seat availability is malformed')
  const entries = requireArray(availabilityRoot.seatAvailabilities, 'Lumos seat availabilities are missing')
  const statuses = new Map<string, string>()
  for (const value of entries) {
    const entry = requireRecord(value, 'Lumos seat availability entry is malformed')
    if (typeof entry.seatId !== 'string' || !entry.seatId.trim() || typeof entry.status !== 'string') {
      throw new Error('Lumos seat availability entry is malformed')
    }
    if (!['Available', 'Sold', 'Broken', 'House'].includes(entry.status)) {
      throw new Error('Lumos seat availability status is unsupported')
    }
    if (statuses.has(entry.seatId)) throw new Error(`Duplicate Lumos availability seat ID ${entry.seatId}`)
    statuses.set(entry.seatId, entry.status)
  }

  const seenIds = new Set<string>()
  const seenSeats = new Set<string>()
  const seats: SeatSnapshot[] = []
  for (const areaValue of areas) {
    const area = requireRecord(areaValue, 'Lumos seat layout area is malformed')
    const rows = requireArray(area.rows, 'Lumos seat layout rows are missing')
    for (const rowValue of rows) {
      const row = requireRecord(rowValue, 'Lumos seat layout row is malformed')
      if (typeof row.label !== 'string') throw new Error('Lumos seat row label is missing')
      const label = row.label.trim().toUpperCase()
      if (!seatRows.includes(label as SeatRow)) continue
      const rowSeats = requireArray(row.seats, `Lumos row ${label} seats are missing`)
      for (const seatValue of rowSeats) {
        const seat = requireRecord(seatValue, `Lumos row ${label} seat is malformed`)
        if (typeof seat.id !== 'string' || !seat.id.trim()) throw new Error(`Lumos row ${label} seat ID is missing`)
        if (seenIds.has(seat.id)) throw new Error(`Duplicate seat ID ${seat.id}`)
        seenIds.add(seat.id)
        const number = physicalSeatNumber(seat)
        const key = `${label}-${number}`
        if (seenSeats.has(key)) throw new Error(`Duplicate seat ${key}`)
        seenSeats.add(key)
        const upstreamStatus = statuses.get(seat.id)
        const status = upstreamStatus === 'Available'
          ? 'available'
          : upstreamStatus === 'Sold'
            ? 'sold'
            : 'held'
        seats.push({ row: label as SeatRow, number, status })
      }
    }
  }
  if (seats.length === 0) throw new Error('Lumos seat layout contains no Rows J-M seats')
  return seats.toSorted((a, b) => seatRows.indexOf(a.row) - seatRows.indexOf(b.row) || a.number - b.number)
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

function safeFailure(error: unknown): LumosFailure {
  if (error instanceof LumosFailure) return error
  if (error instanceof Error && error.name === 'AbortError') return new LumosFailure('error', 'Lumos preview request was aborted')
  if (error instanceof Error && error.message.startsWith('Lumos ')) return new LumosFailure('error', error.message)
  return new LumosFailure('error', 'Lumos preview request failed')
}

export class LumosPreviewSeatProvider implements SeatPreviewProvider {
  private readonly filmUrl: string
  private readonly allowedHosts: string[]
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  private readonly concurrency: number
  private readonly sessionBudget: number
  private readonly tokenRefreshSkewMs: number
  private bootstrap: CachedBootstrap | null = null
  private bootstrapPromise: Promise<CachedBootstrap> | null = null
  private readonly layouts = new Map<string, unknown>()
  private readonly layoutPromises = new Map<string, Promise<unknown>>()
  private readonly lastAttempts = new Map<string, number>()
  private attemptSequence = 0

  constructor(options: LumosPreviewSeatProviderOptions) {
    this.allowedHosts = options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS
    this.filmUrl = validateLumosServiceUrl(options.filmUrl, this.allowedHosts).href.replace(/\/$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
    this.concurrency = options.concurrency ?? 2
    this.sessionBudget = options.sessionBudget ?? 12
    this.tokenRefreshSkewMs = options.tokenRefreshSkewMs ?? 60_000
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 8) {
      throw new Error('Lumos preview concurrency must be an integer from 1 to 8')
    }
    if (!Number.isInteger(this.sessionBudget) || this.sessionBudget < 1 || this.sessionBudget > 100) {
      throw new Error('Lumos preview session budget must be an integer from 1 to 100')
    }
    if (!Number.isInteger(this.tokenRefreshSkewMs) || this.tokenRefreshSkewMs < 1) {
      throw new Error('Lumos token refresh skew must be a positive integer')
    }
  }

  async fetchSeatPreviews(sessions: SessionSnapshot[], signal: AbortSignal): Promise<SeatPreviewResult> {
    const attemptedAt = this.now().toISOString()
    const eligible = sessions
      .filter((session) => SHOWTIME_ID.test(session.listing.sourceId ?? '') && new Date(session.startsAt).getTime() > this.now().getTime())
      .toSorted((a, b) => {
        const aAttempt = this.lastAttempts.get(this.attemptKey(a)) ?? -1
        const bAttempt = this.lastAttempts.get(this.attemptKey(b)) ?? -1
        if (aAttempt !== bAttempt) return aAttempt - bAttempt
        return a.startsAt.localeCompare(b.startsAt)
      })
    const eligibleKeys = new Set(eligible.map((session) => this.attemptKey(session)))
    for (const key of this.lastAttempts.keys()) {
      if (!eligibleKeys.has(key)) this.lastAttempts.delete(key)
    }
    const selected = eligible.slice(0, this.sessionBudget)
    for (const session of selected) this.lastAttempts.set(this.attemptKey(session), this.attemptSequence += 1)
    if (selected.length === 0) {
      return {
        kind: 'ok',
        bootstrap: 'not_attempted',
        detail: 'No upcoming linked sessions require a Lumos preview.',
        observations: [],
        failures: [],
        attemptedAt,
        eligibleSessionCount: eligible.length,
        attemptedSessionCount: 0,
      }
    }

    try {
      await this.getBootstrap(signal)
    } catch (error) {
      const failure = safeFailure(error)
      return {
        kind: failure.kind,
        bootstrap: failure.kind,
        detail: failure.message,
        observations: [],
        failures: selected.map((session) => ({
          sessionId: session.id,
          attemptedAt,
          kind: failure.kind,
          detail: failure.message,
        })),
        attemptedAt,
        eligibleSessionCount: eligible.length,
        attemptedSessionCount: 0,
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      }
    }

    const observations: SessionSnapshot[] = []
    const failures: SeatPreviewFailure[] = []
    let retryAfterMs: number | undefined
    let nextIndex = 0
    let blocked = false
    const worker = async (): Promise<void> => {
      while (!blocked) {
        const index = nextIndex
        nextIndex += 1
        const session = selected[index]
        if (!session) return
        try {
          observations.push(await this.fetchSession(session, attemptedAt, signal))
        } catch (error) {
          const failure = safeFailure(error)
          failures.push({ sessionId: session.id, attemptedAt, kind: failure.kind, detail: failure.message })
          if (failure.kind === 'blocked') {
            blocked = true
            if (failure.retryAfterMs !== undefined) {
              retryAfterMs = Math.max(retryAfterMs ?? 0, failure.retryAfterMs)
            }
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, selected.length) }, worker))
    observations.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    failures.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    const blockedFailure = failures.find(({ kind }) => kind === 'blocked')
    const kind = blockedFailure ? 'blocked' : observations.length === 0 && failures.length > 0 ? 'error' : 'ok'
    const detail = blockedFailure
      ? blockedFailure.detail
      : failures.length > 0
        ? `Exact Lumos preview captured ${observations.length} session(s); ${failures.length} failed.`
        : `Exact Lumos preview captured ${observations.length} session(s).`
    return {
      kind,
      bootstrap: 'ready',
      detail,
      observations,
      failures,
      attemptedAt,
      eligibleSessionCount: eligible.length,
      attemptedSessionCount: observations.length + failures.length,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    }
  }

  private async fetchSession(session: SessionSnapshot, attemptedAt: string, signal: AbortSignal): Promise<SessionSnapshot> {
    const showtimeId = session.listing.sourceId
    if (!showtimeId || !SHOWTIME_ID.test(showtimeId)) throw new Error('Lumos showtime ID is invalid')
    const layout = await this.getLayout(showtimeId, signal)
    const availability = await this.fetchDigitalJson(
      `/ocapi/v1/showtimes/${encodeURIComponent(showtimeId)}/seat-availability?preview=true`,
      'Lumos seat availability',
      signal,
    )
    return {
      ...structuredClone(session),
      seatData: { state: 'captured', capturedAt: attemptedAt },
      seats: normalizeLumosSeats(layout, availability),
    }
  }

  private attemptKey(session: SessionSnapshot): string {
    return `${session.id}\u0000${session.listing.sourceId ?? ''}`
  }

  private async getLayout(showtimeId: string, signal: AbortSignal): Promise<unknown> {
    const cached = this.layouts.get(showtimeId)
    if (cached) return cached
    const active = this.layoutPromises.get(showtimeId)
    if (active) return active
    const request = this.fetchDigitalJson(
      `/ocapi/v1/showtimes/${encodeURIComponent(showtimeId)}/seat-layout`,
      'Lumos seat layout',
      signal,
    ).then((layout) => {
      this.layouts.set(showtimeId, layout)
      return layout
    }).finally(() => this.layoutPromises.delete(showtimeId))
    this.layoutPromises.set(showtimeId, request)
    return request
  }

  private async fetchDigitalJson(path: string, label: string, signal: AbortSignal): Promise<unknown> {
    let bootstrap = await this.getBootstrap(signal)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.fetchImpl(buildLumosRequestUrl(bootstrap.digitalApiUrl, path), {
        signal,
        redirect: 'manual',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${bootstrap.gasToken}`,
          'user-agent': USER_AGENT,
        },
      })
      if (response.status === 401 && attempt === 0) {
        if (this.bootstrap?.gasToken === bootstrap.gasToken) this.bootstrap = null
        bootstrap = await this.getBootstrap(signal)
        continue
      }
      if (response.status === 401) throw new LumosFailure('error', `${label} authorization failed after one refresh`)
      if (response.status === 403 || response.status === 429) {
        throw blockedFailure(label, response, this.now().getTime())
      }
      if (!response.ok || response.status >= 300 && response.status < 400) {
        throw new LumosFailure('error', `${label} returned HTTP ${response.status}`)
      }
      return parseJson(await readBoundedText(response, JSON_BODY_LIMIT, label), label)
    }
    throw new LumosFailure('error', `${label} authorization failed`)
  }

  private async getBootstrap(signal: AbortSignal): Promise<CachedBootstrap> {
    if (this.bootstrap && this.now().getTime() < this.bootstrap.refreshAt) return this.bootstrap
    if (this.bootstrapPromise) return this.bootstrapPromise
    this.bootstrapPromise = this.loadBootstrap(signal).then((value) => {
      this.bootstrap = value
      return value
    }).finally(() => {
      this.bootstrapPromise = null
    })
    return this.bootstrapPromise
  }

  private async loadBootstrap(signal: AbortSignal): Promise<CachedBootstrap> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.fetchImpl(this.filmUrl, {
        signal,
        redirect: 'manual',
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': USER_AGENT,
        },
      })
      if (response.status === 403 || response.status === 429) {
        throw blockedFailure('Public film bootstrap', response, this.now().getTime())
      }
      if (!response.ok || response.status >= 300 && response.status < 400) {
        throw new LumosFailure('error', `Public film bootstrap returned HTTP ${response.status}`)
      }
      const extracted = extractLumosBootstrap(
        await readBoundedText(response, BOOTSTRAP_BODY_LIMIT, 'Lumos'),
      )
      const now = this.now().getTime()
      const refreshAt = extracted.expiresAt - this.tokenRefreshSkewMs
      if (refreshAt <= now) throw new LumosFailure('error', 'Public film bootstrap bearer token expires too soon')
      const cmsApiUrl = validateLumosApiBaseUrl(extracted.cmsApiUrl, this.allowedHosts).href
      const configurationResponse = await this.fetchImpl(
        buildLumosRequestUrl(cmsApiUrl, CMS_CONFIGURATION_PATH),
        {
          signal,
          redirect: 'manual',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${extracted.gasToken}`,
            'user-agent': USER_AGENT,
          },
        },
      )
      if (configurationResponse.status === 401 && attempt === 0) continue
      if (configurationResponse.status === 401) {
        throw new LumosFailure('error', 'Lumos CMS configuration authorization failed after one refresh')
      }
      if (configurationResponse.status === 403 || configurationResponse.status === 429) {
        throw blockedFailure('Lumos CMS configuration', configurationResponse, this.now().getTime())
      }
      if (!configurationResponse.ok || configurationResponse.status >= 300 && configurationResponse.status < 400) {
        throw new LumosFailure('error', `Lumos CMS configuration returned HTTP ${configurationResponse.status}`)
      }
      const configuration = parseJson(
        await readBoundedText(configurationResponse, JSON_BODY_LIMIT, 'Lumos CMS configuration'),
        'Lumos CMS configuration',
      )
      const digitalApiUrl = findVistaConnectUrl(configuration, this.allowedHosts).href
      return { ...extracted, cmsApiUrl, digitalApiUrl, refreshAt }
    }
    throw new LumosFailure('error', 'Lumos CMS configuration authorization failed')
  }
}
