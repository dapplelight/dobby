# Dobby

An AI dev team that runs on your own machine. You file tickets, and Dobby builds, tests, reviews and ships them as pull requests on your GitHub repos. Merges and deploys wait for you unless you say otherwise.

Each role is a Claude Code run with its own rules: Lead, Builder, QA, Code Reviewer, Product Manager and Chief of Staff. Builders work inside an OS sandbox with no credentials and no network.

## Quick start

```sh
npx dobby-ai init
```

`init` asks at most three questions:
1. Which repos to work on.
2. Where to chat: the terminal or Discord.
3. Recommended or custom settings.

It then checks each repo's install and test commands, installs the background jobs, and offers a first ticket. On a fresh install, merges stay paused until you run `dobby resume merges`.

Then:

```sh
dobby add <project> "Fix the footer spacing" "the footer has 16px padding on phones"
dobby start        # or let the background jobs run it
dobby status       # what is building, shipped today, stuck
dobby doctor       # checks the setup and prints the fix for anything wrong
```

## Requirements

- macOS or Linux (systemd), with zsh
- Node 24+, git, and the GitHub CLI (`gh auth login`)
- Claude Code, signed in to a Pro or Max plan, or an Anthropic API key (see [docs/billing.md](docs/billing.md))
- Linux sandbox: bubblewrap and socat. Without them, builders get the credential scrub only.

## Add-ons

- `dobby add discord`: buttons for approvals and one thread per ticket
- `dobby add dashboard`: a local web dashboard ([docs/dashboard-phone.md](docs/dashboard-phone.md) for phone access)
- `dobby add jobs`: run everything in the background instead of `dobby start`

## Safety

- Builders run in Claude Code's sandbox. Dobby runs their tests and installs in the same sandbox.
- A command guard checks every shell command an agent runs.
- Pull requests from strangers on public repos are never reviewed by a model.
- Tickets an agent files (for example from an email) wait for your tap.
- Merges need your account as author, a pinned head commit and a passing review. Deploys wait for you by default.

## Docs

- [Billing: plan or API key](docs/billing.md)
- [The reviewer](docs/reviewer.md) and [external reviewers](docs/reviewer-external.md) (CodeRabbit, Greptile, Copilot)
- [Other model providers](docs/providers.md)

## Development

```sh
npm install
npm test
npm run typecheck
```

## License

MIT. Some skills are copied from other projects and keep their own licenses: see [THIRD_PARTY.md](THIRD_PARTY.md).
