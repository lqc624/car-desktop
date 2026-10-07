import type { CarBridge } from '../shared/ipc-contract'

declare global {
  interface Window {
    car: CarBridge
  }
}

export {}
