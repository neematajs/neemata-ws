import { type Format, ApiError } from '@neematajs/application'
import { ErrorCode, concat, encodeNumber } from '@neematajs/common'
import type { WsTransportSocket } from './types'

export const sendPayload = (
  ws: WsTransportSocket,
  type: number,
  payload: any,
) => {
  return send(ws, type, ws.data.format.encoder.encode(payload))
}

export const send = (
  ws: WsTransportSocket,
  type: number,
  ...buffers: ArrayBuffer[]
): boolean | null => {
  const result = ws.send(concat(encodeNumber(type, 'Uint8'), ...buffers), true)
  if (result === -1) {
    ws.data.backpressure = Promise.withResolvers()
    for (const stream of ws.data.streams.down.values()) stream.pause()
    return false
  } else if (result === 0) {
    return null
  } else {
    return true
  }
}

export const getFormat = ({ headers, url }: Request, format: Format) => {
  const query = new URL(url, 'http://localhost').searchParams

  const contentType = headers.get('content-type') || query.get('content-type')
  const acceptType = headers.get('accept') || query.get('accept')

  const encoder = contentType ? format.supports(contentType) : undefined
  if (!encoder) throw new Error('Unsupported content-type')

  const decoder = acceptType ? format.supports(acceptType) : undefined
  if (!decoder) throw new Error('Unsupported accept')

  return {
    encoder,
    decoder,
  }
}

export const toRecord = (input: Headers | URLSearchParams) => {
  const obj: Record<string, string> = {}
  input.forEach((value, key) => { obj[key] = value })
  return obj
}

export const InternalError = (message = 'Internal Server Error') =>
  new ApiError(ErrorCode.InternalServerError, message)

export const NotFoundError = (message = 'Not Found') =>
  new ApiError(ErrorCode.NotFound, message)

export const ForbiddenError = (message = 'Forbidden') =>
  new ApiError(ErrorCode.Forbidden, message)

export const RequestTimeoutError = (message = 'Request Timeout') =>
  new ApiError(ErrorCode.RequestTimeout, message)
