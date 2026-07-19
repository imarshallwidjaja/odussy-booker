import { seatRows, type SessionSnapshot } from '../../domain/types.js'
import { sessionCardModel, sessionDateLabel, sessionTimeLabel } from '../model.js'

interface SessionCardProps {
  session: SessionSnapshot
  freshnessText: string
  sampleData: boolean
  selected: boolean
  onSelect: () => void
}

export function SessionCard({ session, freshnessText, sampleData, selected, onSelect }: SessionCardProps) {
  const model = sessionCardModel(session)
  const captureLabel = session.seatData.state === 'last_known'
    ? 'J-M LAST-KNOWN'
    : session.seatData.state === 'captured'
    ? session.seatData.lastFailure
      ? 'J-M LAST-KNOWN'
      : session.seatData.source === 'manual'
        ? 'J-M MANUAL CAPTURE'
        : 'J-M FRESH'
    : session.seatData.lastFailure?.kind === 'blocked'
      ? 'J-M BLOCKED'
      : session.seatData.lastFailure
        ? 'J-M UNAVAILABLE'
        : 'J-M PENDING'
  const countsDescription = seatRows
    .map((row) => `row ${row}: ${model.rowCounts[row] ?? 'not captured'}`)
    .join(', ')
  return (
    <article
      className={`session-card${model.full ? ' session-full' : ''}${selected ? ' session-selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
    >
      <div className="session-top">
        <div className="session-when">
          <p className="session-date">{sessionDateLabel(session.startsAt)}</p>
          <p className="session-time">
            <time dateTime={session.startsAt}>{sessionTimeLabel(session.startsAt)}</time>
          </p>
        </div>
        <span className={`format-badge format-${session.format}`}>
          {session.format === 'laser' ? 'LASER' : '70MM'}
        </span>
      </div>
      <h3 className="session-title">{session.title}</h3>
      <div
        className="row-counts"
        role="group"
        aria-label={model.captured
          ? `${session.seatData.state === 'last_known' ? 'Last-known available seats' : 'Available seats'} — ${countsDescription}. ${model.total} total across rows J to M.`
          : 'Exact availability for rows J to M has not been captured.'}
      >
        {seatRows.map((row) => (
          <span className="row-count" key={row} aria-hidden="true">
            <b>{row}</b> {model.rowCounts[row] ?? '–'}
          </span>
        ))}
        <strong className="row-total" aria-hidden="true">{model.total ?? '–'}</strong>
      </div>
      <p className={`seat-wording${model.full ? ' seat-wording-full' : model.scarce ? ' seat-wording-scarce' : ''}`}>
        {model.wording}
      </p>
      <p className="session-status">{captureLabel}</p>
      {session.listing.status === 'soldout' ? <p className="session-status">Session sold out</p> : null}
      <p className={`card-freshness${sampleData ? ' card-freshness-sample' : ''}`}>
        {sampleData ? 'SAMPLE DATA · ' : ''}{freshnessText}
      </p>
      <div className="card-actions">
        <button type="button" className="ghost-button" onClick={onSelect}>
          Inspect Rows J-M
        </button>
        {session.bookingUrl
          ? (
            <a className="booking-link" href={session.bookingUrl} target="_blank" rel="noreferrer">
              Official booking ↗
            </a>
          )
          : null}
      </div>
    </article>
  )
}
