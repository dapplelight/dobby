---
title: "Timelapse of a day"
description: "Make a private 15-second clip of a day of agents working, with a manifest and a signature anyone can check."
sidebar: { group: Guides, order: 16 }
---

`dobby timelapse` turns one day of Dobby's work into a 15-second video. It is made on your machine from Dobby's own event log. It is never a screen recording, and nothing is uploaded.

## Make a clip

```
dobby timelapse                  # today
dobby timelapse 2026-10-27       # a day you name
dobby timelapse --show myapp     # also show the repo name and ticket titles of a public repo
```

Dobby prints a preview first: how many events, the time range, and every event that will go in the file. Then it asks before it writes anything. In a script there is no question, so the command refuses to write unless you pass `--yes`. `--dry` shows the preview and stops.

Three files are written, next to each other (change the place with `--out <path>`, no extension):

- `dobby-timelapse-<day>.mp4`: the clip.
- `dobby-timelapse-<day>.manifest.json`: the events the clip was drawn from.
- `dobby-timelapse-<day>.sig`: a signature over the clip and the manifest.

The clip needs `ffmpeg`. If it is missing, Dobby says so and writes nothing.

## What goes in

Only these fields: time of day, role, what happened (done, failed, passed, changes requested, merged), and how long it took. The counters on screen are counted from those. Code, prompts, diffs, file paths, user names, emails and keys are never read into it.

Repo names and ticket titles are off. `--show <project>` turns them on for one project, and only if its repo is public. Dobby refuses for a private repo. A ticket title that holds a path, an email, a long token or one of your private words is left out even for a public repo.

Before the file is written, the manifest goes through the same privacy check Dobby runs before anything is posted to a public repo. If it finds one of your private words, nothing is written.

For a public repo you opted in, the manifest also lists each merged pull request with the commit that was reviewed and the merge time. Anyone can look those up on GitHub.

## Check a clip

```
dobby timelapse verify clip.mp4 clip.manifest.json
```

Dobby draws the clip again from the manifest and compares it with your clip frame by frame, then checks the signature. Any change to the video or the manifest fails. Keep the `.sig` file next to the clip, or name it with `--sig <file>`.

The signature uses a key made on your machine the first time you export. It lives next to your secrets file as `timelapse-key.pem`, readable only by you. Dobby never prints it.

## What a signature proves

A valid signature proves the clip and the manifest are the files that were exported with that key: nothing was cut, re-timed or edited afterwards. It does not prove the log was honest. The log is on your machine, and you could have changed it before exporting. For merged pull requests in public repos, the commits and merge times in the manifest are the part a stranger can check against GitHub.
