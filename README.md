# Tomatotimer

A small, dependency-free timer at https://tomatotimer.github.io/.

- Set a duration from 1 second to 59 minutes, 59 seconds.
- Pick an inclusive random number of minutes between 1 and 59.
- Pause, resume, reset, or repeat the same duration.
- See local time and optionally play a finishing chime.
- Restore the current session when reloading the same tab.

## Run locally

Serve the repository with any static HTTP server, for example:

```sh
python3 -m http.server 4173 --bind 127.0.0.1
```

Open http://127.0.0.1:4173/. There is no dependency install or build step.

## Test

With Node.js 18 or newer:

```sh
node --test tests/timer.test.cjs
```

The tests cover duration validation, inclusive random endpoints, countdown rounding,
deadline calculations, pause/resume/reset, duplicate state actions, and restored sessions.

`app.js` separates pure timing rules from DOM rendering. Time remaining comes from
an absolute deadline, so delayed browser updates do not accumulate countdown drift.
Browsers may delay sound while backgrounded or asleep. Reloaded pages may need a
new user gesture to enable audio. The on-screen timer reconciles when the page
resumes; changes to the device clock can affect the deadline.

## Deploy

GitHub Pages serves `main` from the repository root. Commit the static source files
and push to `main`. `plan.md` is intentionally ignored and stays local.
