#!/bin/sh
# Proves the npx path end to end: pack the package, run it with npx from a temp folder under a temp HOME, and check that
# the version prints and the sandbox runner (srt) resolves from the npx cache. Needs the network (npx installs the
# dependencies, better-sqlite3's prebuild among them), so it is not part of npm test. Usage: scripts/npx-smoke.sh
set -eu
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && npm pack --silent "$repo" >/dev/null) # prepack builds dist/
tgz="./$(cd "$tmp" && ls dobby-ai-*.tgz)" # npx reads an absolute path as a command; ./file.tgz is a package spec
mkdir "$tmp/home" "$tmp/work"
export HOME="$tmp/home" npm_config_cache="$tmp/cache" DOBBY_CONFIG_DIR="$tmp/home/.config/dobby"
cd "$tmp"
want="$(node -p "require('$repo/package.json').version")"
got="$(npx --yes "$tgz" --version)"
[ "$got" = "$want" ] || { echo "FAIL: npx --version printed '$got', wanted '$want'"; exit 1; }
echo "ok  npx dobby-ai --version -> $got"
out="$(npx --yes "$tgz" doctor 2>&1 || true)"
echo "$out" | grep "sandbox runner"
echo "$out" | grep -q "✓ sandbox runner" || { echo "FAIL: the sandbox runner did not resolve under npx"; exit 1; }
echo "ok  sandbox runner resolves from the npx cache"
pkg="$(ls -d "$tmp"/cache/_npx/*/node_modules/dobby-ai)"
[ ! -e "$pkg/node_modules/.bin/srt" ] && echo "ok  (the old path $pkg/node_modules/.bin/srt does not exist: npx hoists it above the package)"
