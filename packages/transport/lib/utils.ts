import { ApiError, type Format } from '@nmtjs/application'
import {
  ErrorCode,
  type RpcResponse,
  concat,
  encodeNumber,
} from '@nmtjs/common'
import type { HttpRequest } from 'uWebSockets.js'
import type { WsTransportSocket } from './types.ts'

export const sendMessage = (
  ws: WsTransportSocket,
  type: number,
  payload: any,
) => {
  return send(ws, type, ws.getUserData().format.encoder.encode(payload))
}

export const sendRpcMessage = (
  ws: WsTransportSocket,
  type: number,
  rpc: RpcResponse,
) => {
  const data = ws.getUserData()
  return send(ws, type, data.format.encoder.encodeRpc(rpc, data.context.encode))
}

export const send = (
  ws: WsTransportSocket,
  type: number,
  ...buffers: ArrayBuffer[]
): boolean | null => {
  const data = ws.getUserData()
  try {
    const result = ws.send(
      concat(encodeNumber(type, 'Uint8'), ...buffers),
      true,
    )
    if (result === 0) {
      data.backpressure = Promise.withResolvers()
      return false
    }
    if (result === 2) {
      return null
    }
    return true
  } catch (error) {
    return null
  }
}

export const getFormat = ({ headers, query }: RequestData, format: Format) => {
  const contentType = headers.get('content-type') || query.get('content-type')
  const acceptType = headers.get('accept') || query.get('accept')

  const encoder = contentType ? format.supportsEncoder(contentType) : undefined
  if (!encoder) throw new Error('Unsupported content-type')

  const decoder = acceptType ? format.supportsDecoder(acceptType) : undefined
  if (!decoder) throw new Error('Unsupported accept')

  return {
    encoder,
    decoder,
  }
}

export const toRecord = (input: {
  forEach: (cb: (value, key) => void) => void
}) => {
  const obj: Record<string, string> = {}
  input.forEach((value, key) => {
    obj[key] = value
  })
  return obj
}

type RequestData = {
  url: string
  origin: URL | null
  method: string
  headers: Map<string, string>
  query: URLSearchParams
}

export const getRequestData = (req: HttpRequest): RequestData => {
  const url = req.getUrl()
  const method = req.getMethod()
  const headers = new Map()
  req.forEach((key, value) => headers.set(key, value))
  const query = new URLSearchParams(req.getQuery())
  const origin = headers.has('origin')
    ? new URL(url, headers.get('origin'))
    : null

  return {
    url,
    origin,
    method,
    headers,
    query,
  }
}

export const InternalError = (message = 'Internal Server Error') =>
  new ApiError(ErrorCode.InternalServerError, message)

export const NotFoundError = (message = 'Not Found') =>
  new ApiError(ErrorCode.NotFound, message)

export const ForbiddenError = (message = 'Forbidden') =>
  new ApiError(ErrorCode.Forbidden, message)

export const RequestTimeoutError = (message = 'Request Timeout') =>
  new ApiError(ErrorCode.RequestTimeout, message)
