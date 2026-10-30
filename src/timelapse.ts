// dobby timelapse: a day of agents working as a 15-second clip, made from Dobby's event log only (docs/manual/timelapse.md).
// Pipeline: DB -> manifest (a fixed allowlist of fields) -> frames (a pure function of the manifest) -> ffmpeg (fixed flags) -> Ed25519 signature.
// Nothing here reads code, prompts, diffs, paths, names or keys, and nothing is uploaded.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { dirname } from "node:path"
import { z } from "zod"
import type { DB } from "./db.ts"
import { RUN_ROLE } from "./activity.ts"
import { hits, isPublic, ownerWords, patterns } from "./privacy.ts"

// ---- 1. the manifest: the only thing the clip is made from ----------------------------------------------------------------------
export const ROLES = ["Lead", "PM", "Builder", "Tester", "Reviewer", "Designer", "Scout", "Chief of Staff", "Dobby"] as const
export const STATES = ["done", "failed", "passed", "changes", "merged"] as const
const Ev = z.strictObject({
  t: z.number().int(), d: z.number().int().min(0), role: z.enum(ROLES), state: z.enum(STATES), label: z.string().max(60).regex(/^[\w .,:'#()?-]*$/).optional(),
})
export const Manifest = z.strictObject({
  v: z.literal(1), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tzMin: z.number().int(), from: z.number().int(), to: z.number().int(),
  events: z.array(Ev).max(5000),
  /** Public repos the owner opted in only: the merged PRs, so anyone can look them up on GitHub. */
  merges: z.array(z.strictObject({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), pr: z.number().int(), sha: z.string().regex(/^[0-9a-f]{7,40}$/), mergedAt: z.string() })).max(1000),
})
export type Manifest = z.infer<typeof Manifest>
export type Ev = z.infer<typeof Ev>

const q = <T>(db: DB, sql: string, ...a: unknown[]) => { try { return db.prepare(sql).all(...a) as T[] } catch { return [] as T[] } }
const SAFE_LABEL = /^[\w .,:'#()?-]+$/
/** A title may be shown only when it holds no path, no email, no long token and no private word. */
const labelOk = (s: string, pats: ReturnType<typeof patterns>) =>
  SAFE_LABEL.test(s) && !/[\/\\]\w+[\/\\.]|@|\b[A-Za-z0-9_-]{20,}\b|\b(sk|ghp|gho|xox\w|AKIA)[-_A-Za-z0-9]|\d{6,}|(token|secret|password|key)\s*[:=]/i.test(s) && !hits(s, pats).length
const tzAt = (day: string) => -new Date(`${day}T12:00:00`).getTimezoneOffset()

export type Opts = {
  day: string
  /** projects whose repo name and ticket titles may show: each must be a public repo, else buildManifest throws */
  show?: string[]
  /** project name -> "owner/name" ("" when unknown) */
  slugOf?: (project: string) => string
  home?: string
}

/** Local midnight to midnight of `day`, built only from the allowlisted columns of runs, reviews and tickets. */
export function buildManifest(db: DB, o: Opts): Manifest {
  const tzMin = tzAt(o.day), lo = Date.parse(`${o.day}T00:00:00`), hi = lo + 86_400_000
  const slugOf = o.slugOf ?? (() => "")
  const pats = patterns(ownerWords(o.home))
  const shown = new Map<string, string>() // project -> repo slug, public and opted in
  for (const p of o.show ?? []) {
    const slug = slugOf(p)
    if (!slug) throw new Error(`timelapse: no GitHub repo known for "${p}", so its name cannot be shown`)
    if (!isPublic(slug)) throw new Error(`timelapse: "${p}" is a private repo; names and titles are never shown for private repos`)
    shown.set(p, slug)
  }
  const tix = new Map(q<{ id: number; project: string; title: string; status: string; note: string | null; updated_at: string; onto: string | null }>(db, "SELECT id, project, title, status, note, updated_at, onto FROM tickets").map((t) => [t.id, t]))
  const label = (project: string, ticket?: number | null) => {
    const slug = shown.get(project)
    if (!slug) return undefined
    const title = ticket ? tix.get(ticket)?.title : undefined
    const s = [slug.split("/")[1], title && labelOk(title, pats) ? title : ""].filter(Boolean).join(": ").slice(0, 60)
    return SAFE_LABEL.test(s) ? s : undefined
  }
  const events: Ev[] = []
  for (const r of q<{ at: string; project: string; kind: string; ticket: number | null; ok: number; duration_ms: number | null }>(db, "SELECT at, project, kind, ticket, ok, duration_ms FROM runs WHERE at>=? AND at<? ORDER BY at, id", new Date(lo).toISOString(), new Date(hi).toISOString())) {
    const role = RUN_ROLE[r.kind]?.[0] as Ev["role"] | undefined
    if (!role || !ROLES.includes(role)) continue
    const l = label(r.project, r.ticket)
    events.push({ t: Math.floor(Date.parse(r.at) / 1000), d: Math.min(86_400, Math.round((r.duration_ms ?? 0) / 1000)), role, state: r.ok ? "done" : "failed", ...(l ? { label: l } : {}) })
  }
  const projectOf = (repo: string) => [...shown].find(([, s]) => s.toLowerCase() === repo.toLowerCase())?.[0]
  for (const r of q<{ repo: string; verdict: string; at: string }>(db, "SELECT repo, verdict, at FROM reviews WHERE verdict IN ('pass','fail') AND at>=? AND at<? ORDER BY at", new Date(lo).toISOString(), new Date(hi).toISOString())) {
    const p = projectOf(r.repo), l = p ? label(p) : undefined
    events.push({ t: Math.floor(Date.parse(r.at) / 1000), d: 0, role: "Reviewer", state: r.verdict === "pass" ? "passed" : "changes", ...(l ? { label: l } : {}) })
  }
  const merges: Manifest["merges"] = []
  for (const t of tix.values()) {
    const at = Date.parse(t.updated_at)
    if (!(at >= lo && at < hi) || t.onto || !["shipped", "failed"].includes(t.status)) continue
    const l = label(t.project, t.id)
    events.push({ t: Math.floor(at / 1000), d: 0, role: "Dobby", state: t.status === "shipped" ? "merged" : "failed", ...(l ? { label: l } : {}) })
    const m = t.status === "shipped" && shown.has(t.project) ? t.note?.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/) : null
    if (m) {
      const sha = q<{ sha: string }>(db, "SELECT sha FROM reviews WHERE repo=? AND pr=? ORDER BY at DESC LIMIT 1", m[1], Number(m[2]))[0]?.sha
      if (sha && /^[0-9a-f]{7,40}$/.test(sha)) merges.push({ repo: m[1], pr: Number(m[2]), sha, mergedAt: new Date(at).toISOString() })
    }
  }
  events.sort((a, b) => a.t - b.t || ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.state.localeCompare(b.state))
  const first = events.length ? Math.min(...events.map((e) => e.t - e.d)) : lo / 1000, last = events.length ? Math.max(...events.map((e) => e.t)) : lo / 1000 + 3600
  // whole hours around the activity, so the clock reads cleanly
  const from = Math.max(lo / 1000, Math.floor(first / 3600) * 3600), to = Math.max(from + 3600, Math.min(hi / 1000, Math.ceil(last / 3600) * 3600))
  return Manifest.parse({ v: 1, day: o.day, tzMin, from, to, events, merges })
}

/** The privacy check of PR 280 over the whole manifest text: the owner's words, home folders, personal emails. null = clear. */
export function privacyGate(m: Manifest, home?: string): string | null {
  const found = [...new Set(hits(JSON.stringify(m, null, 1), patterns(ownerWords(home))).map((h) => h.split(": ").pop()))]
  return found.length ? `timelapse: not exported: the manifest holds private words (${found.join(", ")}).` : null
}

export const manifestText = (m: Manifest) => JSON.stringify(m, null, 1) + "\n"

/** What the owner sees before anything is written: every field that will be in the file. */
export function previewText(m: Manifest): string {
  const hhmm = (t: number) => { const d = new Date((t + m.tzMin * 60) * 1000); return d.toISOString().slice(11, 16) }
  const n = (s: string[]) => m.events.filter((e) => s.includes(e.state)).length
  const lines = [
    `Timelapse of ${m.day}: ${m.events.length} events from ${hhmm(m.from)} to ${hhmm(m.to)}, a ${SECS}-second clip.`,
    `  done ${n(["done"])}, reviewed ${n(["passed", "changes"])}, merged ${n(["merged"])}, problems ${n(["failed", "changes"])}`,
    "The file holds only these fields per event: time, role, state, duration" + (m.events.some((e) => e.label) ? ", and a name you opted in to" : "") + ". No code, prompts, diffs, paths, user names, emails or keys.",
    m.events.some((e) => e.label) ? "Names shown: " + [...new Set(m.events.flatMap((e) => (e.label ? [e.label.split(":")[0]] : [])))].join(", ") : "Repo names and ticket titles: off.",
    m.merges.length ? `Merged PRs listed with commit and merge time (public repos): ${m.merges.map((x) => `${x.repo}#${x.pr}`).join(", ")}` : "No PR list in the manifest.",
    "", ...m.events.slice(0, 40).map((e) => `  ${hhmm(e.t)}  ${e.role.padEnd(14)} ${e.state.padEnd(8)} ${e.d ? `${e.d}s` : ""}${e.label ? `  ${e.label}` : ""}`),
  ]
  if (m.events.length > 40) lines.push(`  ... and ${m.events.length - 40} more (all of them go in the manifest)`)
  return lines.join("\n")
}

// ---- 2. frames: a pure function of the manifest ---------------------------------------------------------------------------------
/** Frames are drawn on a 640x360 grid (LW) and scaled by S to the clip size. */
export const W = 1280, H = 720, S = 2, LW = W / S, FPS = 20, SECS = 15, FRAMES = FPS * SECS, HOLD = FPS
const BG = [13, 13, 12], RAISE = [22, 22, 20], LINE = [38, 37, 33], INK = [237, 236, 230], DIM = [161, 159, 149], FAINT = [85, 83, 76], MARK = [63, 224, 138], WARN = [240, 163, 94]
type RGB = number[]
const FONT = new Map<string, string>(`A.###.#...##...#######...##...##...# B####.#...##...#####.#...##...#####. C.#####....#....#....#....#.....#### D####.#...##...##...##...##...#####. E######....#....####.#....#....##### F######....#....####.#....#....#.... G.#####....#....#.####...##...#.#### H#...##...##...#######...##...##...# I.###...#....#....#....#....#...###. J..###...#....#....#....#.#..#..##.. K#...##..#.#.#..##...#.#..#..#.#...# L#....#....#....#....#....#....##### M#...###.###.#.##.#.##...##...##...# N#...###..##.#.##..###...##...##...# O.###.#...##...##...##...##...#.###. P####.#...##...#####.#....#....#.... Q.###.#...##...##...##.#.##..#..##.# R####.#...##...#####.#.#..#..#.#...# S.#####....#.....###.....#....#####. T#####..#....#....#....#....#....#.. U#...##...##...##...##...##...#.###. V#...##...##...##...##...#.#.#...#.. W#...##...##...##.#.##.#.###.###...# X#...##...#.#.#...#...#.#.#...##...# Y#...##...#.#.#...#....#....#....#.. Z#####....#...#...#...#...#....##### 0.###.#...##..###.#.###..##...#.###. 1..#...##....#....#....#....#...###. 2.###.#...#....#...#...#...#...##### 3####.....#....#.###.....#....#####. 4...#...##..#.#.#..#.#####...#....#. 5######....####.....#....##...#.###. 6.###.#....#....####.#...##...#.###. 7#####....#...#...#...#....#....#... 8.###.#...##...#.###.#...##...#.###. 9.###.#...##...#.####....#....#.###. ...........................##...##.. :......##...##........##...##....... -...............#####............... /....#....#...#...#...#...#....#.... ?.###.#...#....#...#...#.........#..`.split(" ").map((g) => [g[0], g.slice(1)]))

class Canvas {
  px = new Uint8Array(W * H * 4)
  constructor() { for (let i = 0; i < W * H; i++) this.px.set([...BG, 255], i * 4) }
  rect(x: number, y: number, w: number, h: number, c: RGB, a = 1) {
    x *= S; y *= S; w *= S; h *= S
    for (let j = Math.max(0, Math.round(y)); j < Math.min(H, Math.round(y + h)); j++) for (let i = Math.max(0, Math.round(x)); i < Math.min(W, Math.round(x + w)); i++) this.blend(i, j, c, a)
  }
  blend(i: number, j: number, c: RGB, a: number) {
    const o = (j * W + i) * 4
    for (let k = 0; k < 3; k++) this.px[o + k] = Math.round(this.px[o + k] * (1 - a) + c[k] * a)
  }
  /** Anti-aliased by 4x4 sub-samples; `inside` is true for points of the shape. */
  shape(x0: number, y0: number, x1: number, y1: number, inside: (x: number, y: number) => boolean, c: RGB, a = 1) {
    for (let j = Math.floor(y0 * S); j < Math.ceil(y1 * S); j++) for (let i = Math.floor(x0 * S); i < Math.ceil(x1 * S); i++) {
      let n = 0
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside((i + (sx + 0.5) / 4) / S, (j + (sy + 0.5) / 4) / S)) n++
      if (n) this.blend(i, j, c, (a * n) / 16)
    }
  }
  text(s: string, x: number, y: number, scale: number, c: RGB, align: "l" | "r" = "l") {
    const w = s.length * 6 * scale - scale
    let cx = align === "r" ? x - w : x
    for (const ch of s.toUpperCase()) {
      const g = FONT.get(ch)
      if (g) for (let k = 0; k < 35; k++) if (g[k] === "#") this.rect(cx + (k % 5) * scale, y + Math.floor(k / 5) * scale, scale, scale, c)
      cx += 6 * scale
    }
  }
}

/** The Dobby mark (dashboard/public/favicon.svg): an open ring and a dot, at (x, y) with side `s`. */
function mark(cv: Canvas, x: number, y: number, s: number) {
  const k = s / 200, cx = x + 100 * k, cy = y + 100 * k
  cv.shape(x, y, x + s, y + s, (px, py) => {
    const dx = (px - cx) / k, dy = (py - cy) / k, r = Math.hypot(dx, dy)
    if (r > 72 || r < 57) return false
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI // 0 = right, 90 = down
    return !(ang > 8 && ang < 62)
  }, MARK)
  cv.shape(x, y, x + s, y + s, (px, py) => Math.hypot((px - x) / k - 150.2, (py - y) / k - 136.4) <= 9, MARK)
}

const col = (e: Ev) => (e.state === "failed" || e.state === "changes" ? WARN : MARK)
const clock = (m: Manifest, t: number) => new Date((t + m.tzMin * 60) * 1000).toISOString().slice(11, 16)

/** Frame `i` of the clip as RGBA. Same manifest, same bytes. */
export function frame(m: Manifest, i: number): Uint8Array {
  const cv = new Canvas(), span = m.to - m.from
  const p = Math.min(1, i / (FRAMES - 1 - HOLD)), now = m.from + p * span
  mark(cv, 24, 18, 30)
  cv.text("DOBBY", 64, 25, 3, INK)
  cv.text(clock(m, now), LW - 24, 22, 3, INK, "r")
  cv.text(m.day, LW - 24, 48, 2, DIM, "r")
  const lanes = ROLES.filter((r) => m.events.some((e) => e.role === r))
  const x0 = 210, x1 = LW - 24, top = 84, lh = Math.min(26, Math.floor(200 / Math.max(1, lanes.length)))
  const X = (t: number) => x0 + ((t - m.from) / span) * (x1 - x0)
  lanes.forEach((r, n) => {
    const y = top + n * lh
    cv.rect(24, y + lh - 3, x1 - 24, 1, LINE)
    cv.text(r, 24, y + (lh - 14) / 2 - 2, 2, DIM)
  })
  let best: Ev | undefined
  for (const e of m.events) {
    if (e.t > now) continue
    const y = top + lanes.indexOf(e.role) * lh, age = now - e.t, a = Math.max(0.4, 1 - age / (span * 0.1))
    const xe = Math.min(X(e.t), X(now)), xs = X(e.t - e.d)
    cv.rect(Math.min(xs, xe - 3), y + (lh - 3 - 10) / 2, Math.max(3, xe - xs), 10, col(e), a)
    if (e.label && (!best || e.t >= best.t)) best = e
  }
  const xp = X(now)
  cv.rect(xp - 1, top - 8, 2, lanes.length * lh + 8, INK, 0.9)
  cv.rect(24, 306, LW - 48, 1, LINE)
  const done = m.events.filter((e) => e.t <= now)
  const cnt = (s: string[]) => done.filter((e) => s.includes(e.state)).length
  ;([["DONE", cnt(["done"]), INK], ["REVIEWED", cnt(["passed", "changes"]), INK], ["MERGED", cnt(["merged"]), MARK], ["PROBLEMS", cnt(["failed", "changes"]), WARN]] as [string, number, RGB][]).forEach(([name, n, c], k) => {
    cv.text(name, 24 + k * 150, 318, 1, FAINT)
    cv.text(String(n), 24 + k * 150, 330, 3, n ? c : FAINT)
  })
  if (best?.label) cv.text(best.label.slice(0, 22), LW - 24, 336, 2, DIM, "r")
  return cv.px
}

// ---- 3. encode and decode with ffmpeg (fixed flags, one thread, no metadata) -------------------------------------------------
export const ffmpegMissing = () => (spawnSync("ffmpeg", ["-version"]).status === 0 ? null : "dobby timelapse needs ffmpeg to write the clip. Install it (macOS: brew install ffmpeg; Debian/Ubuntu: apt install ffmpeg) and run the command again.")
const ENC = ["-c:v", "libx264", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p", "-threads", "1", "-x264-params", "threads=1:bframes=2", "-bitexact", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-sws_flags", "+accurate_rnd+bitexact", "-map_metadata", "-1", "-movflags", "+faststart"]

/** Encode raw RGBA frames (a generator) to an mp4. */
export async function encode(frames: Iterable<Uint8Array>, out: string): Promise<void> {
  const p = spawn("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-", ...ENC, out], { stdio: ["pipe", "ignore", "pipe"] })
  let err = ""
  p.stderr.on("data", (d) => (err += d))
  const done = new Promise<void>((ok, bad) => { p.on("error", bad); p.on("close", (c) => (c === 0 ? ok() : bad(new Error(`ffmpeg failed: ${err.trim().slice(0, 300)}`)))) })
  p.stdin.on("error", () => {}) // ffmpeg dying surfaces through "close"
  for (const f of frames) if (!p.stdin.write(f)) await new Promise((r) => p.stdin.once("drain", r))
  p.stdin.end()
  await done
}

/** sha256 of every decoded frame of a clip. */
export function frameHashes(clip: string): Promise<string[]> {
  return new Promise((ok, bad) => {
    const size = W * H * 4, out: string[] = []
    let buf = Buffer.alloc(0)
    const p = spawn("ffmpeg", ["-v", "error", "-i", clip, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdio: ["ignore", "pipe", "pipe"] })
    let err = ""
    p.stderr.on("data", (d) => (err += d))
    p.stdout.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      while (buf.length >= size) { out.push(createHash("sha256").update(buf.subarray(0, size)).digest("hex")); buf = buf.subarray(size) }
    })
    p.on("error", bad)
    p.on("close", (c) => (c === 0 ? ok(out) : bad(new Error(`ffmpeg could not read the clip: ${err.trim().slice(0, 200)}`))))
  })
}

export function* allFrames(m: Manifest) { for (let i = 0; i < FRAMES; i++) yield frame(m, i) }

// ---- 4. signature ---------------------------------------------------------------------------------------------------------
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")
const message = (clip: Buffer, manifest: Buffer) => Buffer.from(`dobby-timelapse-v1\n${sha(clip)}\n${sha(manifest)}\n`)

/** The local signing key, made on first use at `path` (mode 600, next to secrets.env). The private half is never printed. */
export function signingKey(path: string) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
  }
  try { chmodSync(path, 0o600) } catch {}
  return createPrivateKey(readFileSync(path))
}

export type Sig = { alg: "ed25519"; publicKey: string; signature: string }
export function signFiles(clip: Buffer, manifest: Buffer, keyPath: string): Sig {
  const key = signingKey(keyPath)
  return { alg: "ed25519", publicKey: createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64"), signature: edSign(null, message(clip, manifest), key).toString("base64") }
}
export const fingerprint = (s: Sig) => sha(Buffer.from(s.publicKey, "base64")).slice(0, 16)
function sigOk(clip: Buffer, manifest: Buffer, s: Sig): boolean {
  try { return edVerify(null, message(clip, manifest), createPublicKey({ key: Buffer.from(s.publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(s.signature, "base64")) } catch { return false }
}

// ---- 5. export and verify -------------------------------------------------------------------------------------------------------
/** Writes <base>.mp4, <base>.manifest.json and <base>.sig. The caller has shown the preview and been told yes. */
export async function exportClip(m: Manifest, base: string, keyPath: string): Promise<{ clip: string; manifest: string; sig: string; key: string }> {
  mkdirSync(dirname(base), { recursive: true })
  const text = manifestText(m), clip = `${base}.mp4`
  await encode(allFrames(m), clip)
  const sig = signFiles(readFileSync(clip), Buffer.from(text), keyPath)
  writeFileSync(`${base}.manifest.json`, text)
  writeFileSync(`${base}.sig`, JSON.stringify(sig, null, 1) + "\n")
  return { clip, manifest: `${base}.manifest.json`, sig: `${base}.sig`, key: fingerprint(sig) }
}

export type Verdict = { ok: boolean; manifest: boolean; frames: boolean; signature: boolean; key?: string; detail: string }
/** Re-renders the clip from the manifest and compares decoded frames, then checks the signature over both files. */
export async function verify(clip: string, manifestPath: string, sigPath = clip.replace(/\.mp4$/, "") + ".sig", scratch = `${clip}.verify.mp4`): Promise<Verdict> {
  const cb = readFileSync(clip), mb = readFileSync(manifestPath)
  let m: Manifest
  try { m = Manifest.parse(JSON.parse(mb.toString("utf8"))) } catch { return { ok: false, manifest: false, frames: false, signature: false, detail: "The manifest is not a valid Dobby timelapse manifest." } }
  let sig: Sig | undefined
  try { sig = JSON.parse(readFileSync(sigPath, "utf8")) } catch {}
  const signature = !!sig && sigOk(cb, mb, sig)
  await encode(allFrames(m), scratch)
  const [a, b] = await Promise.all([frameHashes(clip), frameHashes(scratch)])
  try { (await import("node:fs")).rmSync(scratch, { force: true }) } catch {}
  const bad = a.length !== b.length ? "frame count differs" : `frame ${a.findIndex((h, i) => h !== b[i])} differs`
  const frames = a.length === b.length && a.every((h, i) => h === b[i])
  return { ok: signature && frames, manifest: true, frames, signature, key: sig && signature ? fingerprint(sig) : undefined, detail: [frames ? "The clip matches the manifest, frame by frame." : `The clip does not match the manifest (${bad}).`, signature ? "The signature is valid." : "The signature is missing or does not match the files."].join(" ") }
}
