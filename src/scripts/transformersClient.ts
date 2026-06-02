type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

type TransformersClientOptions = {
  onProgress?: (key: string, payload: unknown) => void
}

export function createTransformersClient(options: TransformersClientOptions = {}) {
  const worker = new Worker(new URL("./transcriber.worker.ts", import.meta.url), {
    type: "module",
  })
  const pending = new Map<number, PendingRequest>()
  let reqId = 0
  let onChunk: (() => void) | null = null

  worker.onmessage = (event) => {
    const { id, type } = event.data || {}
    if (type === "progress") {
      options.onProgress?.(event.data.key, event.data.payload)
      return
    }
    if (type === "chunk") {
      onChunk?.()
      return
    }
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    if (type === "error") request.reject(new Error(event.data.error))
    else request.resolve(event.data.result)
  }

  return {
    call(type: string, payload?: unknown, transfer: Transferable[] = []) {
      const id = ++reqId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, type, payload }, transfer)
      })
    },
    setChunkHandler(handler: (() => void) | null) {
      onChunk = handler
    },
  }
}
