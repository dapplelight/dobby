---
name: dobby-setup
description: Use when Dobby setup fails, a check in dobby init or dobby doctor is red, a repo will not verify, or the background jobs are not running. Finds the failing step, looks it up in the troubleshooting reference and proposes the smallest fix.
---

# Fixing a Dobby setup

Dobby is a team of AI agents that runs on your machine. Setup checks the machine, finds your repos, proves their install and test commands, saves settings and starts background jobs. This skill finds what is stopping that and proposes the smallest fix.

## Method

1. Run `dobby doctor --json` and read which check fails. If `dobby` is not found, that is the first problem: see "dobby is not on PATH after npx" in `reference/troubleshooting.md`.
2. For a repo that will not verify, read the command that ran and the last lines of its output. Do not guess from the repo name.
3. Look the symptom up in `reference/troubleshooting.md`. Use the entry for this operating system.
4. Propose the smallest fix: one command, or one line to add to a file. Say what it does and why it should work.
5. Show every command before running it and wait for a yes. When the user says yes, run it, then run `dobby doctor` again to see whether the check turned green.

## Rules

- Never use sudo. If a fix needs it, print the command and let the user run it.
- Never edit anything outside the repo being fixed and Dobby's own config folder (`dobby config path` prints where it is).
- Never read secrets.env or any file that holds keys or tokens, and never print one. A secret is only ever "set" or "not set".
- Never run a command that downloads and runs a script (`curl ... | sh`). Show the page and let the user decide.
- Do not change a repo's code to make its tests pass. Setup only needs the install and test commands to be right.
- If a test needs a database, Docker or an env var, say so. The user can add the repo with tests off until those exist.

## Answer shape

When another program asks for the answer as JSON, reply with one JSON object and nothing else: `{"install": "...", "test": "...", "cause": "...", "fix": "..."}`. Every field is optional. `install` and `test` are single shell commands that run in the repo's folder. `cause` and `fix` are one plain sentence each. Leave out a field you do not know.
