import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

import { getConnInfo } from '@hono/node-server/conninfo'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'

import { RecipientSubscriptionLimitError, type MemoryStore } from '../domain/store.js'
import type { SubscriptionFilters, TimePreset } from '../domain/types.js'
import type { CfClearanceManager } from './cf-clearance.js'
import { createCfClearanceRoutes } from './cf-clearance-routes.js'
import type { EmailSender } from './email.js'
import { escapeHtml } from './html.js'
import { readBoundedText } from './http.js'
import { createSchemas } from './validation.js'

interface AppOptions {
  store: MemoryStore
  email: EmailSender
  cfClearance?: CfClearanceManager
  filmUrl?: string
  ingestToken?: string
  staticRoot?: string
  staleAfterMs?: number
  now?: () => number
  rateLimitMaxEntries?: number
  trustProxy?: boolean
}

const SUBSCRIPTION_BODY_LIMIT = 16_384
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
const RATE_LIMIT_ATTEMPTS = 5

function tokenMatches(expected: string | undefined, authorization: string | undefined): boolean {
  if (!expected || !authorization?.startsWith('Bearer ')) return false
  const supplied = authorization.slice(7)
  const expectedBytes = Buffer.from(expected)
  const suppliedBytes = Buffer.from(supplied)
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{margin:0;background:#0a0a0e;color:#f2ede3;font:18px "Archivo",system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}main{max-width:38rem;margin:1rem;padding:2rem;border:1px solid #26262f;background:#14141b}h1{font-family:Impact,"Arial Narrow Bold",sans-serif;letter-spacing:.02em;text-transform:uppercase}a{color:#8fd8ec}dl{display:grid;grid-template-columns:auto 1fr;gap:.4rem 1.2rem;margin:1.2rem 0}dt{color:#96907f;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85rem}dd{margin:0}:focus-visible{outline:3px solid #f5c66b;outline-offset:3px}</style><main><h1>${title}</h1>${body}<p><a href="/">Return to House Lights</a></p></main></html>`
}

function describeTimeFilter(time: SubscriptionFilters['time']): string {
  if (time.preset === 'custom') return `${time.from}–${time.to} Melbourne`
  const labels: Record<Exclude<TimePreset, 'custom'>, string> = {
    anytime: 'Any time of day',
    morning: 'Morning (before 12:00)',
    afternoon: 'Afternoon (12:00–17:00)',
    afterwork: 'After work (17:00–21:00)',
    late: 'Late (21:00 and later)',
  }
  return labels[time.preset]
}

function describeFilters(filters: SubscriptionFilters): string {
  const presentation = filters.format === 'all'
    ? 'All presentations'
    : filters.format === 'laser'
      ? '4K Laser'
      : 'IMAX 70mm Film'
  const days = filters.weekdays.length === 7
    ? 'Every day'
    : filters.weekdays.map((day) => day.slice(0, 1).toUpperCase() + day.slice(1, 3)).join(', ')
  const adjacency = filters.adjacentOnly
    ? `${filters.minimumSeats} adjacent seat${filters.minimumSeats === 1 ? '' : 's'} in one row`
    : `${filters.minimumSeats} seat${filters.minimumSeats === 1 ? '' : 's'} anywhere in Rows J-M`
  return `<dl><dt>Presentation</dt><dd>${presentation}</dd><dt>Days</dt><dd>${days}</dd><dt>Time</dt><dd>${describeTimeFilter(filters.time)}</dd><dt>Minimum</dt><dd>${adjacency}</dd></dl>`
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono()
  const schemas = createSchemas(options.store.filmIds)
  const rateLimits = new Map<string, number[]>()
  const staleAfterMs = options.staleAfterMs ?? 10 * 60 * 1000
  const now = options.now ?? Date.now
  const rateLimitMaxEntries = options.rateLimitMaxEntries ?? 10_000
  if (!Number.isInteger(rateLimitMaxEntries) || rateLimitMaxEntries < 1) {
    throw new Error('Rate-limit entry cap must be a positive integer')
  }

  app.use('*', async (context, next) => {
    await next()
    context.header('X-Content-Type-Options', 'nosniff')
    const tokenPage = ['/confirm', '/manage', '/unsubscribe'].includes(context.req.path)
    context.header('Referrer-Policy', tokenPage ? 'no-referrer' : 'same-origin')
    if (tokenPage) context.header('Cache-Control', 'no-store')
    context.header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'")
  })

  app.get('/health', (context) => {
    const status = options.store.getStatus()
    return context.json({
      process: 'ok',
      state: { mode: 'ephemeral', persistent: false },
      sessionDiscovery: {
        ready: status.sessionDiscovery.state === 'ok',
        state: status.sessionDiscovery.state,
        detail: status.sessionDiscovery.detail,
      },
      lumosBootstrap: { state: status.lumosBootstrap.state },
      seatCapture: { state: status.seatCapture.state },
      email: { configured: options.email.configured },
    })
  })

  app.get('/api/status', (context) => {
    const status = options.store.getStatus()
    const ageMs = status.sessionDiscovery.lastSuccess
      ? Math.max(0, Date.now() - new Date(status.sessionDiscovery.lastSuccess).getTime())
      : null
    const freshnessState = ageMs === null ? 'missing' : ageMs > staleAfterMs ? 'stale' : 'fresh'
    const seatAgeMs = status.seatCapture.lastCapture
      ? Math.max(0, Date.now() - new Date(status.seatCapture.lastCapture).getTime())
      : null
    const seatFreshnessState = seatAgeMs === null ? 'missing' : seatAgeMs > staleAfterMs ? 'stale' : 'fresh'
    return context.json({
      ...status,
      degraded: freshnessState !== 'fresh'
        || status.sessionDiscovery.state !== 'ok'
        || status.seatCapture.state !== 'fresh',
      sessionDiscovery: {
        ...status.sessionDiscovery,
        freshness: {
          state: freshnessState,
          lastUpdate: status.sessionDiscovery.lastSuccess,
          ageMs,
          staleAfterMs,
        },
      },
      seatCapture: {
        ...status.seatCapture,
        freshness: {
          state: seatFreshnessState,
          lastUpdate: status.seatCapture.lastCapture,
          ageMs: seatAgeMs,
          staleAfterMs,
        },
      },
      note: 'All sessions and active alerts are ephemeral and reset whenever this process restarts or redeploys.',
    })
  })

  app.get('/api/sessions', (context) => context.json({
    sessions: options.store.getSessions(),
    timezone: 'Australia/Melbourne',
  }))

  app.post('/api/ingest', async (context) => {
    if (!options.ingestToken) return context.json({ error: 'ingest_not_configured' }, 503)
    if (!tokenMatches(options.ingestToken, context.req.header('authorization'))) {
      return context.json({ error: 'unauthorized' }, 401)
    }

    let body: unknown
    try {
      body = await context.req.json()
    } catch {
      return context.json({ error: 'invalid_json' }, 400)
    }
    const parsed = schemas.ingestSchema.safeParse(body)
    if (!parsed.success) return context.json({ error: 'invalid_payload', issues: parsed.error.issues }, 400)

    const result = options.store.ingest(parsed.data.sessions, 'manual', parsed.data.eventId)
    const pendingDeliveries = options.store.getPendingDeliveries()
    if (pendingDeliveries.length > 0 && options.email.configured) {
      try {
        const sentIds = await options.email.sendAlerts(pendingDeliveries)
        options.store.markDeliveriesSent(sentIds)
        if (sentIds.length !== pendingDeliveries.length) {
          return context.json({ error: 'alert_delivery_failed', ingested: true }, 502)
        }
      } catch (error) {
        console.error(error)
        return context.json({ error: 'alert_delivery_failed', ingested: true }, 502)
      }
    }
    return context.json({
      accepted: true,
      duplicate: result.duplicate,
      transitions: result.transitions.length,
      alertBundles: result.deliveries.length,
    }, 202)
  })

  app.post('/api/subscriptions', async (context) => {
    if (!options.email.configured) {
      return context.json({
        error: 'email_not_configured',
        message: 'Alert email is not configured. Set RESEND_API_KEY and ALERT_FROM.',
      }, 503)
    }

    let clientIdentity = 'shared-untrusted-connection'
    if (options.trustProxy) {
      const realIp = context.req.header('x-real-ip')?.trim() ?? ''
      clientIdentity = isIP(realIp) !== 0 ? realIp : 'shared-invalid-proxy-address'
    } else {
      try {
        clientIdentity = getConnInfo(context).remote.address || clientIdentity
      } catch {}
    }
    const currentTime = now()
    const cutoff = currentTime - RATE_LIMIT_WINDOW_MS
    for (const [client, timestamps] of rateLimits) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff)
      if (active.length === 0) rateLimits.delete(client)
      else if (active.length !== timestamps.length) rateLimits.set(client, active)
    }
    const attempts = rateLimits.get(clientIdentity) ?? []
    if (attempts.length >= RATE_LIMIT_ATTEMPTS) return context.json({ error: 'rate_limited' }, 429)
    if (!rateLimits.has(clientIdentity) && rateLimits.size >= rateLimitMaxEntries) {
      return context.json({ error: 'rate_limited' }, 429)
    }
    attempts.push(currentTime)
    rateLimits.set(clientIdentity, attempts)

    let body: unknown
    try {
      const text = await readBoundedText(context.req.raw, SUBSCRIPTION_BODY_LIMIT, 'Subscription')
      body = JSON.parse(text)
    } catch (error) {
      if (error instanceof Error && error.message.includes('exceeded the body limit')) {
        return context.json({ error: 'body_too_large' }, 413)
      }
      return context.json({ error: 'invalid_json' }, 400)
    }
    const parsed = schemas.subscriptionSchema.safeParse(body)
    if (!parsed.success) return context.json({ error: 'invalid_payload', issues: parsed.error.issues }, 400)

    let created
    try {
      created = options.store.createSubscription(parsed.data.email, parsed.data.filters)
      if (created.confirmationIssued) await options.email.sendConfirmation(created)
    } catch (error) {
      if (error instanceof RecipientSubscriptionLimitError) {
        return context.json({ error: 'rate_limited' }, 429)
      }
      console.error(error)
      return context.json({ error: 'email_delivery_failed' }, 502)
    }
    return context.json({
      accepted: true,
      reused: created.reused,
      needsConfirmation: created.needsConfirmation,
      message: created.needsConfirmation
        ? created.confirmationIssued
          ? 'Check your inbox to confirm within 24 hours.'
          : 'A confirmation is already pending. Use the earlier email to activate this alert.'
        : 'This alert is already confirmed.',
    }, 202)
  })

  app.get('/confirm', (context) => {
    const token = context.req.query('token') ?? ''
    const action = `/confirm?token=${encodeURIComponent(token)}`
    return context.html(htmlPage(
      'Confirm alert',
      `<p>Confirm that you want to activate this House Lights email alert.</p><form method="post" action="${escapeHtml(action)}"><button type="submit">Confirm alert</button></form>`,
    ))
  })

  app.post('/confirm', (context) => {
    const confirmed = options.store.confirmSubscription(context.req.query('token') ?? '')
    return context.html(confirmed
      ? htmlPage('Alert confirmed', '<p>Your House Lights alert is active.</p>')
      : htmlPage('Link invalid or expired', '<p>This confirmation link is invalid or more than 24 hours old.</p>'),
    confirmed ? 200 : 400)
  })

  app.get('/manage', (context) => {
    const subscription = options.store.getManagedSubscription(context.req.query('token') ?? '')
    if (!subscription) return context.html(htmlPage('Link invalid', '<p>This manage link is invalid.</p>'), 404)
    const state = subscription.active ? 'Active' : 'Unsubscribed'
    return context.html(htmlPage(
      'Manage alert',
      `<p>${state} alert for <strong>${escapeHtml(subscription.email)}</strong>. It emails you when seats matching these filters become available:</p>${describeFilters(subscription.filters)}<p>Use the unsubscribe link in any alert email to stop it.</p>`,
    ))
  })

  app.get('/unsubscribe', (context) => {
    const token = context.req.query('token') ?? ''
    const action = `/unsubscribe?token=${encodeURIComponent(token)}`
    return context.html(htmlPage(
      'Confirm unsubscribe',
      `<p>Confirm that you want this House Lights alert to stop sending email.</p><form method="post" action="${escapeHtml(action)}"><button type="submit">Unsubscribe</button></form>`,
    ))
  })

  app.post('/unsubscribe', (context) => {
    const unsubscribed = options.store.unsubscribe(context.req.query('token') ?? '')
    return context.html(unsubscribed
      ? htmlPage('Unsubscribed', '<p>This House Lights alert will no longer send email.</p>')
      : htmlPage('Link invalid', '<p>This unsubscribe link is invalid.</p>'),
    unsubscribed ? 200 : 404)
  })

  if (options.cfClearance && options.filmUrl) {
    const cfRoutes = createCfClearanceRoutes({ manager: options.cfClearance, filmUrl: options.filmUrl })
    app.route('/api/cf-clearance', cfRoutes)
  }

  if (options.staticRoot) {
    app.all('/api', (context) => context.json({ error: 'not_found' }, 404))
    app.all('/api/*', (context) => context.json({ error: 'not_found' }, 404))
    app.all('/health/*', (context) => context.json({ error: 'not_found' }, 404))
    app.all('/confirm/*', (context) => context.json({ error: 'not_found' }, 404))
    app.all('/manage/*', (context) => context.json({ error: 'not_found' }, 404))
    app.all('/unsubscribe/*', (context) => context.json({ error: 'not_found' }, 404))
    app.use('/assets/*', serveStatic({ root: options.staticRoot }))
    app.get('*', serveStatic({ root: options.staticRoot }))
    app.get('*', serveStatic({
      root: options.staticRoot,
      rewriteRequestPath: () => '/index.html',
    }))
  }

  app.notFound((context) => context.json({ error: 'not_found' }, 404))
  app.onError((error, context) => {
    console.error(error)
    return context.json({ error: 'internal_error' }, 500)
  })

  return app
}
