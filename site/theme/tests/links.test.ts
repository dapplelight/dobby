import assert from "node:assert/strict"
import { test } from "node:test"
import { slugOf, rewriteLinks } from "../links.ts"
import { parsePage, pageMarkdown } from "../loader.ts"

test("slugOf", () => {
  assert.equal(slugOf("getting-started.md"), "getting-started")
  assert.equal(slugOf("guides/index.md"), "guides")
  assert.equal(slugOf("index.md"), "")
})

test("rewriteLinks maps links inside the folder, leaves the rest", () => {
  const md = "[a](billing.md#which-one) [b](../README.md) [c](https://x.test/a.md) [d](#top) [e](guides/x.md)"
  assert.equal(rewriteLinks(md, "/r/docs/manual/start.md", "/r/docs/manual", "docs", "page"),
    "[a](/docs/billing/#which-one) [b](../README.md) [c](https://x.test/a.md) [d](#top) [e](/docs/guides/x/)")
  assert.equal(rewriteLinks("[a](manual/billing.md)", "/r/docs/llms.txt", "/r/docs/manual", "docs", "md"), "[a](/docs/billing.md)")
})

test("parsePage: H1 + summary when there is no frontmatter", () => {
  const p = parsePage("<!-- generated -->\n# CLI reference\n\n> Every command.\n\nBody\n")
  assert.deepEqual(p.data, { title: "CLI reference", description: "Every command." })
  assert.equal(p.body, "Body\n")
  assert.equal(pageMarkdown(p), "# CLI reference\n\n> Every command.\n\nBody\n")
})

test("parsePage: frontmatter wins and a duplicate H1 is dropped", () => {
  const p = parsePage("---\ntitle: Install\ndescription: Get it running.\nsidebar:\n  group: Start\n  order: 1\n---\n# Install\n\nBody\n")
  assert.equal(p.data.title, "Install")
  assert.equal(p.data.sidebar.group, "Start")
  assert.equal(p.body, "Body\n")
})
