import { BaseTransport } from '@neematajs/application'
import { TransportType } from '@neematajs/common'
import type { WsConnection } from './connection.ts'
import { WsTransportServer } from './server.ts'
import type { WsTransportOptions } from './types.ts'

export class WsTransport extends BaseTransport<
  TransportType.WS,
  WsConnection,
  WsTransportOptions
> {
  readonly type = TransportType.WS
  name = 'WebSockets'
  server!: WsTransportServer

  initialize() {
    this.server = new WsTransportServer(this)
  }

  async start() {
    await this.server.start()
  }

  async stop() {
    await this.server.stop()
  }
}
