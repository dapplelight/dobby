import assert from "node:assert/strict"
import { test } from "node:test"
import { markdownPath, negotiate, wantsMarkdown } from "../functions/negotiate.ts"

const assets = { fetch: async (u: Request | string) => (String(u).endsWith("/docs/billing.md") ? new Response("# Billing\n") : new Response("nope", { status: 404 })) }
const html = async () => new Response("<h1>Billing</h1>", { headers: { "Content-Type": "text/html" } })
const req = (path: string, accept?: string, method = "GET") => new Request(`https://x.test${path}`, { method, headers: accept ? { Accept: accept } : {} })

test("wantsMarkdown respects q-values", () => {
  assert.equal(wantsMarkdown("text/markdown"), true)
  assert.equal(wantsMarkdown("text/markdown, text/html;q=0.9"), true)
  assert.equal(wantsMarkdown("text/html, text/markdown;q=0.5"), false)
  assert.equal(wantsMarkdown("text/html,*/*"), false)
  assert.equal(wantsMarkdown(null), false)
  assert.equal(wantsMarkdown("text/markdown;q=0"), false)
})

test("markdownPath maps page URLs and skips files", () => {
  assert.equal(markdownPath("/docs/billing/"), "/docs/billing.md")
  assert.equal(markdownPath("/docs/billing"), "/docs/billing.md")
  assert.equal(markdownPath("/docs/llms.txt"), undefined)
  assert.equal(markdownPath("/"), undefined)
})

test("Accept: text/markdown returns the .md copy", async () => {
  const res = await negotiate(req("/docs/billing/", "text/markdown"), assets, html)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("Content-Type"), "text/markdown; charset=utf-8")
  assert.equal(res.headers.get("Vary"), "Accept")
  assert.equal(await res.text(), "# Billing\n")
})

test("browsers get HTML, with Vary: Accept", async () => {
  const res = await negotiate(req("/docs/billing/", "text/html,application/xhtml+xml,*/*;q=0.8"), assets, html)
  assert.equal(await res.text(), "<h1>Billing</h1>")
  assert.match(res.headers.get("Vary") ?? "", /Accept/)
})

test("no .md copy falls through to the normal response (real 404 stays 404)", async () => {
  const res = await negotiate(req("/docs/nope/", "text/markdown"), assets, async () => new Response("not found", { status: 404 }))
  assert.equal(res.status, 404)
})

test("HEAD gets headers, no body", async () => {
  const res = await negotiate(req("/docs/billing/", "text/markdown", "HEAD"), assets, html)
  assert.equal(res.headers.get("Content-Type"), "text/markdown; charset=utf-8")
  assert.equal(await res.text(), "")
})
