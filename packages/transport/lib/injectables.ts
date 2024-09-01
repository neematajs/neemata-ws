import {
  type LazyInjectable,
  type Scope,
  injectables,
} from '@nmtjs/application'
import type { WsConnectionData } from './types.ts'

export const connectionData = injectables.connectionData as LazyInjectable<
  WsConnectionData,
  Scope.Connection
>
