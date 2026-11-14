# pi-core

Extensions and tools for [pi](https://pi.dev), in one package.

| Part | What it does |
|---|---|
| [local-model-guard](local-model-guard/README.md) | Keeps local models (Gemma, Qwen and others on Ollama) on track: fixes requests a model needs, turns tool calls written as text into real ones, nudges turns that end with nothing done, and cancels requests that stall. |
| [async-rewake](async-rewake/README.md) | Runs long jobs in the background and wakes the agent with their output when they finish. |

## Install

```sh
pi install git:github.com/KakkoiDev/pi-core
```

That loads both extensions. To load only one, filter the package in `~/.pi/agent/settings.json`:

```json
{ "packages": [{ "source": "git:github.com/KakkoiDev/pi-core", "extensions": ["local-model-guard/index.ts"] }] }
```

To try one for a single run without installing:

```sh
pi -e ./local-model-guard/index.ts
```

## Develop

```sh
npm install
npm test
```

The local-model guard builds on [AI Core](https://github.com/KakkoiDev/ai-core)'s turn policies, so the same rules can run in other harnesses.
async-rewake came from [pi-async-rewake](https://github.com/KakkoiDev/pi-async-rewake), with its history.
