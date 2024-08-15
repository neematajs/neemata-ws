import { providers } from '@nmtjs/application'
import type { WsConnectionData } from './types.ts'

export const connectionData =
  providers.connectionData.$withType<WsConnectionData>()
