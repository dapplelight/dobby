// `dobby approve|decline <id>` against a ticket parked at the graph's gate node. Offline: temp data dir, the real CLI, no Discord.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-gate-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.env` // empty: nothing can reach Discord or GitHub
process.env.DOBBY_CONFIG = `${dir}/config.json` // points paths.projects at the temp clones, not ~/projects
process.env.JEV_API_KEY = ""
mkdirSync(`${dir}/projects/tally`, { recursive: true })
writeFileSync(`${dir}/config.json`, JSON.stringify({ paths: { projects: `${dir}/projects` } }))
writeFileSync(`${dir}/projects/tally/dobby.md`, "---\nbase: main\n---\n## Goals\n- Ship")
const { open } = await import("../src/db.ts")
const { compileTicketGraph, thread, Command } = await import("../src/graphs/ticket.ts")

const db = open()
const run = (...a: string[]) => spawnSync(new URL("../bin/dobby", import.meta.url).pathname, a, { encoding: "utf8", env: process.env })
const status = (id: number) => (db.prepare("SELECT status FROM tickets WHERE id=?").get(id) as { status: string }).status
/** A ticket whose graph thread waits at the gate, like the old tickets that were waiting for the owner. `onto` makes approve fail fast at the push instead of opening a PR. */
const atGate = async (title: string) => {
  const id = Number(db.prepare("INSERT INTO tickets (project,title,status,onto,created_at,updated_at) VALUES ('tally',?,'review','foreman/none',datetime('now'),datetime('now'))").run(title).lastInsertRowid)
  const app = compileTicketGraph(db)
  await app.invoke(new Command({ goto: "gate", update: { ticketId: id, branch: "foreman/none", summary: "s", verdict: { pass: true, reason: "ok" } } }), thread(id))
  assert.deepEqual((await app.getState(thread(id))).next, ["gate"])
  return id
}

test("approve and decline resume the gate: decline declines the ticket, approve goes on to ship", async () => {
  const no = await atGate("Decline me"), yes = await atGate("Approve me")
  assert.match(run("decline", String(no)).stdout, /Decline me: declined/)
  assert.equal(status(no), "declined")
  assert.match(run("approve", String(yes)).stdout, /Approve me: failed: push/) // ship ran; its push fails: the repo is the temp dir (paths.projects), not a git clone, so nothing can reach a real origin
  assert.notEqual(status(yes), "declined")
})

test("approve or decline on a missing ticket is one line and exit 1, no stack", () => {
  for (const c of ["approve", "decline"]) {
    const r = run(c, "9999")
    assert.equal(r.status, 1)
    assert.match(r.stderr, /^no ticket #9999\n$/)
  }
})
