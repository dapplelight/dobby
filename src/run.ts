// Turn `claude -p --output-format json` output into a runs row. Also usable on its own to wrap existing jobs:
//   node src/run.ts --project web --kind reddit -- --model haiku --allowedTools ... < prompt.txt
import { spawn } from "node:child_process"
import { logRun, open, type Run } from "./db.ts"

/** Bad JSON or is_error counts as a failed run. */
export function parseResult(project: string, kind: string, model: string | undefined, raw: string, code: number): Run & { text: string } {
  try {
    const j = JSON.parse(raw)
    const u = j.usage ?? {}
    const ok = code === 0 && !j.is_error
    return {
      project, kind, model: model ?? Object.keys(j.modelUsage ?? {})[0], ok, // is_error with subtype "success" (usage limit, auth): the real reason is in result
      reason: ok ? undefined : String((j.subtype === "success" ? j.result : j.subtype) || j.result || "error").slice(0, 300),
      turns: j.num_turns, duration_ms: j.duration_ms, input_tokens: u.input_tokens, output_tokens: u.output_tokens,
      cache_read: u.cache_read_input_tokens, cache_write: u.cache_creation_input_tokens, cost_usd: j.total_cost_usd, session_id: j.session_id,
      text: typeof j.result === "string" ? j.result : "",
    }
  } catch {
    return { project, kind, model, ok: false, reason: `unparsable output (exit ${code}): ${raw.slice(0, 200)}`, text: raw }
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const cut = argv.indexOf("--")
  const own = cut === -1 ? argv : argv.slice(0, cut)
  const pass = cut === -1 ? [] : argv.slice(cut + 1)
  const flag = (n: string) => { const i = own.indexOf(`--${n}`); const v = i === -1 ? undefined : own[i + 1]; return v?.startsWith("--") ? undefined : v } // absent, or followed by another flag = no value
  const project = flag("project"), kind = flag("kind")
  if (!project || !kind) throw new Error("usage: run.ts --project <p> --kind <k> -- <claude args>")
  const mi = pass.indexOf("--model")
  const model = mi === -1 ? undefined : pass[mi + 1]
  const p = spawn("claude", ["-p", "--output-format", "json", ...pass], { stdio: ["inherit", "pipe", "inherit"] })
  let raw = ""
  p.stdout.on("data", (d) => (raw += d))
  p.on("close", (code) => {
    const { text, ...run } = parseResult(project, kind, model, raw, code ?? 1)
    logRun(open(), run)
    process.stdout.write(text + "\n")
    process.exit(run.ok ? 0 : 1)
  })
}
