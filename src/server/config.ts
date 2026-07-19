interface FreshnessSchedule {
  pollIntervalMs: number
  previewIntervalMs: number
  providerTimeoutMs: number
  previewTimeoutMs: number
}

export function freshnessThresholdMs(schedule: FreshnessSchedule): number {
  const values = Object.values(schedule)
  if (values.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error('Freshness schedule values must be positive integers')
  }
  return Math.max(schedule.pollIntervalMs, schedule.previewIntervalMs)
    + Math.max(schedule.providerTimeoutMs, schedule.previewTimeoutMs)
    + 60_000
}

export function resolvePublicBaseUrl(
  env: NodeJS.ProcessEnv,
  port: number,
  emailEnabled: boolean,
): string {
  const raw = env.PUBLIC_BASE_URL
  if (!raw) {
    if (env.NODE_ENV === 'production' && emailEnabled) {
      throw new Error('PUBLIC_BASE_URL is required when email is enabled in production')
    }
    return `http://localhost:${port}`
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('PUBLIC_BASE_URL must be an http(s) origin')
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('PUBLIC_BASE_URL must be an http(s) origin')
  }
  if (env.NODE_ENV === 'production' && emailEnabled) {
    const hostname = url.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.')) {
      throw new Error('PUBLIC_BASE_URL must be a public origin when email is enabled in production')
    }
    if (url.protocol !== 'https:') {
      throw new Error('PUBLIC_BASE_URL must use HTTPS when email is enabled in production')
    }
  }
  return url.origin
}

export function resolveTrustProxy(env: NodeJS.ProcessEnv): boolean {
  const raw = env.TRUST_PROXY
  if (raw === undefined || raw === 'false') return false
  if (raw !== 'true') throw new Error('TRUST_PROXY must be exactly true or false')
  if (env.NODE_ENV !== 'production') throw new Error('TRUST_PROXY may be enabled only in production')
  return true
}
