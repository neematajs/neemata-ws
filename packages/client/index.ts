import {
  type ClientDownStreamWrapper,
  ClientTransport,
  type ClientTransportRpcCall,
  type ClientTransportRpcResult,
  ClientUpStream,
  Subscription,
  createClientDownStream,
  onAbort,
  once,
} from '@nmtjs/client'
import {
  type DecodeRpcContext,
  type EncodeRpcContext,
  MessageType,
  MessageTypeName,
  TransportType,
  concat,
  decodeNumber,
  encodeNumber,
} from '@nmtjs/common'

export type WsClientTransportOptions = {
  /**
   * The origin of the server
   * @example 'http://localhost:3000'
   */
  origin: string
  /**
   * Whether to autoreconnect on close
   * @default true
   */
  autoreconnect?: boolean
  /**
   * Custom WebSocket class
   * @default globalThis.WebSocket
   */
  wsFactory?: (url: URL) => WebSocket

  debug?: boolean
}

type WsCall = {
  resolve: (value: ClientTransportRpcResult) => void
  reject: (error: Error) => void
}

export class WsClientTransport extends ClientTransport<{
  open: []
  close: [Error?]
  connect: []
  healthy: []
}> {
  readonly type = TransportType.WS

  protected readonly calls = new Map<number, WsCall>()
  protected readonly subscriptions = new Map<number, Subscription>()
  protected readonly upStreams = new Map<number, ClientUpStream>()
  protected readonly downStreams = new Map<number, ClientDownStreamWrapper>()
  protected upStreamId = 0
  protected queryParams = {}
  protected ws?: WebSocket
  protected isHealthy = false
  protected checkHealthAttempts = 0
  protected autoreconnect: boolean
  protected isConnected = false

  private wsFactory!: (url: URL) => WebSocket
  private encodeRpcContext: EncodeRpcContext
  private decodeRpcContext: DecodeRpcContext

  constructor(private readonly options: WsClientTransportOptions) {
    super()

    this.autoreconnect = this.options.autoreconnect ?? true

    if (options.wsFactory) {
      this.wsFactory = options.wsFactory
    } else {
      this.wsFactory = (url: URL) => new WebSocket(url.toString())
    }

    // TODO: wtf is this for?
    this.on('close', (error) => this.clear(error))

    this.encodeRpcContext = {
      addStream: (blob) => {
        const id = ++this.upStreamId
        const upstream = new ClientUpStream(id, blob)
        this.upStreams.set(id, upstream)
        return { id, metadata: blob.metadata }
      },
      getStream: (id) => this.upStreams.get(id),
    }

    this.decodeRpcContext = {
      addStream: (id, metadata) => {
        const downstream = createClientDownStream(metadata, () =>
          this.send(MessageType.DownStreamPull, encodeNumber(id, 'Uint32')),
        )
        this.downStreams.set(id, downstream)
        return downstream.blob
      },
      getStream: (id) => this.downStreams.get(id),
    }
  }

  async connect() {
    // reset default autoreconnect value
    this.autoreconnect = this.options.autoreconnect ?? true
    await this.healthCheck()

    this.ws = this.wsFactory(
      this.getURL('api', 'ws', {
        ...this.queryParams,
        accept: this.client.format.contentType,
        'content-type': this.client.format.contentType,
        services: this.client.services,
      }),
    )

    this.ws.binaryType = 'arraybuffer'

    this.ws.onmessage = (event) => {
      const buffer: ArrayBuffer = event.data
      const type = decodeNumber(buffer, 'Uint8')
      const handler = this[type]
      if (handler) {
        handler.call(this, buffer.slice(Uint8Array.BYTES_PER_ELEMENT), this.ws)
      }
    }
    this.ws.onopen = (event) => {
      this.isConnected = true
      this.emit('open')
      this.checkHealthAttempts = 0
    }
    this.ws.onclose = (event) => {
      this.isConnected = false
      this.isHealthy = false
      this.emit(
        'close',
        event.code === 1000
          ? undefined
          : new Error(
              `Connection closed with code ${event.code}: ${event.reason}`,
            ),
      )
      // FIXME: cleanup calls, streams, subscriptions
      if (this.autoreconnect) this.connect()
    }
    this.ws.onerror = (event) => {
      this.isHealthy = false
    }
    await once(this, 'open')
    this.emit('connect')
  }

  async disconnect(): Promise<void> {
    this.autoreconnect = false
    this.ws?.close()
    await once(this, 'close')
  }

  async rpc(call: ClientTransportRpcCall): Promise<ClientTransportRpcResult> {
    const { signal, callId, payload, procedure, service } = call

    const data = this.client.format.encodeRpc(
      {
        callId,
        service,
        procedure,
        payload,
      },
      this.encodeRpcContext,
    )

    onAbort(signal, () => {
      const call = this.calls.get(callId)
      if (call) {
        const { reject } = call
        reject(new Error('Request aborted'))
        this.calls.delete(callId)
        this.send(MessageType.RpcAbort, encodeNumber(callId, 'Uint32'))
      }
    })

    if (!this.isConnected) await once(this, 'connect')

    return new Promise((resolve, reject) => {
      this.calls.set(callId, { resolve, reject })
      this.send(MessageType.Rpc, data)
    })
  }

  setQueryParams(params: Record<string, any>) {
    this.queryParams = params
  }

  protected send(type: MessageType, ...payload: ArrayBuffer[]) {
    this.ws?.send(concat(encodeNumber(type, 'Uint8'), ...payload))
    if (this.options.debug) {
      console.groupCollapsed(`[WS] Sent ${MessageTypeName[type]}`)
      console.trace()
      console.groupEnd()
    }
  }

  protected async clear(error: Error = new Error('Connection closed')) {
    for (const call of this.calls.values()) {
      const { reject } = call
      reject(error)
    }

    for (const stream of this.upStreams.values()) {
      stream.reader.cancel(error)
    }

    for (const stream of this.downStreams.values()) {
      stream.writer.abort(error)
    }

    for (const subscription of this.subscriptions.values()) {
      subscription.unsubscribe()
    }

    this.calls.clear()
    this.upStreams.clear()
    this.downStreams.clear()
    this.subscriptions.clear()
  }

  protected async healthCheck() {
    while (!this.isHealthy) {
      try {
        const signal = AbortSignal.timeout(10000)
        const url = this.getURL('healthy', 'http', {
          auth: this.client.auth,
        })
        const { ok } = await fetch(url, { signal })
        this.isHealthy = ok
      } catch (e) {}

      if (!this.isHealthy) {
        this.checkHealthAttempts++
        const seconds = Math.min(this.checkHealthAttempts, 15)
        await new Promise((r) => setTimeout(r, seconds * 1000))
      }
    }
    this.emit('healthy')
  }

  private getURL(
    path = '',
    protocol: 'ws' | 'http',
    params: Record<string, any> = {},
  ) {
    // TODO: add custom path support?
    const base = new URL(this.options.origin)
    const secure = base.protocol === 'https:'
    const url = new URL(
      `${secure ? protocol + 's' : protocol}://${base.host}/${path}`,
    )
    for (let [key, values] of Object.entries(params)) {
      if (!Array.isArray(values)) values = [values]
      for (const value of values) {
        url.searchParams.append(key, value)
      }
    }
    return url
  }

  protected resolveRpc(callId: number, value: ClientTransportRpcResult) {
    const call = this.calls.get(callId)
    if (call) {
      const { resolve } = call
      this.calls.delete(callId)
      resolve(value)
    }
  }

  protected async [MessageType.Event](buffer: ArrayBuffer) {
    const [service, event, payload] = this.client.format.decode(buffer)
    if (this.options.debug) {
      console.groupCollapsed(`[WS] Received "Event" ${service}/${event}`)
      console.log(payload)
      console.groupEnd()
    }
    this.emit('event', service, event, payload)
  }

  protected async [MessageType.Rpc](buffer: ArrayBuffer) {
    const { callId, error, payload } = this.client.format.decodeRpc(
      buffer,
      this.decodeRpcContext,
    )

    if (this.calls.has(callId)) {
      this.resolveRpc(
        callId,
        error ? { success: false, error } : { success: true, value: payload },
      )
    }
  }

  protected async [MessageType.UpStreamPull](buffer: ArrayBuffer) {
    const id = decodeNumber(buffer, 'Uint32')
    const size = decodeNumber(buffer, 'Uint32', Uint32Array.BYTES_PER_ELEMENT)

    if (this.options.debug) {
      console.log(`[WS] Received "UpStreamPull" ${id}`)
    }

    const stream = this.upStreams.get(id)
    if (stream) {
      const buf = new Uint8Array(new ArrayBuffer(size))
      const { done, value } = await stream.reader.read(buf)
      if (done) {
        this.send(MessageType.UpStreamEnd, encodeNumber(id, 'Uint32'))
      } else {
        this.send(
          MessageType.UpStreamPush,
          concat(
            encodeNumber(id, 'Uint32'),
            value.buffer.slice(0, value.byteLength),
          ),
        )
      }
    }
  }

  protected async [MessageType.UpStreamEnd](buffer: ArrayBuffer) {
    const id = decodeNumber(buffer, 'Uint32')
    if (this.options.debug) {
      console.log(`[WS] Received "UpStreamEnd" ${id}`)
    }
    const stream = this.upStreams.get(id)
    if (stream) {
      stream.reader.cancel()
      this.upStreams.delete(id)
    }
  }

  protected [MessageType.UpStreamAbort](buffer: ArrayBuffer) {
    const id = decodeNumber(buffer, 'Uint32')
    if (this.options.debug) {
      console.log(`[WS] Received "UpStreamAbort" ${id}`)
    }
    const stream = this.upStreams.get(id)
    if (stream) {
      try {
        stream.reader.cancel(new Error('Aborted by server'))
      } finally {
        this.upStreams.delete(id)
      }
    }
  }

  protected async [MessageType.DownStreamPush](buffer: ArrayBuffer) {
    const id = decodeNumber(buffer, 'Uint32')
    if (this.options.debug) {
      console.log(`[WS] Received "DownStreamPush" ${id}`)
    }
    const stream = this.downStreams.get(id)
    if (stream) {
      try {
        await stream.writer.ready
        const chunk = buffer.slice(Uint32Array.BYTES_PER_ELEMENT)
        await stream.writer.write(new Uint8Array(chunk))
        await stream.writer.ready
        this.send(MessageType.DownStreamPull, encodeNumber(id, 'Uint32'))
      } catch (e) {
        this.send(MessageType.DownStreamAbort, encodeNumber(id, 'Uint32'))
        this.downStreams.delete(id)
      }
    }
  }

  protected async [MessageType.DownStreamEnd](buffer: ArrayBuffer) {
    const id = decodeNumber(buffer, 'Uint32')
    if (this.options.debug) {
      console.log(`[WS] Received "DownStreamEnd" ${id}`)
    }
    const stream = this.downStreams.get(id)
    if (stream) {
      this.downStreams.delete(id)
      stream.writer.close().catch(() => {})
    }
  }

  protected async [MessageType.DownStreamAbort](buffer: ArrayBuffer) {
    const id = decodeNumber(buffer, 'Uint32')
    if (this.options.debug) {
      console.log(`[WS] Received "DownStreamAbort" ${id}`)
    }
    const stream = this.downStreams.get(id)
    if (stream) {
      this.downStreams.delete(id)
      stream.writer.abort(new Error('Aborted by server')).catch(() => {})
    }
  }

  protected [MessageType.RpcSubscription](buffer: ArrayBuffer) {
    const {
      callId,
      payload: [key, payload],
    } = this.client.format.decodeRpc(buffer, this.decodeRpcContext)
    if (this.calls.has(callId)) {
      const subscription = new Subscription(key, () => {
        subscription.emit('end')
        this.subscriptions.delete(key)
        this.send(
          MessageType.ClientUnsubscribe,
          this.client.format.encode([key]),
        )
      })
      this.subscriptions.set(key, subscription)
      this.resolveRpc(callId, {
        success: true,
        value: { payload, subscription },
      })
    }
  }

  protected [MessageType.ServerSubscriptionEvent](buffer: ArrayBuffer) {
    const [key, event, payload] = this.client.format.decode(buffer)
    if (this.options.debug) {
      console.groupCollapsed(
        `[WS] Received "ServerSubscriptionEvent" ${key}/${event}`,
      )
      console.log(payload)
      console.groupEnd()
    }
    const subscription = this.subscriptions.get(key)
    if (subscription) subscription.emit(event, payload)
  }

  protected [MessageType.ServerUnsubscribe](buffer: ArrayBuffer) {
    const [key] = this.client.format.decode(buffer)
    if (this.options.debug) {
      console.log(`[WS] Received "ServerUnsubscribe" ${key}`)
    }
    const subscription = this.subscriptions.get(key)
    subscription?.emit('end')
    this.subscriptions.delete(key)
  }
}
