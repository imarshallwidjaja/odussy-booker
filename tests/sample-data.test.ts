import { describe, expect, it } from 'vitest'

import { supportedFilmIds } from '../src/domain/types.js'
import { createSampleSessions } from '../src/server/sample-data.js'

describe('development sample dashboard', () => {
  it('keeps each known presentation ID in its own inventory', () => {
    const sessions = createSampleSessions([...supportedFilmIds])
    const laser = sessions.filter(({ filmId }) => filmId === 'HO00000546')
    const film = sessions.filter(({ filmId }) => filmId === 'HO00000547')

    expect(laser).toHaveLength(2)
    expect(laser.every(({ format, title }) =>
      format === 'laser' && title === 'THE ODYSSEY - 4K LASER PRESENTATION')).toBe(true)
    expect(film).toHaveLength(2)
    expect(film.every(({ format, title }) =>
      format === '70mm' && title === 'THE ODYSSEY - IMAX 70MM FILM PRESENTATION')).toBe(true)
  })

  it('links each sample session to its official presentation page', () => {
    const sessions = createSampleSessions([...supportedFilmIds])

    expect(sessions.every(({ bookingUrl, filmId }) =>
      bookingUrl === `https://web.imaxmelbourne.com.au/films/${filmId}`)).toBe(true)
  })
})
