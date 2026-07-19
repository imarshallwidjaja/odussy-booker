import { createHash } from 'node:crypto'

import { Resend } from 'resend'

import type { AlertDelivery, SubscriptionView } from '../domain/types.js'
import { escapeHtml } from './html.js'

export interface ConfirmationMessage {
  subscription: SubscriptionView
  confirmationToken: string
  manageToken: string
  unsubscribeToken: string
}

export interface EmailSender {
  configured: boolean
  sendConfirmation(message: ConfirmationMessage): Promise<void>
  sendAlerts(deliveries: AlertDelivery[], signal?: AbortSignal): Promise<string[]>
}

function idempotencySuffix(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

export class DisabledEmailSender implements EmailSender {
  readonly configured = false
  async sendConfirmation(): Promise<void> {}
  async sendAlerts(): Promise<string[]> { return [] }
}

export class ResendEmailSender implements EmailSender {
  readonly configured = true
  private readonly resend: Resend

  constructor(
    apiKey: string,
    private readonly from: string,
    private readonly baseUrl: string,
  ) {
    this.resend = new Resend(apiKey)
  }

  async sendConfirmation(message: ConfirmationMessage): Promise<void> {
    const { subscription } = message
    const confirmUrl = message.confirmationToken
      ? `${this.baseUrl}/confirm?token=${encodeURIComponent(message.confirmationToken)}`
      : null
    const manageUrl = `${this.baseUrl}/manage?token=${encodeURIComponent(message.manageToken)}`
    const unsubscribeUrl = `${this.baseUrl}/unsubscribe?token=${encodeURIComponent(message.unsubscribeToken)}`
    const action = confirmUrl
      ? `<p><a href="${confirmUrl}">Confirm House Lights alerts</a>. This link expires in 24 hours.</p>`
      : '<p>Your matching House Lights alert is already confirmed.</p>'
    const { data, error } = await this.resend.emails.send({
      from: this.from,
      to: [subscription.email],
      subject: confirmUrl ? 'Confirm your House Lights alert' : 'Your House Lights alert is active',
      headers: unsubscribeHeaders(unsubscribeUrl),
      html: `${action}<p><a href="${manageUrl}">Manage alert</a> · <a href="${unsubscribeUrl}">Unsubscribe</a></p>`,
    }, {
      idempotencyKey: `confirmation/${subscription.id}/${idempotencySuffix(message.confirmationToken || 'active')}`,
    })
    if (error || !data) throw new Error(`Resend confirmation failed: ${error?.message ?? 'missing response data'}`)
  }

  async sendAlerts(deliveries: AlertDelivery[], signal?: AbortSignal): Promise<string[]> {
    const sentIds: string[] = []
    for (const delivery of deliveries) {
      if (signal?.aborted) break
      const sessions = delivery.sessions.map((session) => {
        const seats = session.seats.map((seat) => `${seat.row}${seat.number}`).join(', ')
        return `<li><strong>${escapeHtml(session.title)}</strong> — ${escapeHtml(session.format.toUpperCase())}, ${escapeHtml(session.startsAt)}<br>Newly available: ${escapeHtml(seats)} (${session.availableCount} available in J-M)<br><a href="${escapeHtml(session.bookingUrl)}">Check official booking page</a></li>`
      }).join('')
      const manageUrl = `${this.baseUrl}/manage?token=${encodeURIComponent(delivery.manageToken)}`
      const unsubscribeUrl = `${this.baseUrl}/unsubscribe?token=${encodeURIComponent(delivery.unsubscribeToken)}`
      try {
        const requestOptions = { idempotencyKey: `alert/${delivery.id}`, signal }
        const { data, error } = await this.resend.emails.send({
          from: this.from,
          to: [delivery.email],
          subject: `${delivery.sessions.length} House Lights session${delivery.sessions.length === 1 ? '' : 's'} now match`,
          headers: unsubscribeHeaders(unsubscribeUrl),
          html: `<p>Seats matching your alert became available:</p><ul>${sessions}</ul><p>Availability can change quickly. Confirm on the official site.</p><p><a href="${manageUrl}">Manage alert</a> · <a href="${unsubscribeUrl}">Unsubscribe</a></p>`,
        }, requestOptions)
        if (error || !data) break
        sentIds.push(delivery.id)
      } catch {
        break
      }
    }
    return sentIds
  }
}
