import { seatRows, type SeatSnapshot, type SessionSnapshot } from '../../domain/types.js'

function seatStatusLabel(status: SeatSnapshot['status']): string {
  return status === 'held' ? 'held or unknown' : status
}

export function SeatMap({ session }: { session: SessionSnapshot }) {
  if (session.seatData.state === 'unavailable') {
    return <div className="seat-map-unavailable" role="status">J-M seats not captured</div>
  }
  return (
    <div className="seat-map-viewport">
      <div className="seat-map">
        <div className="screen-bar" aria-hidden="true"><span>SCREEN</span></div>
        <table className="seat-grid">
          <caption className="visually-hidden">Rows J to M seat availability for {session.title}</caption>
          <tbody>
            {seatRows.map((row) => {
              const rowSeats = session.seats
                .filter((seat) => seat.row === row)
                .toSorted((a, b) => a.number - b.number)
              return (
                <tr className="seat-row" key={row}>
                  <th className="row-label" scope="row">{row}</th>
                {rowSeats.length === 0
                    ? <td className="row-empty" colSpan={14}>No data for row {row}</td>
                  : rowSeats.map((seat) => (
                    <td
                      className="seat-cell"
                      aria-label={`Seat ${seat.number}, ${seatStatusLabel(seat.status)}`}
                      key={`${row}-${seat.number}`}
                    >
                      <span className={`seat seat-${seat.status}`} aria-hidden="true">
                        {seat.status === 'held' ? '?' : seat.number}
                      </span>
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="seat-legend" role="group" aria-label="Seat status legend">
          <span><i className="seat seat-available" aria-hidden="true" /> Available</span>
          <span><i className="seat seat-sold" aria-hidden="true" /> Sold</span>
          <span><i className="seat seat-held" aria-hidden="true">?</i> Held / unknown</span>
        </div>
      </div>
    </div>
  )
}
