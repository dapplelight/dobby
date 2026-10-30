#!/usr/bin/env node
// Dobby's only PreToolUse hook for Bash (agent-settings.json). No dependencies.
//
// Why (audit 20 Oct item 3, security review): `rtk hook claude` read the owner's GLOBAL allowlist and answered "allow", which
// skipped each role's --allowedTools (a Lead could `cat` anything, a Builder `git -C x push`). So this hook is the boundary:
//   1. every simple command in the line (each part of && || ; | &, $( ) and backticks, <( ), sh -c bodies, xargs targets,
//      find -exec bodies) must match the role's Bash allowlist, passed in DOBBY_BASH_ALLOW by claude() (lib.ts; unset or
//      empty = no Bash at all);
//   2. the guard rules below deny the dangerous ones even when the role list would allow them;
//   3. only then is the command handed to `rtk rewrite` (compression kept in full, owner 20 Oct) and returned as updatedInput
//      with "allow"; no rtk, or nothing to rewrite = the original command, allowed.
// Claude Code hooks docs (https://code.claude.com/docs/en/hooks, "PreToolUse decision control"): `"allow"` skips the permission
// prompt, deny and ask rules are still evaluated; `updatedInput` "replaces the entire input object" and "Combine with "allow"
// to auto-approve"; with several hooks "precedence is deny > defer > ask > allow". Deny output:
// {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { basename, normalize, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const SUBST = "$(…)" // a command substitution's place in its outer word (its body is checked on its own)

/** Matching `)` for the `(` at i (quote-aware, nested). -1 = unbalanced. */
function closeParen(s, i) {
  let depth = 0
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (c === "\\") { j++; continue }
    if (c === "'") { const k = s.indexOf("'", j + 1); if (k < 0) return -1; j = k; continue }
    if (c === '"') { for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === "\\") j++; continue }
    if (c === "(") depth++
    else if (c === ")" && --depth === 0) return j
  }
  return -1
}
const closeTick = (s, i) => { for (let j = i + 1; j < s.length; j++) { if (s[j] === "\\") j++; else if (s[j] === "`") return j } return -1 }

/**
 * A shell line as simple commands: [{ words, redirs }], quotes removed, substitution bodies as commands of their own.
 * Throws on anything it can't read safely (unbalanced quotes or parentheses, substitutions inside an unquoted heredoc).
 */
export function parse(cmd) {
  const segs = []
  let words = [], redirs = [], w = null, redirNext = false, dataNext = false
  const heredocs = []
  // Expansions the shell does after this parser has read the words (audit 24 Oct M1, M2): brace lists and parameter expansion.
  // `{a,b}` / `{1..3}` unquoted would turn one checked word into others (`--no-ind{ex,ex}`, `{~/.ssh/id,/dev/null}`), and `$NAME`
  // would hand git or a reader the value of a variable (an API key). Both are refused; `$HOME` and `${HOME}` are fine.
  let unq = ""
  const dollar = (at) => {
    if (cmd.startsWith("${HOME}", at) || (cmd.startsWith("$HOME", at) && !/\w/.test(cmd[at + 5] ?? ""))) return
    if (/[\w{@*#?$!'"-]/.test(cmd[at + 1] ?? "")) throw new Error("variable expansion ($NAME): write the value itself")
  }
  const endWord = () => {
    if (/\{[^{}]*(,|\.\.)[^{}]*\}/.test(unq)) throw new Error("brace expansion ({a,b}): write each word out")
    unq = ""
    if (w === null) return
    if (redirNext) redirs.push(w); else if (!dataNext) words.push(w)
    redirNext = dataNext = false
    w = null
  }
  const endSeg = () => { endWord(); if (words.length || redirs.length) segs.push({ words, redirs }); words = []; redirs = [] }
  const nested = (body) => { segs.push(...parse(body)); w = (w ?? "") + SUBST }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], next = cmd[i + 1]
    if (c === "\\") { if (next === "\n") { i++; continue } w = (w ?? "") + (next ?? ""); i++; continue }
    if (c === "'") { const k = cmd.indexOf("'", i + 1); if (k < 0) throw new Error("unbalanced quote"); w = (w ?? "") + cmd.slice(i + 1, k); i = k; continue }
    if (c === '"') {
      let j = i + 1, part = ""
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === "\\" && '"\\$`\n'.includes(cmd[j + 1])) { part += cmd[j + 1] === "\n" ? "" : cmd[j + 1]; j++ }
        else if (cmd[j] === "$" && cmd[j + 1] === "(") { const k = closeParen(cmd, j + 1); if (k < 0) throw new Error("unbalanced $("); w = (w ?? "") + part; part = ""; nested(cmd.slice(j + 2, k)); j = k }
        else if (cmd[j] === "`") { const k = closeTick(cmd, j); if (k < 0) throw new Error("unbalanced backtick"); w = (w ?? "") + part; part = ""; nested(cmd.slice(j + 1, k)); j = k }
        else { if (cmd[j] === "$") dollar(j); part += cmd[j] }
      }
      if (j >= cmd.length) throw new Error("unbalanced quote")
      w = (w ?? "") + part
      i = j
      continue
    }
    if (c === "$" && next === "(") { const k = closeParen(cmd, i + 1); if (k < 0) throw new Error("unbalanced $("); nested(cmd.slice(i + 2, k)); i = k; continue }
    if (c === "`") { const k = closeTick(cmd, i); if (k < 0) throw new Error("unbalanced backtick"); nested(cmd.slice(i + 1, k)); i = k; continue }
    if (c === "#" && w === null) { while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++; continue }
    if (c === " " || c === "\t") { endWord(); continue }
    if (c === "\n") {
      endSeg()
      for (const h of heredocs.splice(0)) {
        const lines = []
        let j = i + 1
        for (;;) {
          const e = cmd.indexOf("\n", j), line = cmd.slice(j, e < 0 ? cmd.length : e)
          j = e < 0 ? cmd.length : e + 1
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim || e < 0) break
          lines.push(line)
        }
        if (!h.quoted && /\$\(|`/.test(lines.join("\n"))) throw new Error("command substitution inside a heredoc")
        if (!h.quoted && /\$(?!HOME\b|\{HOME\}|\()[\w{@*#?$!-]/.test(lines.join("\n"))) throw new Error("variable expansion inside a heredoc: quote the delimiter (<<'EOF')")
        i = j - 1
      }
      continue
    }
    if (c === ";" || c === "(" || c === ")") { endSeg(); continue }
    if (c === "|") { endSeg(); if (next === "|" || next === "&") i++; continue }
    if (c === "&") {
      if (next === "&") { endSeg(); i++; continue }
      if (next === ">") { endWord(); i++; if (cmd[i + 1] === ">") i++; redirNext = true; continue }
      endSeg()
      continue
    }
    if (c === "<" || c === ">") {
      if (next === "(") { const k = closeParen(cmd, i + 1); if (k < 0) throw new Error("unbalanced <("); endWord(); nested(cmd.slice(i + 2, k)); endWord(); i = k; continue }
      if (w !== null && /^\d+$/.test(w)) w = null // a file descriptor number
      else endWord()
      if (c === "<" && next === "<" && cmd[i + 2] === "<") { i += 2; dataNext = true; continue } // here-string: data
      if (c === "<" && next === "<") {
        i++
        const strip = cmd[i + 1] === "-"
        if (strip) i++
        while (cmd[i + 1] === " ") i++
        let delim = "", quoted = false
        while (i + 1 < cmd.length && !/[\s;|&<>()]/.test(cmd[i + 1])) { i++; if (/["'\\]/.test(cmd[i])) quoted = true; else delim += cmd[i] }
        heredocs.push({ delim, quoted, strip })
        continue
      }
      while (cmd[i + 1] === ">" || cmd[i + 1] === "|") i++
      if (cmd[i + 1] === "&") { i++; if (/[\d-]/.test(cmd[i + 1] ?? "")) { while (/[\d-]/.test(cmd[i + 1] ?? "")) i++; continue } }
      redirNext = true
      continue
    }
    if (c === "$") dollar(i)
    unq += c
    w = (w ?? "") + c
  }
  if (heredocs.length) throw new Error("heredoc without its body")
  endSeg()
  return segs
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"])
const RUNNERS = new Set(["bun", "npm", "pnpm", "yarn", "npx", "bunx", "make", "turbo", "nx", "node", "tsx", "ts-node", "deno"])
const BANNED_ENV = /^(DOBBY_|GIT_|GH_|GITHUB_|CLAUDE|ANTHROPIC|DYLD_|LD_)|^(PATH|NODE_OPTIONS|BASH_ENV|ENV|ZDOTDIR|HOME|SHELL|PROMPT_COMMAND)$/
const SECRET_VAR = /^\w*(API_KEY|SECRET|TOKEN|PASSWORD)\w*$/i
const XARGS_VALUE = new Set(["-n", "-I", "-i", "-L", "-l", "-P", "-d", "-E", "-e", "-s", "-a", "-J", "-R", "-S"])

/** Simple commands as they will run: wrappers and `rtk` stripped, sh -c / find -exec / xargs bodies split out. A string = deny. */
export function expand(seg) {
  let w = seg.words.slice()
  const out = []
  for (;;) {
    const h = w[0]
    if (h === undefined) break
    const m = h.match(/^([A-Za-z_]\w*)\+?=/)
    if (m) { if (BANNED_ENV.test(m[1])) return `setting ${m[1]} is not allowed`; w.shift(); continue }
    if (h === "rtk") { w = w.slice(w[1] === "proxy" ? 2 : 1); continue }
    if (["command", "builtin", "noglob", "nohup", "time", "exec", "{", "!", "}"].includes(h)) { w.shift(); continue }
    if (h === "sudo" || h === "doas") return "no sudo"
    if (h === "env") {
      w.shift()
      if (w[0]?.startsWith("-")) return "env with options is not allowed"
      if (!w.some((x) => !/^[A-Za-z_]\w*\+?=/.test(x))) return "dumping the environment prints every key; ask for the one variable you need"
      continue
    }
    if (h === "nice") { w.shift(); if (w[0] === "-n") w.splice(0, 2); else if (/^-\d+$/.test(w[0] ?? "")) w.shift(); continue }
    if (h === "timeout") { w.shift(); while (w[0]?.startsWith("-")) w.splice(0, /^-[sk]$/.test(w[0]) ? 2 : 1); w.shift(); continue }
    if (h === "stdbuf") { w.shift(); while (w[0]?.startsWith("-")) w.splice(0, /^-[oei]$/.test(w[0]) ? 2 : 1); continue }
    break
  }
  if (!w.length) return out
  const cmd = basename(w[0])
  if (cmd === "xargs") {
    let i = 1
    while (i < w.length && w[i].startsWith("-")) i += XARGS_VALUE.has(w[i]) ? 2 : 1
    if (i >= w.length) return "xargs without a command"
    const inner = expand({ words: w.slice(i), redirs: [] })
    return typeof inner === "string" ? inner : [...inner, { words: ["xargs"], redirs: seg.redirs, xargs: true }]
  }
  if (SHELLS.has(cmd)) {
    const at = w.findIndex((x, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(x))
    if (at < 0 || w[at + 1] === undefined) return `running ${cmd} on a script or stdin is not allowed (curl | sh and friends)`
    let body
    try { body = parse(w[at + 1]) } catch (e) { return `unreadable ${cmd} -c body: ${e.message}` }
    for (const s of body) { const x = expand(s); if (typeof x === "string") return x; out.push(...x) }
    out.push({ words: w.slice(0, at + 1), redirs: seg.redirs })
    return out
  }
  if (["eval", "source", "."].includes(cmd)) return `${cmd} is not allowed`
  if (cmd === "find") {
    const keep = []
    for (let i = 0; i < w.length; i++) {
      if (w[i] === "-delete") return "find -delete is not allowed"
      if (/^-(exec|execdir|ok|okdir)$/.test(w[i])) {
        let j = i + 1
        while (j < w.length && w[j] !== ";" && w[j] !== "+") j++
        const inner = expand({ words: w.slice(i + 1, j).map((x) => (x === "{}" ? "FILE" : x)), redirs: [] })
        if (typeof inner === "string") return inner
        out.push(...inner)
        i = j
        continue
      }
      keep.push(w[i])
    }
    w = keep
  }
  out.push({ words: w, redirs: seg.redirs })
  return out
}

/** Does this simple command match one of the role's Bash patterns? (`x:*` and `x *` = x itself or x followed by arguments.) */
/** Read-only checks agents pair with a graph query (audit 24 Oct: 48% of graph calls were refused over these): `ls graphify-out`,
 *  `test -d graphify-out`, and `head`/`tail` with only a line count, which read the pipe, not a file. Only for roles that may run graphify. */
export function graphHelper(words) {
  const [c, ...a] = words
  if ((c === "ls" || c === "test" || c === "[") && a.some((w) => /^graphify-out(\/|$)/.test(w))) return a.every((w) => /^(-[a-zA-Z]+|graphify-out(\/[\w.-]*)?|\])$/.test(w))
  return (c === "head" || c === "tail") && a.every((w) => /^(-n|-\d+|\d+|-n\d+)$/.test(w))
}
const graphRole = (patterns) => patterns.some((p) => p === "*" || p.startsWith("graphify"))

export function allowedBy(words, patterns) {
  const line = words.join(" ")
  return patterns.some((p) => {
    if (p === "*") return true
    const prefix = p.endsWith(":*") ? p.slice(0, -2) : p.endsWith(" *") ? p.slice(0, -2) : null
    if (prefix !== null) return line === prefix || line.startsWith(`${prefix} `)
    if (p.includes("*")) return new RegExp(`^${p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(line)
    return line === p
  })
}

const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep)

/** A word as a path: quotes are gone already; backslashes dropped, ~ and $HOME expanded, // collapsed, resolved from cwd. */
const UNRESOLVABLE = "/\0unresolvable"
export function asPath(word, cwd, home = homedir()) {
  const w = word.replace(/\\/g, "")
  // ~user/..., any $VAR (also mid-word: ./$F, .e$X) : the shell expands these to somewhere we cannot know, so never read them as a folder inside cwd.
  if (/^~[^/]/.test(w) || /\$/.test(w.replace(/^(\$HOME|\$\{HOME\})(?=\/|$)/, ""))) return UNRESOLVABLE
  let p = w.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home).replace(/\/{2,}/g, "/")
  return normalize(resolve(cwd, p))
}

const PATH_CMDS = new Set(["cp", "mv", "ln", "rsync", "tee", "diff", "cmp", "source", ".", "sed", "awk"])
const ENV_FILE = /^\.env(\..+)?$/
const ENV_OK = /\.(example|sample|template|dist|d\.ts|ts|tsx|js|mjs|cjs|md|txt)$|\.example\./
const secretFile = (name) => (ENV_FILE.test(name) && !ENV_OK.test(name)) || name === "secrets.env"
/** Commands that print what they read: their paths must stay inside the worktree, and no glob may reach a .env file. */
const READERS = new Set(["cat", "grep", "egrep", "fgrep", "rg", "ag", "head", "tail", "less", "more", "bat", "nl", "tac", "strings", "xxd", "od", "hexdump"])
/** A glob (`.en*`, `.e?v`, `.{env,x}`, `[.]env`) that would match a .env file. A leading * or ? skips dotfiles in the shell. */
function envGlob(word) {
  const b = basename(word.replace(/\\/g, ""))
  if (!/[*?[{]/.test(b) || /^[*?]/.test(b)) return false
  let re = ""
  for (const ch of b) re += ch === "*" ? ".*" : ch === "?" ? "." : ch === "{" ? "(" : ch === "}" ? ")" : ch === "," ? "|" : ch === "[" || ch === "]" ? ch : ch.replace(/[.+^$()|\\]/g, "\\$&")
  try { return [".env", ".env.local", ".env.production"].some((n) => new RegExp(`^${re}$`).test(n)) } catch { return true } // unreadable = deny
}
const VALUE_FLAGS = new Set(["-R", "--repo", "--hostname", "-b", "--body", "-t", "--title", "-B", "--base", "-H", "--head", "--search", "-S", "-q", "--jq", "--json", "-L", "--limit", "-s", "--state", "-A", "--author", "-l", "--label", "-T", "--template", "-X", "--method", "-f", "-F", "--field", "--raw-field", "--input", "--header", "-a", "--assignee", "-m", "--milestone", "-w", "--web", "-e", "--env", "-p", "--project", "-r", "--reviewer", "-c", "--cache", "--app"])
const BOOL_FLAGS = new Set(["--paginate", "-w", "--web", "--slurp", "-i", "--include", "--silent", "--verbose"])
const GH_READ = { pr: ["view", "list", "diff", "checks", "status"], repo: ["view"], release: ["list", "view"], run: ["list", "view"], workflow: ["list", "view"], search: null, status: null, api: null }

/** Why this simple command is denied whatever the role allows, or null. ctx: { cwd, wtRoot, home, dobbyRoot, dataDir, branch() }. */
export function guardSegment(words, redirs, ctx) {
  const cmd = basename(words[0] ?? "")
  const args = words.slice(1)
  // ---- paths: secrets, ~/.ssh, Dobby's data outside the agent's own worktree, .env files ----
  const grepPattern = ["grep", "egrep", "fgrep", "rg", "ag"].includes(cmd) && !args.some((a) => /^-(e|f)$|^--(regexp|file)=?/.test(a)) ? args.findIndex((a) => !a.startsWith("-")) : -1
  const values = [...args.flatMap((a, i) => (i === grepPattern ? [] : a.startsWith("--") && a.includes("=") ? [a, a.slice(a.indexOf("=") + 1)] : [a])), ...redirs]
  const reader = READERS.has(cmd)
  for (const v of values) {
    if (/\.config\/+(foreman|dobby)(\/|$)/.test(v.replace(/\\/g, "")) || /(^|\/)secrets\.env$/.test(v)) return "Dobby's secrets are off-limits"
    if (reader && envGlob(v)) return ".env files hold secrets and are off-limits (a glob that matches them too)"
    if (!/^[-\w./~$@{}+:,=]*$/.test(v.replace(/\\/g, ""))) continue // not a path (a message, a pattern with spaces)
    const p = asPath(v, ctx.cwd, ctx.home)
    if (/(^|\/)\.git\/config$/.test(p)) return ".git/config may hold credentials and is off-limits"
    if (p === UNRESOLVABLE && (reader || PATH_CMDS.has(cmd))) return `${cmd}: a path built from a shell variable or ~user cannot be checked; write the path out`
    if (reader && !v.startsWith("-") && !inside(p, ctx.wtRoot)) return `${cmd} may only read inside your own worktree`
    if (inside(p, `${ctx.home}/.ssh`)) return "~/.ssh is off-limits"
    if (inside(p, ctx.dataDir) && !inside(p, ctx.wtRoot)) return "Dobby's data folder is off-limits outside your own worktree"
    if (ENV_FILE.test(basename(p)) && !ENV_OK.test(basename(p)) && !["test", "[", "[["].includes(cmd)) return ".env files hold secrets and are off-limits"
  }
  // ---- secrets in the transcript: env dumps and echoing a key (was the global secret-guard plugin; bundled here, #193) ----
  if (((cmd === "printenv" || cmd === "export" || cmd === "declare") && !args.some((a) => !a.startsWith("-"))) || (cmd === "set" && !args.length)) return "dumping the environment prints every key; ask for the one variable you need"
  if ((cmd === "printenv" && args.some((a) => SECRET_VAR.test(a))) || (["echo", "printf", "print"].includes(cmd) && args.some((a) => [...a.matchAll(/\$\{?(\w+)/g)].some((m) => SECRET_VAR.test(m[1]))))) return 'echoing a key prints it; check it is set with test -n "$NAME"'
  if (cmd === "rm" && (args.some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) || a === "--recursive") && args.some((a) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || a === "--force"))) return "no recursive force deletes"
  // ---- deploys: wrangler anywhere in the command (npx, bunx, node_modules/.bin), deploy scripts ----
  const wi = words.findIndex((x) => /^wrangler(@\S*)?$/.test(basename(x)) || /(^|\/)wrangler\/bin\//.test(x))
  if (wi >= 0) {
    const sub = words.slice(wi + 1).find((x) => !x.startsWith("-"))
    if (!["dev", "types"].includes(sub) && !words.includes("--local")) return "Cloudflare deploys and remote changes are the deploy step's, not an agent's (wrangler dev, types and --local are fine)"
  }
  if (RUNNERS.has(cmd) && args.some((a) => /^deploy([.:_-]|$)/.test(basename(a)))) return "deploys are the deploy step's, not an agent's"
  if (cmd === "rg" && args.some((a) => /^--pre(=|$)/.test(a))) return "rg --pre runs a program"
  if (cmd === "git") return gitRule(args, ctx)
  if (cmd === "gh") return ghRule(args)
  return null
}

function gitRule(args, ctx) {
  let i = 0
  for (; i < args.length && args[i].startsWith("-"); i++) {
    const a = args[i]
    if (a === "-C") {
      const dir = asPath(args[++i] ?? "", ctx.cwd, ctx.home)
      if (!inside(dir, ctx.wtRoot) || (ctx.dobbyRoot && inside(dir, ctx.dobbyRoot) && !inside(ctx.wtRoot, ctx.dobbyRoot))) return "git -C may only point at your own worktree"
      ctx = { ...ctx, cwd: dir }
    } else if (/^-c/.test(a) || /^--config-env/.test(a)) return "git -c / --config-env is not allowed"
    else if (/^--(git-dir|work-tree|exec-path|namespace|super-prefix)/.test(a)) return `git ${a.split("=")[0]} is not allowed`
  }
  const sub = args[i], rest = args.slice(i + 1)
  if (["push", "send-pack", "update-ref", "receive-pack", "filter-branch", "replace"].includes(sub)) return `git ${sub} is not allowed: agents never push; Dobby's ship step does`
  if (rest.includes("--no-index") || args.includes("--no-index")) return "git --no-index reads files outside the repo"
  if (sub === "grep" && rest.some((a) => /^--open-files-in-pager(=|$)/.test(a) || /^-[a-zA-Z]*O/.test(a))) return "git grep -O runs a program"
  if (rest.some((a) => !a.startsWith("-") && a.includes(":") && secretFile(basename(a.slice(a.indexOf(":") + 1))))) return ".env files hold secrets and are off-limits (also as REV:path)"
  if (sub === "config" && !rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a))) return "git config changes are not allowed"
  if (sub === "config" && rest.some((a) => /^(alias|core|credential|include|includeif|url)\./i.test(a))) return "git config alias/core is not allowed"
  if (sub === "switch" || sub === "checkout") {
    const dd = rest.indexOf("--")
    const pos = (dd < 0 ? rest : rest.slice(0, dd)).filter((a) => !a.startsWith("-"))
    const creates = rest.some((a) => /^-[bBcC]$|^--(orphan|create|force-create)$/.test(a))
    const target = creates ? pos[0] : dd >= 0 && sub === "checkout" ? null : pos[0]
    if (/^(main|master)$/.test(target ?? "")) return "agents stay on their ticket branch, never main/master"
  }
  if (sub === "reset" && rest.includes("--hard") && (rest.some((a) => /^(origin\/)?(main|master)$/.test(a)) || /^(main|master)$/.test(ctx.branch()))) return "no hard reset on main/master"
  if (["diff", "log", "show", "blame", "grep", "format-patch", "whatchanged"].includes(sub)) {
    for (const a of rest) {
      if (/^--(output|ext-diff|textconv)(=|$)/.test(a) || /^-o$/.test(a) && sub === "format-patch") return `git ${sub} ${a.split("=")[0]} is not allowed`
      const path = a.startsWith("--") ? null : a.startsWith("-") ? null : a
      if (path && /^(\/|~|\$|\.\.(\/|$))|\$|\/\.\.(\/|$)/.test(path) && !inside(asPath(path, ctx.cwd, ctx.home), ctx.wtRoot)) return "git may only read paths inside your own worktree"
    }
  }
  return null
}

function ghRule(args) {
  if (args.some((a) => a === "--body-file" || a.startsWith("--body-file="))) return "gh --body-file is not allowed"
  const pos = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith("-")) { if (VALUE_FLAGS.has(a) && !BOOL_FLAGS.has(a)) i++; continue }
    pos.push(a)
  }
  const [group, action] = pos
  if (group === "api") {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (/^(-X|--method)$/.test(a) && (args[i + 1] ?? "").toUpperCase() !== "GET") return "gh api may only GET"
      if (/^--method=/.test(a) && a.slice(9).toUpperCase() !== "GET") return "gh api may only GET"
      if (/^-X./.test(a) && a.slice(2).toUpperCase() !== "GET") return "gh api may only GET"
      if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a) || /^-[fF]./.test(a)) return "gh api may not send fields or a body"
    }
    if (action === "graphql" || args.some((a) => /\bmutation\b/.test(a))) return "gh api graphql is not allowed"
    return null
  }
  if (args.some((a) => a === "-F" || a === "--body-file")) return "gh --body-file is not allowed"
  if (!(group in GH_READ)) return `gh ${group ?? ""} is not allowed`
  const ok = GH_READ[group]
  if (ok && !ok.includes(action)) return `gh ${group} ${action ?? ""} is not allowed (read-only: ${ok.join(", ")})`
  return null
}

/** The hook's verdict for one Bash command: { deny } or { allow }. ctx as for guardSegment, plus allow = the role's patterns. */
export function decide(command, ctx) {
  let segs
  try { segs = parse(command) } catch (e) { return { deny: `Dobby guard: can't read this command safely (${e.message})` } }
  let cwd = ctx.cwd
  for (const seg of segs) {
    const xs = expand(seg)
    if (typeof xs === "string") return { deny: `Dobby guard: ${xs}` }
    for (const x of xs) {
      const c = { ...ctx, cwd }
      const why = x.xargs ? null : guardSegment(x.words, x.redirs, c)
      if (why) return { deny: `Dobby guard: ${why} (\`${x.words.join(" ").slice(0, 80)}\`)` }
      if (!x.xargs && !allowedBy(x.words, ctx.allow) && !(graphRole(ctx.allow) && graphHelper(x.words))) return { deny: `Dobby guard: \`${x.words.join(" ").slice(0, 80)}\` is not in this role's allowed commands${ctx.allow.length ? "" : " (this role has no shell)"}` }
      if (x.words[0] === "cd" && x.words[1]) cwd = asPath(x.words[1], cwd, ctx.home)
    }
  }
  return { allow: true }
}

/** The role's Bash patterns from DOBBY_BASH_ALLOW (a JSON array); anything unreadable = none. */
export function patterns(env = process.env.DOBBY_BASH_ALLOW) {
  try { const p = JSON.parse(env ?? "[]"); return Array.isArray(p) ? p.filter((x) => typeof x === "string") : [] } catch { return [] }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let raw = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (d) => (raw += d))
  process.stdin.on("end", () => {
    const say = (o) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...o } }))
    let input
    try { input = JSON.parse(raw) } catch { return say({ permissionDecision: "deny", permissionDecisionReason: "Dobby guard: unreadable hook input" }) }
    const command = input?.tool_input?.command
    if (input?.tool_name !== "Bash") return
    if (typeof command !== "string") return say({ permissionDecision: "deny", permissionDecisionReason: "Dobby guard: no command" })
    const cwd = input.cwd || process.cwd()
    const git = (...a) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).stdout?.trim() ?? ""
    const home = homedir()
    const ctx = {
      cwd, wtRoot: git("rev-parse", "--show-toplevel") || cwd, home, allow: patterns(),
      dobbyRoot: (process.env.DOBBY_ROOT ?? "").replace(/\/$/, ""), dataDir: process.env.DOBBY_DIR || `${home}/.local/share/dobby`,
      branch: () => git("rev-parse", "--abbrev-ref", "HEAD"),
    }
    const d = decide(command, ctx)
    if (d.deny) return say({ permissionDecision: "deny", permissionDecisionReason: d.deny })
    const r = spawnSync("rtk", ["rewrite", command], { encoding: "utf8", timeout: 5000 })
    const rewritten = (r.status === 0 || r.status === 3) ? (r.stdout ?? "").trim() : ""
    say({ permissionDecision: "allow", permissionDecisionReason: "Dobby guard: within this role's allowed commands", ...(rewritten && rewritten !== command ? { updatedInput: { ...input.tool_input, command: rewritten } } : {}) })
  })
}
