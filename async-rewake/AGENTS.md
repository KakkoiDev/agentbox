# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## Project notes

- **What this is**: a Pi extension + CLI pair that wakes the Pi agent when detached
  background jobs complete (Claude Code `asyncRewake` equivalent). The CLI spawns
  jobs; the extension delivers results as follow-up user messages.
- **State protocol** (job registry): `~/.pi-async-rewake/jobs/` (override
  `PI_ASYNC_REWAKE_DIR`), one file set per label: `.pid .cmd .out .err .exit .done`,
  plus `.delivered` as the extension's atomic claim marker (rename `.done`→`.delivered`
  before sending — never deliver without claiming). Wrapper is `/bin/sh -c '"$@"; …'`
  writing exit code then touching `.done`. Canonical docs: `lib/jobs.js` header.
- **Single source of truth**: the Pi extension lives in `extension/index.ts`;
  `.pi/extensions/async-rewake.ts` is a one-line re-export (verified to load under
  `pi -e`). Keep it that way — do not copy the body.
- **Delivery**: `pi.sendUserMessage(msg, { deliverAs: "followUp" })` is fire-and-forget
  (never throws); `followUp` is safe both idle (immediate turn) and streaming (queued).
  Hooks: `agent_settled` + `session_start` sweep + a 5s poll (`PI_ASYNC_REWAKE_POLL_MS`).
- **Zombie pitfall**: `kill(pid, 0)` returns true for unreaped zombies. `cancelJob`
  must be async (yield to the event loop so Node reaps) — a busy wait leaves dead
  pids reporting alive. Never revert it to a sync busy loop.
- **Checks**: `npm test` (node --test, hermetic temp dirs via `PI_ASYNC_REWAKE_DIR`),
  `npm run typecheck` (tsc on the extension), `npm run check` (both).
- **E2E**: drive a long-lived headless Pi via `pi --mode rpc` over a FIFO on stdin
  (stdin must stay open), `-e .pi/extensions/async-rewake.ts`, then watch
  `message_start` events for the `[pi-async-rewake]` wake message.
