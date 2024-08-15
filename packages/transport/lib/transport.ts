import { Hook, createPlugin } from '@nmtjs/application'
import { WsTransportServer } from './server.ts'
import type { WsTransportOptions } from './types.ts'

export const WsTransport = createPlugin<WsTransportOptions>(
  'WsTransport',
  (app, options) => {
    const server = new WsTransportServer(app, options)
    app.hooks.add(Hook.OnStartup, async () => {
      await server.start()
    })
    app.hooks.add(Hook.OnShutdown, async () => {
      await server.stop()
    })
  },
)
