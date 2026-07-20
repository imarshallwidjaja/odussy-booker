import { Hono } from 'hono'
import type { CfClearanceManager } from './cf-clearance.js'

interface CfClearanceRouteOptions { manager: CfClearanceManager }

export function createCfClearanceRoutes(options: CfClearanceRouteOptions): Hono {
  const app = new Hono()

  app.get('/', (context) => {
    const manager = options.manager
    context.header('Cache-Control', 'no-store')
    return context.json({
      state: manager.state,
      detail: manager.detail,
    })
  })

  return app
}
