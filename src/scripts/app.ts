import {
  hasBuiltInTranslationSupport,
} from "@/scripts/builtInTranslate.ts"
import { createDownloadsController } from "@/scripts/downloads.ts"
import { createEditorHistory } from "@/scripts/editorHistory.ts"
import { createEditorSegmentsController } from "@/scripts/editorSegments.ts"
import { createExportModal } from "@/scripts/export/exportModal.ts"
import { createVideoExporter } from "@/scripts/export/videoExport.ts"
import { drawSubtitlesAt } from "@/scripts/export/subtitleRenderer.ts"
import { baseFileName, prettifyBytes } from "@/scripts/file.ts"
import { I18N, langName, tt } from "@/scripts/i18n.ts"
import {
  deleteProject,
  getProject,
  listProjects,
  saveProject,
  type StoredProject,
  type StoredProjectSummary,
} from "@/scripts/projectStorage.ts"
import { createStageManager } from "@/scripts/stageManager.ts"
import { createConfigStageController } from "@/scripts/stages/configStage.ts"
import { createEditorStageController } from "@/scripts/stages/editorStage.ts"
import { createUploadStageController } from "@/scripts/stages/uploadStage.ts"
import { createSubtitleStyleController } from "@/scripts/subtitleStyle.ts"
import { parseSrt } from "@/scripts/subtitles.ts"
import { createTimelineController } from "@/scripts/timeline.ts"
import { createTransformersClient } from "@/scripts/transformersClient.ts"
import { createTranslationService } from "@/scripts/translation.ts"
import { ui } from "@/scripts/ui.ts"

type Segment = { start: number; end: number; text: string }
type SegmentsByLang = Record<string, Segment[]>
type VisibleTrack = {
  lang: string
  label: string
  role: "default" | "transcription" | "subtitles"
  segments: Segment[]
  hidden?: boolean
  locked?: boolean
}
type TrackState = { hidden?: boolean; locked?: boolean }

const {
  downloads,
  renderDownloads,
  updateDownloadStatus,
  makeTransformersTracker,
  fetchWithProgress,
  refreshClearModelsUI,
  clearLocalModels,
} = createDownloadsController({
  ui,
  tt,
  prettifyBytes,
  hasBuiltInTranslationSupport,
})

// ── State ──
let selectedVideoFile: File | null = null
let videoObjectUrl = ""
let detectedLang = ""
let baseSegments: Segment[] = []
let segmentsByLang: SegmentsByLang = {}
let orderedLangs: string[] = []
let activeLang = ""
let dualTrackMode = false
let dualTrackLangs: string[] = []
let trackStates: Record<string, TrackState> = {}
let exporting = false
let currentProjectId = ""
let projectSaveTimer = 0
let verticalCameraCrop = { x: 0.69, y: 0.62, width: 0.28, height: 0.34 }
let verticalScreenCrop = { x: 0, y: 0, width: 1, height: 1 }
let activeCropTarget: "camera" | "screen" = "camera"
let fixedTitle = {
  enabled: false,
  text: "",
  color: "#ffffff",
  font: "sans",
  position: "top",
  size: 72,
}
let verticalSubtitles = { size: 0.68, y: 78 }

const PREFS_KEY = "subvid.last-options"

const { setStage } = createStageManager({ ui })
const asrTracker = makeTransformersTracker("asr")
const translationTracker = makeTransformersTracker("translation")
const transformersClient = createTransformersClient({
  onProgress(key, payload) {
    if (key === "asr") asrTracker(payload)
    else if (key === "translation") translationTracker(payload)
  },
})

let translationService: ReturnType<typeof createTranslationService>
let historyController: ReturnType<typeof createEditorHistory<SegmentsByLang>>
let editorStageController: ReturnType<typeof createEditorStageController>
let subtitleStyleController: ReturnType<typeof createSubtitleStyleController>

const translateSegments = (
  segments: Segment[],
  sourceLang: string,
  targetLang: string,
) => translationService.translateSegments(segments, sourceLang, targetLang)

function currentSegments(): Segment[] {
  return segmentsByLang[activeLang] || []
}

function trackLabel(lang: string) {
  if (dualTrackMode && lang === detectedLang)
    return tt("tracks.transcription", { lang: langName(lang) })
  if (dualTrackMode && dualTrackLangs.includes(lang))
    return tt("tracks.subtitles", { lang: langName(lang) })
  return langName(lang)
}

function trackRole(lang: string): VisibleTrack["role"] {
  if (dualTrackMode && lang === detectedLang) return "transcription"
  if (dualTrackMode && dualTrackLangs.includes(lang)) return "subtitles"
  return "default"
}

function visibleTrackLangs() {
  const langs =
    dualTrackMode && dualTrackLangs.includes(activeLang)
      ? dualTrackLangs
      : [activeLang]
  return langs.filter((lang, index) => lang && langs.indexOf(lang) === index)
}

function trackState(lang: string) {
  return trackStates[lang] || {}
}

function visibleTracks(): VisibleTrack[] {
  return visibleTrackLangs()
    .map((lang) => ({
      lang,
      label: trackLabel(lang),
      role: trackRole(lang),
      segments: segmentsByLang[lang] || [],
      hidden: !!trackState(lang).hidden,
      locked: !!trackState(lang).locked,
    }))
    .filter((track) => track.segments.length)
}

function currentVideoSegments(): any[] {
  const tracks = visibleTracks().filter((track) => !track.hidden)
  return tracks.length ? tracks : []
}

function resetEditorState() {
  detectedLang = ""
  baseSegments = []
  segmentsByLang = {}
  orderedLangs = []
  activeLang = ""
  dualTrackMode = false
  dualTrackLangs = []
  trackStates = {}
}

function projectNameFor(file: File | null) {
  return file ? baseFileName(file) : tt("projectUntitled")
}

function projectSnapshot(): StoredProject | null {
  if (!selectedVideoFile) return null
  const now = Date.now()
  const id = currentProjectId || crypto.randomUUID?.() || String(now)
  currentProjectId = id

  return {
    id,
    name: projectNameFor(selectedVideoFile),
    createdAt: now,
    updatedAt: now,
    videoFile: selectedVideoFile,
    videoName: selectedVideoFile.name,
    videoSize: selectedVideoFile.size,
    videoType: selectedVideoFile.type,
    detectedLang,
    baseSegments,
    segmentsByLang,
    orderedLangs,
    activeLang,
    dualTrackMode,
    dualTrackLangs,
    trackStates,
    verticalCameraCrop,
    verticalScreenCrop,
    inputLang: ui.inputLang.value,
    outputLang: ui.outputLang.value,
    wordAnimation: ui.wordAnimation.checked,
    fixedTitle,
    verticalSubtitles,
  }
}

function saveLastOptions() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        inputLang: ui.inputLang.value,
        outputLang: ui.outputLang.value,
        wordAnimation: ui.wordAnimation.checked,
        fixedTitle,
        verticalSubtitles,
      }),
    )
  } catch {}
}

function restoreLastOptions() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}")
    if (typeof prefs.inputLang === "string") ui.inputLang.value = prefs.inputLang
    if (typeof prefs.outputLang === "string") ui.outputLang.value = prefs.outputLang
    if (typeof prefs.wordAnimation === "boolean") {
      ui.wordAnimation.checked = prefs.wordAnimation
    }
    if (prefs.fixedTitle) fixedTitle = { ...fixedTitle, ...prefs.fixedTitle }
    if (prefs.verticalSubtitles) {
      verticalSubtitles = { ...verticalSubtitles, ...prefs.verticalSubtitles }
    }
    syncFixedTitleControls()
  } catch {}
}

function updateVideoSources(file: File) {
  const previousUrl = videoObjectUrl
  if (previousUrl) URL.revokeObjectURL(previousUrl)

  videoObjectUrl = URL.createObjectURL(file)
  selectedVideoFile = file
  ui.video.src = videoObjectUrl
  ui.video.load()
  ui.configVideo.src = videoObjectUrl
  ui.configVideo.load()

  const metaText = `${file.name} · ${prettifyBytes(file.size)}`
  ui.meta.textContent = metaText
  ui.configMeta.textContent = metaText
}

function scheduleProjectSave() {
  if (!selectedVideoFile) return
  if (projectSaveTimer) window.clearTimeout(projectSaveTimer)
  projectSaveTimer = window.setTimeout(() => {
    void saveCurrentProject()
  }, 500)
}

async function saveCurrentProject() {
  const snapshot = projectSnapshot()
  if (!snapshot) return

  try {
    const existing = await getProject(snapshot.id)
    await saveProject({
      ...snapshot,
      createdAt: existing?.createdAt || snapshot.createdAt,
      updatedAt: Date.now(),
    })
    await renderProjectList()
  } catch (error) {
    console.warn("[projects] save failed", error)
  }
}

function formatProjectDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value)
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    return "&quot;"
  })
}

function renderProjectCard(project: StoredProjectSummary) {
  const buttonLabel = tt("projectOpen")
  const deleteLabel = tt("projectDelete")
  const lines = tt("segCount", { n: project.segmentCount })
  const tracks = project.trackCount
    ? ` · ${tt("projectTracks", { n: project.trackCount })}`
    : ""

  return `
    <article class="project-card" data-project-id="${project.id}">
      <div class="project-card-main">
        <h3>${escapeHtml(project.name)}</h3>
        <p>${escapeHtml(project.videoName)} · ${prettifyBytes(project.videoSize)}</p>
        <span>${formatProjectDate(project.updatedAt)} · ${lines}${tracks}</span>
      </div>
      <div class="project-card-actions">
        <button class="project-open" type="button" data-project-open="${project.id}">${buttonLabel}</button>
        <button class="project-delete" type="button" data-project-delete="${project.id}">${deleteLabel}</button>
      </div>
    </article>`
}

async function renderProjectList() {
  try {
    const projects = await listProjects()
    ui.projectsPanel.hidden = projects.length === 0
    ui.projectsEmpty.hidden = projects.length !== 0
    ui.projectsList.innerHTML = projects.map(renderProjectCard).join("")
  } catch (error) {
    console.warn("[projects] list failed", error)
  }
}

async function openStoredProject(id: string) {
  const project = await getProject(id)
  if (!project) return

  currentProjectId = project.id
  updateVideoSources(project.videoFile)
  detectedLang = project.detectedLang || ""
  baseSegments = project.baseSegments || []
  segmentsByLang = project.segmentsByLang || {}
  orderedLangs = project.orderedLangs || Object.keys(segmentsByLang)
  activeLang = project.activeLang || orderedLangs[0] || ""
  dualTrackMode = !!project.dualTrackMode
  dualTrackLangs = project.dualTrackLangs || []
  trackStates = project.trackStates || {}
  if (project.verticalCameraCrop) {
    verticalCameraCrop = clampCrop(project.verticalCameraCrop)
  }
  if (project.verticalScreenCrop) verticalScreenCrop = clampCrop(project.verticalScreenCrop)
  ui.inputLang.value = project.inputLang || ui.inputLang.value
  ui.outputLang.value = project.outputLang || ui.outputLang.value
  ui.wordAnimation.checked = !!project.wordAnimation
  if (project.fixedTitle) fixedTitle = { ...fixedTitle, ...project.fixedTitle }
  if (project.verticalSubtitles) {
    verticalSubtitles = { ...verticalSubtitles, ...project.verticalSubtitles }
  }
  syncFixedTitleControls()
  syncCropBox()

  setLangAddStatus("")
  populateAddLang()
  renderTabs()
  renderSegments()
  syncActiveCaptionStyle()
  enableExports(currentSegments().length > 0)
  ui.addSegBtn.disabled = currentSegments().length === 0
  resetHistory()
  applyCaptionStyle()
  updateCaption()
  configStageController.setStatus(tt("projectOpened"), "ok")
  setStage(currentSegments().length ? "editor" : "config")
}

function snapshotSegments() {
  return historyController.snapshotSegments()
}

function pushHistory(snapshotBefore: string) {
  historyController.pushHistory(snapshotBefore)
}

function resetHistory() {
  historyController.resetHistory()
}

function enableExports(on: boolean) {
  editorStageController.enableExports(on)
}

function syncActiveCaptionStyle() {
  subtitleStyleController?.setActiveTrack(trackRole(activeLang), activeLang)
}

function enableWordAnimationForAll() {
  if (!ui.wordAnimation.checked) return
  subtitleStyleController?.setWordHighlightForAll(true)
}

async function importSrtFile(file: File) {
  const text = await file.text()
  const importedSegments = parseSrt(text)
  if (!importedSegments.length) {
    configStageController.setStatus("SRT sin subtítulos válidos.", "error")
    return
  }

  const lang = activeLang || detectedLang || ui.outputLang.value || "imported"
  activeLang = lang
  segmentsByLang[lang] = importedSegments.map((segment) => ({ ...segment }))
  if (!orderedLangs.includes(lang)) orderedLangs.push(lang)
  if (!baseSegments.length) baseSegments = importedSegments.map((segment) => ({ ...segment }))
  if (!detectedLang) detectedLang = lang

  syncActiveCaptionStyle()
  renderTabs()
  renderSegments()
  renderTimeline()
  enableExports(true)
  ui.addSegBtn.disabled = false
  resetHistory()
  updateCaption()
  scheduleProjectSave()
  configStageController.setStatus(`SRT importado: ${importedSegments.length} líneas.`, "ok")
}

function clampCrop(crop: typeof verticalCameraCrop) {
  const width = Math.max(0.08, Math.min(0.9, crop.width))
  const height = Math.max(0.08, Math.min(0.9, crop.height))
  return {
    x: Math.max(0, Math.min(1 - width, crop.x)),
    y: Math.max(0, Math.min(1 - height, crop.y)),
    width,
    height,
  }
}

function activeCrop() {
  return activeCropTarget === "screen" ? verticalScreenCrop : verticalCameraCrop
}

function setActiveCrop(crop: typeof verticalCameraCrop) {
  if (activeCropTarget === "screen") verticalScreenCrop = crop
  else verticalCameraCrop = crop
}

function syncCropBox() {
  syncCameraCropOverlayBounds()
  const crop = clampCrop(activeCrop())
  setActiveCrop(crop)
  ui.cameraCropBox.style.left = `${crop.x * 100}%`
  ui.cameraCropBox.style.top = `${crop.y * 100}%`
  ui.cameraCropBox.style.width = `${crop.width * 100}%`
  ui.cameraCropBox.style.height = `${crop.height * 100}%`
  ui.cameraCropBox.classList.toggle("is-screen", activeCropTarget === "screen")
  ui.cameraCropBox.querySelector(".camera-crop-label")!.textContent =
    activeCropTarget === "screen" ? tt("screenCrop") : tt("cameraCrop")
}

function syncCameraCropOverlayBounds() {
  const previewRect = ui.videoPreview.getBoundingClientRect()
  const videoWidth = Number(ui.video?.videoWidth) || 0
  const videoHeight = Number(ui.video?.videoHeight) || 0
  let left = 0
  let top = 0
  let width = previewRect.width
  let height = previewRect.height

  if (previewRect.width && previewRect.height && videoWidth && videoHeight) {
    const previewRatio = previewRect.width / previewRect.height
    const videoRatio = videoWidth / videoHeight

    if (previewRatio > videoRatio) {
      height = previewRect.height
      width = height * videoRatio
      left = (previewRect.width - width) / 2
    } else {
      width = previewRect.width
      height = width / videoRatio
      top = (previewRect.height - height) / 2
    }
  }

  ui.cameraCropOverlay.style.left = `${left}px`
  ui.cameraCropOverlay.style.top = `${top}px`
  ui.cameraCropOverlay.style.right = "auto"
  ui.cameraCropOverlay.style.bottom = "auto"
  ui.cameraCropOverlay.style.width = `${width}px`
  ui.cameraCropOverlay.style.height = `${height}px`
}

function closeCameraCropEditor() {
  ui.cameraCropOverlay.hidden = true
  ui.videoPreview.classList.remove("is-camera-crop-active")
  scheduleProjectSave()
}

function openCropEditor(target: "camera" | "screen") {
  activeCropTarget = target
  ui.cameraCropOverlay.hidden = false
  ui.videoPreview.classList.add("is-camera-crop-active")
  syncCropBox()
}

function syncFixedTitleControls() {
  ui.fixedTitleEnabled.checked = !!fixedTitle.enabled
  ui.fixedTitleText.value = fixedTitle.text || ""
  ui.fixedTitleColor.value = fixedTitle.color || "#ffffff"
  ui.fixedTitleFont.value = fixedTitle.font || "sans"
  ui.fixedTitlePosition.value = fixedTitle.position || "top"
  ui.fixedTitleSize.value = String(fixedTitle.size || 72)
  ui.verticalSubsSize.value = String(Math.round((verticalSubtitles.size || 0.68) * 100))
  ui.verticalSubsY.value = String(verticalSubtitles.y || 78)
}

function readFixedTitleControls() {
  fixedTitle = {
    enabled: ui.fixedTitleEnabled.checked,
    text: ui.fixedTitleText.value,
    color: ui.fixedTitleColor.value,
    font: ui.fixedTitleFont.value,
    position: ui.fixedTitlePosition.value,
    size: Number(ui.fixedTitleSize.value) || 72,
  }
  verticalSubtitles = {
    size: (Number(ui.verticalSubsSize.value) || 68) / 100,
    y: Number(ui.verticalSubsY.value) || 78,
  }
  saveLastOptions()
  scheduleProjectSave()
  renderVerticalPreview()
}

function drawPreviewCover(
  ctx: CanvasRenderingContext2D,
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
  ctx.drawImage(ui.video, cropX, cropY, cropW, cropH, dx, dy, dw, dh)
}

function renderVerticalPreview() {
  if (ui.verticalPreviewPanel.hidden) return
  const ctx = ui.verticalPreviewCanvas.getContext("2d")
  if (!ctx) return
  const sw = ui.video.videoWidth || 1920
  const sh = ui.video.videoHeight || 1080
  const w = ui.verticalPreviewCanvas.width
  const h = ui.verticalPreviewCanvas.height
  const screenH = Math.round(h * 0.646)
  const screen = verticalScreenCrop
  const cam = verticalCameraCrop

  ctx.fillStyle = "#05070a"
  ctx.fillRect(0, 0, w, h)
  drawPreviewCover(ctx, screen.x * sw, screen.y * sh, screen.width * sw, screen.height * sh, 0, 0, w, screenH)
  drawPreviewCover(ctx, cam.x * sw, cam.y * sh, cam.width * sw, cam.height * sh, 25, Math.round(h * 0.69), w - 50, Math.round((w - 50) * 0.563))
  if (fixedTitle.enabled && fixedTitle.text.trim()) {
    const fontMap: Record<string, string> = {
      sans: '"Outfit", "Segoe UI", sans-serif',
      serif: 'Georgia, "Times New Roman", serif',
      rounded: '"Quicksand", "Trebuchet MS", sans-serif',
      mono: '"JetBrains Mono", monospace',
    }
    const size = Math.max(14, Math.round((fixedTitle.size || 72) * (w / 1080)))
    const y = fixedTitle.position === "middle" ? h * 0.48 : fixedTitle.position === "bottom" ? h * 0.72 : h * 0.08
    ctx.font = `800 ${size}px ${fontMap[fixedTitle.font] || fontMap.sans}`
    ctx.textAlign = "center"
    ctx.textBaseline = "top"
    ctx.lineWidth = Math.max(2, size * 0.14)
    ctx.strokeStyle = "rgba(0,0,0,.85)"
    ctx.fillStyle = fixedTitle.color
    ctx.strokeText(fixedTitle.text, w / 2, y)
    ctx.fillText(fixedTitle.text, w / 2, y)
  }
  drawSubtitlesAt(ctx, ui.video.currentTime || 0, w, h, currentVideoSegments(), {
    fontScale: verticalSubtitles.size,
    yPercent: verticalSubtitles.y,
    maxWidthRatio: 0.9,
  })
}

function wireFixedTitleAndPreview() {
  ;[
    ui.fixedTitleEnabled,
    ui.fixedTitleText,
    ui.fixedTitleColor,
    ui.fixedTitleFont,
    ui.fixedTitlePosition,
    ui.fixedTitleSize,
    ui.verticalSubsSize,
    ui.verticalSubsY,
  ].forEach((control) => {
    control.addEventListener("input", readFixedTitleControls)
    control.addEventListener("change", readFixedTitleControls)
  })
  ui.verticalPreviewBtn.addEventListener("click", () => {
    ui.verticalPreviewPanel.hidden = false
    renderVerticalPreview()
  })
  ui.verticalPreviewClose.addEventListener("click", () => {
    ui.verticalPreviewPanel.hidden = true
  })
  ui.video.addEventListener("seeked", renderVerticalPreview)
}

function wireCameraCropEditor() {
  let drag:
    | {
        mode: "move" | "resize"
        pointerId: number
        startX: number
        startY: number
        crop: typeof verticalCameraCrop
      }
    | null = null

  ui.cameraCropBtn.addEventListener("click", () => openCropEditor("camera"))
  ui.screenCropBtn.addEventListener("click", () => openCropEditor("screen"))

  ui.cameraCropSetBtn.addEventListener("click", closeCameraCropEditor)
  ui.video.addEventListener("loadedmetadata", syncCropBox)
  window.addEventListener("resize", () => {
    if (!ui.cameraCropOverlay.hidden) syncCropBox()
  })

  ui.cameraCropBox.addEventListener("pointerdown", (event: PointerEvent) => {
    const target = event.target as HTMLElement
    const mode = target.classList.contains("camera-crop-handle") ? "resize" : "move"
    drag = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      crop: { ...activeCrop() },
    }
    ui.cameraCropBox.setPointerCapture(event.pointerId)
    event.preventDefault()
  })

  ui.cameraCropBox.addEventListener("pointermove", (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    const rect = ui.cameraCropOverlay.getBoundingClientRect()
    const dx = (event.clientX - drag.startX) / Math.max(1, rect.width)
    const dy = (event.clientY - drag.startY) / Math.max(1, rect.height)

    if (drag.mode === "resize") {
      setActiveCrop(clampCrop({
        ...drag.crop,
        width: drag.crop.width + dx,
        height: drag.crop.height + dy,
      }))
    } else {
      setActiveCrop(clampCrop({
        ...drag.crop,
        x: drag.crop.x + dx,
        y: drag.crop.y + dy,
      }))
    }
    syncCropBox()
  })

  const endDrag = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    drag = null
  }
  ui.cameraCropBox.addEventListener("pointerup", endDrag)
  ui.cameraCropBox.addEventListener("pointercancel", endDrag)
}

let editorSegmentsController: any
const { renderTimeline, highlightSegment, updateCaption } = createTimelineController({
  ui,
  tt,
  currentSegments,
  visibleTracks,
  activeLang: () => activeLang,
  setActiveLang: (lang) => {
    activeLang = lang
    syncActiveCaptionStyle()
  },
  renderTabs: () => editorSegmentsController.renderTabs(),
  renderCaptions: (tracks, time) =>
    subtitleStyleController?.renderCaptions(tracks, time),
  toggleTrackHidden: (lang) => {
    const before = snapshotSegments()
    trackStates[lang] = {
      ...trackState(lang),
      hidden: !trackState(lang).hidden,
    }
    pushHistory(before)
    renderTimeline()
    updateCaption()
  },
  toggleTrackLocked: (lang) => {
    const before = snapshotSegments()
    trackStates[lang] = {
      ...trackState(lang),
      locked: !trackState(lang).locked,
    }
    pushHistory(before)
    renderTimeline()
    updateCaption()
  },
  snapshotSegments,
  pushHistory,
  renderSegments: () => editorSegmentsController.renderSegments(),
  enableExports,
})
editorSegmentsController = createEditorSegmentsController({
  ui,
  tt,
  langName,
  getState: () => ({
    detectedLang,
    baseSegments,
    segmentsByLang,
    orderedLangs,
    activeLang,
    dualTrackMode,
    dualTrackLangs,
    trackStates,
  }),
  setActiveLang: (lang) => {
    activeLang = lang
    syncActiveCaptionStyle()
  },
  setOrderedLangs: (langs) => {
    orderedLangs = langs
  },
  setSegmentsForLang: (lang, segments) => {
    segmentsByLang[lang] = segments
    if (ui.wordAnimation.checked) subtitleStyleController?.setWordHighlightForAll(true)
  },
  trackLabel,
  translateSegments,
  snapshotSegments,
  pushHistory,
  renderTimeline,
  highlightSegment,
  updateCaption,
  enableExports,
})
const {
  addLanguage,
  buildLangSelects,
  populateAddLang,
  renderSegments,
  renderTabs,
  setLangAddStatus,
  wireSegmentEditor,
} = editorSegmentsController
subtitleStyleController = createSubtitleStyleController({ ui, I18N })
const {
  applyCaptionStyle,
  renderPresets,
  syncStyleControls,
  wireStyleControls,
} = subtitleStyleController
const exportModal = createExportModal({ ui, tt, isExporting: () => exporting })
const { closeExportModal } = exportModal

editorStageController = createEditorStageController({
  ui,
  currentSegments,
  selectedVideoFile: () => selectedVideoFile,
  activeLang: () => activeLang,
  isExporting: () => exporting,
  setStage,
  undo: () => historyController.undo(),
  redo: () => historyController.redo(),
})

historyController = createEditorHistory<SegmentsByLang>({
  getState: () => ({
    segmentsByLang,
    orderedLangs,
    activeLang,
    dualTrackMode,
    dualTrackLangs,
    trackStates,
  }),
  restoreState: (state) => {
    segmentsByLang = state.segmentsByLang || {}
    orderedLangs = state.orderedLangs || Object.keys(segmentsByLang)
    activeLang = state.activeLang || orderedLangs[0] || ""
    if (!segmentsByLang[activeLang])
      activeLang = orderedLangs[0] || Object.keys(segmentsByLang)[0] || ""
    dualTrackMode = !!state.dualTrackMode
    dualTrackLangs = state.dualTrackLangs || []
    trackStates = state.trackStates || {}
  },
  refreshButtons: (canUndo, canRedo) => {
    if (ui.undoBtn) ui.undoBtn.disabled = !canUndo
    if (ui.redoBtn) ui.redoBtn.disabled = !canRedo
  },
  onRestore: () => {
    syncActiveCaptionStyle()
    renderTabs()
    renderSegments()
    enableExports(true)
    updateCaption()
  },
})

const configStageController = createConfigStageController({
  ui,
  tt,
  downloads,
  fetchWithProgress,
  updateDownloadStatus,
  transformersClient,
  translateSegments,
  selectedVideoFile: () => selectedVideoFile,
  isExporting: () => exporting,
  setGeneratedState: (state) => {
    detectedLang = state.detectedLang
    baseSegments = state.baseSegments
    segmentsByLang = state.segmentsByLang
    orderedLangs = state.orderedLangs
    activeLang = state.activeLang
    dualTrackMode = state.dualTrackMode
    dualTrackLangs = state.dualTrackLangs
    trackStates = {}
    enableWordAnimationForAll()
    syncActiveCaptionStyle()
    scheduleProjectSave()
  },
  renderTabs,
  renderSegments,
  enableExports,
  resetHistory,
  updateCaption,
  setStage,
})

translationService = createTranslationService({
  downloads,
  renderDownloads,
  updateDownloadStatus,
  transformersClient,
  tt,
  langName,
  setStatus: configStageController.setStatus,
})

const uploadStageController = createUploadStageController({
  ui,
  tt,
  setStage,
  setStatus: configStageController.setStatus,
  setProgress: configStageController.setProgress,
  isExporting: () => exporting,
  getVideoObjectUrl: () => videoObjectUrl,
  setVideoObjectUrl: (url) => {
    videoObjectUrl = url
  },
  setSelectedVideoFile: (file) => {
    selectedVideoFile = file
  },
  resetEditorState,
  setLangAddStatus,
  populateAddLang,
  renderSegments,
  enableExports,
  resetHistory,
  startEarlyTranscription: (file) =>
    configStageController.startEarlyTranscription(file),
  resetTranscriptionCache: () => configStageController.resetTranscriptionCache(),
  onVideoSelected: () => {
    currentProjectId = ""
    restoreLastOptions()
    scheduleProjectSave()
  },
})

const { downloadVideo } = createVideoExporter({
  ui,
  tt,
  currentSegments: currentVideoSegments,
  selectedVideoFile: () => selectedVideoFile,
  activeLang: () => activeLang,
  baseFileName: () => baseFileName(selectedVideoFile),
  isExporting: () => exporting,
  setExporting: (value) => {
    exporting = value
  },
  enableExports,
  setStatus: configStageController.setStatus,
  modal: exportModal,
  verticalCameraCrop: () => verticalCameraCrop,
  verticalScreenCrop: () => verticalScreenCrop,
  fixedTitle: () => fixedTitle,
  verticalSubtitles: () => verticalSubtitles,
})

// ── Init ──
buildLangSelects()
restoreLastOptions()
renderDownloads()
renderPresets()
syncStyleControls()
applyCaptionStyle()
wireStyleControls()
wireSegmentEditor()
wireCameraCropEditor()
wireFixedTitleAndPreview()
configStageController.preloadAssetsInBackground()
setStage("upload")
uploadStageController.wireUploadStage()
void renderProjectList()
configStageController.wireConfigStage()
editorStageController.wireEditorStage()
ui.projectsList?.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null
  const openId = target?.closest<HTMLElement>("[data-project-open]")?.dataset
    .projectOpen
  const deleteId = target?.closest<HTMLElement>("[data-project-delete]")?.dataset
    .projectDelete

  if (openId) void openStoredProject(openId)
  if (deleteId) {
    void deleteProject(deleteId).then(renderProjectList)
  }
})
window.setInterval(() => {
  if (selectedVideoFile && Object.keys(segmentsByLang).length) void saveCurrentProject()
}, 2000)
ui.langAddSelect?.addEventListener("change", () => {
  const target = ui.langAddSelect.value
  if (target) addLanguage(target)
})
ui.inputLang.addEventListener("change", () => {
  saveLastOptions()
  scheduleProjectSave()
})
ui.outputLang.addEventListener("change", () => {
  saveLastOptions()
  scheduleProjectSave()
})
ui.wordAnimation.addEventListener("change", () => {
  saveLastOptions()
  scheduleProjectSave()
})
ui.downloadVideoBtn.addEventListener("click", downloadVideo)
ui.importSrtBtn.addEventListener("click", () => ui.importSrtInput.click())
ui.importSrtInput.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement | null
  const file = target?.files?.[0]
  if (file) void importSrtFile(file)
  if (target) target.value = ""
})
ui.exportClose.addEventListener("click", closeExportModal)
ui.exportBackdrop.addEventListener("click", closeExportModal)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !ui.exportModal.hidden) closeExportModal()
})
ui.downloadsToggle.addEventListener("click", () => {
  const opening = ui.downloadsPanel.hidden
  ui.downloadsPanel.hidden = !opening
  // The panel header already shows the status, so drop the dock label while open.
  ui.statusDock?.classList.toggle("panel-open", opening)
  if (opening) refreshClearModelsUI()
})
ui.clearModelsBtn?.addEventListener("click", clearLocalModels)
