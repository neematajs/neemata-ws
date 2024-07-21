import {
  type AnyProcedure,
  ApiError,
  type Container,
  EncodedStreamResponse,
  Procedure,
  Scope,
  type Service,
  Stream,
  StreamResponse,
  SubscriptionResponse,
} from '@neematajs/application'
import { Server } from '@neematajs/bun-http-server'
import {
  MessageType,
  StreamDataType,
  type StreamMetadata,
  decodeNumber,
  encodeNumber,
} from '@neematajs/common'
import { WsConnection } from './connection.ts'
import type { WsTransport } from './transport.ts'
import type { WsTransportSocket, WsUserData } from './types.ts'
import {
  InternalError,
  getFormat,
  send,
  sendPayload,
  toRecord,
} from './utils.ts'

export class WsTransportServer {
  protected server!: Server<WsUserData>

  constructor(protected readonly transport: WsTransport) {
    this.server = new Server<WsUserData>(
      {
        port: this.options.port,
        hostname: this.options.hostname,
        unix: this.options.unix,
        tls: this.options.tls,
        development: false,
      },
      {
        cors: this.options.cors ?? {
          origin: '*',
          methods: ['GET', 'POST', 'OPTIONS'],
          headers: ['Content-Type', 'Authorization'],
          credentials: 'true',
        },
      },
    )
      .get('/healthy', () => new Response('OK'))
      .upgrade('/api', (req, server) => {
        const container = this.transport.application.container.createScope(
          Scope.Connection,
        )
        const query = new URLSearchParams(req.url.split('?')[1] || '')
        const services = query.getAll('services')

        for (const serviceName of services) {
          const service = this.application.registry.services.get(serviceName)
          if (!service)
            throw new Response(`Service ${service} not found`, { status: 400 })
          if (this.transport.type in service.contract.transports === false)
            throw new Response(`Service ${service} not supported`, {
              status: 400,
            })
        }

        const data: WsUserData = {
          id: crypto.randomUUID(),
          format: getFormat(req, this.transport.application.format),
          container,
          streams: {
            streamId: 0,
            up: new Map(),
            down: new Map(),
          },
          calls: new Map(),
          subscriptions: new Map(),
          services,
          transportData: {
            query,
            transport: 'websockets' as const,
            headers: toRecord(req.headers),
            ip: server.requestIP(req),
          },
          backpressure: null,
        }
        return { data }
      })
      .ws({
        open: (ws: WsTransportSocket) => {
          ws.binaryType = 'arraybuffer'
          const connection = new WsConnection(
            this.application.registry,
            ws.data.services,
            ws.data.transportData,
            ws,
            ws.data.id,
            ws.data.subscriptions,
          )
          this.application.connections.add(connection)
        },
        message: (ws: WsTransportSocket, event) => {
          const buffer = event as unknown as ArrayBuffer
          const messageType = decodeNumber(buffer, 'Uint8')
          if (messageType in this === false) {
            ws.close(1011, 'Unknown message type')
          } else {
            this[messageType](ws, buffer.slice(Uint8Array.BYTES_PER_ELEMENT))
          }
        },
        drain: (ws: WsTransportSocket) => {
          ws.data.backpressure = null
          for (const stream of ws.data.streams.down.values()) {
            if (stream.isPaused()) stream.resume()
          }
        },
        close: (ws: WsTransportSocket) => {
          this.application.connections.remove(ws.data.id)
          const error = new Error('Connection closed')

          for (const ac of ws.data.calls.values()) ac.abort(error)
          ws.data.calls.clear()

          for (const _streams of [ws.data.streams.up, ws.data.streams.down]) {
            for (const stream of _streams.values()) stream.destroy(error)
            _streams.clear()
          }

          for (const subscription of ws.data.subscriptions.values()) {
            subscription.destroy()
          }

          ws.data.subscriptions.clear()

          this.handleContainerDisposal(ws.data.container)
        },
      })
  }

  get options() {
    return this.transport.options
  }

  get application() {
    return this.transport.application
  }

  get api() {
    return this.transport.application.api
  }

  get logger() {
    return this.transport.application.logger
  }

  async start() {
    const url = this.server.listen()
    this.logger.info('Server started on %s', url)
  }

  async stop() {
    this.server.close()
  }

  protected async logError(
    cause: Error,
    message = 'Unknown error while processing request',
  ) {
    this.logger.error(new Error(message, { cause }))
  }

  protected handleContainerDisposal(container: Container) {
    container.dispose()
  }

  protected async handleRPC(options: {
    container: Container
    service: Service
    procedure: AnyProcedure
    payload: any
    connection: WsConnection
  }) {
    return await this.api.call({
      ...options,
      transport: this.transport,
    })
  }

  protected async [MessageType.Rpc](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    // TODO: refactor this mess
    const connection = <WsConnection>(
      this.application.connections.get(ws.data.id)
    )
    if (!connection) return void ws.close(1011, 'Unknown connection')

    const addStream = (id: number, metadata: StreamMetadata) => {
      const read = (size) => {
        const buffers = [encodeNumber(id, 'Uint32')]
        if (size) buffers.push(encodeNumber(size, 'Uint32'))
        send(ws, MessageType.UpStreamPull, ...buffers)
      }
      const stream = new Stream(
        id,
        metadata,
        read,
        this.transport.options.maxStreamChunkLength,
      )
      ws.data.streams.up.set(id, stream)
      stream.on('error', (cause) =>
        this.logger.trace(new Error('Stream error', { cause })),
      )
    }

    const getStream = (id: number) => ws.data.streams.up.get(id)!

    const data = ws.data.format.decoder.decodeRpc(buffer, {
      addStream,
      getStream,
    })

    const ac = new AbortController()
    ws.data.calls.set(data.callId, ac)

    const container = ws.data.container.createScope(Scope.Call)
    container.provide(Procedure.signal, ac.signal)

    try {
      const { service, procedure } = this.api.find(
        data.service,
        data.procedure,
        this.transport,
      )

      const response = await this.handleRPC({
        connection,
        service,
        procedure,
        container,
        payload: data.payload,
      })

      if (response instanceof StreamResponse) {
        const streamDataType =
          response instanceof EncodedStreamResponse
            ? StreamDataType.Encoded
            : StreamDataType.Binary

        const streamId = ++ws.data.streams.streamId
        sendPayload(ws, MessageType.RpcStream, [
          data.callId,
          streamDataType,
          streamId,
          response.payload,
        ])
        ws.data.streams.down.set(streamId, response)
        response.on('data', (chunk) => {
          chunk =
            streamDataType === StreamDataType.Encoded
              ? ws.data.format.encoder.encode(chunk)
              : chunk
          send(
            ws,
            MessageType.DownStreamPush,
            encodeNumber(streamId, 'Uint32'),
            chunk,
          )
        })
        response.once('end', () => {
          send(ws, MessageType.DownStreamEnd, encodeNumber(streamId, 'Uint32'))
        })
        response.once('error', () => {
          send(
            ws,
            MessageType.DownStreamAbort,
            encodeNumber(streamId, 'Uint32'),
          )
        })
      } else if (response instanceof SubscriptionResponse) {
        sendPayload(ws, MessageType.RpcSubscription, [
          data.callId,
          response.subscription.key,
          response.payload,
        ])
        response.subscription.on('event', (event, payload) => {
          sendPayload(ws, MessageType.ServerSubscriptionEvent, [
            response.subscription.key,
            event,
            payload,
          ])
        })
        response.subscription.once('end', () => {
          sendPayload(ws, MessageType.ServerUnsubscribe, [
            response.subscription.key,
          ])
        })
      } else {
        sendPayload(ws, MessageType.Rpc, [data.callId, response, null])
      }
    } catch (error) {
      if (error instanceof ApiError) {
        sendPayload(ws, MessageType.Rpc, [data.callId, null, error])
      } else {
        this.logger.error(new Error('Unexpected error', { cause: error }))
        sendPayload(ws, MessageType.Rpc, [data.callId, null, InternalError()])
      }
    } finally {
      ws.data.calls.delete(data.callId)
      this.handleContainerDisposal(container)
    }
  }

  async [MessageType.UpStreamPush](ws: WsTransportSocket, buffer: ArrayBuffer) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = ws.data.streams.up.get(id)
    if (!stream) return ws.close(1011, 'Unknown stream')
    stream.push(Buffer.from(buffer.slice(Uint32Array.BYTES_PER_ELEMENT)))
  }

  async [MessageType.UpStreamEnd](ws: WsTransportSocket, buffer: ArrayBuffer) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = ws.data.streams.up.get(id)
    if (!stream) return ws.close(1011, 'Unknown stream')
    stream.once('end', () =>
      send(ws, MessageType.UpStreamEnd, encodeNumber(id, 'Uint32')),
    )
    stream.push(null)
    ws.data.streams.up.delete(id)
  }

  async [MessageType.UpStreamAbort](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = ws.data.streams.up.get(id)
    if (!stream) return ws.close(1011, 'Unknown stream')
    stream.destroy(new Error('Aborted by client'))
  }

  async [MessageType.DownStreamPull](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = ws.data.streams.down.get(id)
    if (!stream) return ws.close(1011, 'Unknown stream')
    stream.resume()
  }

  async [MessageType.DownStreamEnd](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = ws.data.streams.down.get(id)
    if (!stream) return ws.close(1011, 'Unknown stream')
    ws.data.streams.down.delete(id)
  }

  async [MessageType.DownStreamAbort](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = ws.data.streams.down.get(id)
    if (!stream) return ws.close(1011, 'Unknown stream')
    stream.destroy(new Error('Aborted by client'))
  }

  async [MessageType.ClientUnsubscribe](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const [key] = ws.data.format.decoder.decode(buffer)
    const subscription = ws.data.subscriptions.get(key)
    if (!subscription) return void ws.close()
    subscription.destroy()
  }
}
