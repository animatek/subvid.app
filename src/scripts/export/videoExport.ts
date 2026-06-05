import { drawFrame, drawSubtitlesAt } from "@/scripts/export/subtitleRenderer.ts"

type VideoExportOptions = {
  ui: any
  tt: (path: string, vars?: Record<string, unknown>) => string
  currentSegments: () => any[]
  selectedVideoFile: () => File | null
  activeLang: () => string
  baseFileName: () => string
  isExporting: () => boolean
  setExporting: (value: boolean) => void
  enableExports: (on: boolean) => void
  setStatus: (message: string, kind?: string) => void
  modal: any
  verticalCameraCrop: () => VideoCrop
  verticalScreenCrop: () => VideoCrop
  fixedTitle: () => FixedTitle
  verticalSubtitles: () => { size: number; y: number }
}

type VideoCrop = { x: number; y: number; width: number; height: number }
type FixedTitle = {
  enabled: boolean
  text: string
  color: string
  font: string
  position: string
  size: number
}

type WebCodecsExportResult =
  | { handled: true }
  | { handled: false; reason: string }

type ExportFormat = "mp4" | "webm"
type ExportQuality = "optimized" | "high" | "lossless"
type ExportLayout = "original" | "vertical-stream"
type ExportSettings = {
  format: ExportFormat
  quality: ExportQuality
  layout: ExportLayout
}

const EXPORT_FORMATS = new Set<ExportFormat>(["mp4", "webm"])
const EXPORT_QUALITIES = new Set<ExportQuality>([
  "optimized",
  "high",
  "lossless",
])
const EXPORT_LAYOUTS = new Set<ExportLayout>(["original", "vertical-stream"])
const VERTICAL_EXPORT_WIDTH = 1080
const VERTICAL_EXPORT_HEIGHT = 1920
const RECORDER_MIME_TYPES: Record<ExportFormat, string[]> = {
  mp4: [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=h264,aac",
    "video/mp4",
  ],
  webm: [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ],
}
const QUALITY_BITS_PER_PIXEL: Record<ExportQuality, number> = {
  optimized: 0.07,
  high: 0.13,
  lossless: 0.24,
}
const QUALITY_MIN_BITRATE: Record<ExportQuality, number> = {
  optimized: 350_000,
  high: 1_000_000,
  lossless: 8_000_000,
}
const QUALITY_MAX_BITRATE: Record<ExportQuality, number> = {
  optimized: 18_000_000,
  high: 36_000_000,
  lossless: 80_000_000,
}
const QUALITY_SOURCE_MULTIPLIER: Record<ExportQuality, number> = {
  optimized: 1.15,
  high: 2,
  lossless: Number.POSITIVE_INFINITY,
}

export function createVideoExporter(options: VideoExportOptions) {
  const {
    ui,
    tt,
    currentSegments,
    selectedVideoFile,
    activeLang,
    baseFileName,
    isExporting,
    setExporting,
    enableExports,
    setStatus,
    modal,
    verticalCameraCrop,
    verticalScreenCrop,
    fixedTitle,
    verticalSubtitles,
  } = options

  function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error || "unknown error")
  }

  function formatDiagnostic(value: unknown) {
    if (!value) return tt("exportErrors.diagnosticUnavailable")
    if (typeof value === "string") return value
    try {
      const serialized = JSON.stringify(value)
      return serialized || tt("exportErrors.diagnosticUnavailable")
    } catch {
      return String(value)
    }
  }

  function getWebCodecsSupportIssue() {
    const missingApis = [
      typeof VideoEncoder === "undefined" ? "VideoEncoder" : "",
      typeof VideoDecoder === "undefined" ? "VideoDecoder" : "",
      typeof OffscreenCanvas === "undefined" ? "OffscreenCanvas" : "",
    ].filter(Boolean)

    if (missingApis.length) {
      return tt("exportErrors.webcodecsMissingApis", {
        apis: missingApis.join(", "),
      })
    }

    if (!selectedVideoFile()) return tt("exportErrors.webcodecsMissingFile")
    return ""
  }

  function exportSettings(): ExportSettings {
    const rawFormat = ui.exportFormat?.value
    const rawQuality = ui.exportQuality?.value
    const rawLayout = ui.exportLayout?.value
    return {
      format: EXPORT_FORMATS.has(rawFormat) ? rawFormat : "mp4",
      quality: EXPORT_QUALITIES.has(rawQuality) ? rawQuality : "optimized",
      layout: EXPORT_LAYOUTS.has(rawLayout) ? rawLayout : "original",
    }
  }

  function setExportControlsDisabled(disabled: boolean) {
    ui.downloadVideoBtn.disabled = disabled
    ui.downloadSrtBtn.disabled = disabled
    ui.exportFormat.disabled = disabled
    ui.exportQuality.disabled = disabled
    ui.exportLayout.disabled = disabled
    ui.cameraCropBtn.disabled = disabled
    ui.screenCropBtn.disabled = disabled
    ui.verticalPreviewBtn.disabled = disabled
  }

  function drawFixedTitle(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const title = fixedTitle()
    if (!title.enabled || !title.text.trim()) return
    const fontMap: Record<string, string> = {
      sans: '"Outfit", "Segoe UI", sans-serif',
      serif: 'Georgia, "Times New Roman", serif',
      rounded: '"Quicksand", "Trebuchet MS", sans-serif',
      mono: '"JetBrains Mono", monospace',
    }
    const size = Math.max(24, Math.min(140, Number(title.size) || 72))
    const y =
      title.position === "middle"
        ? h * 0.48
        : title.position === "bottom"
          ? h * 0.72
          : h * 0.08
    ctx.save()
    ctx.font = `800 ${size}px ${fontMap[title.font] || fontMap.sans}`
    ctx.textAlign = "center"
    ctx.textBaseline = "top"
    ctx.lineJoin = "round"
    ctx.miterLimit = 2
    ctx.strokeStyle = "rgba(0, 0, 0, 0.82)"
    ctx.lineWidth = Math.max(6, size * 0.12)
    ctx.fillStyle = title.color || "#ffffff"
    const maxWidth = w * 0.86
    const words = title.text.trim().split(/\s+/)
    const lines: string[] = []
    let line = ""
    words.forEach((word) => {
      const test = line ? `${line} ${word}` : word
      if (line && ctx.measureText(test).width > maxWidth) {
        lines.push(line)
        line = word
      } else {
        line = test
      }
    })
    if (line) lines.push(line)
    lines.slice(0, 3).forEach((text, index) => {
      const lineY = y + index * size * 1.12
      ctx.strokeText(text, w / 2, lineY)
      ctx.fillText(text, w / 2, lineY)
    })
    ctx.restore()
  }

  function drawCover(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ) {
    const sourceRatio = sw / sh
    const destRatio = dw / dh
    let cropX = sx
    let cropY = sy
    let cropW = sw
    let cropH = sh

    if (sourceRatio > destRatio) {
      cropW = sh * destRatio
      cropX = sx + (sw - cropW) / 2
    } else {
      cropH = sw / destRatio
      cropY = sy + (sh - cropH) / 2
    }

    ctx.drawImage(video, cropX, cropY, cropW, cropH, dx, dy, dw, dh)
  }

  function drawVerticalStreamFrame(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    segments: any[],
  ) {
    const sw = video.videoWidth || 1920
    const sh = video.videoHeight || 1080
    const w = VERTICAL_EXPORT_WIDTH
    const h = VERTICAL_EXPORT_HEIGHT
    const screenH = 1240
    const screenCrop = verticalScreenCrop()
    const cameraCrop = verticalCameraCrop()
    const screenX = Math.max(0, Math.min(sw, screenCrop.x * sw))
    const screenY = Math.max(0, Math.min(sh, screenCrop.y * sh))
    const screenW = Math.max(1, Math.min(sw - screenX, screenCrop.width * sw))
    const screenSourceH = Math.max(1, Math.min(sh - screenY, screenCrop.height * sh))
    const camX = Math.max(0, Math.min(sw, cameraCrop.x * sw))
    const camY = Math.max(0, Math.min(sh, cameraCrop.y * sh))
    const camW = Math.max(1, Math.min(sw - camX, cameraCrop.width * sw))
    const camH = Math.max(1, Math.min(sh - camY, cameraCrop.height * sh))
    const camDestW = 920
    const camDestH = 518
    const camDestX = (w - camDestW) / 2
    const camDestY = 1326

    ctx.fillStyle = "#05070a"
    ctx.fillRect(0, 0, w, h)
    const gradient = ctx.createLinearGradient(0, 0, 0, h)
    gradient.addColorStop(0, "rgba(184, 240, 96, 0.14)")
    gradient.addColorStop(0.42, "rgba(6, 8, 11, 0)")
    gradient.addColorStop(1, "rgba(96, 150, 250, 0.12)")
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, w, h)

    drawCover(ctx, video, screenX, screenY, screenW, screenSourceH, 0, 0, w, screenH)

    ctx.save()
    ctx.shadowColor = "rgba(0, 0, 0, 0.7)"
    ctx.shadowBlur = 28
    ctx.shadowOffsetY = 14
    ctx.fillStyle = "#0a0d12"
    ctx.fillRect(camDestX - 10, camDestY - 10, camDestW + 20, camDestH + 20)
    ctx.restore()

    drawCover(ctx, video, camX, camY, camW, camH, camDestX, camDestY, camDestW, camDestH)

    ctx.strokeStyle = "rgba(184, 240, 96, 0.42)"
    ctx.lineWidth = 4
    ctx.strokeRect(camDestX, camDestY, camDestW, camDestH)
    drawFixedTitle(ctx, w, h)
    const subs = verticalSubtitles()
    drawSubtitlesAt(ctx, video.currentTime, w, h, segments, {
      fontScale: subs.size,
      yPercent: subs.y,
      maxWidthRatio: 0.9,
    })
  }

  function sourceBitrateFor(duration: number) {
    const file = selectedVideoFile()
    if (!file || !Number.isFinite(duration) || duration <= 0) return 0
    return Math.round((file.size * 8) / duration)
  }

  function videoBitrateFor(quality: ExportQuality, width: number, height: number) {
    const pixels = Math.max(640 * 360, (width || 1280) * (height || 720))
    const resolutionBitrate = Math.round(
      pixels * 30 * QUALITY_BITS_PER_PIXEL[quality],
    )
    const sourceBitrate = sourceBitrateFor(ui.video.duration)
    const sourceAwareMax = sourceBitrate
      ? Math.round(sourceBitrate * QUALITY_SOURCE_MULTIPLIER[quality])
      : Number.POSITIVE_INFINITY
    const bitrate = Math.min(resolutionBitrate, sourceAwareMax)
    const targetBitrate = Math.max(
      QUALITY_MIN_BITRATE[quality],
      Math.min(QUALITY_MAX_BITRATE[quality], bitrate),
    )
    console.info("[export] video bitrate target", {
      quality,
      sourceBitrate,
      targetBitrate,
      width,
      height,
    })
    return Math.max(
      QUALITY_MIN_BITRATE[quality],
      Math.min(QUALITY_MAX_BITRATE[quality], targetBitrate),
    )
  }

  function recorderMimeType(format: ExportFormat) {
    return RECORDER_MIME_TYPES[format].find((mimeType) =>
      MediaRecorder.isTypeSupported(mimeType),
    )
  }

  async function webCodecsVideoCodec(
    mediabunny: any,
    settings: ExportSettings,
    bitrate: number,
  ) {
    const candidates = settings.format === "mp4" ? ["avc"] : ["vp9", "vp8"]
    for (const codec of candidates) {
      try {
        const supported = await mediabunny.canEncodeVideo?.(codec, {
          width: ui.video.videoWidth || undefined,
          height: ui.video.videoHeight || undefined,
          bitrate,
        })
        if (supported) return codec
      } catch {}
    }
    return candidates[0]
  }

  function downloadBlob(blob: Blob, settings: ExportSettings) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    const suffix = settings.layout === "vertical-stream" ? "_v" : ""
    link.download = `${baseFileName()}${suffix}.${activeLang()}.${settings.format}`
    link.click()
    URL.revokeObjectURL(url)
  }

  async function downloadVideo() {
    const segments = currentSegments()
    if (!segments.length || isExporting()) return

    const settings = exportSettings()
    setExporting(true)
    setExportControlsDisabled(true)
    ui.transcribeBtn.disabled = true
    ui.backBtn.disabled = true

    try {
      if (settings.format === "mp4") {
        const localResult = await exportMp4ViaLocalTranscode(segments, settings)
        if (localResult.handled) return
        console.warn(
          "[export] Local MP4 transcode unavailable; trying WebCodecs:",
          localResult.reason,
        )
      }

      let fallbackReason = getWebCodecsSupportIssue()
      if (!fallbackReason && settings.layout === "original") {
        const result = await exportWithWebCodecs(segments, settings)
        if (result.handled) return
        fallbackReason = result.reason
      }
      if (fallbackReason) {
        console.warn(
          "[export] WebCodecs unavailable; using recorder fallback:",
          fallbackReason,
        )
      }
      await exportWithRecorder(segments, settings, fallbackReason)
    } finally {
      setExporting(false)
      ui.backBtn.disabled = false
      ui.transcribeBtn.disabled = false
      enableExports(true)
    }
  }

  async function exportWithWebCodecs(
    segments: any[],
    settings: ExportSettings,
  ): Promise<WebCodecsExportResult> {
    let mediabunny: any
    try {
      mediabunny = await import("mediabunny")
    } catch (e) {
      console.warn("[export] mediabunny failed to load, falling back", e)
      return {
        handled: false,
        reason: tt("exportErrors.mediabunnyLoadFailed", {
          error: errorMessage(e),
        }),
      }
    }

    const {
      Input,
      Output,
      Conversion,
      BlobSource,
      ALL_FORMATS,
      Mp4OutputFormat,
      WebMOutputFormat,
      BufferTarget,
    } = mediabunny

    modal.openExportModal()
    modal.setExportStep("prepare", "active")
    modal.setExportStage(tt("exportStages.preparingEncoder"), "busy")
    ui.exportHint.textContent = tt("exportStages.renderingLocally")

    const file = selectedVideoFile()
    if (!file) {
      return {
        handled: false,
        reason: tt("exportErrors.webcodecsMissingFile"),
      }
    }

    const input = new Input({
      source: new BlobSource(file),
      formats: ALL_FORMATS,
    })
    const output = new Output({
      format:
        settings.format === "mp4"
          ? new Mp4OutputFormat()
          : new WebMOutputFormat(),
      target: new BufferTarget(),
    })
    const videoBitrate = videoBitrateFor(
      settings.quality,
      ui.video.videoWidth,
      ui.video.videoHeight,
    )
    const videoCodec = await webCodecsVideoCodec(
      mediabunny,
      settings,
      videoBitrate,
    )

    let canvas: any = null
    let ctx: any = null

    let conversion: any
    try {
      conversion = await Conversion.init({
        input,
        output,
        video: {
          codec: videoCodec,
          bitrate: videoBitrate,
          latencyMode: "quality",
          keyFrameInterval: settings.quality === "optimized" ? 4 : 2,
          process: (sample: any) => {
            if (!ctx) {
              canvas = new OffscreenCanvas(
                sample.displayWidth,
                sample.displayHeight,
              )
              ctx = canvas.getContext("2d")
            }
            sample.draw(ctx, 0, 0)
            drawSubtitlesAt(
              ctx,
              sample.timestamp,
              canvas.width,
              canvas.height,
              segments,
            )
            return canvas
          },
        },
      })
    } catch (e) {
      console.warn("[export] WebCodecs init failed, falling back", e)
      return {
        handled: false,
        reason: tt("exportErrors.webcodecsInitFailed", {
          error: errorMessage(e),
        }),
      }
    }

    const discardedVideoTracks = conversion.discardedTracks?.filter(
      (entry: any) => entry?.track?.type === "video" || entry?.track?.isVideoTrack?.(),
    )
    const hasUtilizedVideoTrack = conversion.utilizedTracks?.some(
      (track: any) => track?.type === "video" || track?.isVideoTrack?.(),
    )
    if (!conversion.isValid || discardedVideoTracks.length || !hasUtilizedVideoTrack) {
      console.warn(
        "[export] WebCodecs conversion cannot produce a video track, falling back",
        conversion.discardedTracks,
      )
      return {
        handled: false,
        reason: tt("exportErrors.webcodecsInvalid", {
          tracks: formatDiagnostic(conversion.discardedTracks),
        }),
      }
    }

    conversion.onProgress = (p: number) => {
      modal.setExportProgress(Math.min(95, p * 95))
    }

    modal.setExportStep("prepare", "done")
    modal.setExportStep("render", "active")
    modal.setExportStage(tt("exportStages.renderingVideo"), "busy")

    try {
      await conversion.execute()
    } catch (e: any) {
      console.error(e)
      return {
        handled: false,
        reason: tt("exportErrors.webcodecsFailed", {
          error: errorMessage(e),
        }),
      }
    }

    modal.setExportStep("render", "done")
    modal.setExportStep("encode", "done")
    modal.setExportStep("done", "active")
    modal.setExportStage(tt("exportStages.saving"), "busy")

    const blob = new Blob([output.target.buffer], {
      type: `video/${settings.format}`,
    })
    downloadBlob(blob, settings)

    modal.setExportStep("done", "done")
    modal.setExportProgress(100)
    modal.setExportStage(tt("exportStages.exported"), "ok")
    ui.exportTitle.textContent = tt("exportStages.complete")
    ui.exportHint.hidden = true
    ui.exportClose.hidden = false
    setStatus(tt("videoExported"), "ok")
    return { handled: true }
  }

  async function recordCanvasBlob(
    segments: any[],
    settings: ExportSettings,
    fallbackReason = "",
  ): Promise<Blob | null> {
    const video = ui.video

    modal.openExportModal()
    if (fallbackReason) {
      modal.setExportNotice(tt("exportStages.webcodecsFallbackNotice"))
    }

    const capture = video.captureStream
      ? video.captureStream.bind(video)
      : video.mozCaptureStream
        ? video.mozCaptureStream.bind(video)
        : null
    if (!capture || typeof MediaRecorder === "undefined") {
      modal.failExport(
        fallbackReason
          ? tt("exportErrors.noSupportAfterFallback")
          : tt("exportErrors.noSupport"),
      )
      return null
    }

    const w = settings.layout === "vertical-stream" ? VERTICAL_EXPORT_WIDTH : video.videoWidth || 1280
    const h = settings.layout === "vertical-stream" ? VERTICAL_EXPORT_HEIGHT : video.videoHeight || 720
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")

    const canvasStream = canvas.captureStream(30)
    let hasAudio = false
    try {
      const elementStream = capture()
      elementStream.getAudioTracks().forEach((track: MediaStreamTrack) => {
        canvasStream.addTrack(track)
        hasAudio = true
      })
    } catch (e) {
      console.warn("No audio track for the export", e)
    }

    const mimeType = recorderMimeType(settings.format)
    if (!mimeType) {
      modal.failExport(
        tt("exportErrors.formatNotSupported", {
          format: settings.format.toUpperCase(),
        }),
      )
      return null
    }
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(canvasStream, {
        mimeType,
        videoBitsPerSecond: videoBitrateFor(settings.quality, w, h),
      })
    } catch (e) {
      console.error(e)
      modal.failExport(tt("exportErrors.recordStart"))
      return null
    }

    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }

    const finished = new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        modal.setExportStep("render", "done")
        modal.setExportStep("encode", "active")
        modal.setExportStage(tt("exportStages.generatingFile"), "busy")
        resolve(new Blob(chunks, { type: mimeType }))
      }
    })

    const previousVolume = video.volume
    const wasMuted = video.muted
    video.muted = true
    video.volume = 0

    modal.setExportStage(tt("exportStages.preparingVideo"), "busy")
    video.pause()
    try {
      video.currentTime = 0
    } catch {}
    await new Promise((r) => setTimeout(r, 150))

    modal.setExportStep("prepare", "done")
    modal.setExportStep("render", "active")
    modal.setExportStage(
      hasAudio
        ? tt("exportStages.recordingAudio")
        : tt("exportStages.recordingNoAudio"),
      "busy",
    )
    ui.exportHint.textContent = tt("exportStages.keepTabActive")

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
      if (ctx) {
        if (settings.layout === "vertical-stream") {
          drawVerticalStreamFrame(ctx, video, segments)
        } else {
          drawFrame(ctx, video, w, h, segments)
        }
      }
      const dur = video.duration
      if (dur && isFinite(dur)) {
        modal.setExportProgress(Math.min(94, (video.currentTime / dur) * 94))
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
      return await finished
    } catch (e) {
      console.error(e)
      stopRecording()
      recorder.onstop = null
      if (recorder.state !== "inactive") recorder.stop()
      modal.failExport(tt("exportErrors.playbackBlocked"))
      return null
    } finally {
      video.muted = wasMuted
      video.volume = previousVolume
    }
  }

  async function transcodeWebmToMp4(webmBlob: Blob) {
    const form = new FormData()
    form.append("video", webmBlob, "render.webm")
    const response = await fetch("/api/transcode-mp4", {
      method: "POST",
      body: form,
    })
    if (!response.ok) {
      let message = await response.text().catch(() => "")
      try {
        message = JSON.parse(message).error || message
      } catch {}
      throw new Error(message || `HTTP ${response.status}`)
    }
    return response.blob()
  }

  async function exportMp4ViaLocalTranscode(
    segments: any[],
    settings: ExportSettings,
  ): Promise<WebCodecsExportResult> {
    const webmSettings: ExportSettings = { ...settings, format: "webm" }
    const webmBlob = await recordCanvasBlob(segments, webmSettings)
    if (!webmBlob) {
      return { handled: false, reason: tt("exportErrors.recordStart") }
    }

    try {
      modal.setExportStage("Convirtiendo a MP4 compatible con Instagram…", "busy")
      ui.exportHint.textContent = "Codificando H.264/AAC localmente con ffmpeg."
      modal.setExportProgress(96)
      const mp4Blob = await transcodeWebmToMp4(webmBlob)
      downloadBlob(mp4Blob, settings)
    } catch (error) {
      console.warn("[export] local ffmpeg MP4 transcode failed", error)
      return { handled: false, reason: errorMessage(error) }
    }

    modal.setExportStep("encode", "done")
    modal.setExportStep("done", "done")
    modal.setExportProgress(100)
    modal.setExportStage(tt("exportStages.exported"), "ok")
    ui.exportTitle.textContent = tt("exportStages.complete")
    ui.exportHint.hidden = true
    ui.exportClose.hidden = false
    setStatus(tt("videoExported"), "ok")
    return { handled: true }
  }

  async function exportWithRecorder(
    segments: any[],
    settings: ExportSettings,
    fallbackReason = "",
  ) {
    const blob = await recordCanvasBlob(segments, settings, fallbackReason)
    if (!blob) return
    downloadBlob(blob, settings)

    modal.setExportStep("encode", "done")
    modal.setExportStep("done", "done")
    modal.setExportProgress(100)
    modal.setExportStage(tt("exportStages.exported"), "ok")
    ui.exportTitle.textContent = tt("exportStages.complete")
    ui.exportHint.hidden = true
    ui.exportClose.hidden = false
    setStatus(tt("videoExported"), "ok")
  }

  return {
    downloadVideo,
  }
}
