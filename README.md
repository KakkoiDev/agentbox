# agentbox

The pi coding agent, set up to get the most out of the model you give it, in a macOS sandbox. Local models first
(Ollama); DeepSeek's hosted model as the alternative.

Every setting in agentbox is there because it raised a model's score on our benches: hidden-test coding tasks,
image reading and multi-step assistant jobs. Each new finding from a bench run goes back into agentbox.

## Install

Requirements: macOS, Python 3.10+, the pi coding agent (1.1 or later) and, for local models, Ollama.

```bash
uv tool install git+https://github.com/KakkoiDev/agentbox
```

## Use

In a project folder:

```bash
agentbox
```

Options:
- `agentbox --model ollama/qwen3.8:27b` picks a local model.
- `agentbox --model deepseek/flash --thinking max` uses DeepSeek's hosted model.
- `agentbox -p "make the tests pass"` runs once without the interactive screen; anything agentbox doesn't know goes
  to pi.
- `agentbox models` lists the models it can use.
- `agentbox doctor` checks your setup.
- `agentbox spent` shows what DeepSeek has cost so far.
- `agentbox install git:github.com/KakkoiDev/pi-core` adds a pi package to agentbox's own pi config.

DeepSeek needs your API key in `~/.config/deepseek/api-key` (`chmod 600`). agentbox starts a small proxy on
127.0.0.1:8096 that holds the key, logs each request's cost and stops at a $25 cap (set `usd` in
`~/.local/share/agentbox/deepseek-budget.json`). DeepSeek doubles its prices from 01:00 to 04:00 and from 06:00 to
10:00 UTC, Monday to Friday, and agentbox warns you when you start it in those hours.

## The sandbox

Each run gets its own `sandbox-exec` profile:
- Writes go only to the current folder, agentbox's own state (`~/.local/share/agentbox`) and a private temp folder.
- Nothing else in your home folder can be read, except git's config and the folders pi and node are installed in.
- Keys and credentials (`~/.ssh`, `~/.aws`, `~/.gnupg`, keychains, API keys) can never be read, even if the current
  folder is above them.
- The network reaches only the model's own port. `--net` lifts this.

agentbox refuses to run in your home folder itself unless you pass `--allow-home`.

## Config

`~/.config/agentbox/config.json` is optional:

```json
{"model": "ollama/qwen3.8:27b", "thinking": "off", "extensions": [], "net": false}
```

## License

MIT
