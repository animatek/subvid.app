import type { APIRoute } from "astro"

export const prerender = false

function jsonError(message: string, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export const POST: APIRoute = async ({ request }) => {
  let writeFile: typeof import("node:fs/promises").writeFile
  let readFile: typeof import("node:fs/promises").readFile
  let unlink: typeof import("node:fs/promises").unlink
  let mkdtemp: typeof import("node:fs/promises").mkdtemp
  let rm: typeof import("node:fs/promises").rm
  let tmpdir: typeof import("node:os").tmpdir
  let join: typeof import("node:path").join
  let spawn: typeof import("node:child_process").spawn

  try {
    ;({ writeFile, readFile, unlink, mkdtemp, rm } = await import(
      "node:fs/promises"
    ))
    ;({ tmpdir } = await import("node:os"))
    ;({ join } = await import("node:path"))
    ;({ spawn } = await import("node:child_process"))
  } catch {
    return jsonError("Local MP4 transcoding only works in the local Node dev server.", 501)
  }

  const form = await request.formData()
  const file = form.get("video")
  if (!(file instanceof File)) return jsonError("Missing video file", 400)

  const dir = await mkdtemp(join(tmpdir(), "subvid-transcode-"))
  const input = join(dir, "input.webm")
  const output = join(dir, "output.mp4")

  try {
    await writeFile(input, Buffer.from(await file.arrayBuffer()))

    const args = [
      "-hide_banner",
      "-y",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-level",
      "4.1",
      "-r",
      "30",
      "-vf",
      "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      output,
    ]

    const { code, stderr } = await new Promise<{
      code: number | null
      stderr: string
    }>((resolve) => {
      const child = spawn("ffmpeg", args)
      let stderr = ""
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString()
      })
      child.on("close", (code) => resolve({ code, stderr }))
      child.on("error", (error) =>
        resolve({ code: 1, stderr: String(error?.message || error) }),
      )
    })

    if (code !== 0) {
      return jsonError(`ffmpeg failed: ${stderr.slice(-2000)}`, 500)
    }

    const mp4 = await readFile(output)
    return new Response(mp4, {
      headers: {
        "content-type": "video/mp4",
        "content-length": String(mp4.byteLength),
      },
    })
  } finally {
    await Promise.allSettled([unlink(input), unlink(output)])
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
