// Dedicated Web Worker that hosts the Whisper ASR transformers.js pipeline.
// Loading and running inference is heavy CPU/WASM work that would otherwise
// freeze the main thread (the UI, progress bars, etc.).
//
// Protocol (main ⇄ worker):
//   → { id, type: "ensure-asr", payload: { model, webgpu } }
//   → { id, type: "transcribe", payload: { audio, language, wordTimestamps } }
//                                                             // audio buffer transferred
//   ← { type: "progress", key, payload }   // streamed model-download progress
//   ← { type: "chunk" }                     // streamed per-chunk ASR progress
//   ← { id, type: "done", result? }         // request finished
//   ← { id, type: "error", error }          // request failed

import { env, pipeline } from "@huggingface/transformers"

env.allowLocalModels = false
env.useBrowserCache = true

let recognizer: any = null

const post = (msg: any, transfer: Transferable[] = []) =>
  (self as any).postMessage(msg, transfer)

const progressCallback = (p: any) =>
  post({ type: "progress", key: "asr", payload: p })

async function createRecognizer(model: string, preferWebGPU: boolean) {
  const baseOptions = { progress_callback: progressCallback }
  const attempts: any[] = []

  if (preferWebGPU) {
    attempts.push({ ...baseOptions, device: "webgpu", dtype: "fp32" })
  }

  // Prefer the full-precision WASM model as the stable fallback. Some browser
  // ONNX Runtime/WebGPU combinations fail to load Whisper's quantized decoder
  // with: "TransposeDQWeightsForMatMulNBits Missing required scale".
  attempts.push({ ...baseOptions, device: "wasm", dtype: "fp32" })

  let lastError: unknown
  for (const options of attempts) {
    try {
      console.info(
        `[asr] loading Whisper on ${options.device} (${options.dtype})`,
      )
      return await pipeline("automatic-speech-recognition", model, options)
    } catch (error) {
      console.warn(
        `[asr] failed loading Whisper on ${options.device} (${options.dtype})`,
        error,
      )
      lastError = error
    }
  }

  throw lastError
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data || {}
  try {
    if (type === "ensure-asr") {
      if (!recognizer) {
        recognizer = await createRecognizer(payload.model, !!payload?.webgpu)
      }
      post({ id, type: "done" })
    } else if (type === "transcribe") {
      const output = await recognizer(payload.audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: payload.wordTimestamps ? "word" : true,
        language: payload.language || null,
        chunk_callback: () => post({ type: "chunk" }),
      })
      post({ id, type: "done", result: output })
    } else {
      post({ id, type: "error", error: `Unknown message type: ${type}` })
    }
  } catch (err: any) {
    post({ id, type: "error", error: String(err?.message || err) })
  }
}
