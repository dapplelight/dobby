// A unified diff as files and lines. Pure text in, plain objects out: the server counts files with it, the dashboard draws the diff with it.
export type DLine = { t: "add" | "del" | "ctx" | "hunk"; old: number | null; new: number | null; text: string }
export type DFile = { path: string; add: number; del: number; lines: DLine[] }

export function parseDiff(text: string): DFile[] {
  const files: DFile[] = []
  let f: DFile | undefined, o = 0, n = 0, inHunk = false
  for (const l of text.split("\n")) {
    if (l.startsWith("diff --git ")) {
      const m = l.match(/^diff --git a\/(.+) b\/(.+)$/)
      f = { path: m?.[2] ?? l.slice(11), add: 0, del: 0, lines: [] }; files.push(f); inHunk = false
      continue
    }
    if (!f) continue
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (h) { o = Number(h[1]); n = Number(h[2]); inHunk = true; f.lines.push({ t: "hunk", old: null, new: null, text: l }); continue }
    if (!inHunk) { if (l.startsWith("+++ b/")) f.path = l.slice(6); continue }
    if (l.startsWith("+")) { f.add++; f.lines.push({ t: "add", old: null, new: n++, text: l.slice(1) }) }
    else if (l.startsWith("-")) { f.del++; f.lines.push({ t: "del", old: o++, new: null, text: l.slice(1) }) }
    else if (l.startsWith(" ")) f.lines.push({ t: "ctx", old: o++, new: n++, text: l.slice(1) })
  }
  return files
}
