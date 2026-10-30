import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []))

test("dashboard: no browser dialogs (alert, confirm, prompt); errors show on the page", () => {
  const hits = files("dashboard/src").filter((f) => /(?<![\w.])(window\.)?(alert|confirm|prompt)\(/.test(readFileSync(f, "utf8")))
  assert.deepEqual(hits, [])
})
