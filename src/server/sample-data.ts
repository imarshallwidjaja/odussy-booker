import type { SeatSnapshot, SessionSnapshot } from '../domain/types.js'

const presentations: Record<string, { format: SessionSnapshot['format']; title: string }> = {
  HO00000546: {
    format: 'laser',
    title: 'THE ODYSSEY - 4K LASER PRESENTATION',
  },
  HO00000547: {
    format: '70mm',
    title: 'THE ODYSSEY - IMAX 70MM FILM PRESENTATION',
  },
}

function seats(offset: number): SeatSnapshot[] {
  return (['J', 'K', 'L', 'M'] as const).flatMap((row, rowIndex) =>
    Array.from({ length: 14 }, (_, index) => ({
      row,
      number: index + 1,
      status: (index + rowIndex + offset) % 7 === 0
        ? 'held' as const
        : (index + rowIndex + offset) % 3 === 0
          ? 'available' as const
          : 'sold' as const,
    })),
  )
}

export function createSampleSessions(filmIds: string[]): SessionSnapshot[] {
  const now = Date.now()
  return filmIds.flatMap((filmId, filmIndex) => {
    const presentation = presentations[filmId]
    if (!presentation) throw new Error(`No sample presentation is defined for film ID ${filmId}`)
    const bookingUrl = `https://web.imaxmelbourne.com.au/films/${filmId}`
    return [{
      id: `sample-${filmIndex}-available`,
      filmId,
      title: presentation.title,
      startsAt: new Date(now + (filmIndex + 1) * 24 * 60 * 60 * 1000).toISOString(),
      format: presentation.format,
      bookingUrl,
      listing: { status: 'available', observedAt: new Date(now).toISOString(), sourceId: null },
      seatData: { state: 'captured', capturedAt: new Date(now).toISOString() },
      seats: seats(filmIndex),
    },
    {
      id: `sample-${filmIndex}-full`,
      filmId,
      title: presentation.title,
      startsAt: new Date(now + (filmIndex + 2) * 24 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000).toISOString(),
      format: presentation.format,
      bookingUrl,
      listing: { status: 'available', observedAt: new Date(now).toISOString(), sourceId: null },
      seatData: { state: 'captured', capturedAt: new Date(now).toISOString() },
      seats: seats(filmIndex + 2).map((seat) => ({ ...seat, status: 'sold' })),
    }]
  })
}
