import {
  BaseTransportConnection,
  type Registry,
  type Subscription,
} from '@neematajs/application'
import { MessageType, TransportType } from '@neematajs/common'
import type { WsTransportData, WsTransportSocket } from './types.ts'
import { sendPayload } from './utils.ts'

export class WsConnection extends BaseTransportConnection {
  readonly transport = TransportType.WS

  #websocket: WsTransportSocket

  constructor(
    protected readonly registry: Registry,
    services: string[],
    readonly data: WsTransportData,
    websocket: WsTransportSocket,
    id: string,
    subscriptions: Map<string, Subscription>,
  ) {
    super(registry, services, id, subscriptions)
    this.#websocket = websocket
  }

  protected sendEvent(service: string, event: string, payload: any) {
    return sendPayload(this.#websocket, MessageType.Event, [
      service,
      event,
      payload,
    ])
  }
}
