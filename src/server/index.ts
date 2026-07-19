import { fileURLToPath } from 'node:url'

import { serve } from '@hono/node-server'

import { MemoryStore } from '../domain/store.js'
import { supportedFilmIds } from '../domain/types.js'
import { createApp } from './app.js'
import { freshnessThresholdMs, resolvePublicBaseUrl, resolveTrustProxy } from './config.js'
import { DisabledEmailSender, ResendEmailSender, type EmailSender } from './email.js'
import { ImaxMelbourneListingProvider } from './provider.js'
import { LumosPreviewSeatProvider } from './lumos-provider.js'
import { createSampleSessions } from './sample-data.js'
import { PollScheduler } from './scheduler.js'

const filmIds = [...new Set(
  (process.env.FILM_IDS?.split(',') ?? supportedFilmIds).map((value) => value.trim()).filter(Boolean),
)]
if (filmIds.length === 0) throw new Error('FILM_IDS must contain at least one film ID')

const port = Number(process.env.PORT ?? 3000)
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port')
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 15 * 60 * 1000)
const pollCooldownMs = Number(process.env.POLL_COOLDOWN_MS ?? 15 * 60 * 1000)
const previewCooldownMs = Number(process.env.LUMOS_PREVIEW_COOLDOWN_MS ?? 15 * 60 * 1000)
const providerTimeoutMs = Number(process.env.PROVIDER_TIMEOUT_MS ?? 30_000)
const previewTimeoutMs = Number(process.env.LUMOS_PREVIEW_TIMEOUT_MS ?? 30_000)
const deliveryTimeoutMs = Number(process.env.EMAIL_DELIVERY_TIMEOUT_MS ?? 30_000)
const deliveryBatchSize = Number(process.env.OUTBOX_BATCH_SIZE ?? 25)
const confirmationCooldownMs = Number(process.env.CONFIRMATION_COOLDOWN_MS ?? 15 * 60 * 1000)
const pendingSubscriptionLimitPerRecipient = Number(process.env.PENDING_SUBSCRIPTIONS_PER_EMAIL ?? 3)
const resendApiKey = process.env.RESEND_API_KEY
const alertFrom = process.env.ALERT_FROM
const emailEnabled = Boolean(resendApiKey && alertFrom)
const baseUrl = resolvePublicBaseUrl(process.env, port, emailEnabled)
const staleAfterMs = freshnessThresholdMs({
  pollIntervalMs: Math.max(pollIntervalMs, pollCooldownMs),
  previewIntervalMs: Math.max(pollIntervalMs, previewCooldownMs),
  providerTimeoutMs,
  previewTimeoutMs,
})
const sampleData = process.env.DEV_SAMPLE_DATA === 'true' && process.env.NODE_ENV !== 'production'
const store = new MemoryStore({
  filmIds,
  sampleData,
  confirmationCooldownMs,
  pendingSubscriptionLimitPerRecipient,
})
const lumosAllowedHosts = [
  'imaxmelbourne.com.au',
  'vista.co',
  ...(process.env.LUMOS_ALLOWED_HOSTS?.split(',') ?? []),
].map((value) => value.trim()).filter(Boolean)

let email: EmailSender = new DisabledEmailSender()
if (resendApiKey && alertFrom) {
  email = new ResendEmailSender(resendApiKey, alertFrom, baseUrl)
} else if (resendApiKey || alertFrom) {
  console.warn('Email disabled: both RESEND_API_KEY and ALERT_FROM are required.')
}

if (sampleData) {
  store.ingest(createSampleSessions(filmIds), 'sample', 'development-sample-baseline')
  console.warn('DEV_SAMPLE_DATA is enabled. The dashboard is showing SAMPLE DATA, not live availability.')
}

const app = createApp({
  store,
  email,
  ingestToken: process.env.INGEST_TOKEN,
  staticRoot: fileURLToPath(new URL('../../client', import.meta.url)),
  staleAfterMs,
  trustProxy: resolveTrustProxy(process.env),
})
const scheduler = new PollScheduler({
  provider: new ImaxMelbourneListingProvider({ filmIds }),
  seatProvider: new LumosPreviewSeatProvider({
    filmUrl: process.env.LUMOS_FILM_URL ?? 'https://web.imaxmelbourne.com.au/films/HO00000547',
    allowedHosts: [...new Set(lumosAllowedHosts)],
    concurrency: Number(process.env.LUMOS_PREVIEW_CONCURRENCY ?? 2),
    sessionBudget: Number(process.env.LUMOS_PREVIEW_SESSION_BUDGET ?? 12),
  }),
  store,
  cooldownMs: pollCooldownMs,
  previewCooldownMs,
  providerTimeoutMs,
  previewTimeoutMs,
  deliveryTimeoutMs,
  deliveryBatchSize,
  onDeliveries: email.configured ? (deliveries, signal) => email.sendAlerts(deliveries, signal) : undefined,
})
if (!sampleData) scheduler.start(pollIntervalMs)

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`House Lights listening on http://0.0.0.0:${info.port}`)
})

function shutdown(): void {
  scheduler.stop()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
