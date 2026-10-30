# Dobby

Dobby runs Claude Code on your tickets and opens reviewed pull requests on your GitHub repos. It runs on your own machine and on your own Claude plan.

Dobby is in public beta.

## Quick start

You need macOS or Linux (WSL2 on Windows), Node 24, git and 15 GB of free disk. Dobby runs on Claude Code only today. Support for other agent harnesses is coming.

Sign in to the GitHub CLI, then to Claude Code (a Pro or Max plan, or an Anthropic API key):

```sh
gh auth login
claude
```

Install Dobby. This puts the `dobby` command on your PATH. `npx dobby-ai init` also runs setup, but it does not keep the `dobby` command.

```sh
npm i -g dobby-ai
dobby init
```

If npm warns that better-sqlite3 has install scripts that are not allowed, Dobby still works. See [Install](docs/manual/install.md).

`dobby init` looks for repos with a GitHub remote in ~/projects, ~/code, ~/dev, ~/src, ~/work, ~/Developer, ~/repos and ~/GitHub. For another folder, run `dobby init --projects <folder>`.

Setup asks before it installs the background jobs that build while you are away. To try Dobby without them, skip the jobs and keep `dobby start` open in a terminal:

```sh
dobby init --no-jobs
dobby start
```

Then write a ticket: a project, a title and a done-when line.

```sh
dobby add shopfront "Fix the footer spacing" "the footer has 16px padding on phones"
dobby status
```

[Your first hour](docs/manual/first-hour.md) follows that ticket to a merged pull request.

## What waits for you

- A fresh install opens pull requests but does not merge them until you run `dobby resume merges`.
- Deploys wait for your tap by default, and a migration that changes existing data always waits.
- The safety preset (Balanced, Strict or Autonomous) decides which other changes wait for you.
- Builders run in an OS sandbox with no credentials and no network.

## Docs

The docs are at [dobby.dapplelight.in/docs](https://dobby.dapplelight.in/docs). The same pages are in [docs/manual](docs/manual/), and `dobby docs` prints them in your terminal.

- [Your first hour](docs/manual/first-hour.md)
- [What waits for you](docs/manual/what-waits.md)
- [Security and the sandbox](docs/manual/security.md)
- [CLI reference](docs/manual/cli.md)

## Development

```sh
npm install
npm test              # unit tests, fast
npm run e2e           # tickets from start to merge, with a fake Claude and a fake GitHub (tests/e2e); offline
npm run coverage      # everything above, with a line-coverage gate on src/
npm run typecheck
npm run docs          # regenerate the generated manual pages and llms.txt
```

## License

MIT. Some skills are copied from other projects and keep their own licenses: see [THIRD_PARTY.md](THIRD_PARTY.md).
