import type { D1Database } from '@cloudflare/workers-types'

declare module 'h3' {
  interface H3EventContext {
    cloudflare?: {
      env: {
        DB: D1Database
        ENVIRONMENT?: string
      }
    }
  }
}

declare module 'highs-wasm' {
  const wasmModule: WebAssembly.Module
  export default wasmModule
}

declare module '*.wasm' {
  const wasmModule: WebAssembly.Module
  export default wasmModule
}
