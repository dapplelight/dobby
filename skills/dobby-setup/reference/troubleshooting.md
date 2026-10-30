# Setup troubleshooting

Each entry is a symptom, the likely cause, and the fix. Commands are for macOS and Linux. Run them in a terminal.

## dobby is not on PATH after npx

Symptom: `dobby: command not found` after `npx dobby-ai init`.
Cause: npx runs Dobby once and does not install it.
Fix: install it, then open a new terminal.

    npm install -g dobby-ai

Then run `dobby jobs install` so the background jobs point at the installed copy and not at the npx cache, which gets cleaned.

## Node is not found by the background jobs

Symptom: setup works, but jobs show "did not start", or `dobby doctor` says a job is not loaded, or the job log says `node: not found`.
Cause: Node comes from nvm, volta, asdf, mise or fnm, which add themselves to PATH only in an interactive shell. A background job does not read that.
Fix: use a Node that is on the system PATH, or run the job install from a terminal where `which node` prints the Node you want.

    which node
    npm install -g dobby-ai
    dobby jobs install

If it still fails, install Node 24 with Homebrew (`brew install node`) or your package manager.

## Node is too old

Symptom: "Dobby needs Node 24" or a native module error such as a `better-sqlite3` ABI mismatch.
Fix: install Node 24.
macOS: `brew install node`.
Linux: `fnm install 24 && fnm use 24`, or the NodeSource package for 24.

## GitHub CLI is signed out

Symptom: the check "GitHub sign-in" fails.
Fix: sign in with the browser flow. Over SSH the page cannot open, but the one-time code is printed, so you can enter it on another device.

    gh auth login --web --git-protocol https

If you have several accounts, `gh auth status` shows which one is active and `gh auth switch` changes it. Dobby uses the active one.

## GitHub CLI cannot reach GitHub

Symptom: "not signed in" although you are signed in.
Cause: the check could not reach github.com (offline, proxy, outage).
Fix: check the network, then run `gh auth status`. Behind a proxy, set `HTTPS_PROXY` in the terminal and run the check again.

## GitHub Enterprise Server

Dobby supports github.com. A repo whose remote points at an Enterprise host is not listed.

## SSH host aliases in remotes

Symptom: a repo you expect is missing from the list, and its remote looks like `git@github-work:org/repo.git`.
Cause: the remote uses an alias from `~/.ssh/config`, so Dobby cannot tell it is a GitHub repo.
Fix: point the remote at the real host.

    git remote set-url origin git@github.com:org/repo.git

If you need the alias for a second key, keep it in your ssh config and use `Host github.com` with an `IdentityFile` line instead.

## The account cannot push or read an organization

Symptom: pushes fail with 403, or "SAML enforcement".
Fix: the signed-in account needs push rights on the repo. Check with `gh api repos/OWNER/REPO --jq .permissions.push`. For an organization with single sign-on, authorize the token for it in GitHub under Settings, Applications. For workflow files, run `gh auth refresh -s workflow`.

## Claude Code is not signed in

Symptom: "Claude sign-in" fails.
Fix: run `claude` in a terminal, type `/login` and finish the browser step. Run `claude auth status` to confirm.

## API-key mode

Symptom: you pay by the token and have no Pro or Max plan, and the Claude sign-in check keeps failing.
Fix: Dobby has an API-key mode. Run `dobby config set billing.mode apiKey`, then add the line `DOBBY_API_KEY=<your key>` to the secrets file yourself (`dobby config path` shows the folder). Do not paste the key into a chat or into this tool.

## Claude Code is not installed

Fix: `npm install -g @anthropic-ai/claude-code`, then run `claude` once to sign in.

## Tests need a database, Docker or env vars

Symptom: a repo fails to verify with a connection refused, a missing env var, or "cannot connect to the Docker daemon".
Cause: the tests need a service or a secret that is not there during setup.
Fix, pick one:
- Start the service (`docker compose up -d`) and check the repo again.
- Set a test command that does not need it, such as a unit-test script: `npm run test:unit`.
- Add the repo anyway with tests off. It is saved with `verify: true`, and you set the real command in its project file later.

Do not put secrets in the project file.

## Install fails

Symptom: the install step fails before any test runs.
Fix: run the exact install command in the repo's folder in a terminal and read the first error. Common causes are a missing compiler (`xcode-select --install` on macOS, `sudo apt install build-essential` on Ubuntu), a private package registry that needs a login, or the wrong Node version for that repo (check `.nvmrc` or `engines` in package.json).

## Python repos

Symptom: `pip install -e .` fails with "externally-managed-environment".
Cause: recent Homebrew Python and Ubuntu 23.04 and newer refuse to install into the system Python.
Fix: use a virtual environment in the repo.

    python3 -m venv .venv && .venv/bin/pip install -e .

If the repo has a `uv.lock`, use `uv sync` and `uv run pytest`. If it has `poetry.lock`, use `poetry install` and `poetry run pytest`.

## Repos in other languages

Symptom: the repo is listed with "none found" for its test command.
Fix: type the test command yourself. Examples: `bundle exec rspec` (Ruby), `./gradlew test` (Gradle), `mvn test` (Maven), `composer test` (PHP), `dotnet test` (.NET), `mix test` (Elixir), `swift test` (Swift). The install command can stay `true` when the test command installs what it needs.

## Linux: the sandbox is blocked

Symptom: builds and verifies fail with a user namespace or `bwrap` error, mostly on Ubuntu 24.04 and newer.
Cause: bubblewrap is installed, but the system forbids unprivileged user namespaces for it.
Fix: install the tools, then allow bubblewrap with an AppArmor profile or, for a quick test, relax the setting.

    sudo apt install bubblewrap socat
    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0

The sysctl line lasts until reboot. To keep it, put `kernel.apparmor_restrict_unprivileged_userns=0` in a file in `/etc/sysctl.d/`. Check with `bwrap --ro-bind / / true`, which should print nothing.

## Git commits fail: signing

Symptom: a builder cannot commit, with a gpg or ssh-keygen error.
Cause: `commit.gpgsign=true` is set globally, and the signing agent is not reachable from a background job.
Fix: turn signing off for the repo Dobby works in. Your other repos are not changed.

    git -C /path/to/repo config commit.gpgsign false

GitHub signs squash merges itself.

## Git commits fail: no identity

Symptom: "Please tell me who you are" or "unable to auto-detect email address".
Fix:

    git config --global user.name "Your Name"
    git config --global user.email "you@example.com"

## Branch protection needs approvals

Symptom: Dobby's pull requests never merge, and GitHub says the base branch policy prohibits the merge.
Cause: Dobby opens pull requests as your account, and GitHub does not let you approve your own pull request.
Fix: ask a second person to review, or change the required approvals for your account in the repo's branch rules under Settings, Branches. Dobby never bypasses a rule.

## Background jobs do not start

macOS, set up over SSH with nobody logged in: log in once on the screen, then run `dobby jobs install`.
Linux, "Failed to connect to bus": there is no systemd user session. Run `dobby start` in tmux, or enable systemd in WSL with `systemd=true` under `[boot]` in `/etc/wsl.conf` and restart WSL.
In both cases `dobby doctor` shows which jobs are loaded.

## Git LFS or submodules

If a repo uses Git LFS, install it: `brew install git-lfs` or `sudo apt install git-lfs`, then `git lfs install`. If it has submodules, run `git submodule update --init --recursive` in the repo.

## Disk full or slow network drive

Dobby keeps its database in a folder under your home. On a network drive, or with under 15 GB free, set `DOBBY_DIR` to a folder on a local disk.
