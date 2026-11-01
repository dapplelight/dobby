import assert from "node:assert/strict"
import { test } from "node:test"
import { goalText, runAction } from "../src/actions.ts"
import { actionArgs } from "../src/dashboard-server.ts"
import { open } from "../src/db.ts"
import { addTicket } from "../src/lib.ts"

test("dobby goal moves tickets of the goal's own app and leaves the rest", () => {
  const db = open(":memory:")
  const ins = db.prepare("INSERT INTO goals (project,title,rank,updated_at) VALUES (?,?,?,?) RETURNING id")
  const a = (ins.get("shop", "Launch", 1, "") as { id: number }).id
  const b = (ins.get("shop", "After launch", 2, "") as { id: number }).id
  const t1 = addTicket(db, { project: "shop", title: "one", goal: a }).id
  const t2 = addTicket(db, { project: "blog", title: "two" }).id
  assert.match(goalText(db, b, [t1, t2]), /^1 ticket\(s\) moved to goal \d+: After launch\. Not shop tickets.*#\d+/)
  assert.equal((db.prepare("SELECT goal FROM tickets WHERE id=?").get(t1) as { goal: number }).goal, b)
  assert.equal(goalText(db, 999, [t1]), "goal 999 is not an active goal (dobby goals <app> lists them)")
})

test("the goal action: MCP and dashboard reach the same move", async () => {
  const db = open(":memory:")
  const g = (db.prepare("INSERT INTO goals (project,title,rank,updated_at) VALUES ('shop','After launch',1,'') RETURNING id").get() as { id: number }).id
  const t = addTicket(db, { project: "shop", title: "one" }).id
  assert.match((await runAction(db, "goal", { id: t, goal: g })).text, /^1 ticket\(s\) moved/)
  assert.deepEqual(actionArgs(db, { action: "goal", id: t, goal: g }), { args: ["goal", String(g), String(t)], direct: true })
  assert.deepEqual(actionArgs(db, { action: "goal", id: t }), { error: "goal needs a ticket id and a goal id" })
})
