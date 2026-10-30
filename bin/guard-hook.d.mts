export type Seg = { words: string[]; redirs: string[]; xargs?: boolean }
export type Ctx = { cwd: string; wtRoot: string; home: string; dobbyRoot: string; dataDir: string; branch: () => string }
export function parse(cmd: string): Seg[]
export function expand(seg: Seg): Seg[] | string
export function allowedBy(words: string[], patterns: string[]): boolean
export function asPath(word: string, cwd: string, home?: string): string
export function guardSegment(words: string[], redirs: string[], ctx: Ctx): string | null
export function decide(command: string, ctx: Ctx & { allow: string[] }): { deny?: string; allow?: boolean }
export function patterns(env?: string): string[]
