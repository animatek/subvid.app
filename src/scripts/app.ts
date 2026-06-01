import { FFmpeg } from "@ffmpeg/ffmpeg"
// @ffmpeg/ffmpeg always spawns its worker with { type: "module" }, so the
// worker must use import() (not importScripts). We let Vite bundle the ESM
// worker — resolving its relative imports — and serve it same-origin.
import ffmpegWorkerURL from "@ffmpeg/ffmpeg/worker?worker&url"
import { fetchFile } from "@ffmpeg/util"
import { env, pipeline } from "@xenova/transformers"
import { $, $$ } from "./dom.ts"

const ASR_MODEL = "Xenova/whisper-base"
const TRANSLATION_MODEL = "Xenova/nllb-200-distilled-600M"

// ── Subtitle styling ──
const FONT_STACKS = {
  sans: '"Outfit", "Segoe UI", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: '"Quicksand", "Trebuchet MS", system-ui, sans-serif',
  condensed: '"Arial Narrow", "Roboto Condensed", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", monospace',
}

// Visual presets. `position` is intentionally omitted so switching presets
// never moves the captions the user already placed.
const CAPTION_PRESETS = [
  {
    id: "default",
    name: "Default",
    s: {
      font: "sans",
      size: 1,
      color: "#ffffff",
      weight: 600,
      bgEnabled: true,
      bgColor: "#06080b",
      bgOpacity: 0.84,
      outline: false,
    },
  },
  {
    id: "clean",
    name: "Clean",
    s: {
      font: "sans",
      size: 1,
      color: "#ffffff",
      weight: 600,
      bgEnabled: false,
      bgColor: "#06080b",
      bgOpacity: 0.84,
      outline: true,
    },
  },
  {
    id: "bold",
    name: "Bold",
    s: {
      font: "sans",
      size: 1.12,
      color: "#ffffff",
      weight: 700,
      bgEnabled: true,
      bgColor: "#000000",
      bgOpacity: 1,
      outline: false,
    },
  },
  {
    id: "pop",
    name: "Pop",
    s: {
      font: "rounded",
      size: 1.06,
      color: "#fde047",
      weight: 700,
      bgEnabled: false,
      bgColor: "#000000",
      bgOpacity: 0.84,
      outline: true,
    },
  },
  {
    id: "neon",
    name: "Neon",
    s: {
      font: "sans",
      size: 1,
      color: "#b8f060",
      weight: 700,
      bgEnabled: true,
      bgColor: "#06080b",
      bgOpacity: 0.55,
      outline: false,
    },
  },
  {
    id: "classic",
    name: "Classic",
    s: {
      font: "serif",
      size: 1,
      color: "#ffffff",
      weight: 600,
      bgEnabled: false,
      bgColor: "#06080b",
      bgOpacity: 0.84,
      outline: true,
    },
  },
  {
    id: "terminal",
    name: "Terminal",
    s: {
      font: "mono",
      size: 0.92,
      color: "#ffffff",
      weight: 600,
      bgEnabled: true,
      bgColor: "#0a0d12",
      bgOpacity: 0.9,
      outline: false,
    },
  },
]

const captionStyle = {
  font: "sans",
  size: 1,
  color: "#ffffff",
  weight: 600,
  bgEnabled: true,
  bgColor: "#06080b",
  bgOpacity: 0.84,
  outline: false,
  position: "bottom",
}
let activePresetId = "default"

const LANGS = {
  en: { label: "English", nllb: "eng_Latn" },
  es: { label: "Español", nllb: "spa_Latn" },
  fr: { label: "Français", nllb: "fra_Latn" },
  de: { label: "Deutsch", nllb: "deu_Latn" },
  pt: { label: "Português", nllb: "por_Latn" },
  it: { label: "Italiano", nllb: "ita_Latn" },
  nl: { label: "Nederlands", nllb: "nld_Latn" },
  ru: { label: "Русский", nllb: "rus_Cyrl" },
  ja: { label: "日本語", nllb: "jpn_Jpan" },
  ko: { label: "한국어", nllb: "kor_Hang" },
  zh: { label: "中文", nllb: "zho_Hans" },
  ar: { label: "العربية", nllb: "arb_Arab" },
  hi: { label: "हिन्दी", nllb: "hin_Deva" },
  pl: { label: "Polski", nllb: "pol_Latn" },
  tr: { label: "Türkçe", nllb: "tur_Latn" },
}

const ui = {
  app: $("#app"),
  stageUpload: $("#stage-upload"),
  stageConfig: $("#stage-config"),
  stageEditor: $("#stage-editor"),
  dropzone: $("#dropzone"),
  input: $<HTMLInputElement>("#video-input"),
  video: $<HTMLVideoElement>("#video"),
  configVideo: $<HTMLVideoElement>("#config-video"),
  caption: $("#caption-overlay"),
  status: $("#status"),
  progress: $("#progress"),
  configProgress: $("#config-progress"),
  configProgressFill: $("#config-progress-fill"),
  configProgressPct: $("#config-progress-pct"),
  configStatus: $("#config-status"),
  configError: $("#config-error"),
  meta: $("#video-meta"),
  configMeta: $("#config-meta"),
  detected: $("#detected-language"),
  inputLang: $<HTMLSelectElement>("#input-lang"),
  outputLang: $<HTMLSelectElement>("#output-lang"),
  configBackBtn: $("#config-back-btn"),
  langTabs: $("#lang-tabs"),
  segList: $("#seg-list"),
  segCount: $("#seg-count"),
  addSegBtn: $<HTMLButtonElement>("#add-seg-btn"),
  transcribeBtn: $<HTMLButtonElement>("#transcribe-btn"),
  downloadVideoBtn: $<HTMLButtonElement>("#download-video-btn"),
  downloadSrtBtn: $<HTMLButtonElement>("#download-srt-btn"),
  backBtn: $("#back-btn"),
  stylePresets: $("#style-presets"),
  styleToggle: $("#style-toggle"),
  styleControls: $("#style-controls"),
  csFont: $<HTMLSelectElement>("#cs-font"),
  csSize: $<HTMLInputElement>("#cs-size"),
  csColor: $<HTMLInputElement>("#cs-color"),
  csBold: $<HTMLInputElement>("#cs-bold"),
  csOutline: $<HTMLInputElement>("#cs-outline"),
  csBg: $<HTMLInputElement>("#cs-bg"),
  csBgColor: $<HTMLInputElement>("#cs-bgcolor"),
  csBgOpacity: $<HTMLInputElement>("#cs-bgopacity"),
  csPosition: $("#cs-position"),
  exportModal: $("#export-modal"),
  exportBackdrop: $("#export-backdrop"),
  exportClose: $("#export-close"),
  exportTitle: $("#export-title"),
  exportStage: $("#export-stage"),
  exportFill: $("#export-fill"),
  exportPct: $("#export-pct"),
  exportHint: $("#export-hint"),
  exportSteps: $("#export-steps"),
  exportError: $("#export-error"),
  downloadsToggle: $("#downloads-toggle"),
  downloadsRing: $("#downloads-ring"),
  downloadsPct: $("#downloads-pct"),
  downloadsLabel: $("#downloads-label"),
  downloadsSummary: $("#downloads-summary"),
  downloadsOverall: $("#downloads-overall"),
  downloadsPanel: $("#downloads-panel"),
  downloadsList: $("#downloads-list"),
  statusDock: $("#status-dock"),
  timeline: $("#timeline"),
  timelineScroll: $("#timeline-scroll"),
  timelineTrack: $("#timeline-track"),
  timelineRuler: $("#timeline-ruler"),
  timelineBlocks: $("#timeline-blocks"),
  timelinePlayhead: $("#timeline-playhead"),
  tlPlay: $("#tl-play"),
  tlClock: $("#tl-clock"),
  tlZoomIn: $("#tl-zoom-in"),
  tlZoomOut: $("#tl-zoom-out"),
}

const downloads = {
  ffmpeg: {
    label: "Núcleo FFmpeg WASM",
    state: "pending",
    progress: 0,
    loaded: 0,
    total: 0,
    speed: 0,
  },
  asr: {
    label: "Modelo Whisper",
    state: "pending",
    progress: 0,
    loaded: 0,
    total: 0,
    speed: 0,
  },
  translation: {
    label: "Modelo de traducción",
    state: "pending",
    progress: 0,
    loaded: 0,
    total: 0,
    speed: 0,
    pendingNote: "Solo si traduces",
  },
}

const RING_C = 2 * Math.PI * 15.5

// ── State ──
let selectedVideoFile = null
let videoObjectUrl = ""
let detectedLang = ""
let baseSegments = []
let segmentsByLang = {}
let orderedLangs = []
let activeLang = ""

let ffmpeg = null
let recognizer = null
let translator = null
let dragDepth = 0
let exporting = false
let onFfmpegProgress = null
let progressRaf = 0

env.allowLocalModels = false
env.useBrowserCache = true

const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator

const currentSegments = () => segmentsByLang[activeLang] || []

// ── Helpers ──
function setStatus(message, kind = "ok") {
  ui.status.textContent = message
  ui.status.dataset.kind = kind
  // Mirror to the config stage (visible while generating, before the
  // editor stage is shown).
  ui.configStatus.textContent = message
  ui.configStatus.dataset.kind = kind
}

function setProgress(percent) {
  stopProgressCreep()
  applyProgress(percent)
}

// Directly paint a progress value without touching any running animation.
function applyProgress(percent) {
  const clamped = Math.max(0, Math.min(100, percent))
  ui.progress.style.width = `${clamped}%`
  ui.configProgressFill.style.width = `${clamped}%`
  ui.configProgressPct.textContent = `${Math.round(clamped)}%`
}

function stopProgressCreep() {
  if (progressRaf) {
    cancelAnimationFrame(progressRaf)
    progressRaf = 0
  }
}

// Smoothly creep from `from` toward `ceiling` (asymptotically, never quite
// reaching it) so an opaque step still shows continuous movement. `expected`
// is the rough duration in ms the step is expected to take.
function startProgressCreep(from, ceiling, expected) {
  stopProgressCreep()
  const start = performance.now()
  const span = ceiling - from
  const tick = (now) => {
    const t = (now - start) / Math.max(1, expected)
    const eased = 1 - Math.exp(-1.6 * t)
    applyProgress(from + span * eased)
    progressRaf = requestAnimationFrame(tick)
  }
  progressRaf = requestAnimationFrame(tick)
}

function prettifyBytes(bytes) {
  if (!bytes && bytes !== 0) return "-"
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatSrtTime(seconds) {
  const c = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const h = Math.floor(c / 3600)
  const m = Math.floor((c % 3600) / 60)
  const s = Math.floor(c % 60)
  const ms = Math.floor((c - Math.floor(c)) * 1000)
  const p = (n, l = 2) => String(n).padStart(l, "0")
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`
}

function formatClock(seconds) {
  const c = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const m = Math.floor(c / 60)
  const s = Math.floor(c % 60)
  const cs = Math.round((c - Math.floor(c)) * 100)
  const p = (n) => String(n).padStart(2, "0")
  return `${m}:${p(s)}.${p(cs)}`
}

function parseClock(value) {
  const match = String(value)
    .trim()
    .match(/^(\d+):(\d{1,2})(?:[.,](\d{1,3}))?$/)
  if (!match) return null
  const m = Number(match[1])
  const s = Number(match[2])
  const frac = match[3] ? Number(`0.${match[3]}`) : 0
  return m * 60 + s + frac
}

function normalizeSegments(output) {
  if (!output || !Array.isArray(output.chunks)) {
    const text = output?.text?.trim()
    return text ? [{ start: 0, end: 6, text }] : []
  }
  return output.chunks
    .map((chunk, index) => {
      const range = Array.isArray(chunk.timestamp)
        ? chunk.timestamp
        : [index * 2, index * 2 + 2]
      const start = Number.isFinite(range[0]) ? range[0] : index * 2
      const end = Number.isFinite(range[1]) ? range[1] : start + 2
      return {
        start,
        end: Math.max(start + 0.35, end),
        text: (chunk.text || "").trim(),
      }
    })
    .filter((s) => s.text.length > 0)
}

function buildSrt(segments) {
  return segments
    .map(
      (s, i) =>
        `${i + 1}\n${formatSrtTime(s.start)} --> ${formatSrtTime(s.end)}\n${s.text}`,
    )
    .join("\n\n")
}

function normalizeLanguageCode(code) {
  if (!code) return ""
  const short = String(code).toLowerCase().slice(0, 2)
  return LANGS[short] ? short : ""
}

function outputTarget(sourceLang) {
  const value = ui.outputLang.value
  if (!value || value === "same") return sourceLang
  return LANGS[value] ? value : sourceLang
}

function baseFileName() {
  return (
    (selectedVideoFile?.name || "subtitulos")
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9-_]+/g, "-")
      .toLowerCase() || "subtitulos"
  )
}

// ── Stage switching ──
function setStage(stage) {
  ui.stageUpload.hidden = stage !== "upload"
  ui.stageConfig.hidden = stage !== "config"
  ui.stageEditor.hidden = stage !== "editor"
  if (ui.statusDock) ui.statusDock.hidden = stage === "editor"
  if (stage === "editor") ui.downloadsPanel.hidden = true
}

// ── Model download status ──
const STATE_LABEL = {
  pending: "En espera",
  downloading: "Descargando",
  ready: "Listo",
  error: "Error",
}

function trackSpeed(item, loaded) {
  const now = performance.now()
  if (item._lastTime == null) {
    item._lastTime = now
    item._lastLoaded = loaded
    return
  }
  const dt = (now - item._lastTime) / 1000
  if (dt >= 0.35) {
    const inst = Math.max(0, (loaded - item._lastLoaded) / dt)
    item.speed = item.speed ? item.speed * 0.55 + inst * 0.45 : inst
    item._lastTime = now
    item._lastLoaded = loaded
  }
}

function updateDownloadStatus(key, state) {
  const item = downloads[key]
  item.state = state
  if (state === "downloading" && item.progress === 0 && !item.total) {
    // keep indeterminate until first byte info arrives
  }
  if (state === "ready") {
    item.progress = 100
    item.speed = 0
  }
  if (state === "error") {
    item.speed = 0
  }
  renderDownloads()
}

// Aggregates transformers.js per-file progress into one model entry.
function makeTransformersTracker(key) {
  const files = new Map()
  return (e) => {
    const item = downloads[key]
    if (
      e?.status === "progress" ||
      e?.status === "download" ||
      e?.status === "initiate"
    ) {
      if (
        typeof e.loaded === "number" &&
        typeof e.total === "number" &&
        e.total > 0
      ) {
        files.set(e.file, { loaded: e.loaded, total: e.total })
      }
      let loaded = 0
      let total = 0
      files.forEach((f) => {
        loaded += f.loaded
        total += f.total
      })
      item.loaded = loaded
      item.total = total
      item.progress = total
        ? Math.min(100, (loaded / total) * 100)
        : item.progress
      item.state = "downloading"
      trackSpeed(item, loaded)
      renderDownloads()
    }
  }
}

// Streams a URL into a Blob while reporting bytes + speed.
// `fallbackTotal` is used when the server omits content-length (e.g. gzip
// responses where the header is stripped); it must be the *decompressed*
// byte size, since the stream reader yields decompressed bytes.
async function fetchWithProgress(url, key, mimeType, fallbackTotal = 0) {
  const item = downloads[key]
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    // Fallback without progress info.
    const blob = await (await fetch(url)).blob()
    return URL.createObjectURL(new Blob([blob], { type: mimeType }))
  }
  const headerTotal = Number(response.headers.get("content-length")) || 0
  const partTotal = headerTotal || fallbackTotal
  item.total = (item._totalBase || 0) + partTotal
  const reader = response.body.getReader()
  const chunks = []
  let partLoaded = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    partLoaded += value.length
    item.loaded = (item._loadedBase || 0) + partLoaded
    item.progress = item.total
      ? Math.min(99, (item.loaded / item.total) * 100)
      : item.progress
    trackSpeed(item, item.loaded)
    renderDownloads()
  }
  item._loadedBase = (item._loadedBase || 0) + partLoaded
  item._totalBase = (item._totalBase || 0) + partTotal
  return URL.createObjectURL(new Blob(chunks, { type: mimeType }))
}

function downloadIcon(state) {
  if (state === "ready")
    return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 8.4l2.6 2.6L12 5.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  if (state === "error")
    return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`
  if (state === "downloading") return `<span class="spinner"></span>`
  return `<span class="dot"></span>`
}

function renderDownloads() {
  ui.downloadsList.innerHTML = ""
  Object.values(downloads).forEach((item) => {
    const pct = item.state === "ready" ? 100 : Math.round(item.progress)
    const sizeInfo = item.total
      ? `${prettifyBytes(item.loaded)} / ${prettifyBytes(item.total)}`
      : ""
    const speedInfo =
      item.state === "downloading" && item.speed > 0
        ? `${prettifyBytes(item.speed)}/s`
        : ""
    const meta = [speedInfo, sizeInfo].filter(Boolean).join(" · ")
    const showTrack = item.state === "downloading"
    const footMeta =
      item.state === "pending" && item.pendingNote ? item.pendingNote : meta
    const li = document.createElement("li")
    li.className = `item item-${item.state}`
    li.innerHTML = `
      <span class="item-icon">${downloadIcon(item.state)}</span>
      <div class="item-body">
        <div class="item-head">
          <strong>${item.label}</strong>
          <span class="item-pct">${item.state === "ready" ? "✓" : `${pct}%`}</span>
        </div>
        ${
          showTrack
            ? `<div class="dl-track${!item.total ? " is-indeterminate" : ""}">
                <div class="dl-fill" style="width:${pct}%"></div>
              </div>`
            : ""
        }
        <div class="item-foot">
          <span class="item-state">${STATE_LABEL[item.state] || item.state}</span>
          <span class="item-meta">${footMeta}</span>
        </div>
      </div>`
    ui.downloadsList.appendChild(li)
  })

  const tracked = Object.values(downloads).filter(
    (i) => i.state !== "pending",
  )
  const overall = tracked.length
    ? tracked.reduce(
        (acc, i) => acc + (i.state === "ready" ? 100 : i.progress),
        0,
      ) / tracked.length
    : 0
  const allReady =
    tracked.length > 0 && tracked.every((i) => i.state === "ready")
  const hasError = Object.values(downloads).some((i) => i.state === "error")
  const liveCount = Object.values(downloads).filter(
    (i) => i.state === "downloading",
  ).length

  ui.downloadsRing.style.strokeDasharray = String(RING_C)
  ui.downloadsRing.style.strokeDashoffset = String(
    RING_C * (1 - overall / 100),
  )
  ui.downloadsPct.textContent = `${Math.round(overall)}%`

  ui.downloadsOverall.style.width = `${overall}%`
  ui.downloadsPanel.classList.toggle("is-ready", allReady)
  ui.downloadsPanel.classList.toggle("is-error", hasError)
  ui.downloadsToggle.classList.toggle("is-ready", allReady)
  ui.downloadsToggle.classList.toggle("is-error", hasError)
  ui.downloadsToggle.classList.toggle("is-busy", liveCount > 0 && !allReady)

  ui.downloadsSummary.textContent = allReady
    ? "Todo listo"
    : hasError
      ? "Con errores"
      : liveCount
        ? `${liveCount} en curso`
        : ""

  const labelText = allReady
    ? "All ready"
    : hasError
      ? "Download failed"
      : liveCount
        ? "Download in progress"
        : "Preparing models"
  ui.downloadsLabel.textContent = labelText
  ui.downloadsLabel.dataset.state = allReady
    ? "ready"
    : hasError
      ? "error"
      : "busy"
}

// ── Lazy model loaders ──
async function ensureFfmpeg() {
  if (ffmpeg) return ffmpeg
  updateDownloadStatus("ffmpeg", "downloading")
  // The Vite-bundled worker is a module worker, so it loads the core via
  // dynamic import() and reads `.default` (only the ESM core has one).
  //
  // The core JS *must* be a real URL, not a blob: an ESM module imported
  // from a blob: URL gets `import.meta.url = blob:…` and can't resolve its
  // assets, which breaks load(). So we import the core straight from the
  // CDN (it's tiny, ~110 KB) and only stream the big 31 MB .wasm with a
  // progress bar — the library's mainScriptUrlOrBlob hack makes the core
  // fetch the wasm from the URL we provide here.
  const coreBase = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm"
  const coreURL = `${coreBase}/ffmpeg-core.js`
  console.info("[ffmpeg] fetching core WASM…")
  const wasmURL = await fetchWithProgress(
    `${coreBase}/ffmpeg-core.wasm`,
    "ffmpeg",
    "application/wasm",
    32232419,
  )
  console.info("[ffmpeg] core WASM ready:", wasmURL)

  // classWorkerURL is the Vite-bundled ESM worker served same-origin; this
  // avoids the default worker failing to resolve its relative imports.
  const classWorkerURL = ffmpegWorkerURL
  console.info("[ffmpeg] class worker url:", classWorkerURL)

  ffmpeg = new FFmpeg()
  ffmpeg.on("log", ({ type, message }) => {
    console.info(`[ffmpeg:${type}] ${message}`)
  })
  ffmpeg.on("progress", ({ progress, time }) => {
    if (typeof onFfmpegProgress === "function") onFfmpegProgress(progress)
  })

  console.info("[ffmpeg] calling load()…")
  const t0 = performance.now()
  const watchdog = setInterval(() => {
    console.warn(
      `[ffmpeg] load() still pending after ${Math.round(
        (performance.now() - t0) / 1000,
      )}s`,
    )
  }, 3000)
  try {
    await ffmpeg.load({ classWorkerURL, coreURL, wasmURL })
    console.info(
      `[ffmpeg] load() resolved in ${Math.round(performance.now() - t0)}ms`,
    )
  } catch (err) {
    console.error("[ffmpeg] load() failed:", err)
    throw err
  } finally {
    clearInterval(watchdog)
  }
  updateDownloadStatus("ffmpeg", "ready")
  return ffmpeg
}

async function ensureRecognizer() {
  if (recognizer) return recognizer
  updateDownloadStatus("asr", "downloading")
  const options = { progress_callback: makeTransformersTracker("asr") }
  if (hasWebGPU) options.device = "webgpu"
  recognizer = await pipeline(
    "automatic-speech-recognition",
    ASR_MODEL,
    options,
  )
  updateDownloadStatus("asr", "ready")
  return recognizer
}

async function ensureTranslator() {
  if (translator) return translator
  updateDownloadStatus("translation", "downloading")
  translator = await pipeline("translation", TRANSLATION_MODEL, {
    progress_callback: makeTransformersTracker("translation"),
  })
  updateDownloadStatus("translation", "ready")
  return translator
}

async function preloadAssetsInBackground() {
  await Promise.allSettled([
    ensureFfmpeg().catch((e) => {
      console.error(e)
      updateDownloadStatus("ffmpeg", "error")
    }),
    ensureRecognizer().catch((e) => {
      console.error(e)
      updateDownloadStatus("asr", "error")
    }),
  ])
}

// ── Audio extraction ──
async function extractAudioBuffer(file) {
  setStatus("Cargando FFmpeg…", "busy")
  startProgressCreep(2, 12, 4000)
  const worker = await ensureFfmpeg()
  stopProgressCreep()
  const inputName = "input-video"
  const outputName = "audio.wav"
  setStatus("Preparando vídeo…", "busy")
  startProgressCreep(12, 18, 2500)
  await worker.writeFile(inputName, await fetchFile(file))
  stopProgressCreep()
  setStatus("Extrayendo audio…", "busy")
  setProgress(18)
  // ffmpeg reports decode progress as 0→1; map it onto 18%→34% so the bar
  // moves continuously while the audio track is demuxed.
  onFfmpegProgress = (p) => {
    const ratio = Math.max(0, Math.min(1, p || 0))
    applyProgress(18 + ratio * 16)
  }
  await worker.exec([
    "-i",
    inputName,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "wav",
    outputName,
  ])
  onFfmpegProgress = null
  setStatus("Decodificando audio…", "busy")
  // readFile + decodeAudioData are opaque; creep 34→42 so it keeps moving.
  startProgressCreep(34, 42, 2500)
  const outputData = await worker.readFile(outputName)
  await worker.deleteFile(inputName)
  await worker.deleteFile(outputName)
  const audioContext = new AudioContext({ sampleRate: 16000 })
  const decoded = await audioContext.decodeAudioData(
    outputData.buffer.slice(0),
  )
  const mono = decoded.getChannelData(0)
  const copied = new Float32Array(mono.length)
  copied.set(mono)
  await audioContext.close()
  stopProgressCreep()
  setProgress(42)
  return copied
}

// ── Translation ──
async function translateSegments(segments, sourceLang, targetLang) {
  if (!segments.length || sourceLang === targetLang)
    return segments.map((s) => ({ ...s }))
  if (!LANGS[sourceLang] || !LANGS[targetLang])
    return segments.map((s) => ({ ...s }))
  setStatus(`Traduciendo a ${LANGS[targetLang].label}…`, "busy")
  const worker = await ensureTranslator()
  const texts = segments.map((s) => s.text)
  const translated = await worker(texts, {
    src_lang: LANGS[sourceLang].nllb,
    tgt_lang: LANGS[targetLang].nllb,
  })
  const normalized = Array.isArray(translated) ? translated : [translated]
  return segments.map((s, i) => ({
    ...s,
    text: (
      normalized[i]?.translation_text ||
      normalized[i]?.generated_text ||
      s.text
    ).trim(),
  }))
}

// ── Generate flow ──
async function generate() {
  if (!selectedVideoFile || exporting) return
  ui.transcribeBtn.disabled = true
  ui.downloadVideoBtn.disabled = true
  ui.downloadSrtBtn.disabled = true
  ui.configError.hidden = true
  ui.configError.textContent = ""
  ui.configProgress.hidden = false
  setStatus("Preparando…", "busy")
  setProgress(2)
  try {
    const audio = await extractAudioBuffer(selectedVideoFile)
    setStatus("Cargando modelo de voz…", "busy")
    startProgressCreep(42, 58, 8000)
    const asr = await ensureRecognizer()
    stopProgressCreep()
    setProgress(58)
    setStatus("Transcribiendo…", "busy")
    // Whisper runs as one opaque call; creep toward 86% over a rough
    // estimate (~0.7× audio duration) so the bar keeps moving meanwhile.
    const audioSeconds = audio.length / 16000
    startProgressCreep(58, 86, Math.max(4000, audioSeconds * 700))
    const output = await asr(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      language: ui.inputLang.value || null,
    })
    stopProgressCreep()
    setProgress(86)

    detectedLang =
      normalizeLanguageCode(output?.language) ||
      normalizeLanguageCode(ui.inputLang.value) ||
      "en"
    ui.detected.textContent = `Detectado: ${LANGS[detectedLang]?.label || detectedLang}`

    baseSegments = normalizeSegments(output)
    if (!baseSegments.length)
      throw new Error("No se detectó voz en el vídeo.")

    const target = outputTarget(detectedLang)
    const targets = [detectedLang]
    if (target !== detectedLang && !targets.includes(target))
      targets.push(target)

    segmentsByLang = {}
    let done = 0
    for (const lang of targets) {
      if (lang === detectedLang) {
        segmentsByLang[lang] = baseSegments.map((s) => ({ ...s }))
      } else {
        startProgressCreep(
          86 + (done / targets.length) * 14,
          86 + ((done + 1) / targets.length) * 14,
          6000,
        )
        segmentsByLang[lang] = await translateSegments(
          baseSegments,
          detectedLang,
          lang,
        )
        stopProgressCreep()
      }
      done += 1
      setProgress(86 + (done / targets.length) * 14)
    }

    orderedLangs = targets
    activeLang = target
    renderTabs()
    renderSegments()
    enableExports(true)
    ui.addSegBtn.disabled = false
    setProgress(100)
    setStatus(
      `Listo · ${baseSegments.length} líneas · ${targets.length} idioma(s).`,
      "ok",
    )
    setStage("editor")
    updateCaption()
    ui.configProgress.hidden = true
  } catch (error) {
    console.error(error)
    const message = error?.message || "Error durante la generación."
    setStatus(message, "error")
    setProgress(0)
    ui.configError.textContent = message
    ui.configError.hidden = false
    ui.configProgress.hidden = true
  } finally {
    ui.transcribeBtn.disabled = false
  }
}

function enableExports(on) {
  const ready = on && currentSegments().length > 0
  ui.downloadSrtBtn.disabled = !ready
  ui.downloadVideoBtn.disabled = !ready
}

// ── Rendering: language selects, tabs, segments ──
function buildLangSelects() {
  ui.inputLang.innerHTML =
    '<option value="">Detectar automáticamente</option>'
  ui.outputLang.innerHTML =
    '<option value="same">El mismo que el audio</option>'
  Object.entries(LANGS).forEach(([code, { label }]) => {
    const inOpt = document.createElement("option")
    inOpt.value = code
    inOpt.textContent = label
    ui.inputLang.appendChild(inOpt)

    const outOpt = document.createElement("option")
    outOpt.value = code
    outOpt.textContent = label
    ui.outputLang.appendChild(outOpt)
  })
}

function renderTabs() {
  ui.langTabs.innerHTML = ""
  orderedLangs.forEach((lang) => {
    const tab = document.createElement("button")
    tab.type = "button"
    tab.className = `tab${lang === activeLang ? " is-active" : ""}`
    tab.textContent = LANGS[lang]?.label || lang
    tab.addEventListener("click", () => {
      if (activeLang === lang) return
      activeLang = lang
      renderTabs()
      renderSegments()
      enableExports(true)
      updateCaption()
    })
    ui.langTabs.appendChild(tab)
  })
}

function renderSegments() {
  const segments = currentSegments()
  ui.segList.innerHTML = ""
  if (!segments.length) {
    ui.segList.innerHTML =
      '<li class="seg-empty">Genera subtítulos para editarlos aquí.</li>'
    ui.segCount.textContent = ""
    renderTimeline()
    return
  }
  segments.forEach((seg, index) => {
    const li = document.createElement("li")
    li.className = "seg"
    li.dataset.index = String(index)
    li.innerHTML = `
      <div class="seg-row">
        <button class="seg-play" type="button" title="Ir a este momento" aria-label="Ir">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M3 2l5 3.5L3 9V2z" fill="currentColor"/></svg>
        </button>
        <input class="t-input t-start" value="${formatClock(seg.start)}" aria-label="Inicio" />
        <span class="t-sep">→</span>
        <input class="t-input t-end" value="${formatClock(seg.end)}" aria-label="Fin" />
        <button class="seg-del" type="button" title="Eliminar línea" aria-label="Eliminar">✕</button>
      </div>
      <textarea class="seg-text" rows="2" spellcheck="false">${seg.text.replace(/</g, "&lt;")}</textarea>
    `
    ui.segList.appendChild(li)
  })
  ui.segCount.textContent = `${segments.length} líneas`
  renderTimeline()
}

// Event delegation for sidebar edits
ui.segList.addEventListener("input", (event) => {
  const li = event.target.closest(".seg")
  if (!li) return
  const index = Number(li.dataset.index)
  const seg = currentSegments()[index]
  if (!seg) return
  if (event.target.classList.contains("seg-text")) {
    seg.text = event.target.value
    updateCaption()
  }
})

ui.segList.addEventListener("change", (event) => {
  const li = event.target.closest(".seg")
  if (!li) return
  const index = Number(li.dataset.index)
  const seg = currentSegments()[index]
  if (!seg) return
  if (
    event.target.classList.contains("t-start") ||
    event.target.classList.contains("t-end")
  ) {
    const parsed = parseClock(event.target.value)
    if (parsed === null) {
      event.target.value = formatClock(
        event.target.classList.contains("t-start") ? seg.start : seg.end,
      )
      return
    }
    if (event.target.classList.contains("t-start")) seg.start = parsed
    else seg.end = parsed
    if (seg.end <= seg.start) seg.end = seg.start + 0.5
    currentSegments().sort((a, b) => a.start - b.start)
    renderSegments()
    updateCaption()
  }
})

ui.segList.addEventListener("click", (event) => {
  const li = event.target.closest(".seg")
  if (!li) return
  const index = Number(li.dataset.index)
  const seg = currentSegments()[index]
  if (!seg) return
  if (event.target.closest(".seg-play")) {
    ui.video.currentTime = seg.start
    ui.video.play().catch(() => {})
  } else if (event.target.closest(".seg-del")) {
    currentSegments().splice(index, 1)
    renderSegments()
    enableExports(true)
    updateCaption()
  }
})

// Editing a line moves the video to that moment.
ui.segList.addEventListener("focusin", (event) => {
  const li = event.target.closest(".seg")
  if (!li) return
  const isEditable =
    event.target.classList.contains("seg-text") ||
    event.target.classList.contains("t-input")
  if (!isEditable) return
  const index = Number(li.dataset.index)
  const seg = currentSegments()[index]
  if (!seg) return
  if (Math.abs(ui.video.currentTime - seg.start) > 0.05)
    ui.video.currentTime = seg.start
})

ui.addSegBtn.addEventListener("click", () => {
  const segments = currentSegments()
  const t = ui.video.currentTime || 0
  segments.push({ start: t, end: t + 2, text: "" })
  segments.sort((a, b) => a.start - b.start)
  renderSegments()
  enableExports(true)
  const created = $(
    `.seg[data-index="${segments.findIndex((s) => s.start === t)}"] .seg-text`,
    ui.segList,
  )
  created?.focus()
})

// ── Timeline (video-editor style) ──
const TL_MIN_DUR = 0.3
let tlPxPerSec = 90
let tlDuration = 0
let tlDrag = null

function tlTotalDuration() {
  const segs = currentSegments()
  const segEnd = segs.length ? segs[segs.length - 1].end : 0
  return Math.max(tlDuration, segEnd, 1)
}

function renderTimeline() {
  if (!ui.timelineBlocks) return
  const segments = currentSegments()
  const dur = tlTotalDuration()
  ui.timelineTrack.style.width = `${dur * tlPxPerSec}px`

  // Ruler ticks — choose a step that keeps labels legible.
  let step = 1
  if (tlPxPerSec < 24) step = 15
  else if (tlPxPerSec < 45) step = 10
  else if (tlPxPerSec < 80) step = 5
  else if (tlPxPerSec < 140) step = 2
  else step = 1
  let ruler = ""
  for (let t = 0; t <= dur + 0.001; t += step) {
    const left = t * tlPxPerSec
    ruler += `<span class="tl-tick" style="left:${left}px"><i></i><b>${formatClock(t)}</b></span>`
  }
  ui.timelineRuler.innerHTML = ruler

  // Subtitle blocks
  ui.timelineBlocks.innerHTML = ""
  segments.forEach((seg, index) => {
    const block = document.createElement("div")
    block.className = "tl-block"
    block.dataset.index = String(index)
    block.style.left = `${seg.start * tlPxPerSec}px`
    block.style.width = `${Math.max(TL_MIN_DUR, seg.end - seg.start) * tlPxPerSec}px`
    block.innerHTML = `
      <span class="tl-handle tl-handle-l" data-edge="start"></span>
      <span class="tl-block-label">${(seg.text || "—").replace(/</g, "&lt;")}</span>
      <span class="tl-handle tl-handle-r" data-edge="end"></span>
    `
    ui.timelineBlocks.appendChild(block)
  })
  updateTimelinePlayhead()
}

function updateTimelinePlayhead() {
  if (!ui.timelinePlayhead) return
  const t = ui.video.currentTime || 0
  ui.timelinePlayhead.style.left = `${t * tlPxPerSec}px`
  if (ui.tlClock)
    ui.tlClock.textContent = `${formatClock(t)} / ${formatClock(tlTotalDuration())}`
  // Keep the playhead in view while playing.
  if (!ui.video.paused && ui.timelineScroll) {
    const x = t * tlPxPerSec
    const view = ui.timelineScroll
    if (
      x < view.scrollLeft + 60 ||
      x > view.scrollLeft + view.clientWidth - 60
    ) {
      view.scrollLeft = x - view.clientWidth * 0.4
    }
  }
}

function setTimelineActive(idx) {
  if (!ui.timelineBlocks) return
  $$(".tl-block.is-active", ui.timelineBlocks).forEach((el) =>
    el.classList.remove("is-active"),
  )
  if (idx >= 0) {
    $(`.tl-block[data-index="${idx}"]`, ui.timelineBlocks)?.classList.add(
      "is-active",
    )
  }
}

function seekFromTimelineEvent(event) {
  const rect = ui.timelineTrack.getBoundingClientRect()
  const x = event.clientX - rect.left
  const t = Math.max(0, Math.min(tlTotalDuration(), x / tlPxPerSec))
  ui.video.currentTime = t
  updateCaption()
}

// Seek by clicking the ruler.
ui.timelineRuler?.addEventListener("pointerdown", seekFromTimelineEvent)

// Drag / trim blocks.
ui.timelineBlocks?.addEventListener("pointerdown", (event) => {
  const block = event.target.closest(".tl-block")
  if (!block) return
  const handle = event.target.closest(".tl-handle")
  const index = Number(block.dataset.index)
  const seg = currentSegments()[index]
  if (!seg) return
  event.preventDefault()
  tlDrag = {
    index,
    seg,
    block,
    mode: handle ? handle.dataset.edge : "move",
    startX: event.clientX,
    origStart: seg.start,
    origEnd: seg.end,
    moved: false,
  }
  block.setPointerCapture?.(event.pointerId)
  block.classList.add("is-dragging")
})

ui.timelineBlocks?.addEventListener("pointermove", (event) => {
  if (!tlDrag) return
  const dx = event.clientX - tlDrag.startX
  const dt = dx / tlPxPerSec
  if (Math.abs(dx) > 3) tlDrag.moved = true
  const dur0 = tlDrag.origEnd - tlDrag.origStart
  const { seg, mode } = tlDrag
  if (mode === "move") {
    const ns = Math.max(0, tlDrag.origStart + dt)
    seg.start = ns
    seg.end = ns + dur0
  } else if (mode === "start") {
    seg.start = Math.max(
      0,
      Math.min(tlDrag.origEnd - TL_MIN_DUR, tlDrag.origStart + dt),
    )
  } else {
    seg.end = Math.max(tlDrag.origStart + TL_MIN_DUR, tlDrag.origEnd + dt)
  }
  tlDrag.block.style.left = `${seg.start * tlPxPerSec}px`
  tlDrag.block.style.width = `${(seg.end - seg.start) * tlPxPerSec}px`
  // Mirror to the sidebar inputs live.
  const li = $(`.seg[data-index="${tlDrag.index}"]`, ui.segList)
  if (li) {
    const s = $<HTMLInputElement>(".t-start", li)
    const e = $<HTMLInputElement>(".t-end", li)
    if (s) s.value = formatClock(seg.start)
    if (e) e.value = formatClock(seg.end)
  }
  updateCaption()
})

function endTimelineDrag() {
  if (!tlDrag) return
  const { block, moved, seg } = tlDrag
  block.classList.remove("is-dragging")
  tlDrag = null
  currentSegments().sort((a, b) => a.start - b.start)
  renderSegments()
  enableExports(true)
  if (!moved) {
    // A simple click on the block seeks to its start.
    ui.video.currentTime = seg.start
  }
  updateCaption()
}

ui.timelineBlocks?.addEventListener("pointerup", endTimelineDrag)
ui.timelineBlocks?.addEventListener("pointercancel", endTimelineDrag)

ui.tlPlay?.addEventListener("click", () => {
  if (ui.video.paused) ui.video.play().catch(() => {})
  else ui.video.pause()
})
ui.video.addEventListener("play", () =>
  ui.timeline?.classList.add("is-playing"),
)
ui.video.addEventListener("pause", () =>
  ui.timeline?.classList.remove("is-playing"),
)
ui.tlZoomIn?.addEventListener("click", () => {
  tlPxPerSec = Math.min(400, tlPxPerSec * 1.4)
  renderTimeline()
})
ui.tlZoomOut?.addEventListener("click", () => {
  tlPxPerSec = Math.max(12, tlPxPerSec / 1.4)
  renderTimeline()
})
ui.video.addEventListener("loadedmetadata", () => {
  tlDuration = Number.isFinite(ui.video.duration) ? ui.video.duration : 0
  renderTimeline()
})

// ── Caption overlay + active highlight ──
function updateCaption() {
  updateTimelinePlayhead()
  const segments = currentSegments()
  if (!segments.length || !ui.video.duration) {
    ui.caption.textContent = ""
    setTimelineActive(-1)
    return
  }
  const current = ui.video.currentTime
  const idx = segments.findIndex(
    (s) => current >= s.start && current <= s.end,
  )
  ui.caption.textContent = idx >= 0 ? segments[idx].text : ""
  setTimelineActive(idx)
  $$(".seg.is-active", ui.segList).forEach((el) =>
    el.classList.remove("is-active"),
  )
  if (idx >= 0) {
    const li = $(`.seg[data-index="${idx}"]`, ui.segList)
    if (li && document.activeElement?.tagName !== "TEXTAREA") {
      li.classList.add("is-active")
      li.scrollIntoView({ block: "nearest" })
    }
  }
}

// ── File handling ──
function handleSelectedFile(file) {
  if (!file) return
  const isVideo =
    file.type.startsWith("video/") ||
    file.type === "" ||
    /\.(mp4|mov|webm|mkv|avi|m4v|ogv|wmv)$/i.test(file.name)
  if (!isVideo) return

  if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl)
  selectedVideoFile = file
  videoObjectUrl = URL.createObjectURL(file)
  ui.video.src = videoObjectUrl
  ui.video.load()
  ui.configVideo.src = videoObjectUrl
  ui.configVideo.load()

  baseSegments = []
  segmentsByLang = {}
  orderedLangs = []
  activeLang = ""
  ui.langTabs.innerHTML = ""
  renderSegments()
  ui.addSegBtn.disabled = true
  enableExports(false)

  ui.outputLang.value = "same"
  ui.inputLang.value = ""

  const metaText = `${file.name} · ${prettifyBytes(file.size)}`
  ui.meta.textContent = metaText
  ui.configMeta.textContent = metaText
  ui.detected.textContent = ""
  setStatus("Vídeo cargado.", "ok")
  setProgress(0)
  ui.configProgress.hidden = true
  ui.configError.hidden = true
  ui.configError.textContent = ""
  setStage("config")
}

function resetFlow() {
  if (exporting) return
  if (videoObjectUrl) {
    URL.revokeObjectURL(videoObjectUrl)
    videoObjectUrl = ""
  }
  selectedVideoFile = null
  baseSegments = []
  segmentsByLang = {}
  orderedLangs = []
  activeLang = ""
  ui.caption.textContent = ""
  ui.video.removeAttribute("src")
  ui.video.load()
  ui.configVideo.removeAttribute("src")
  ui.configVideo.load()
  enableExports(false)
  setStage("upload")
}

// Back from editor to the configuration step.
function backToConfig() {
  if (exporting) return
  ui.video.pause()
  setStage("config")
}

// ── Download .srt ──
function downloadSrt() {
  const segments = currentSegments()
  if (!segments.length) return
  const blob = new Blob([buildSrt(segments)], {
    type: "text/plain;charset=utf-8",
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `${baseFileName()}.${activeLang}.srt`
  link.click()
  URL.revokeObjectURL(url)
}

// ── Download video with burned-in subtitles (canvas + MediaRecorder) ──
function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/)
  const lines = []
  let line = ""
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = word
    } else {
      line = test
    }
  }
  if (line) lines.push(line)
  return lines
}

function drawFrame(ctx, video, w, h, segments) {
  ctx.drawImage(video, 0, 0, w, h)
  const current = video.currentTime
  const seg = segments.find((s) => current >= s.start && current <= s.end)
  if (!seg || !seg.text.trim()) return

  const c = captionStyle
  const fontSize = Math.round(h * 0.052 * c.size)
  ctx.font = `${c.weight} ${fontSize}px ${FONT_STACKS[c.font] || FONT_STACKS.sans}`
  ctx.textAlign = "center"
  ctx.textBaseline = "alphabetic"

  const lines = wrapText(ctx, seg.text.trim(), w * 0.82)
  const lineHeight = fontSize * 1.28
  const padX = fontSize * 0.5
  const padY = fontSize * 0.3
  const blockH = lines.length * lineHeight
  let y
  if (c.position === "top") {
    y = h * 0.08 + fontSize
  } else if (c.position === "middle") {
    y = (h - blockH) / 2 + fontSize
  } else {
    y = h - h * 0.06 - (lines.length - 1) * lineHeight
  }

  lines.forEach((line) => {
    const metrics = ctx.measureText(line)
    if (c.bgEnabled) {
      const boxW = metrics.width + padX * 2
      const boxH = lineHeight + padY
      ctx.fillStyle = hexToRgba(c.bgColor, c.bgOpacity)
      const boxX = (w - boxW) / 2
      const boxY = y - fontSize - padY / 2
      const r = fontSize * 0.18
      ctx.beginPath()
      ctx.moveTo(boxX + r, boxY)
      ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, r)
      ctx.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, r)
      ctx.arcTo(boxX, boxY + boxH, boxX, boxY, r)
      ctx.arcTo(boxX, boxY, boxX + boxW, boxY, r)
      ctx.closePath()
      ctx.fill()
    }

    // Outline / soft shadow for readability when there's no box.
    if (!c.bgEnabled && c.outline) {
      ctx.lineWidth = Math.max(2, fontSize * 0.14)
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)"
      ctx.lineJoin = "round"
      ctx.miterLimit = 2
      ctx.strokeText(line, w / 2, y)
    } else if (!c.bgEnabled) {
      ctx.shadowColor = "rgba(0, 0, 0, 0.8)"
      ctx.shadowBlur = fontSize * 0.25
      ctx.shadowOffsetY = fontSize * 0.04
    }

    ctx.fillStyle = c.color
    ctx.fillText(line, w / 2, y)
    ctx.shadowColor = "transparent"
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
    y += lineHeight
  })
}

// ── Export progress modal ──
const EXPORT_STEPS = [
  { id: "prepare", label: "Preparando lienzo y audio" },
  { id: "render", label: "Grabando vídeo con subtítulos" },
  { id: "encode", label: "Generando el archivo" },
  { id: "done", label: "Descarga lista" },
]

function openExportModal() {
  ui.exportSteps.innerHTML = EXPORT_STEPS.map(
    (s) =>
      `<li class="export-step" data-id="${s.id}" data-state="pending"><span class="export-step-dot"></span><span class="export-step-label">${s.label}</span></li>`,
  ).join("")
  ui.exportError.hidden = true
  ui.exportError.textContent = ""
  ui.exportClose.hidden = true
  ui.exportTitle.textContent = "Exportando vídeo"
  ui.exportHint.hidden = false
  setExportStep("prepare", "active")
  setExportStage("Preparando…", "busy")
  setExportProgress(0)
  ui.exportModal.hidden = false
}

function closeExportModal() {
  if (exporting) return
  ui.exportModal.hidden = true
}

function setExportStage(text, kind = "busy") {
  ui.exportStage.textContent = text
  ui.exportStage.dataset.kind = kind
}

function setExportProgress(percent) {
  const clamped = Math.max(0, Math.min(100, percent))
  ui.exportFill.style.width = `${clamped}%`
  ui.exportPct.textContent = `${Math.round(clamped)}%`
}

function setExportStep(id, state) {
  const el = $(`[data-id="${id}"]`, ui.exportSteps)
  if (el) el.dataset.state = state
}

function failExport(message) {
  setExportStage("No se pudo exportar", "error")
  ui.exportError.textContent = message
  ui.exportError.hidden = false
  ui.exportHint.hidden = true
  ui.exportClose.hidden = false
}

// ── Download video with burned-in subtitles (canvas + MediaRecorder) ──
async function downloadVideo() {
  const segments = currentSegments()
  if (!segments.length || exporting) return
  const video = ui.video

  openExportModal()

  const capture = video.captureStream
    ? video.captureStream.bind(video)
    : video.mozCaptureStream
      ? video.mozCaptureStream.bind(video)
      : null
  if (!capture || typeof MediaRecorder === "undefined") {
    failExport(
      "Tu navegador no permite exportar vídeo en el cliente. Prueba con Chrome o Edge de escritorio.",
    )
    return
  }

  exporting = true
  ui.downloadVideoBtn.disabled = true
  ui.downloadSrtBtn.disabled = true
  ui.transcribeBtn.disabled = true
  ui.backBtn.disabled = true

  const w = video.videoWidth || 1280
  const h = video.videoHeight || 720
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d")

  const canvasStream = canvas.captureStream(30)
  let hasAudio = false
  try {
    const elementStream = capture()
    elementStream.getAudioTracks().forEach((track) => {
      canvasStream.addTrack(track)
      hasAudio = true
    })
  } catch (e) {
    console.warn("Sin pista de audio para la exportación", e)
  }

  const mimeType =
    [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ].find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm"
  let recorder
  try {
    recorder = new MediaRecorder(canvasStream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
    })
  } catch (e) {
    console.error(e)
    exporting = false
    ui.backBtn.disabled = false
    ui.transcribeBtn.disabled = false
    enableExports(true)
    failExport("No se pudo iniciar la grabación del vídeo.")
    return
  }

  const chunks = []
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }

  const finished = new Promise((resolve) => {
    recorder.onstop = () => {
      setExportStep("render", "done")
      setExportStep("encode", "active")
      setExportStage("Generando el archivo…", "busy")
      const blob = new Blob(chunks, { type: "video/webm" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `${baseFileName()}.${activeLang}.webm`
      link.click()
      URL.revokeObjectURL(url)
      resolve()
    }
  })

  const previousVolume = video.volume
  const wasMuted = video.muted
  video.muted = true
  video.volume = 0

  setExportStage("Preparando el vídeo…", "busy")
  video.pause()
  try {
    video.currentTime = 0
  } catch {}
  await new Promise((r) => setTimeout(r, 150))

  setExportStep("prepare", "done")
  setExportStep("render", "active")
  setExportStage(
    hasAudio
      ? "Grabando vídeo con subtítulos…"
      : "Grabando vídeo con subtítulos (sin audio)…",
    "busy",
  )
  ui.exportHint.textContent =
    "Mantén esta pestaña activa: el vídeo se reproduce una vez para grabarse."

  let raf = 0
  let stopped = false
  const stopRecording = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(raf)
    video.removeEventListener("ended", onEnded)
    if (recorder.state !== "inactive") recorder.stop()
  }
  const onEnded = () => stopRecording()

  const tick = () => {
    drawFrame(ctx, video, w, h, segments)
    const dur = video.duration
    if (dur && isFinite(dur)) {
      // Reserve the last 6% for file generation.
      setExportProgress(Math.min(94, (video.currentTime / dur) * 94))
      if (video.currentTime >= dur - 0.05) {
        stopRecording()
        return
      }
    }
    raf = requestAnimationFrame(tick)
  }

  video.addEventListener("ended", onEnded)
  recorder.start(100)
  tick()

  try {
    await video.play()
  } catch (e) {
    console.error(e)
    stopRecording()
    recorder.onstop = null
    if (recorder.state !== "inactive") recorder.stop()
    video.muted = wasMuted
    video.volume = previousVolume
    exporting = false
    ui.backBtn.disabled = false
    ui.transcribeBtn.disabled = false
    enableExports(true)
    failExport(
      "El navegador bloqueó la reproducción necesaria para grabar. Inténtalo de nuevo.",
    )
    return
  }

  await finished

  video.muted = wasMuted
  video.volume = previousVolume
  exporting = false
  ui.backBtn.disabled = false
  ui.transcribeBtn.disabled = false
  enableExports(true)

  setExportStep("encode", "done")
  setExportStep("done", "done")
  setExportProgress(100)
  setExportStage("¡Vídeo exportado! Revisa tus descargas.", "ok")
  ui.exportTitle.textContent = "Exportación completada"
  ui.exportHint.hidden = true
  ui.exportClose.hidden = false
  setStatus("Vídeo exportado.", "ok")
}

// ── Global drag & drop ──
function attachGlobalDrop() {
  const hasFiles = (e) =>
    Array.from(e.dataTransfer?.types || []).includes("Files")
  const setDragging = (active) => {
    ui.dropzone.classList.toggle("over", active)
    ui.app.classList.toggle("is-dragging", active)
  }
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth += 1
    setDragging(true)
  })
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
  })
  document.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) setDragging(false)
  })
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth = 0
    setDragging(false)
    handleSelectedFile(e.dataTransfer?.files?.[0])
  })
}

// ── Subtitle style: live preview + presets ──
function hexToRgba(hex, alpha = 1) {
  let h = String(hex || "#000000").replace("#", "")
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("")
  }
  const n = parseInt(h, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Apply the visual part of a style (font, color, background, shadow) to any
// element — shared by the live overlay and the preset thumbnails.
function applyVisualStyle(el, s) {
  el.style.fontFamily = FONT_STACKS[s.font] || FONT_STACKS.sans
  el.style.fontWeight = String(s.weight || 600)
  el.style.color = s.color || "#ffffff"
  el.style.background = s.bgEnabled
    ? hexToRgba(s.bgColor, s.bgOpacity)
    : "transparent"
  el.style.textShadow = s.outline
    ? "0 1px 2px rgba(0,0,0,.95), 0 0 5px rgba(0,0,0,.85), 0 0 1px rgba(0,0,0,.9)"
    : s.bgEnabled
      ? "none"
      : "0 1px 3px rgba(0,0,0,.85)"
}

function applyCaptionStyle() {
  const c = captionStyle
  applyVisualStyle(ui.caption, c)
  ui.caption.style.fontSize = `clamp(${Math.round(13 * c.size)}px, ${(
    2.4 * c.size
  ).toFixed(2)}vw, ${Math.round(28 * c.size)}px)`
  ui.caption.style.padding = c.bgEnabled ? "0.22rem 0.6rem" : "0"
  ui.caption.style.top = ""
  ui.caption.style.bottom = ""
  if (c.position === "middle") {
    ui.caption.style.top = "50%"
    ui.caption.style.transform = "translate(-50%, -50%)"
  } else if (c.position === "top") {
    ui.caption.style.top = "8%"
    ui.caption.style.transform = "translateX(-50%)"
  } else {
    ui.caption.style.bottom = "8%"
    ui.caption.style.transform = "translateX(-50%)"
  }
}

function renderPresets() {
  ui.stylePresets.innerHTML = ""
  CAPTION_PRESETS.forEach((p) => {
    const on = p.id === activePresetId
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "preset" + (on ? " is-on" : "")
    btn.setAttribute("role", "tab")
    btn.setAttribute("aria-selected", on ? "true" : "false")
    btn.title = p.name

    const prev = document.createElement("span")
    prev.className = "preset-prev"
    const inner = document.createElement("span")
    inner.textContent = "Aa"
    applyVisualStyle(inner, p.s)
    inner.style.padding = p.s.bgEnabled ? "1px 6px" : "0"
    inner.style.borderRadius = "4px"
    inner.style.fontSize = "13px"
    prev.appendChild(inner)

    const name = document.createElement("span")
    name.className = "preset-name"
    name.textContent = p.name

    btn.append(prev, name)
    btn.addEventListener("click", () => applyPreset(p))
    ui.stylePresets.appendChild(btn)
  })
}

function applyPreset(p) {
  Object.assign(captionStyle, p.s)
  activePresetId = p.id
  applyCaptionStyle()
  syncStyleControls()
  renderPresets()
}

function syncStyleControls() {
  const c = captionStyle
  ui.csFont.value = c.font
  ui.csSize.value = String(c.size)
  ui.csColor.value = c.color
  ui.csBold.checked = c.weight >= 700
  ui.csOutline.checked = !!c.outline
  ui.csBg.checked = !!c.bgEnabled
  ui.csBgColor.value = c.bgColor
  ui.csBgOpacity.value = String(c.bgOpacity)
  ui.csBgColor.disabled = !c.bgEnabled
  ui.csBgOpacity.disabled = !c.bgEnabled
  $$("button", ui.csPosition).forEach((b) => {
    b.classList.toggle("is-on", b.dataset.pos === c.position)
  })
}

// A manual tweak means we're no longer on a named preset.
function onManualStyleChange() {
  activePresetId = ""
  applyCaptionStyle()
  renderPresets()
}

function wireStyleControls() {
  ui.styleToggle.addEventListener("click", () => {
    const open = ui.styleControls.hidden
    ui.styleControls.hidden = !open
    ui.styleToggle.setAttribute("aria-expanded", String(open))
    ui.styleToggle.classList.toggle("is-open", open)
  })
  ui.csFont.addEventListener("change", () => {
    captionStyle.font = ui.csFont.value
    onManualStyleChange()
  })
  ui.csSize.addEventListener("input", () => {
    captionStyle.size = Number(ui.csSize.value)
    onManualStyleChange()
  })
  ui.csColor.addEventListener("input", () => {
    captionStyle.color = ui.csColor.value
    onManualStyleChange()
  })
  ui.csBold.addEventListener("change", () => {
    captionStyle.weight = ui.csBold.checked ? 700 : 600
    onManualStyleChange()
  })
  ui.csOutline.addEventListener("change", () => {
    captionStyle.outline = ui.csOutline.checked
    onManualStyleChange()
  })
  ui.csBg.addEventListener("change", () => {
    captionStyle.bgEnabled = ui.csBg.checked
    syncStyleControls()
    onManualStyleChange()
  })
  ui.csBgColor.addEventListener("input", () => {
    captionStyle.bgColor = ui.csBgColor.value
    onManualStyleChange()
  })
  ui.csBgOpacity.addEventListener("input", () => {
    captionStyle.bgOpacity = Number(ui.csBgOpacity.value)
    onManualStyleChange()
  })
  ui.csPosition.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-pos]")
    if (!b) return
    captionStyle.position = b.dataset.pos
    syncStyleControls()
    applyCaptionStyle()
  })
}

// ── Init ──
buildLangSelects()
renderDownloads()
renderPresets()
syncStyleControls()
applyCaptionStyle()
wireStyleControls()
preloadAssetsInBackground()
setStage("upload")
attachGlobalDrop()

ui.dropzone.addEventListener("click", () => ui.input.click())
ui.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault()
    ui.input.click()
  }
})
ui.input.addEventListener("change", (e) =>
  handleSelectedFile(e.target?.files?.[0]),
)
ui.transcribeBtn.addEventListener("click", generate)
ui.backBtn.addEventListener("click", backToConfig)
ui.configBackBtn.addEventListener("click", resetFlow)
ui.downloadSrtBtn.addEventListener("click", downloadSrt)
ui.downloadVideoBtn.addEventListener("click", downloadVideo)
ui.exportClose.addEventListener("click", closeExportModal)
ui.exportBackdrop.addEventListener("click", closeExportModal)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !ui.exportModal.hidden) closeExportModal()
})
ui.video.addEventListener("timeupdate", updateCaption)
ui.video.addEventListener("seeked", updateCaption)
ui.downloadsToggle.addEventListener("click", () => {
  ui.downloadsPanel.hidden = !ui.downloadsPanel.hidden
})
