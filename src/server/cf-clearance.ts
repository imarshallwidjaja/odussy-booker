import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const ACQUIRE_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tools',
  'cf-clearance-acquire.py',
)

interface AcquireResult {
  success: boolean
  cookies: Record<string, string>
  user_agent: string
  cf_clearance_expires: number | null
  error?: string
}

export type CfClearanceState = 'valid' | 'expired' | 'never_acquired' | 'acquiring' | 'auto_failed'

export class CfClearanceManager {
  private _state: CfClearanceState = 'never_acquired'
  private _detail = 'Cloudflare clearance has not been acquired yet.'
  private cookies: Record<string, string> = {}
  private userAgent = ''
  private expiresAt: number | null = null
  private autoRetried = false
  private readonly listeners = new Set<(state: CfClearanceState, detail: string) => void>()

  get state(): CfClearanceState { return this._state }
  get detail(): string { return this._detail }

  private notify(): void {
    for (const listener of this.listeners) listener(this._state, this._detail)
  }

  onStateChange(listener: (state: CfClearanceState, detail: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  isExpired(): boolean {
    if (this._state === 'never_acquired' || this._state === 'auto_failed') return true
    if (this._state === 'acquiring') return false
    if (this.expiresAt !== null && Date.now() >= this.expiresAt * 1000) return true
    return false
  }

  apply(init: RequestInit): RequestInit {
    if (Object.keys(this.cookies).length === 0 && !this.userAgent) return init
    const cookieHeader = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
    return {
      ...init,
      headers: {
        ...init.headers,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...(this.userAgent ? { 'user-agent': this.userAgent } : {}),
      },
    }
  }

  async acquire(url: string): Promise<boolean> {
    this._state = 'acquiring'
    this._detail = 'Acquiring Cloudflare clearance via Scrapling...'
    this.notify()

    try {
      const result = await this.runAcquire(url)
      if (result.success) {
        this.cookies = result.cookies
        this.userAgent = result.user_agent
        this.expiresAt = result.cf_clearance_expires
        this._state = 'valid'
        this._detail = 'Cloudflare clearance acquired successfully.'
        this.autoRetried = false
        this.notify()
        return true
      }
      this._state = 'expired'
      this._detail = `Cloudflare clearance acquisition failed: ${result.error ?? 'unknown error'}`
      this.notify()
      return false
    } catch (error) {
      this._state = 'expired'
      this._detail = `Cloudflare clearance acquisition error: ${error instanceof Error ? error.message : 'unknown error'}`
      this.notify()
      return false
    }
  }

  tryAutoRetry(url: string): Promise<boolean> {
    if (this.autoRetried) return Promise.resolve(false)
    this.autoRetried = true
    return this.acquire(url)
  }

  resetAutoRetry(): void {
    this.autoRetried = false
  }

  private runAcquire(url: string): Promise<AcquireResult> {
    return new Promise((resolvePromise, reject) => {
      const proc = spawn('python3', [ACQUIRE_SCRIPT, url], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      proc.on('close', (code) => {
        if (code === 0 && stdout) {
          try {
            resolvePromise(JSON.parse(stdout) as AcquireResult)
          } catch {
            reject(new Error(`Failed to parse acquire output: ${stdout.slice(0, 200)}`))
          }
        } else {
          const errorMsg = stderr.trim() || `exit code ${code}`
          resolvePromise({ success: false, cookies: {}, user_agent: '', cf_clearance_expires: null, error: errorMsg })
        }
      })
      proc.on('error', reject)
    })
  }
}
