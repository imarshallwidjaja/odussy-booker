import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  seatRows,
  supportedFilmFormats,
  supportedFilmIds,
  type AlertDelivery,
  type AppStatus,
  type IngestResult,
  type ExactSeatCaptureState,
  type LumosBootstrapState,
  type SeatCaptureFailureKind,
  type SeatRow,
  type SessionSnapshot,
  type SessionDiscoveryState,
  type SubscriptionFilters,
  type SubscriptionView,
  type Transition,
  type Weekday,
} from './types.js'

interface StoredSubscription extends SubscriptionView {
  confirmationTokenHash: string
  confirmationExpiresAt: string
  confirmationIssuedAt: string
  manageToken: string
  manageTokenHash: string
  unsubscribeToken: string
  unsubscribeTokenHash: string
}

interface StoreOptions {
  filmIds: string[]
  now?: () => Date
  sampleData?: boolean
  confirmationCooldownMs?: number
  pendingSubscriptionLimitPerRecipient?: number
}

export class RecipientSubscriptionLimitError extends Error {}

const melbourneParts = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Melbourne',
  weekday: 'long',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const presetMinutes = {
  anytime: [0, 24 * 60],
  morning: [0, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  afterwork: [17 * 60, 21 * 60],
  late: [21 * 60, 24 * 60],
} as const

function token(): string {
  return randomBytes(32).toString('base64url')
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function minuteOfDay(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return (hours ?? 0) * 60 + (minutes ?? 0)
}

function normalizeFilters(filters: SubscriptionFilters): SubscriptionFilters {
  return {
    ...filters,
    filmIds: [...new Set(filters.filmIds)].sort(),
    weekdays: [...new Set(filters.weekdays)].sort(),
  }
}

function publicSubscription(subscription: StoredSubscription): SubscriptionView {
  const { id, email, filters, verified, active } = subscription
  return { id, email, filters, verified, active }
}

const melbourneIdentity = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Australia/Melbourne',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function sessionIdentity(session: Pick<SessionSnapshot, 'filmId' | 'startsAt'>): string {
  return `${session.filmId}:${melbourneIdentity.format(new Date(session.startsAt))}`
}

export class MemoryStore {
  readonly filmIds: string[]
  readonly sampleData: boolean
  private readonly allowedFilmIds: Set<string>
  private readonly now: () => Date
  private readonly confirmationCooldownMs: number
  private readonly pendingSubscriptionLimitPerRecipient: number
  private readonly sessions = new Map<string, SessionSnapshot>()
  private readonly providerSessionIdentities = new Set<string>()
  private readonly subscriptions = new Map<string, StoredSubscription>()
  private readonly ingestEvents = new Set<string>()
  private transitionCount = 0
  private readonly outbox = new Map<string, AlertDelivery>()
  private lastManualIngest: string | null = null
  private sessionDiscovery: AppStatus['sessionDiscovery'] = {
    state: 'blocked',
    detail: 'The public session listing has not been fetched yet.',
    lastAttempt: null,
    lastSuccess: null,
    nextAttempt: null,
  }
  private lumosBootstrap: AppStatus['lumosBootstrap'] = {
    state: 'pending',
    detail: 'The public Lumos film bootstrap has not been attempted yet.',
    lastAttempt: null,
    lastSuccess: null,
    nextAttempt: null,
  }
  private seatCapture: Pick<AppStatus['seatCapture'], 'state' | 'detail' | 'lastAttempt' | 'nextAttempt'> = {
    state: 'pending',
    detail: 'Exact Rows J-M preview has not been attempted yet; signed manual ingest remains available.',
    lastAttempt: null,
    nextAttempt: null,
  }

  constructor(options: StoreOptions) {
    this.filmIds = [...new Set(options.filmIds)]
    if (this.filmIds.length === 0) throw new Error('At least one film ID must be configured')
    const unsupported = this.filmIds.find(
      (filmId) => !supportedFilmIds.includes(filmId as (typeof supportedFilmIds)[number]),
    )
    if (unsupported) throw new Error(`${unsupported} is not a supported film ID`)
    this.allowedFilmIds = new Set(this.filmIds)
    this.now = options.now ?? (() => new Date())
    this.sampleData = options.sampleData ?? false
    this.confirmationCooldownMs = options.confirmationCooldownMs ?? 15 * 60 * 1000
    this.pendingSubscriptionLimitPerRecipient = options.pendingSubscriptionLimitPerRecipient ?? 3
    if (!Number.isInteger(this.confirmationCooldownMs) || this.confirmationCooldownMs < 0) {
      throw new Error('Confirmation cooldown must be a non-negative integer')
    }
    if (!Number.isInteger(this.pendingSubscriptionLimitPerRecipient) || this.pendingSubscriptionLimitPerRecipient < 1) {
      throw new Error('Pending subscription limit must be a positive integer')
    }
  }

  get subscriptionCount(): number {
    return this.subscriptions.size
  }

  getSessions(): SessionSnapshot[] {
    return [...this.sessions.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  }

  getStatus(): AppStatus {
    const sessions = [...this.sessions.values()]
    const capturedSessionCount = sessions
      .filter(({ seatData }) => seatData.state === 'captured').length
    const lastKnownSessionCount = sessions
      .filter(({ seatData }) => seatData.state === 'last_known').length
    const uncapturedSessionCount = sessions
      .filter(({ seatData }) => seatData.state === 'unavailable').length
    const failedSessionCount = sessions.filter(({ seatData }) => seatData.lastFailure).length
    const lastCapture = sessions
      .map(({ seatData }) => seatData.capturedAt)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null
    return {
      mode: 'ephemeral',
      sampleData: this.sampleData,
      filmIds: this.filmIds,
      sessionCount: this.sessions.size,
      subscriptionCount: this.subscriptions.size,
      transitionCount: this.transitionCount,
      pendingAlertCount: this.outbox.size,
      lastManualIngest: this.lastManualIngest,
      sessionDiscovery: { ...this.sessionDiscovery },
      lumosBootstrap: { ...this.lumosBootstrap },
      seatCapture: {
        ...this.seatCapture,
        state: this.seatCapture.state === 'fresh' && (lastKnownSessionCount > 0 || uncapturedSessionCount > 0)
          ? 'partial'
          : this.seatCapture.state,
        lastCapture,
        capturedSessionCount,
        lastKnownSessionCount,
        uncapturedSessionCount,
        failedSessionCount,
      },
    }
  }

  setUpstreamStatus(
    state: SessionDiscoveryState,
    detail: string,
    options: { attemptedAt: string; nextAttempt: string | null; succeeded?: boolean },
  ): void {
    this.sessionDiscovery = {
      state,
      detail,
      lastAttempt: options.attemptedAt,
      lastSuccess: options.succeeded ? options.attemptedAt : this.sessionDiscovery.lastSuccess,
      nextAttempt: options.nextAttempt,
    }
  }

  setLumosBootstrapStatus(
    state: LumosBootstrapState,
    detail: string,
    options: { attemptedAt: string; nextAttempt: string | null },
  ): void {
    this.lumosBootstrap = {
      state,
      detail,
      lastAttempt: options.attemptedAt,
      lastSuccess: state === 'ready' ? options.attemptedAt : this.lumosBootstrap.lastSuccess,
      nextAttempt: options.nextAttempt,
    }
  }

  setSeatCaptureStatus(
    state: ExactSeatCaptureState,
    detail: string,
    options: { attemptedAt: string; nextAttempt: string | null },
  ): void {
    this.seatCapture = {
      state,
      detail,
      lastAttempt: options.attemptedAt,
      nextAttempt: options.nextAttempt,
    }
  }

  recordSeatPreviewFailures(failures: Array<{
    sessionId: string
    attemptedAt: string
    kind: SeatCaptureFailureKind
    detail: string
  }>): void {
    for (const failure of failures) {
      const session = [...this.sessions.values()].find(({ id }) => id === failure.sessionId)
      if (!session) continue
      session.seatData = {
        ...session.seatData,
        lastAttempt: failure.attemptedAt,
        lastFailure: {
          at: failure.attemptedAt,
          kind: failure.kind,
          detail: failure.detail,
        },
      }
    }
  }

  ingest(
    snapshots: SessionSnapshot[],
    source: 'manual' | 'preview' | 'provider' | 'sample',
    eventId: string,
  ): IngestResult {
    if (this.ingestEvents.has(eventId)) {
      return { duplicate: true, transitions: [], deliveries: [] }
    }

    const sessionIds = new Set<string>()
    const sessionIdentities = new Set<string>()
    for (const snapshot of snapshots) {
      if (sessionIds.has(snapshot.id)) throw new Error(`Duplicate session ${snapshot.id}`)
      sessionIds.add(snapshot.id)
      const identity = sessionIdentity(snapshot)
      if (sessionIdentities.has(identity)) throw new Error(`Duplicate session time ${identity}`)
      sessionIdentities.add(identity)
      this.validateSnapshot(snapshot)
      if (source === 'manual' && snapshot.seats.length === 0) {
        throw new Error('Manual exact snapshots require at least one seat')
      }
    }

    const occurredAt = this.now().toISOString()
    const transitions: Transition[] = []
    if (source === 'provider') {
      for (const identity of this.providerSessionIdentities) {
        if (sessionIdentities.has(identity)) continue
        this.sessions.delete(identity)
        this.providerSessionIdentities.delete(identity)
      }
    }
    for (const snapshot of snapshots) {
      const identity = sessionIdentity(snapshot)
      const previous = this.sessions.get(identity)
      const discovered = source === 'provider'
      const exactSeatsPreviouslyKnown = previous !== undefined && previous.seatData.state !== 'unavailable'
      const previousSourceShowtimeId = previous?.seatData.sourceShowtimeId ?? previous?.listing.sourceId ?? null
      const incomingSourceShowtimeId = snapshot.listing.sourceId
      const sourceRolledOver = exactSeatsPreviouslyKnown
        && incomingSourceShowtimeId !== null
        && previousSourceShowtimeId !== incomingSourceShowtimeId
      const preserveKnownSeats = exactSeatsPreviouslyKnown && !sourceRolledOver
      const next: SessionSnapshot = discovered
        ? {
            ...structuredClone(snapshot),
            id: previous?.id ?? snapshot.id,
            seats: preserveKnownSeats ? structuredClone(previous.seats) : [],
            seatData: preserveKnownSeats
              ? {
                  ...previous.seatData,
                  state: previousSourceShowtimeId !== null && incomingSourceShowtimeId === null
                    ? 'last_known'
                    : previous.seatData.state,
                }
              : { state: 'unavailable', capturedAt: null },
          }
        : {
            ...structuredClone(snapshot),
            id: previous?.id ?? snapshot.id,
            title: previous?.listing.observedAt ? previous.title : snapshot.title,
            bookingUrl: previous?.listing.observedAt ? previous.bookingUrl : snapshot.bookingUrl,
            listing: previous?.listing.observedAt
              ? { ...previous.listing }
              : { ...snapshot.listing },
            seatData: {
              state: 'captured',
              capturedAt: occurredAt,
              source: source === 'preview' ? 'lumos_preview' : source,
              sourceShowtimeId: previous?.listing.observedAt
                ? previous.listing.sourceId
                : snapshot.listing.sourceId,
              lastAttempt: occurredAt,
              lastFailure: null,
            },
          }
      if (!discovered && exactSeatsPreviouslyKnown && previous) {
        const previousSeats = new Map(
          previous.seats.map((seat) => [`${seat.row}-${seat.number}`, seat.status]),
        )
        for (const seat of next.seats) {
          const oldStatus = previousSeats.get(`${seat.row}-${seat.number}`)
          if (oldStatus && oldStatus !== 'available' && seat.status === 'available') {
            transitions.push({
              sessionId: next.id,
              occurredAt,
              seat: { row: seat.row, number: seat.number },
              from: oldStatus,
              to: 'available',
            })
          }
        }
      }
      this.sessions.set(identity, next)
      if (source === 'provider' && (this.providerSessionIdentities.has(identity) || previous === undefined)) {
        this.providerSessionIdentities.add(identity)
      }
    }

    this.ingestEvents.add(eventId)
    this.transitionCount += transitions.length
    if (source === 'manual') {
      this.lastManualIngest = occurredAt
      this.seatCapture = {
        state: 'fresh',
        detail: 'Exact Rows J-M snapshot captured through signed manual ingest.',
        lastAttempt: occurredAt,
        nextAttempt: this.seatCapture.nextAttempt,
      }
    } else if (source === 'sample') {
      this.seatCapture = {
        state: 'fresh',
        detail: 'Exact Rows J-M sample fixture is loaded.',
        lastAttempt: occurredAt,
        nextAttempt: null,
      }
    }

    return {
      duplicate: false,
      transitions,
      deliveries: this.matchDeliveries(transitions),
    }
  }

  getPendingDeliveries(): AlertDelivery[] {
    return structuredClone([...this.outbox.values()])
  }

  markDeliveriesSent(deliveryIds: string[]): void {
    for (const deliveryId of deliveryIds) this.outbox.delete(deliveryId)
  }

  createSubscription(email: string, requestedFilters: SubscriptionFilters): {
    subscription: SubscriptionView
    confirmationToken: string
    manageToken: string
    unsubscribeToken: string
    reused: boolean
    needsConfirmation: boolean
    confirmationIssued: boolean
  } {
    const normalizedEmail = email.trim().toLowerCase()
    const filters = normalizeFilters(requestedFilters)
    const fingerprint = `${normalizedEmail}\u0000${JSON.stringify(filters)}`
    const existing = [...this.subscriptions.values()].find(
      (candidate) => `${candidate.email}\u0000${JSON.stringify(candidate.filters)}` === fingerprint,
    )

    if (existing) {
      if (!existing.active) existing.verified = false
      existing.active = true
      let confirmationToken = ''
      let confirmationIssued = false
      const currentTime = this.now().getTime()
      const confirmationPending = existing.confirmationTokenHash.length > 0
        && currentTime < new Date(existing.confirmationExpiresAt).getTime()
      const inCooldown = currentTime - new Date(existing.confirmationIssuedAt).getTime() < this.confirmationCooldownMs
      if (!existing.verified && (!confirmationPending || !inCooldown)) {
        confirmationToken = token()
        existing.confirmationTokenHash = hashToken(confirmationToken)
        existing.confirmationIssuedAt = this.now().toISOString()
        existing.confirmationExpiresAt = new Date(currentTime + 24 * 60 * 60 * 1000).toISOString()
        confirmationIssued = true
      }
      return {
        subscription: publicSubscription(existing),
        confirmationToken,
        manageToken: existing.manageToken,
        unsubscribeToken: existing.unsubscribeToken,
        reused: true,
        needsConfirmation: !existing.verified,
        confirmationIssued,
      }
    }

    const pendingForRecipient = [...this.subscriptions.values()].filter(
      (candidate) => candidate.email === normalizedEmail && candidate.active && !candidate.verified,
    ).length
    if (pendingForRecipient >= this.pendingSubscriptionLimitPerRecipient) {
      throw new RecipientSubscriptionLimitError('Pending alert limit reached for this recipient')
    }

    const confirmationToken = token()
    const manageToken = token()
    const unsubscribeToken = token()
    const confirmationIssuedAt = this.now().toISOString()
    const subscription: StoredSubscription = {
      id: randomUUID(),
      email: normalizedEmail,
      filters,
      verified: false,
      active: true,
      confirmationTokenHash: hashToken(confirmationToken),
      confirmationExpiresAt: new Date(this.now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
      confirmationIssuedAt,
      manageToken,
      manageTokenHash: hashToken(manageToken),
      unsubscribeToken,
      unsubscribeTokenHash: hashToken(unsubscribeToken),
    }
    this.subscriptions.set(subscription.id, subscription)

    return {
      subscription: publicSubscription(subscription),
      confirmationToken,
      manageToken,
      unsubscribeToken,
      reused: false,
      needsConfirmation: true,
      confirmationIssued: true,
    }
  }

  confirmSubscription(rawToken: string): boolean {
    const hashed = hashToken(rawToken)
    const subscription = [...this.subscriptions.values()].find(
      (candidate) => candidate.confirmationTokenHash === hashed,
    )
    if (!subscription || this.now().getTime() >= new Date(subscription.confirmationExpiresAt).getTime()) {
      return false
    }
    subscription.verified = true
    subscription.active = true
    subscription.confirmationTokenHash = ''
    return true
  }

  getManagedSubscription(rawToken: string): SubscriptionView | undefined {
    const hashed = hashToken(rawToken)
    const subscription = [...this.subscriptions.values()].find(
      (candidate) => candidate.manageTokenHash === hashed,
    )
    return subscription ? publicSubscription(subscription) : undefined
  }

  unsubscribe(rawToken: string): boolean {
    const hashed = hashToken(rawToken)
    const subscription = [...this.subscriptions.values()].find(
      (candidate) => candidate.unsubscribeTokenHash === hashed,
    )
    if (!subscription) return false
    subscription.active = false
    for (const [deliveryId, delivery] of this.outbox) {
      if (delivery.subscriptionId === subscription.id) this.outbox.delete(deliveryId)
    }
    return true
  }

  private validateSnapshot(snapshot: SessionSnapshot): void {
    if (!this.allowedFilmIds.has(snapshot.filmId)) throw new Error(`Film ${snapshot.filmId} is not configured`)
    const expectedFormat = supportedFilmFormats[snapshot.filmId as keyof typeof supportedFilmFormats]
    if (expectedFormat && snapshot.format !== expectedFormat) {
      throw new Error(`Film ${snapshot.filmId} requires ${expectedFormat} format`)
    }
    const seatKeys = new Set<string>()
    for (const seat of snapshot.seats) {
      if (!seatRows.includes(seat.row as SeatRow)) throw new Error('Only rows J-M may be ingested')
      const key = `${seat.row}-${seat.number}`
      if (seatKeys.has(key)) throw new Error(`Duplicate seat ${key}`)
      seatKeys.add(key)
    }
  }

  private matchDeliveries(transitions: Transition[]): AlertDelivery[] {
    if (transitions.length === 0) return []
    const transitionsBySession = new Map<string, Transition[]>()
    for (const transition of transitions) {
      const current = transitionsBySession.get(transition.sessionId) ?? []
      current.push(transition)
      transitionsBySession.set(transition.sessionId, current)
    }

    const deliveries: AlertDelivery[] = []
    for (const subscription of this.subscriptions.values()) {
      if (!subscription.active || !subscription.verified) continue

      const sessions = []
      for (const [sessionId, sessionTransitions] of transitionsBySession) {
        const snapshot = [...this.sessions.values()].find(({ id }) => id === sessionId)
        if (!snapshot || !snapshot.bookingUrl || !this.matches(snapshot, subscription.filters)) continue
        sessions.push({
          sessionId,
          title: snapshot.title,
          startsAt: snapshot.startsAt,
          format: snapshot.format,
          bookingUrl: snapshot.bookingUrl,
          seats: sessionTransitions.map(({ seat }) => seat),
          availableCount: snapshot.seats.filter(({ status }) => status === 'available').length,
        })
      }

      if (sessions.length > 0) {
        const delivery = {
          id: randomUUID(),
          subscriptionId: subscription.id,
          email: subscription.email,
          manageToken: subscription.manageToken,
          unsubscribeToken: subscription.unsubscribeToken,
          sessions,
        }
        this.outbox.set(delivery.id, delivery)
        deliveries.push(delivery)
      }
    }
    return deliveries
  }

  private matches(snapshot: SessionSnapshot, filters: SubscriptionFilters): boolean {
    if (!filters.filmIds.includes(snapshot.filmId)) return false
    if (filters.format !== 'all' && filters.format !== snapshot.format) return false

    const parts = melbourneParts.formatToParts(new Date(snapshot.startsAt))
    const weekday = parts.find(({ type }) => type === 'weekday')?.value.toLowerCase() as Weekday
    if (!filters.weekdays.includes(weekday)) return false
    const hour = Number(parts.find(({ type }) => type === 'hour')?.value)
    const minute = Number(parts.find(({ type }) => type === 'minute')?.value)
    const sessionMinutes = hour * 60 + minute
    const [from, to] = filters.time.preset === 'custom'
      ? [minuteOfDay(filters.time.from), minuteOfDay(filters.time.to)]
      : presetMinutes[filters.time.preset]
    if (sessionMinutes < from || sessionMinutes >= to) return false

    const available = snapshot.seats.filter(({ status }) => status === 'available')
    if (available.length < filters.minimumSeats) return false
    if (!filters.adjacentOnly) return true

    for (const row of seatRows) {
      const numbers = available
        .filter((seat) => seat.row === row)
        .map((seat) => seat.number)
        .sort((a, b) => a - b)
      let run = numbers.length > 0 ? 1 : 0
      for (let index = 1; index < numbers.length; index += 1) {
        run = numbers[index] === (numbers[index - 1] ?? 0) + 1 ? run + 1 : 1
        if (run >= filters.minimumSeats) return true
      }
      if (run >= filters.minimumSeats) return true
    }
    return false
  }
}
