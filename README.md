# agentbox

The pi coding agent, set up to get the most out of the model you give it, in a macOS sandbox. Local models first
(Ollama); DeepSeek's hosted model as the alternative.

agentbox works in tandem with two other repos:
- **[agentbench](https://github.com/KakkoiDev/agentbench)** holds the benches and all their results: coding tasks
  graded by hidden tests, image reading, multi-step assistant jobs, game bots. It runs models through agentbox
  (`agent_bench.py run --harness agentbox`), so every change here is measured there.
- **[ai-core](https://github.com/KakkoiDev/ai-core)** holds the reusable knowledge both use: which parts each model
  gets and the bench result behind each (`harness-profiles.json`), the recovery policies for local models, DeepSeek's
  API rules, the sandbox profile and pi's provider settings. agentbox is the thin, runnable layer on top.

A part goes into a model's setup only once a bench shows it helps that model. `agentbox harness -m MODEL` prints what
a model gets and why.

## Install

Requirements: macOS, Node 20+, the pi coding agent (1.1 or later) and, for local models, Ollama.

```bash
npm install -g github:KakkoiDev/agentbox
```

If npm's global folder isn't writable (Nix, for example), install into `~/.local` instead:

```bash
npm install -g --prefix ~/.local github:KakkoiDev/agentbox
```

To update to the latest version later:

```bash
agentbox update
```

It reinstalls from GitHub into the same place, so it works for either install.

## Use

In a project folder:

```bash
agentbox
```

- `agentbox -m ollama/qwen3.8:27b` picks a local model.
- `agentbox -m deepseek/flash -t max` uses DeepSeek's hosted model with thinking at its highest effort (`off`,
  `high` or `max`).
- `agentbox -p "make the tests pass"` runs once without the interactive screen; anything agentbox doesn't know goes
  to pi.
- `agentbox models` lists the models it can use, and `agentbox doctor` checks your setup.
- `agentbox harness -m MODEL` shows what that model gets and the bench result behind each part.
- `agentbox spent` shows what DeepSeek has cost so far.
- `agentbox install SOURCE` adds a pi package to agentbox's own pi config.
- `agentbox report` turns the session you just had in this folder into an issue on agentbench, after you edit it.
- `agentbox update` installs the latest version.

DeepSeek needs your API key in `~/.config/deepseek/api-key` (`chmod 600`). agentbox starts a small proxy on
127.0.0.1:8096 that holds the key, logs each request's cost and stops at a $25 cap (set `usd` in
`~/.local/share/agentbox/deepseek-budget.json`). DeepSeek doubles its prices from 01:00 to 04:00 and from 06:00 to
10:00 UTC, Monday to Friday, and agentbox warns you when you start it in those hours.

## What a model gets

| Part | For | Why |
|---|---|---|
| command-timeout | every model | pi's bash tool has no timeout; one endless command used a task's whole 15 minutes (agentic-v4) |
| local-model-guard | Gemma models | Gemma 4 26B went from 0–1/5 with a long hang every run to 3/5 with none (agentic-v1) |

`coding-boost` (coding rules, guides, a wake-up to test unverified changes), `verify` (only the "test yourself first"
part of coding-boost, for any kind of task: a change with no passing test run after it wakes the agent to test it) and
`async-rewake` (background jobs) are included but off: no bench has shown a gain from them yet (`verify` is being
measured per kind of task). Turn them on in the config.

## The sandbox

Each run gets its own `sandbox-exec` profile:
- Writes go only to the current folder, agentbox's own state (`~/.local/share/agentbox`) and a private temp folder.
- Nothing else in your home folder can be read, except git's config and the folders pi and node are installed in.
- Keys and credentials (`~/.ssh`, `~/.aws`, `~/.gnupg`, keychains, API keys) can never be read, even if the current
  folder is above them.
- The network reaches only the model's own port, so web search, package installs and pushes are blocked. `--net`
  lifts this.

agentbox refuses to run in your home folder itself unless you pass `--allow-home`.

## Config

`~/.config/agentbox/config.json` is optional:

```json
{"model": "ollama/qwen3.8:27b", "thinking": "off", "extensions": ["coding-boost"], "net": false, "issues": true}
```

`extensions` takes part names (`coding-boost`, `verify`, `async-rewake`, `local-model-guard`) or paths to any pi extension.

`"issues": false` (or `AGENTBOX_ISSUES=off`) means this agentbox never files an issue: `agentbox report` refuses, and
agentbench's `bench_issues.py` skips bench runs made through it. Nothing is ever sent without one of those two
commands; this switch makes sure of it.

## History

The extensions in `extensions/pi-core` come from [pi-core](https://github.com/KakkoiDev/pi-core), merged here with
their history on 2026-11-25.

## License

MIT
