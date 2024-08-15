import type {
  Callback,
  Connection,
  Container,
  ServerDownStream,
  ServerUpStream,
  Subscription,
} from '@nmtjs/application'
import type {
  BaseServerDecoder,
  BaseServerEncoder,
  BaseServerFormat,
  DecodeRpcContext,
  EncodeRpcContext,
} from '@nmtjs/common'
import type { AppOptions, WebSocket } from 'uWebSockets.js'

export type WsUserData = {
  id: Connection['id']
  services: string[]
  backpressure: null | {
    promise: Promise<void>
    resolve: Callback
  }
  abortControllers: Map<number, AbortController>
  streams: {
    /**
     * Client to server streams
     */
    up: Map<number, ServerUpStream>
    /**
     * Server to client streams
     */
    down: Map<number, ServerDownStream>
    streamId: number
  }
  subscriptions: Map<string, Subscription>
  container: Container
  data: WsConnectionData
  format: {
    encoder: BaseServerEncoder
    decoder: BaseServerDecoder
  }
  context: {
    decode: Omit<DecodeRpcContext, 'addStream'> & {
      addStream: (
        signal: AbortSignal,
        ...args: Parameters<DecodeRpcContext['addStream']>
      ) => any
    }
    encode: EncodeRpcContext
  }
}

export type WsTransportSocket = WebSocket<WsUserData>

export type WsTransportOptions = {
  port?: number
  hostname?: string
  unix?: string
  tls?: AppOptions
  maxPayloadLength?: number
  maxStreamChunkLength?: number
  // cors?: ServerOptions['cors']
}

export type WsConnectionData = {
  headers: Map<string, string>
  query: URLSearchParams
  remoteAddress: string
  proxiedRemoteAddress: string
}
