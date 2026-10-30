import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { ghRepo, hits, outboundPrivate, ownerWords, patterns, pushRefusal, redactPrivate, repoOfUrl, visibility } from "../src/privacy.ts"

// a made-up owner: config words plus the private terms file, under a temp HOME
const home = mkdtempSync(join(tmpdir(), "privacy-"))
mkdirSync(`${home}/.config/dobby`, { recursive: true })
writeFileSync(`${home}/.config/dobby/config.json`, JSON.stringify({ github: { owner: "acmeorg", accounts: ["acmeorg", "jdoe9"] }, clientNames: ["Tally"] }))
writeFileSync(`${home}/.config/dobby/private-terms.txt`, "# comment\nshopfront\n")
process.env.HOME = home
visibility.set("acmeorg/dobby", true).set("acmeorg/secret", false)

test("owner words: config and terms file; the hosting account and the product's names are allowed", () => {
  assert.deepEqual(ownerWords(home, ["acmeorg"]).sort(), ["Tally", "jdoe9", "shopfront"])
})

test("hits and redaction: whole words, any case, plus home folders and personal emails", () => {
  const p = patterns(["shopfront"])
  assert.deepEqual(hits("ok\nShopfront ships\n/Users/jane/x\nmail a@gmail.com\nshopfronts", p), ["line 2: shopfront", "line 3: home folder", "line 4: personal email"])
  assert.equal(redactPrivate("shopfront and SHOPFRONT", p), "‹private› and ‹private›")
})

test("the repo a gh call targets", () => {
  assert.equal(ghRepo(["pr", "create", "--repo", "a/b"]), "a/b")
  assert.equal(ghRepo(["issue", "create", "-R", "a/b"]), "a/b")
  assert.equal(ghRepo(["api", "-X", "POST", "repos/a/b/issues/1/comments"]), "a/b")
  assert.equal(repoOfUrl("git@github.com:a/b.git"), "a/b")
  assert.equal(repoOfUrl("https://github.com/a/b\n"), "a/b")
})

test("text posted to a public repo loses private words; a private repo and read calls are untouched", () => {
  assert.deepEqual(outboundPrivate(["issue", "create", "--repo", "acmeorg/dobby", "--title", "Fix Tally login", "--body", "for shopfront"]),
    ["issue", "create", "--repo", "acmeorg/dobby", "--title", "Fix ‹private› login", "--body", "for ‹private›"])
  assert.deepEqual(outboundPrivate(["issue", "create", "--repo", "acmeorg/secret", "--title", "Fix Tally"]), ["issue", "create", "--repo", "acmeorg/secret", "--title", "Fix Tally"])
  assert.deepEqual(outboundPrivate(["pr", "list", "--repo", "acmeorg/dobby", "--search", "Tally"]), ["pr", "list", "--repo", "acmeorg/dobby", "--search", "Tally"])
})

test("a push to a public origin is refused when the change or its message holds a private word", () => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-push-"))
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: dir, encoding: "utf8" })
  git("init", "-q", "-b", "main"); git("remote", "add", "origin", "https://github.com/acmeorg/dobby.git")
  writeFileSync(`${dir}/a.txt`, "hello\n"); git("add", "."); git("commit", "-qm", "first")
  git("update-ref", "refs/remotes/origin/main", "HEAD")
  git("switch", "-qc", "feat")
  writeFileSync(`${dir}/a.txt`, "hello\nclean line\n"); git("commit", "-qam", "clean")
  assert.equal(pushRefusal(["push", "origin", "feat"], dir), null)
  writeFileSync(`${dir}/b.txt`, "built for shopfront\n"); git("add", "."); git("commit", "-qm", "add b")
  assert.match(pushRefusal(["push", "origin", "feat"], dir) ?? "", /not pushed to public acmeorg\/dobby.*shopfront/)
  assert.equal(pushRefusal(["push", "origin", ":feat"], dir), null) // a branch delete always goes
  git("remote", "set-url", "origin", "https://github.com/acmeorg/secret.git")
  assert.equal(pushRefusal(["push", "origin", "feat"], dir), null) // private repo
})
