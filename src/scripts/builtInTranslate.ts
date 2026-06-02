// Chrome Prompt API (Gemini Nano) for subtitle translation between en, es, and ja.
// Rich context: timing, tone, subtitle constraints. Any other pair → NLLB (~900 MB).

/** @typedef {'prompt'} BuiltInBackend */

/** Languages Gemini Nano can read and write in Chrome today. */
const NANO_LANGS = new Set(["en", "es", "ja"])

/** @typedef {{ text: string, start?: number, end?: number }} SubtitleCue */

/** @type {Map<string, any>} */
const promptSessionByPair = new Map()

/** @type {Map<string, BuiltInBackend | 'nllb'>} */
const backendByPair = new Map()

function pairKey(source, target) {
  return `${source}:${target}`
}

function toBcp47(code) {
  return code === "zh" ? "zh" : code
}

function formatCueTime(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return ""
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.round((seconds % 1) * 1000)
  const pad = (n, w = 2) => String(n).padStart(w, "0")
  return h > 0
    ? `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3, "0")}`
    : `${pad(m)}:${pad(s)}.${String(ms).padStart(3, "0")}`
}

function onDownloadProgress(callback, e) {
  if (typeof callback !== "function") return
  const loaded = e?.loaded
  if (typeof loaded === "number") callback(Math.min(1, loaded))
}

function subtitleSystemPrompt(sourceLabel, targetLabel) {
  return (
    `You translate video subtitles from ${sourceLabel} to ${targetLabel}.\n\n` +
    "Context: these are timed on-screen captions from a video, not prose or chat.\n\n" +
    "Rules:\n" +
    "- Output exactly one translated string per input cue, in the same order\n" +
    "- Keep each line concise and readable on screen; match the source tone and register\n" +
    "- Preserve names, brands, and technical terms when appropriate\n" +
    "- Do not merge, split, or reorder cues\n" +
    "- Whitespace-only cues must stay empty\n" +
    "- No speaker labels, quotes, numbering, stage directions, or explanations\n" +
    "- Return only the JSON array requested by the user"
  )
}

function formatCueBlock(cues, offset) {
  return cues
    .map((cue, j) => {
      const idx = offset + j + 1
      const range =
        typeof cue.start === "number" && typeof cue.end === "number"
          ? ` (${formatCueTime(cue.start)} → ${formatCueTime(cue.end)})`
          : ""
      return `${idx}.${range} ${cue.text}`
    })
    .join("\n")
}

export function isNanoLanguagePair(source, target) {
  return (
    source !== target &&
    NANO_LANGS.has(source) &&
    NANO_LANGS.has(target)
  )
}

/** @returns {Promise<BuiltInBackend | null>} */
export async function probeBuiltInTranslation(source, target) {
  if (!isNanoLanguagePair(source, target)) return null
  if (!("LanguageModel" in globalThis)) return null

  const src = toBcp47(source)
  const tgt = toBcp47(target)

  const inputLangs = [...new Set(["en", src, tgt])]
  try {
    const availability = await globalThis.LanguageModel.availability({
      expectedInputs: [{ type: "text", languages: inputLangs }],
      expectedOutputs: [{ type: "text", languages: [tgt] }],
    })
    if (availability !== "unavailable") return "prompt"
  } catch {
    /* NLLB fallback */
  }
  return null
}

export function hasBuiltInTranslationSupport() {
  return "LanguageModel" in globalThis
}

/**
 * @returns {Promise<BuiltInBackend | 'nllb'>}
 */
export async function resolveTranslationBackend(source, target) {
  const key = pairKey(source, target)
  if (backendByPair.has(key)) return backendByPair.get(key)
  const builtIn = await probeBuiltInTranslation(source, target)
  const backend = builtIn || "nllb"
  backendByPair.set(key, backend)
  return backend
}

async function getPromptSession(source, target, sourceLabel, targetLabel, onProgress) {
  const src = toBcp47(source)
  const tgt = toBcp47(target)
  const key = pairKey(src, tgt)
  if (promptSessionByPair.has(key)) return promptSessionByPair.get(key)

  const inputLangs = [...new Set(["en", src, tgt])]
  const session = await globalThis.LanguageModel.create({
    expectedInputs: [{ type: "text", languages: inputLangs }],
    expectedOutputs: [{ type: "text", languages: [tgt] }],
    initialPrompts: [
      {
        role: "system",
        content: subtitleSystemPrompt(sourceLabel, targetLabel),
      },
    ],
    monitor(m) {
      m.addEventListener("downloadprogress", (e) => onDownloadProgress(onProgress, e))
    },
  })
  promptSessionByPair.set(key, session)
  return session
}

const PROMPT_BATCH = 20

/**
 * @param {SubtitleCue[]} cues
 * @param {string} source BCP 47-ish app code
 * @param {string} target
 * @param {{ onProgress?: (ratio: number) => void, sourceLabel?: string, targetLabel?: string }} [opts]
 */
export async function translateCuesBuiltIn(cues, source, target, opts = {}) {
  const backend = await resolveTranslationBackend(source, target)
  if (backend !== "prompt") {
    throw new Error("Prompt API unavailable for this language pair")
  }

  const sourceLabel = opts.sourceLabel || source
  const targetLabel = opts.targetLabel || target
  const onProgress = opts.onProgress
  const session = await getPromptSession(
    source,
    target,
    sourceLabel,
    targetLabel,
    onProgress,
  )

  const out = []
  for (let i = 0; i < cues.length; i += PROMPT_BATCH) {
    const batch = cues.slice(i, i + PROMPT_BATCH)
    const schema = {
      type: "array",
      items: { type: "string" },
      minItems: batch.length,
      maxItems: batch.length,
    }
    const prompt =
      `Translate exactly ${batch.length} subtitle cues from ${sourceLabel} to ${targetLabel}.\n` +
      `Return a JSON array of ${batch.length} strings in the same order.\n\n` +
      formatCueBlock(batch, i)

    const raw = await session.prompt(prompt, { responseConstraint: schema })
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error("Prompt API returned invalid JSON")
    }
    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      throw new Error("Prompt API returned unexpected shape")
    }
    out.push(...parsed.map((s) => String(s ?? "").trim()))
    if (typeof onProgress === "function") {
      onProgress(Math.min(1, out.length / cues.length))
    }
    await new Promise((r) => setTimeout(r, 0))
  }
  return out
}

export function builtInBackendLabel() {
  return "Gemini Nano"
}
