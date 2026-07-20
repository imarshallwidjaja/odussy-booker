import { Hono } from 'hono'
import type { CfClearanceManager, CfClearanceState } from './cf-clearance.js'

interface CfClearanceRouteOptions {
  manager: CfClearanceManager
  filmUrl: string
}

export function createCfClearanceRoutes(options: CfClearanceRouteOptions): Hono {
  const app = new Hono()

  app.get('/', (context) => {
    const manager = options.manager
    return context.json({
      state: manager.state,
      detail: manager.detail,
    })
  })

  app.post('/acquire', async (context) => {
    const manager = options.manager
    if (manager.state === 'acquiring') {
      return context.json({ error: 'clearance_acquisition_already_in_progress' }, 409)
    }
    const promise = manager.acquire(options.filmUrl)
    context.header('X-Accel-Buffering', 'no')
    const result = await promise
    if (result) {
      return context.json({ state: 'valid', detail: 'Cloudflare clearance acquired successfully.' })
    }
    return context.json({ error: 'clearance_acquisition_failed', state: manager.state, detail: manager.detail }, 502)
  })

  return app
}
