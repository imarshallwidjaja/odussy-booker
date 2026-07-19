import type { SessionSnapshot } from '../../domain/types.js'
import { sessionCardModel, sessionDateLabel, sessionTimeLabel } from '../model.js'
import { SeatMap } from './SeatMap.js'

interface SessionDetailProps {
  session: SessionSnapshot
  onClose?: () => void
}

export function SessionDetail({ session, onClose }: SessionDetailProps) {
  const model = sessionCardModel(session)
  return (
    <div className="detail-inner">
      {onClose
        ? <button type="button" className="ghost-button detail-close" onClick={onClose}>Close</button>
        : null}
      <p className="eyebrow">ROWS J-M · READ-ONLY SEAT MAP</p>
      <h2 className="detail-time">
        <time dateTime={session.startsAt}>{sessionTimeLabel(session.startsAt)}</time>
      </h2>
      <p className="detail-date">{sessionDateLabel(session.startsAt)} · Melbourne</p>
      <p className="detail-title">
        {session.title}
        <span className={`format-badge format-${session.format}`}>
          {session.format === 'laser' ? 'LASER' : '70MM'}
        </span>
      </p>
      {model.captured
        ? (
          <p className={`seat-wording${model.full ? ' seat-wording-full' : model.scarce ? ' seat-wording-scarce' : ''}`}>
            {model.wording}
          </p>
        )
        : null}
      {session.listing.status === 'soldout' ? <p className="session-status">Session sold out</p> : null}
      <SeatMap session={session} />
      {session.bookingUrl
        ? (
          <a className="solid-link" href={session.bookingUrl} target="_blank" rel="noreferrer">
            Confirm on the official booking site ↗
          </a>
        )
        : null}
    </div>
  )
}
