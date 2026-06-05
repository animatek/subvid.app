type Segment = { start: number; end: number; text: string }

export type StoredProject = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  videoFile: File
  videoName: string
  videoSize: number
  videoType: string
  detectedLang: string
  baseSegments: Segment[]
  segmentsByLang: Record<string, Segment[]>
  orderedLangs: string[]
  activeLang: string
  dualTrackMode: boolean
  dualTrackLangs: string[]
  trackStates: Record<string, { hidden?: boolean; locked?: boolean }>
  verticalCameraCrop?: { x: number; y: number; width: number; height: number }
  verticalScreenCrop?: { x: number; y: number; width: number; height: number }
  inputLang?: string
  outputLang?: string
  wordAnimation?: boolean
  fixedTitle?: {
    enabled: boolean
    text: string
    color: string
    font: string
    position: string
    size: number
  }
  verticalSubtitles?: { size: number; y: number }
}

export type StoredProjectSummary = Pick<
  StoredProject,
  "id" | "name" | "createdAt" | "updatedAt" | "videoName" | "videoSize"
> & { trackCount: number; segmentCount: number }

const DB_NAME = "subvid-projects"
const DB_VERSION = 1
const STORE_NAME = "projects"

let dbPromise: Promise<IDBDatabase> | null = null

function openProjectsDb() {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" })
      }
    }
  })

  return dbPromise
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
) {
  const db = await openProjectsDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode)
    const store = tx.objectStore(STORE_NAME)
    const request = run(store)

    tx.oncomplete = () => resolve(request ? request.result : (undefined as T))
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function summarize(project: StoredProject): StoredProjectSummary {
  const tracks = Object.keys(project.segmentsByLang || {})
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    videoName: project.videoName,
    videoSize: project.videoSize,
    trackCount: tracks.length,
    segmentCount: tracks.reduce(
      (total, lang) => total + (project.segmentsByLang[lang]?.length || 0),
      0,
    ),
  }
}

export async function listProjects() {
  const projects = await withStore<StoredProject[]>("readonly", (store) =>
    store.getAll(),
  )
  return projects
    .map(summarize)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getProject(id: string) {
  return withStore<StoredProject | undefined>("readonly", (store) => store.get(id))
}

export async function saveProject(project: StoredProject) {
  await withStore("readwrite", (store) => store.put(project))
}

export async function deleteProject(id: string) {
  await withStore("readwrite", (store) => store.delete(id))
}
