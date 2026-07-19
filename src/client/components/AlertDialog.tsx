import { useEffect, useRef, useState, type RefObject } from 'react'

import { alertFiltersFromDashboard, summarizeFilters, type DashboardFilters } from '../model.js'

type SubmitPhase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'confirmed-sent'; message: string }
  | { kind: 'duplicate'; message: string }
  | { kind: 'error'; message: string }

interface AlertDialogProps {
  open: boolean
  onClose: () => void
  filters: DashboardFilters
  configuredFilmIds: string[]
  filmConfigurationLoading?: boolean
  emailConfigured: boolean
  returnFocusRef?: RefObject<HTMLButtonElement | null>
}

export function AlertDialog({
  open,
  onClose,
  filters,
  configuredFilmIds,
  filmConfigurationLoading = false,
  emailConfigured,
  returnFocusRef,
}: AlertDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const wasOpenRef = useRef(false)
  const [email, setEmail] = useState('')
  const [minimumSeats, setMinimumSeats] = useState(2)
  const [adjacentOnly, setAdjacentOnly] = useState(true)
  const [phase, setPhase] = useState<SubmitPhase>({ kind: 'idle' })

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      wasOpenRef.current = true
      if (!dialog.open) dialog.showModal()
      setPhase({ kind: 'idle' })
    } else if (wasOpenRef.current) {
      if (dialog.open) dialog.close()
      wasOpenRef.current = false
      returnFocusRef?.current?.focus()
    }
  }, [open, returnFocusRef])

  const inherited = summarizeFilters(filters)
  const canSubmit = !filmConfigurationLoading
    && configuredFilmIds.length > 0
    && filters.days.length > 0
    && emailConfigured
    && phase.kind !== 'submitting'

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setPhase({ kind: 'submitting' })
    let response: Response
    try {
      response = await fetch('/api/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          filters: alertFiltersFromDashboard(filters, configuredFilmIds, { minimumSeats, adjacentOnly }),
        }),
      })
    } catch {
      setPhase({ kind: 'error', message: 'Network error. Check your connection and try again.' })
      return
    }
    let body: { error?: string; message?: string; reused?: boolean; needsConfirmation?: boolean } = {}
    try {
      body = await response.json()
    } catch {
      setPhase({ kind: 'error', message: `Unexpected response (${response.status}).` })
      return
    }
    if (response.ok) {
      if (body.needsConfirmation) {
        setPhase({
          kind: 'confirmed-sent',
          message: `Confirmation link sent to ${email.trim()}. Confirm within 24 hours to activate this alert.`,
        })
      } else {
        setPhase({
          kind: 'duplicate',
          message: body.message ?? 'This exact alert is already active and confirmed.',
        })
      }
      return
    }
    if (body.error === 'email_not_configured') {
      setPhase({
        kind: 'error',
        message: 'Alert email is not configured on this deployment, so alerts cannot be delivered yet.',
      })
    } else if (body.error === 'rate_limited') {
      setPhase({ kind: 'error', message: 'Too many attempts. Wait an hour and try again.' })
    } else if (body.error === 'invalid_payload') {
      setPhase({ kind: 'error', message: 'The current filters cannot make a valid alert. Adjust them and retry.' })
    } else {
      setPhase({ kind: 'error', message: body.message ?? `Could not create alert (${response.status}).` })
    }
  }

  return (
    <dialog ref={dialogRef} className="alert-dialog" onClose={onClose} aria-labelledby="alert-heading">
      <form onSubmit={submit}>
        <div className="dialog-head">
          <div>
            <p className="eyebrow">DOUBLE OPT-IN EMAIL</p>
            <h2 id="alert-heading">Create alert</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>Close</button>
        </div>

        <p className="dialog-copy">
          This alert inherits the dashboard filters you have active right now.
        </p>
        <ul className="active-filters" aria-label="Inherited filters">
          {(inherited.length > 0 ? inherited : ['All presentations', 'Every day', 'All day']).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        {!emailConfigured
          ? <p className="dialog-warning" role="note">Alert email is not configured on this deployment. Submissions will be accepted only after email is configured.</p>
          : null}
        {filters.days.length === 0
          ? <p className="dialog-warning" role="note">No days are selected. Select at least one day to create an alert.</p>
          : null}
        {filmConfigurationLoading
          ? <p className="dialog-warning" role="note">Film configuration is still loading. Alert submission will be enabled when it is available.</p>
          : configuredFilmIds.length === 0
            ? <p className="dialog-warning" role="note">No supported films are configured for alerts on this deployment.</p>
            : null}

        <label className="field">
          Email
          <input
            id="alert-email"
            name="email"
            required
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="field">
          Minimum available seats
          <select
            id="minimum-seats"
            name="minimumSeats"
            value={minimumSeats}
            onChange={(event) => setMinimumSeats(Number(event.target.value))}
          >
            {[1, 2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <label className="check-field">
          <input
            name="adjacentOnly"
            type="checkbox"
            checked={adjacentOnly}
            onChange={(event) => setAdjacentOnly(event.target.checked)}
          />
          Seats must be adjacent in one row
        </label>

        <button className="solid-button" type="submit" disabled={!canSubmit}>
          {phase.kind === 'submitting' ? 'Sending…' : 'Email me a confirmation link'}
        </button>

        <p
          className={`submit-state${phase.kind === 'error' ? ' submit-error' : phase.kind === 'confirmed-sent' || phase.kind === 'duplicate' ? ' submit-ok' : ''}`}
          aria-live="polite"
        >
          {phase.kind === 'idle' || phase.kind === 'submitting' ? '' : phase.message}
        </p>
      </form>
    </dialog>
  )
}
