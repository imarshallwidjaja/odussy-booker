import type { AlertDelivery } from '../domain/types.js'
import type { MemoryStore } from '../domain/store.js'
import type { ProviderResult, UpstreamProvider } from './provider.js'
import type { SeatPreviewProvider, SeatPreviewResult } from './lumos-provider.js'

interface SchedulerOptions {
  provider: UpstreamProvider
  seatProvider?: SeatPreviewProvider
  store: MemoryStore
  cooldownMs: number
  previewCooldownMs?: number
  providerTimeoutMs?: number
  previewTimeoutMs?: number
  deliveryTimeoutMs?: number
  deliveryBatchSize?: number
  now?: () => Date
  onDeliveries?: (deliveries: AlertDelivery[], signal: AbortSignal) => Promise<string[]>
}

export class PollScheduler {
  private readonly provider: UpstreamProvider
  private readonly seatProvider?: SeatPreviewProvider
  private readonly store: MemoryStore
  private readonly cooldownMs: number
  private readonly previewCooldownMs: number
  private readonly providerTimeoutMs: number
  private readonly previewTimeoutMs: number
  private readonly deliveryTimeoutMs: number
  private readonly deliveryBatchSize: number
  private readonly now: () => Date
  private readonly onDeliveries?: (deliveries: AlertDelivery[], signal: AbortSignal) => Promise<string[]>
  private running = false
  private failures = 0
  private nextAllowedAt = 0
  private previewFailures = 0
  private nextPreviewAllowedAt = 0
  private deliveryFailures = 0
  private nextDeliveryAllowedAt = 0
  private readonly deliveryAttempts = new Map<string, number>()
  private deliveryAttemptSequence = 0
  private timer?: NodeJS.Timeout

  constructor(options: SchedulerOptions) {
    if (!Number.isFinite(options.cooldownMs) || options.cooldownMs < 0) {
      throw new Error('Poll cooldown must be a non-negative number')
    }
    const providerTimeoutMs = options.providerTimeoutMs ?? 30_000
    if (!Number.isInteger(providerTimeoutMs) || providerTimeoutMs < 1) {
      throw new Error('Provider timeout must be a positive integer')
    }
    const previewCooldownMs = options.previewCooldownMs ?? options.cooldownMs
    if (!Number.isFinite(previewCooldownMs) || previewCooldownMs < 0) {
      throw new Error('Preview cooldown must be a non-negative number')
    }
    const previewTimeoutMs = options.previewTimeoutMs ?? providerTimeoutMs
    if (!Number.isInteger(previewTimeoutMs) || previewTimeoutMs < 1) {
      throw new Error('Preview timeout must be a positive integer')
    }
    const deliveryTimeoutMs = options.deliveryTimeoutMs ?? providerTimeoutMs
    if (!Number.isInteger(deliveryTimeoutMs) || deliveryTimeoutMs < 1) {
      throw new Error('Delivery timeout must be a positive integer')
    }
    const deliveryBatchSize = options.deliveryBatchSize ?? 25
    if (!Number.isInteger(deliveryBatchSize) || deliveryBatchSize < 1 || deliveryBatchSize > 100) {
      throw new Error('Delivery batch size must be an integer from 1 to 100')
    }
    this.provider = options.provider
    this.seatProvider = options.seatProvider
    this.store = options.store
    this.cooldownMs = options.cooldownMs
    this.previewCooldownMs = previewCooldownMs
    this.providerTimeoutMs = providerTimeoutMs
    this.previewTimeoutMs = previewTimeoutMs
    this.deliveryTimeoutMs = deliveryTimeoutMs
    this.deliveryBatchSize = deliveryBatchSize
    this.now = options.now ?? (() => new Date())
    this.onDeliveries = options.onDeliveries
  }

  start(intervalMs: number): void {
    if (!Number.isInteger(intervalMs) || intervalMs < 1) {
      throw new Error('Poll interval must be a positive integer')
    }
    void this.runOnce()
    this.timer = setInterval(() => void this.runOnce(), intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async runOnce(): Promise<boolean> {
    const attemptedAt = this.now()
    if (this.running) return false
    this.running = true
    let didWork = false

    try {
      if (attemptedAt.getTime() >= this.nextAllowedAt) {
        didWork = true
        try {
          const result = await this.fetchProvider()
          if (result.kind !== 'ok') {
            this.failures += 1
            const backoff = Math.min(this.cooldownMs * 2 ** (this.failures - 1), 60 * 60 * 1000)
            this.nextAllowedAt = attemptedAt.getTime() + backoff
            this.store.setUpstreamStatus(
              result.kind,
              result.kind === 'error' ? result.message : result.reason,
              {
                attemptedAt: attemptedAt.toISOString(),
                nextAttempt: new Date(this.nextAllowedAt).toISOString(),
              },
            )
          } else {
            this.store.ingest(
              result.sessions,
              'provider',
              `provider-${attemptedAt.toISOString()}`,
            )
            this.failures = 0
            this.nextAllowedAt = attemptedAt.getTime() + this.cooldownMs
            this.store.setUpstreamStatus('ok', 'Public session listing refresh completed.', {
              attemptedAt: attemptedAt.toISOString(),
              nextAttempt: new Date(this.nextAllowedAt).toISOString(),
              succeeded: true,
            })
          }
        } catch (error) {
          this.failures += 1
          const backoff = Math.min(this.cooldownMs * 2 ** (this.failures - 1), 60 * 60 * 1000)
          this.nextAllowedAt = attemptedAt.getTime() + backoff
          this.store.setUpstreamStatus('error', error instanceof Error ? error.message : 'Unknown provider error', {
            attemptedAt: attemptedAt.toISOString(),
            nextAttempt: new Date(this.nextAllowedAt).toISOString(),
          })
        }
      }

      if (this.seatProvider && attemptedAt.getTime() >= this.nextPreviewAllowedAt) {
        didWork = true
        try {
          await this.pollSeatProvider(attemptedAt)
        } catch (error) {
          this.previewFailures += 1
          const backoff = Math.min(this.previewCooldownMs * 2 ** (this.previewFailures - 1), 60 * 60 * 1000)
          this.nextPreviewAllowedAt = attemptedAt.getTime() + backoff
          this.store.setSeatCaptureStatus(
            'error',
            `${error instanceof Error ? error.message : 'Unknown preview error'} Signed manual ingest remains available.`,
            {
              attemptedAt: attemptedAt.toISOString(),
              nextAttempt: new Date(this.nextPreviewAllowedAt).toISOString(),
            },
          )
        }
      }

      const pendingDeliveries = this.store.getPendingDeliveries()
      if (this.onDeliveries && pendingDeliveries.length > 0 && attemptedAt.getTime() >= this.nextDeliveryAllowedAt) {
        didWork = true
        const pendingIds = new Set(pendingDeliveries.map(({ id }) => id))
        for (const id of this.deliveryAttempts.keys()) {
          if (!pendingIds.has(id)) this.deliveryAttempts.delete(id)
        }
        const batch = pendingDeliveries
          .toSorted((a, b) => {
            const aAttempt = this.deliveryAttempts.get(a.id) ?? -1
            const bAttempt = this.deliveryAttempts.get(b.id) ?? -1
            return aAttempt - bAttempt
          })
          .slice(0, this.deliveryBatchSize)
        for (const delivery of batch) {
          this.deliveryAttempts.set(delivery.id, this.deliveryAttemptSequence += 1)
        }
        const sentIds = await this.deliver(batch)
        this.store.markDeliveriesSent(sentIds)
        if (sentIds.length === batch.length) {
          this.deliveryFailures = 0
          this.nextDeliveryAllowedAt = attemptedAt.getTime() + this.cooldownMs
        } else {
          this.deliveryFailures += 1
          const backoff = Math.min(this.cooldownMs * 2 ** (this.deliveryFailures - 1), 60 * 60 * 1000)
          this.nextDeliveryAllowedAt = attemptedAt.getTime() + backoff
        }
      }
      return didWork
    } finally {
      this.running = false
    }
  }

  private async fetchProvider(): Promise<ProviderResult> {
    const controller = new AbortController()
    let timeout: NodeJS.Timeout | undefined
    const timeoutResult = new Promise<ProviderResult>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort()
        resolve({
          kind: 'error',
          message: `Provider request timed out after ${this.providerTimeoutMs}ms`,
        })
      }, this.providerTimeoutMs)
      timeout.unref()
    })
    try {
      return await Promise.race([
        this.provider.fetchSessions(controller.signal),
        timeoutResult,
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private async deliver(deliveries: AlertDelivery[]): Promise<string[]> {
    if (!this.onDeliveries) return []
    const controller = new AbortController()
    let timeout: NodeJS.Timeout | undefined
    const timeoutResult = new Promise<string[]>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort()
        resolve([])
      }, this.deliveryTimeoutMs)
      timeout.unref()
    })
    try {
      const sentIds = await Promise.race([
        this.onDeliveries(deliveries, controller.signal),
        timeoutResult,
      ])
      const selectedIds = new Set(deliveries.map(({ id }) => id))
      return [...new Set(sentIds)].filter((id) => selectedIds.has(id))
    } catch {
      return []
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private async pollSeatProvider(attemptedAt: Date): Promise<void> {
    if (!this.seatProvider || attemptedAt.getTime() < this.nextPreviewAllowedAt) return
    let result: SeatPreviewResult
    try {
      result = await this.fetchSeatProvider(this.store.getSessions())
    } catch {
      result = {
        kind: 'error',
        bootstrap: 'error',
        detail: 'Lumos preview provider failed unexpectedly.',
        observations: [],
        failures: [],
        attemptedAt: attemptedAt.toISOString(),
        eligibleSessionCount: 0,
        attemptedSessionCount: 0,
      }
    }

    if (result.kind === 'ok') {
      this.previewFailures = 0
      this.nextPreviewAllowedAt = attemptedAt.getTime() + this.previewCooldownMs
    } else {
      this.previewFailures += 1
      const backoff = Math.min(this.previewCooldownMs * 2 ** (this.previewFailures - 1), 60 * 60 * 1000)
      this.nextPreviewAllowedAt = attemptedAt.getTime() + backoff
    }
    const nextAttempt = new Date(this.nextPreviewAllowedAt).toISOString()
    if (result.bootstrap !== 'not_attempted') {
      this.store.setLumosBootstrapStatus(result.bootstrap, result.bootstrap === 'ready'
        ? 'Public film bootstrap and tenant API discovery succeeded.'
        : result.detail, {
        attemptedAt: result.attemptedAt,
        nextAttempt,
      })
    }
    if (result.observations.length > 0) {
      this.store.ingest(result.observations, 'preview', `lumos-preview-${result.attemptedAt}`)
    }
    this.store.recordSeatPreviewFailures(result.failures)
    if (result.bootstrap === 'not_attempted' && result.attemptedSessionCount === 0) return

    const state = result.kind === 'blocked'
      ? 'blocked'
        : result.kind === 'error'
          ? 'error'
        : result.failures.length > 0 || result.attemptedSessionCount < result.eligibleSessionCount
          ? 'partial'
          : 'fresh'
    const detail = state === 'fresh'
      ? result.detail
      : `${result.detail} Signed manual ingest remains available.`
    this.store.setSeatCaptureStatus(state, detail, {
      attemptedAt: result.attemptedAt,
      nextAttempt,
    })
  }

  private async fetchSeatProvider(sessions: Parameters<SeatPreviewProvider['fetchSeatPreviews']>[0]): Promise<SeatPreviewResult> {
    if (!this.seatProvider) throw new Error('Seat preview provider is not configured')
    const controller = new AbortController()
    let timeout: NodeJS.Timeout | undefined
    const timeoutResult = new Promise<SeatPreviewResult>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort()
        resolve({
          kind: 'error',
          bootstrap: 'error',
          detail: `Lumos preview timed out after ${this.previewTimeoutMs}ms`,
          observations: [],
          failures: [],
          attemptedAt: this.now().toISOString(),
          eligibleSessionCount: 0,
          attemptedSessionCount: 0,
        })
      }, this.previewTimeoutMs)
      timeout.unref()
    })
    try {
      return await Promise.race([
        this.seatProvider.fetchSeatPreviews(sessions, controller.signal),
        timeoutResult,
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}
