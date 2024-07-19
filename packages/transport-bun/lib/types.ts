import type {
  BaseTransportConnection,
  Callback,
  Container,
  Stream,
  Subscription,
} from '@neematajs/application'
import type { ServerOptions } from '@neematajs/bun-http-server'
import type { BaseServerFormat } from '@neematajs/common'
import type { ServerWebSocket, SocketAddress, TLSOptions } from 'bun'
import type { Readable } from 'node:stream'

export type WsUserData = {
  id: BaseTransportConnection['id']
  services: string[]
  backpressure: null | {
    promise: Promise<void>
    resolve: Callback
  }
  calls: Map<number, AbortController>
  streams: {
    /**
     * Client to server streams
     */
    up: Map<number, Stream>
    /**
     * Server to client streams
     */
    down: Map<number, Readable>
    streamId: number
  }
  subscriptions: Map<string, Subscription>
  container: Container
  transportData: WsTransportData
  format: {
    encoder: BaseServerFormat
    decoder: BaseServerFormat
  }
}

export type WsTransportSocket = ServerWebSocket<WsUserData>

export type WsTransportOptions = {
  port?: number
  hostname?: string
  unix?: string
  tls?: TLSOptions
  maxPayloadLength?: number
  maxStreamChunkLength?: number
  cors?: ServerOptions['cors']
}

export type WsTransportData = {
  transport: 'websockets'
  ip: SocketAddress | null
  headers: Record<string, string>
  query: URLSearchParams
}
