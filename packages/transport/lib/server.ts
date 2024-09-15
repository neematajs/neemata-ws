import { randomUUID } from 'node:crypto'
import {
  type AnyProcedure,
  ApiError,
  type ApplicationContext,
  type Connection,
  type Container,
  Scope,
  ServerDownStream,
  ServerUpStream,
  type Service,
  SubscriptionResponse,
  onAbort,
} from '@nmtjs/application'
import {
  type ApiBlobMetadata,
  type EncodeRpcContext,
  MessageType,
  TransportType,
  decodeNumber,
  encodeNumber,
} from '@nmtjs/common'
import {
  App,
  type HttpRequest,
  type HttpResponse,
  SSLApp,
  type TemplatedApp,
} from 'uWebSockets.js'

import { connectionData } from './injectables.ts'
import type {
  WsTransportOptions,
  WsTransportSocket,
  WsUserData,
} from './types.ts'
import {
  InternalError,
  getFormat,
  getRequestData,
  send,
  sendMessage,
  sendRpcMessage,
} from './utils.ts'

export class WsTransportServer {
  protected server!: TemplatedApp
  protected readonly transportType = TransportType.WS

  constructor(
    protected readonly application: ApplicationContext,
    protected readonly options: WsTransportOptions,
  ) {
    this.server = this.options.tls ? SSLApp(options.tls!) : App()

    this.server
      .options('/*', (res, req) => {
        this.applyCors(res, req)
        res.writeStatus('200 OK')
        res.endWithoutBody()
      })
      .get('/healthy', (res, req) => {
        this.applyCors(res, req)
        res.writeHeader('Content-Type', 'text/plain')
        res.end('OK')
      })
      .ws<WsUserData>('/api', {
        sendPingsAutomatically: true,
        maxPayloadLength: this.options.maxPayloadLength,
        upgrade: (res, req, context) => {
          this.applyCors(res, req)
          const requestData = getRequestData(req)
          const container = this.application.container.createScope(
            Scope.Connection,
          )
          const services = requestData.query.getAll('services')

          for (const serviceName of services) {
            const service = this.application.registry.services.get(serviceName)
            if (!service)
              return void res
                .writeStatus('400 Bad Request')
                .end(`Service ${service} not found`)
            if (this.transportType in service.contract.transports === false)
              return void res
                .writeStatus('400 Bad Request')
                .end(`Service ${service} not supported`)
          }

          const data: WsUserData = {
            id: randomUUID(),
            format: getFormat(requestData, this.application.format),
            container,
            streams: {
              up: new Map(),
              down: new Map(),
              streamId: 0,
            },
            abortControllers: new Map(),
            subscriptions: new Map(),
            services,
            data: {
              query: requestData.query,
              headers: requestData.headers,
              proxiedRemoteAddress: Buffer.from(
                res.getProxiedRemoteAddressAsText(),
              ).toString(),
              remoteAddress: Buffer.from(
                res.getRemoteAddressAsText(),
              ).toString(),
            },
            backpressure: null,
            context: {} as any,
          }

          res.upgrade(
            data,
            req.getHeader('sec-websocket-key'),
            req.getHeader('sec-websocket-protocol'),
            req.getHeader('sec-websocket-extensions'),
            context,
          )
        },
        open: (ws: WsTransportSocket) => {
          const data = ws.getUserData()
          this.logger.debug('Connection %s opened', data.id)
          data.context.decode = this.createDecodeRpcContext(ws)
          data.context.encode = this.createEncodeRpcContext(ws)
          data.container.provide(connectionData, data.data)
          this.application.connections.add({
            id: data.id,
            services: data.services,
            type: this.transportType,
            subscriptions: data.subscriptions,
            sendEvent: (service, event, payload) =>
              sendMessage(ws, MessageType.Event, [service, event, payload]),
          })
        },
        message: async (ws: WsTransportSocket, event) => {
          const buffer = event as unknown as ArrayBuffer
          const messageType = decodeNumber(buffer, 'Uint8')
          if (messageType in this === false) {
            ws.end(1011, 'Unknown message type')
          } else {
            try {
              await this[messageType](
                ws,
                buffer.slice(Uint8Array.BYTES_PER_ELEMENT),
              )
            } catch (error: any) {
              this.logError(error, 'Error while processing message')
            }
          }
        },
        drain: (ws: WsTransportSocket) => {
          const data = ws.getUserData()
          data.backpressure?.resolve()
          data.backpressure = null
        },
        close: (ws: WsTransportSocket, code, message) => {
          const data = ws.getUserData()

          this.logger.debug(
            'Connection %s closed with code %s: ',
            data.id,
            code,
            Buffer.from(message).toString(),
          )

          this.application.connections.remove(data.id)
          const error = new Error('Connection closed')

          for (const ac of data.abortControllers.values()) {
            ac.abort(error)
          }
          data.abortControllers.clear()

          for (const stream of data.streams.down.values()) {
            stream.destroy(error)
          }
          data.streams.down.clear()

          for (const stream of data.streams.up.values()) {
            stream.destroy(error)
          }
          data.streams.up.clear()

          for (const subscription of data.subscriptions.values()) {
            subscription.destroy()
          }
          data.subscriptions.clear()

          this.handleContainerDisposal(data.container)
        },
      })
  }

  async start() {
    return new Promise<void>((resolve, reject) => {
      const hostname = this.options.hostname ?? '127.0.0.1'
      this.server.listen(hostname, this.options.port!, (socket) => {
        if (socket) {
          this.logger.info(
            'Server started on %s:%s',
            hostname,
            this.options.port!,
          )
          resolve()
        } else {
          reject(new Error('Failed to start server'))
        }
      })
    })
  }

  async stop() {
    this.server.close()
  }

  protected get api() {
    return this.application.api
  }

  protected get logger() {
    return this.application.logger
  }

  protected async logError(
    cause: Error,
    message = 'Unknown error while processing request',
  ) {
    this.logger.error(new Error(message, { cause }))
  }

  protected applyCors(res: HttpResponse, req: HttpRequest) {
    // TODO: this should be configurable
    const origin = req.getHeader('origin')
    if (!origin) return
    res.writeHeader('Access-Control-Allow-Origin', origin)
    res.writeHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.writeHeader('Access-Control-Allow-Methods', 'GET, POST')
    res.writeHeader('Access-Control-Allow-Credentials', 'true')
  }

  protected handleContainerDisposal(container: Container) {
    container.dispose()
  }

  protected async handleRPC(options: {
    connection: Connection
    service: Service
    procedure: AnyProcedure
    container: Container
    signal: AbortSignal
    payload: any
  }) {
    return await this.api.call({
      ...options,
      transport: this.transportType,
    })
  }

  protected createEncodeRpcContext(ws: WsTransportSocket): EncodeRpcContext {
    const data = ws.getUserData()
    return {
      addStream: (blob) => {
        const id = ++data.streams.streamId
        const downstream = new ServerDownStream(id, blob)
        downstream.pause()
        downstream.on('error', console.dir)
        downstream.once('error', (err) => {
          console.log({ err })
          if (downstream.errored?.message !== 'Aborted by client')
            send(ws, MessageType.DownStreamAbort, encodeNumber(id, 'Uint32'))
        })
        downstream.on('data', (chunk) => {
          downstream.pause()
          send(
            ws,
            MessageType.DownStreamPush,
            encodeNumber(id, 'Uint32'),
            Buffer.from(chunk).buffer as ArrayBuffer,
          )
        })
        data.streams.down.set(id, downstream)
        return { id, metadata: blob.metadata }
      },
      getStream: (id) => {
        return data.streams.down.get(id)!
      },
    }
  }

  protected createDecodeRpcContext(ws: WsTransportSocket) {
    const data = ws.getUserData()
    return {
      addStream(signal: AbortSignal, id: number, metadata: ApiBlobMetadata) {
        const upstream = new ServerUpStream(metadata, {
          read: (size) => {
            send(
              ws,
              MessageType.UpStreamPull,
              encodeNumber(id, 'Uint32'),
              encodeNumber(size, 'Uint32'),
            )
          },
        })

        data.streams.up.set(id, upstream)
        onAbort(signal, () => {
          upstream.destroy(new Error('Call aborted by client'))
        })
        upstream.once('error', (error) => {
          if (error.message !== 'Aborted by server')
            send(ws, MessageType.UpStreamAbort, encodeNumber(id, 'Uint32'))
        })
        upstream.once('close', () => {
          if (upstream.errored?.message !== 'Aborted by server')
            send(ws, MessageType.UpStreamEnd, encodeNumber(id, 'Uint32'))
        })

        return upstream
      },
      getStream(id) {
        return data.streams.down.get(id)
      },
    }
  }

  protected async [MessageType.Rpc](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const data = ws.getUserData()

    const connection = this.application.connections.get(data.id)
    if (!connection) return void ws.end(1011, 'Unknown connection')

    const ac = new AbortController()
    const rpc = data.format.decoder.decodeRpc(buffer, {
      ...data.context.decode,
      addStream: data.context.decode.addStream.bind(null, ac.signal),
    })

    data.abortControllers.set(rpc.callId, ac)

    const container = data.container.createScope(Scope.Call)

    try {
      const { service, procedure } = this.api.find(
        rpc.service,
        rpc.procedure,
        this.transportType,
      )

      const response = await this.handleRPC({
        connection,
        service,
        procedure,
        container,
        signal: ac.signal,
        payload: rpc.payload,
      })

      if (response instanceof SubscriptionResponse) {
        sendRpcMessage(ws, MessageType.RpcSubscription, {
          callId: rpc.callId,
          error: null,
          payload: [response.subscription.key, response.payload],
        })

        response.subscription.on('event', (event, payload) => {
          sendMessage(ws, MessageType.ServerSubscriptionEvent, [
            response.subscription.key,
            event,
            payload,
          ])
        })
        response.subscription.once('end', () => {
          sendMessage(ws, MessageType.ServerUnsubscribe, [
            response.subscription.key,
          ])
        })
      } else {
        sendRpcMessage(ws, MessageType.Rpc, {
          callId: rpc.callId,
          error: null,
          payload: response,
        })
      }
    } catch (error) {
      if (error instanceof ApiError) {
        this.logger.debug(new Error('Api error', { cause: error }))
        sendRpcMessage(ws, MessageType.Rpc, {
          callId: rpc.callId,
          error,
          payload: null,
        })
      } else {
        this.logger.error(new Error('Unexpected error', { cause: error }))
        sendRpcMessage(ws, MessageType.Rpc, {
          callId: rpc.callId,
          error: InternalError(),
          payload: null,
        })
      }
    } finally {
      data.abortControllers.delete(rpc.callId)
      this.handleContainerDisposal(container)
    }
  }

  async [MessageType.UpStreamPush](ws: WsTransportSocket, buffer: ArrayBuffer) {
    const data = ws.getUserData()
    const id = decodeNumber(buffer, 'Uint32')
    const stream = data.streams.up.get(id)
    if (!stream) return ws.end(1011, 'Unknown stream')
    stream.push(Buffer.from(buffer.slice(Uint32Array.BYTES_PER_ELEMENT)))
  }

  async [MessageType.UpStreamEnd](ws: WsTransportSocket, buffer: ArrayBuffer) {
    const data = ws.getUserData()
    const id = decodeNumber(buffer, 'Uint32')
    const stream = data.streams.up.get(id)
    if (!stream) return ws.end(1011, 'Unknown stream')
    stream.push(null)
    data.streams.up.delete(id)
  }

  async [MessageType.UpStreamAbort](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const data = ws.getUserData()
    const id = decodeNumber(buffer, 'Uint32')
    const stream = data.streams.up.get(id)
    if (!stream) return ws.end(1011, 'Unknown stream')
    stream.destroy(new Error('Aborted by client'))
    data.streams.up.delete(id)
  }

  async [MessageType.DownStreamPull](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const data = ws.getUserData()
    const id = decodeNumber(buffer, 'Uint32')
    const stream = data.streams.down.get(id)
    if (!stream) return ws.end(1011, 'Unknown stream')
    await data.backpressure?.promise
    if (stream.readableEnded)
      send(ws, MessageType.DownStreamEnd, encodeNumber(id, 'Uint32'))
    else stream.resume()
  }

  async [MessageType.DownStreamEnd](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const data = ws.getUserData()
    const id = decodeNumber(buffer, 'Uint32')
    const stream = data.streams.down.get(id)
    if (!stream) return ws.end(1011, 'Unknown stream')
    data.streams.down.delete(id)
  }

  async [MessageType.DownStreamAbort](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const data = ws.getUserData()
    const id = decodeNumber(buffer, 'Uint32')
    const stream = data.streams.down.get(id)
    if (!stream) return ws.end(1011, 'Unknown stream')
    stream.destroy(new Error('Aborted by client'))
    data.streams.down.delete(id)
  }

  async [MessageType.ClientUnsubscribe](
    ws: WsTransportSocket,
    buffer: ArrayBuffer,
  ) {
    const data = ws.getUserData()
    const [key] = data.format.decoder.decode(buffer)
    const subscription = data.subscriptions.get(key)
    if (!subscription) return void ws.end()
    subscription.destroy()
    data.subscriptions.delete(key)
  }

  async [MessageType.RpcAbort](ws: WsTransportSocket, buffer: ArrayBuffer) {
    const data = ws.getUserData()
    const callId = decodeNumber(buffer, 'Uint32')
    const ac = data.abortControllers.get(callId)
    if (ac) ac.abort(new Error('Aborted by client'))
  }
}
