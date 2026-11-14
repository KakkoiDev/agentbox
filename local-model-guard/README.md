# local-model-guard

A pi extension that keeps local models on track as coding agents. It was built after a
benchmark where Gemma 4 (26B, on Ollama) failed agentic tasks in pi without writing bad
code. Instead, it:

- **ended turns with only thinking**, so pi stopped with nothing done, even with thinking set to off;
- **wrote a tool call as text** (`<tool> bash { command: "ls -R" } </tool>`), so it never ran;
- **hung** until the bench's timeout.

## What it does

| Problem | What the guard does |
|---|---|
| A model ignores "thinking off" | Adds the request fields that model needs. Today: `reasoning_effort: "none"` for `gemma4` on Ollama. |
| A tool call written as text | Turns it into a real tool call, which pi runs through its normal tool path (and its tool checks). Recognises `<tool> name {...}`, Gemma's `call:name{...}`, Qwen's `<tool_call>{...}`, `<function=name>...`, and a JSON object naming a tool. Only tools that exist are accepted. |
| A turn with only thinking, nothing at all, or "I will now edit the file." with no call | Sends one short follow-up asking the model to act or answer. At most 2 per request by default. |
| An answer cut off at the length limit | Asks the model to continue, more briefly. |
| A request with no output at all for 2 minutes | Cancels it and asks the model to continue. Thinking counts as output, so long reasoning is not cut off. |

Every action is recorded as a `local-model-guard` session entry. Type `/guard` to see the counts for the session.

## Settings

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PI_GUARD` | on | `off` disables the guard |
| `PI_GUARD_MAX_NUDGES` | `2` | Follow-ups per request |
| `PI_GUARD_IDLE_SECONDS` | `120` | Cancel a request after this long with no output (`0` turns the stall watch off) |
| `PI_GUARD_TOTAL_SECONDS` | `1200` | Cancel a single model request after this long |
| `PI_GUARD_LOG` | | Also append each action as a JSON line to this file |

## How it works

The rules are [AI Core](https://github.com/KakkoiDev/ai-core)'s turn policies (`classifyTurn`,
`parseTextToolCalls`, `turnRecovery`, `createStallWatch`, `requestAdjustments`); this extension
connects them to pi's hooks:

| pi hook | Use |
|---|---|
| `before_provider_request` | Merge request fixes into the payload |
| `message_end` | Classify the finished turn; replace a text tool call with a real one |
| `agent_before_settle` | Add a follow-up message and continue once |
| `message_start` / `message_update` / `provider_stream_event` | Stall watch |
| `agent_settled` | After a stall was cancelled, ask the model to continue |

A new message from you resets the follow-up budget; the guard's own messages do not, so it
cannot loop.
