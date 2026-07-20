import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const ACQUIRE_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'tools',
  'cf-clearance-acquire.py',
)
const ACQUIRE_OUTPUT_LIMIT = 32_000_000
const DEFAULT_ALLOWED_HOSTS = ['imaxmelbourne.com.au', 'vista.co']
const MAX_PROTECTED_PREVIEW_TIMEOUT_MS = 50_000
const PREVIEW_TIMEOUT_HEADROOM_MS = 5_000

export function resolveProtectedPreviewTimeoutMs(previewTimeoutMs: number): number {
  if (!Number.isInteger(previewTimeoutMs) || previewTimeoutMs <= PREVIEW_TIMEOUT_HEADROOM_MS) {
    throw new Error(`LUMOS_PREVIEW_TIMEOUT_MS must be an integer greater than ${PREVIEW_TIMEOUT_HEADROOM_MS}`)
  }
  return Math.min(MAX_PROTECTED_PREVIEW_TIMEOUT_MS, previewTimeoutMs - PREVIEW_TIMEOUT_HEADROOM_MS)
}

export interface AcquireResult {
  success: boolean
  previews?: Array<{
    showtime_id: string
    layout: unknown
    availability: unknown
  }>
}

interface CfClearanceManagerOptions {
  runAcquire?: (url: string, signal?: AbortSignal, showtimeIds?: string[]) => Promise<AcquireResult>
  allowedHosts?: string[]
  timeoutMs?: number
}

export interface ProtectedPreviewPayload {
  showtimeId: string
  layout: unknown
  availability: unknown
}

export type ProtectedPreviewState = 'idle' | 'acquiring' | 'succeeded' | 'failed'

export class CfClearanceManager {
  private readonly acquireImpl: (
    url: string,
    signal?: AbortSignal,
    showtimeIds?: string[],
  ) => Promise<AcquireResult>
  private readonly allowedHosts: string[]
  private readonly timeoutMs: number
  private _state: ProtectedPreviewState = 'idle'
  private _detail = 'Protected exact-seat preview has not run yet.'
  private protectedPreviews: ProtectedPreviewPayload[] | null = null
  private readonly listeners = new Set<(state: ProtectedPreviewState, detail: string) => void>()

  constructor(options: CfClearanceManagerOptions = {}) {
    this.allowedHosts = [...new Set(options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS)]
    this.timeoutMs = options.timeoutMs ?? 50_000
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('Protected preview timeout must be a positive integer')
    }
    this.acquireImpl = options.runAcquire ?? (
      (url, signal, showtimeIds) => this.runAcquire(url, signal, showtimeIds ?? [])
    )
  }

  get state(): ProtectedPreviewState { return this._state }
  get detail(): string { return this._detail }

  private notify(): void {
    for (const listener of this.listeners) listener(this._state, this._detail)
  }

  onStateChange(listener: (state: ProtectedPreviewState, detail: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async acquire(url: string, signal: AbortSignal, showtimeIds: string[]): Promise<boolean> {
    this._state = 'acquiring'
    this._detail = 'Fetching the protected film bootstrap via Scrapling...'
    this.notify()

    const acquireSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
    let removeAbortListener = () => {}
    const abortResult = new Promise<AcquireResult>((resolveAbort) => {
      const onAbort = () => resolveAbort({ success: false })
      if (acquireSignal.aborted) {
        onAbort()
        return
      }
      acquireSignal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => acquireSignal.removeEventListener('abort', onAbort)
    })
    try {
      const result = await Promise.race([
        this.acquireImpl(url, acquireSignal, showtimeIds),
        abortResult,
      ])
      const requestedIds = new Set(showtimeIds)
      const byShowtimeId = new Map<string, ProtectedPreviewPayload>()
      const duplicateIds = new Set<string>()
      for (const preview of result.previews ?? []) {
        if (typeof preview !== 'object' || preview === null || typeof preview.showtime_id !== 'string') continue
        const showtimeId = preview.showtime_id
        if (!requestedIds.has(showtimeId) || duplicateIds.has(showtimeId)) continue
        if (byShowtimeId.has(showtimeId)) {
          byShowtimeId.delete(showtimeId)
          duplicateIds.add(showtimeId)
          continue
        }
        byShowtimeId.set(showtimeId, {
          showtimeId,
          layout: preview.layout,
          availability: preview.availability,
        })
      }
      const previews = [...byShowtimeId.values()]
      if (result.success && previews.length > 0) {
        this.protectedPreviews = previews
        this._state = 'succeeded'
        this._detail = `Last protected exact-seat preview fetched ${previews.length} session(s).`
        this.notify()
        return true
      }
      this._state = 'failed'
      this._detail = 'Protected exact-seat preview failed.'
      this.notify()
      return false
    } catch {
      this._state = 'failed'
      this._detail = 'Protected exact-seat preview failed.'
      this.notify()
      return false
    } finally {
      removeAbortListener()
    }
  }

  async fetchProtectedPreviews(
    url: string,
    showtimeIds: string[],
    signal: AbortSignal,
  ): Promise<ProtectedPreviewPayload[] | null> {
    if (!await this.acquire(url, signal, showtimeIds)) return null
    const previews = this.protectedPreviews
    this.protectedPreviews = null
    return previews
  }

  private runAcquire(url: string, signal: AbortSignal | undefined, showtimeIds: string[]): Promise<AcquireResult> {
    return new Promise((resolvePromise) => {
      const proc = spawn('python3', [ACQUIRE_SCRIPT, url, JSON.stringify(this.allowedHosts), ...showtimeIds], {
        stdio: ['ignore', 'pipe', 'ignore'],
        signal,
      })
      const chunks: Buffer[] = []
      let outputBytes = 0
      let settled = false
      const finish = (result: AcquireResult): void => {
        if (settled) return
        settled = true
        resolvePromise(result)
      }
      proc.stdout.on('data', (chunk: Buffer) => {
        if (settled) return
        outputBytes += chunk.byteLength
        if (outputBytes > ACQUIRE_OUTPUT_LIMIT) {
          proc.kill()
          finish({ success: false })
          return
        }
        chunks.push(chunk)
      })
      proc.on('close', (code) => {
        if (settled) return
        const stdout = Buffer.concat(chunks, outputBytes).toString('utf8').trim()
        if (stdout) {
          try {
            const result = JSON.parse(stdout) as AcquireResult
            if (typeof result.success === 'boolean' && (code === 0 || !result.success)) {
              finish(result)
              return
            }
          } catch {
            // Treat malformed helper output as a failed protected preview.
          }
        }
        finish({ success: false })
      })
      proc.on('error', () => finish({ success: false }))
    })
  }
}
