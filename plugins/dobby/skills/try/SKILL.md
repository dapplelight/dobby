---
name: try
description: Decide whether Dobby fits this repo before installing it. Use when the user asks what Dobby is, whether to install it, or says /dobby:try.
---

Help the user decide whether to install Dobby. Read first, install nothing.

1. Read how Dobby works with the `dobby_docs` tool: op "read" for the topics how-it-works, what-waits, security and install. Use op "search" for anything the user asks about.
2. Look at this repo, read only: does it have a GitHub remote, do its tests run and pass on main, is this macOS or Linux (or WSL2), and is Node 24 there? Dobby needs all of these.
3. Answer in plain words, short:
   - What Dobby would do here, using one real example from this repo as a ticket.
   - What would wait for the user with the default settings, and what would merge on its own.
   - What is missing before it can run, if anything.
   - Your verdict: install now, fix something first, or skip it.
4. If the user wants it, give the install steps from the install page. Never run `npm i -g dobby-ai`, `dobby init` or any sign-in yourself: the user runs them.

If the `dobby_docs` tool is missing, read https://dobby.dapplelight.in/docs/llms-full.txt instead.
