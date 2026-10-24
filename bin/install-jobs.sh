#!/bin/zsh
# Installs Dobby's six background jobs (launchd). Kept for older scripts: the installer is `dobby jobs install` (src/jobs.ts).
exec "${0:A:h}/dobby" jobs install "$@"
