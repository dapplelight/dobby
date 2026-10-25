// The shell that runs a project's own command lines (install, verify, deploy): a login shell so PATH matches the owner's terminal.
import { existsSync } from "node:fs"
import { delimiter } from "node:path"

const onPath = (bin: string, path = process.env.PATH ?? "") => path.split(delimiter).some((d) => d && existsSync(`${d}/${bin}`))
/** zsh when installed (the Mac), else bash, else plain sh (no login flag: dash and busybox lack it). */
export const shellName = (path?: string): "zsh" | "bash" | "sh" => onPath("zsh", path) ? "zsh" : onPath("bash", path) ? "bash" : "sh"
/** [command, args] to run `cmd` in that shell. */
export function loginShell(cmd: string, path?: string): [string, string[]] {
  const s = shellName(path)
  return [s, [s === "sh" ? "-c" : "-lc", cmd]]
}
