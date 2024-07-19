import {
  AbortStreamError,
  ClientTransport,
  type ClientTransportConnectOptions,
  type ClientTransportRpcCall,
  type ClientTransportRpcResult,
  type DownStream,
  Subscription,
  type UpStream,
  onAbort,
  once,
} from '@neematajs/client'
import {
  type BaseClientFormat,
  MessageType,
  TransportType,
  concat,
  decodeNumber,
  encodeNumber,
} from '@neematajs/common'

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
  format: BaseClientFormat
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
  protected readonly upStreams = new Map<number, UpStream>()
  protected readonly downStreams = new Map<number, DownStream>()
  protected queryParams = {}
  protected ws?: WebSocket
  protected isHealthy = false
  protected checkHealthAttempts = 0
  protected autoreconnect: boolean
  protected isConnected = false
  protected connectOptions?: ClientTransportConnectOptions

  private wsFactory!: (url: URL) => WebSocket

  constructor(private readonly options: WsClientTransportOptions) {
    super(options.format)

    this.autoreconnect = this.options.autoreconnect ?? true

    if (options.wsFactory) {
      this.wsFactory = options.wsFactory
    } else {
      this.wsFactory = (url: URL) => new WebSocket(url.toString())
    }

    this.on('close', (error) => this.clear(error))
  }

  async connect(options?: ClientTransportConnectOptions) {
    this.connectOptions = options
    // reset default autoreconnect value
    this.autoreconnect = this.options.autoreconnect ?? true
    await this.healthCheck()

    this.ws = this.wsFactory(
      this.getURL('api', 'ws', {
        ...this.queryParams,
        accept: this.options.format.mime,
        'content-type': this.options.format.mime,
        services: options?.services?.join(','),
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
    const { abortSignal, callId, payload, procedure, service } = call

    const data = this.options.format.encodeRpc({
      callId,
      service,
      procedure,
      payload,
    })

    onAbort(abortSignal, () => {
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

  protected async send(type: MessageType, ...payload: ArrayBuffer[]) {
    this.ws?.send(concat(encodeNumber(type, 'Uint8'), ...payload))
  }

  protected async clear(error: Error = new Error('Connection closed')) {
    for (const call of this.calls.values()) {
      const { reject } = call
      reject(error)
    }

    for (const stream of this.upStreams.values()) {
      stream.destroy(error)
    }

    for (const stream of this.downStreams.values()) {
      stream.ac.abort(error)
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
          auth: this.connectOptions?.auth,
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
    const [service, event, payload] = this.options.format.decode(buffer)
    this.emit('event', service, event, payload)
  }

  protected async [MessageType.Rpc](buffer: ArrayBuffer) {
    const [callId, response, error] = this.options.format.decode(buffer)

    if (this.calls.has(callId)) {
      this.resolveRpc(
        callId,
        error ? { success: false, error } : { success: true, value: response },
      )
    }
  }

  protected [MessageType.RpcStream](buffer: ArrayBuffer) {
    const [callId, streamDataType, streamId, payload] =
      this.options.format.decode(buffer)

    const abortStream = () =>
      this.send(MessageType.DownStreamAbort, encodeNumber(streamId, 'Uint32'))

    if (this.calls.has(callId)) {
      const ac = new AbortController()
      onAbort(ac.signal, () => {
        this.downStreams.delete(streamId)
        abortStream()
      })
      const stream = this.createDownStream(streamDataType, ac)
      this.downStreams.set(streamId, stream)
      this.resolveRpc(callId, {
        success: true,
        value: { payload, stream: stream.interface },
      })
    } else {
      abortStream()
    }
  }

  protected async [MessageType.UpStreamPull](buffer: ArrayBuffer) {
    const id = decodeNumber(buffer, 'Uint32')
    const size = decodeNumber(buffer, 'Uint32', Uint32Array.BYTES_PER_ELEMENT)
    const stream = this.upStreams.get(id)
    if (!stream) throw new Error('Stream not found')
    const { done, chunk } = await stream._read(size)
    if (done) {
      this.send(MessageType.UpStreamEnd, encodeNumber(id, 'Uint32'))
    } else {
      this.send(
        MessageType.UpStreamEnd,
        concat(encodeNumber(id, 'Uint32'), chunk!),
      )
    }
  }

  protected async [MessageType.UpStreamEnd](buffer: ArrayBuffer) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = this.upStreams.get(id)
    if (!stream) throw new Error('Stream not found')
    stream.emit('end')
    stream.destroy()
    this.upStreams.delete(id)
  }

  protected [MessageType.UpStreamAbort](buffer: ArrayBuffer) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = this.upStreams.get(id)
    if (!stream) throw new Error('Stream not found')
    stream.destroy(new AbortStreamError('Aborted by server'))
    this.upStreams.delete(id)
  }

  protected async [MessageType.DownStreamPush](buffer: ArrayBuffer) {
    const streamId = decodeNumber(buffer, 'Uint32')
    const stream = this.downStreams.get(streamId)
    if (stream) {
      await stream.writer.write(
        new Uint8Array(buffer.slice(Uint32Array.BYTES_PER_ELEMENT)),
      )
      this.send(MessageType.DownStreamPull, encodeNumber(streamId, 'Uint32'))
    }
  }

  protected [MessageType.DownStreamEnd](buffer: ArrayBuffer) {
    const streamId = decodeNumber(buffer, 'Uint32')
    const stream = this.downStreams.get(streamId)
    if (stream) {
      stream.writer.close()
      this.downStreams.delete(streamId)
    }
  }

  protected [MessageType.DownStreamAbort](buffer: ArrayBuffer) {
    const streamId = decodeNumber(buffer, 'Uint32')
    const stream = this.downStreams.get(streamId)
    if (stream) {
      stream.writable.abort(new AbortStreamError('Aborted by server'))
      this.downStreams.delete(streamId)
    }
  }

  protected [MessageType.RpcSubscription](buffer: ArrayBuffer) {
    const [callId, key, payload] = this.options.format.decode(buffer)
    if (this.calls.has(callId)) {
      const subscription = new Subscription(key, () => {
        subscription.emit('end')
        this.subscriptions.delete(key)
        this.send(MessageType.ClientUnsubscribe, this.format.encode([key]))
      })
      this.subscriptions.set(key, subscription)
      this.resolveRpc(callId, {
        success: true,
        value: { payload, subscription },
      })
    }
  }

  protected [MessageType.ServerSubscriptionEvent](buffer: ArrayBuffer) {
    const [key, event, payload] = this.options.format.decode(buffer)
    const subscription = this.subscriptions.get(key)
    if (subscription) subscription.emit(event, payload)
  }

  protected [MessageType.ServerUnsubscribe](buffer: ArrayBuffer) {
    const [key] = this.options.format.decode(buffer)
    const subscription = this.subscriptions.get(key)
    subscription?.emit('end')
    this.subscriptions.delete(key)
  }
}
