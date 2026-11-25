# pi-async-rewake

Pi extension for **async background job rewake** — the equivalent of Claude
Code's Stop hook with `asyncRewake: true`, for [Pi](https://pi.dev).

Background jobs (long-running `lavish-axi poll`, renders, CI probes, whatever)
run **detached** as child processes. When one finishes, this extension detects
it and delivers the job's output to the Pi agent as a follow-up user message —
so the agent picks the result up on its next turn without ever blocking the
foreground conversation.

## What this solves

Pi has no built-in background-job wake mechanism:

- The foreground agent cannot run long tasks without blocking the conversation.
- Tools like `lavish-axi poll` need to run for a long time and then tell the
  agent "the report is ready".
- A detached process's completion is invisible to the agent unless something
  explicitly re-injects it into the session.

`pi-async-rewake` fills that gap with two small pieces:

1. **`pi-async-rewake` CLI** — spawn/status/cancel detached jobs, with state
   tracked in `~/.pi-async-rewake/jobs/`.
2. **A Pi extension** — watches that state directory and, the moment a job
   completes, sends the agent a follow-up message with the job's stdout,
   stderr, and exit code. The agent wakes and continues.

## How it works

```
pi-async-rewake spawn --label lavish -- lavish-axi poll /tmp/report.html
        │
        ▼  spawns detached, in its own process group (never blocks the shell)
┌───────────────┐     stdout/stderr stream to state files      ┌──────────────┐
│ wrapper (sh)  │ ───────────────────────────────────────────► │ ~/.pi-async- │
│   └─ real job │                                             │  rewake/jobs/│
└───────────────┘                                             │  lavish.pid   │
        │ on exit: write lavish.exit, touch lavish.done         │  lavish.cmd   │
        └────────────────────────────────────────────────────► │  lavish.out   │
                                                               │  lavish.err   │
                                                               │  lavish.done  │
                                                               └──────┬───────┘
                                                                      │ watched by
                                                                      ▼
                                                              ┌─────────────────┐
                                                              │  Pi extension   │
                                                              │  (agent_settled │
                                                              │   + 5s poll)    │
                                                              └────────┬────────┘
                                                                      │ claims (.done
                                                                      │  → .delivered,
                                                                      │  crash-safe),
                                                                      │  reads output
                                                                      ▼
                                     pi.sendUserMessage(result, { deliverAs: "followUp" })
                                             │
                                             ▼
                                  agent wakes on its next turn,
                                  processes the job's output
```

### Pi lifecycle integration

The extension hooks Pi's agent lifecycle:

- **`agent_settled`** — fires when an agent run fully settles (no automatic
  retry, compaction retry, or queued continuation remains). The extension
  sweeps the job registry here, so a job that completed during a run wakes the
  agent the moment the run finishes.
- **`session_start`** — catches jobs that finished while Pi was closed or
  before the session existed.
- **Background poll** — `agent_settled` only fires around agent runs. While the
  agent idles, a lightweight poll (every 5s by default,
  `PI_ASYNC_REWAKE_POLL_MS`) keeps completion detection timely so an idle agent
  still gets woken.

Delivery uses `pi.sendUserMessage(..., { deliverAs: "followUp" })`:

- agent **idle** → the message is sent immediately and triggers a fresh turn
  (the wake);
- agent **busy** → the message is queued as a follow-up and delivered once the
  current run settles.

Either way the agent sees the result on its next turn, and the foreground
conversation is never blocked.

### Delivery safety

- The extension **claims** a completed job by atomically renaming
  `.done` → `.delivered` before sending. Concurrent sweeps (poll vs. event) or
  even a second Pi process racing on the same registry can never deliver the
  same job twice.
- After delivery the job's state files are removed. If removal fails, the
  `.delivered` marker stays and suppresses redelivery.
- Output included in the wake message is capped (6 KB stdout / 2 KB stderr per
  job, 10 jobs per message); full output stays on disk in the state directory.

## Install

### 1. CLI (for spawning jobs)

```bash
npm i -g @kakkoidv/pi-async-rewake
# or, from a clone:
npm link
```

### 2. Pi extension

Pick one:

- **Project extension** — copy `extension/index.ts` to
  `.pi/extensions/async-rewake.ts` in your project (or clone this repo and the
  included `.pi/extensions/async-rewake.ts` is discovered automatically).
- **Pi package** — `pi install npm:@kakkoidv/pi-async-rewake@latest` (or
  `pi install ./path/to/clone` locally).
- **Manual** — add the path to your `~/.pi/agent/settings.json`:
  ```json
  { "extensions": ["/absolute/path/to/clone/extension"] }
  ```

Reload with `/reload`, or restart Pi.

## Usage

### Spawn a background job

```bash
# lavishly poll a report in the background
pi-async-rewake spawn --label lavish -- lavish-axi poll /tmp/report.html

# any command; label defaults to the command's basename
pi-async-rewake spawn -- sleep 5 && echo done
pi-async-rewake spawn --label render --env PAGER=cat -- bash -c 'pdflatex paper.tex && echo done'
```

`spawn` returns immediately; the job runs detached and survives the shell that
launched it. When it completes, the Pi agent is woken with its output.

### Check status

```bash
pi-async-rewake status
#   LABEL   PID   STATE   EXIT AGE  OUT ERR
#   ---------------------------------------
#   lavish 88211 running -    12s 1.2M  -
pi-async-rewake status --json   # machine-readable
```

States: `running` (alive), `done` (completed; delivered or pending), `stale`
(process gone without completing — cancel to clean up).

### Cancel

```bash
pi-async-rewake cancel --label lavish
```

Sends SIGTERM to the job's process group, escalates to SIGKILL after 1.5s, and
removes the state files.

## State directory

`~/.pi-async-rewake/jobs/` (override with `PI_ASYNC_REWAKE_DIR`). Each job owns:

| File | Contents |
|------|----------|
| `<label>.pid` | process id of the detached wrapper |
| `<label>.cmd` | JSON: `{ cmd, cwd, startedAt }` |
| `<label>.out` | captured stdout (streamed live) |
| `<label>.err` | captured stderr (streamed live) |
| `<label>.exit` | exit code, written by the wrapper on completion |
| `<label>.done` | touch file signaling completion (written after `.exit`) |
| `<label>.delivered` | claim marker — set by the extension while delivering |

Labels must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` (path-traversal safe).

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `PI_ASYNC_REWAKE_DIR` | `~/.pi-async-rewake/jobs` | job state directory (both CLI and extension) |
| `PI_ASYNC_REWAKE_POLL_MS` | `5000` | extension poll cadence; `0` disables polling (only `agent_settled`/`session_start` sweeps remain) |

## Development

```bash
npm install
npm test          # node --test (CLI + registry behavior, hermetic temp dirs)
npm run typecheck # tsc --noEmit on the extension
npm run check     # typecheck + tests
```

The extension source of truth is `extension/index.ts` (shipped in the npm
package and installed via `pi install`). The repo's own
`.pi/extensions/async-rewake.ts` is a thin re-export so the project loads it as
a project extension — keep it that way if you edit the file.

## Limitations

- **Unix/macOS only** — relies on `/bin/sh`, process groups, and detached
  spawn; Windows is not supported.
- **Delivery is fire-and-forget** — the extension sends the wake message via
  Pi's extension API and cannot observe the send's failure. If the agent has no
  model/API key configured at delivery time, the result is reported as an
  extension error and not retried (the claim marker prevents redelivery).
- **One-shot** — a job's state files are removed after delivery. Re-run
  `spawn` to poll again (e.g. from a `/lavish-poll` prompt template or skill).

## License

MIT © Kakkoi Dev
