# coding-boost

A pi extension that gives local models the coding habits
[pi-local-harness](https://github.com/KakkoiDev/pi-local-harness) (plh) gives them, without plh's workbench,
Gate server or project paperwork. Each part answers a mistake plh saw a local model make (plh's `docs/lessons/`).

Load it together with [local-model-guard](../local-model-guard/README.md), which handles turns that go wrong
(thinking only, tool calls written as text, stalls, reasoning loops). coding-boost handles the coding itself.

## What it does

| Part | What it does | From plh |
|---|---|---|
| Coding rules | Adds a short "Coding" section to the system prompt: inspect files before changing them, preserve unrelated edits, change files with edit, test the change and run tests without pipes or `\|\| true`, never call an unrun check passed. | `harness/AGENTS.md`, lesson L-005 |
| Terse style | Adds "Answer as briefly as possible", keeping errors, blockers and how a change was verified complete. | `harness/terse.mjs` (task 326) |
| Guides | A short guide joins the system prompt only when the request's words call for it: **bug** (reproduce with a failing test before fixing), **doubt** (answer with evidence, run it), **rename** (find every occurrence, change them all, grep again) and **speed** (given tests are small: cost every step, time it on a bigger input). At most 2 per request. | `harness/guides/`, `harness/guides.mjs` |
| Verify loop | Tracks code files changed with write/edit and test runs in bash. When the model finishes a request with a change that no passing test run came after, it is woken: "You changed app.py and no passing test ran on that code yet. Run the tests, fix what fails…". Out of wake-ups, the request is recorded as **Not verified**. | Gate rule G-012, lesson L-005 |
| Edit hints | An edit of a file that does not exist is told to use write. When an edit's old text fails to match the same file again, the error gets the closest current passage of the file to copy exactly. | Gate rule G-004, lesson L-003 |
| Action-loop watch | The same call with the same result 4 times, the same call failing 3 times in a row, or two calls alternating 6 times: the tool result says so and asks for another approach. | `harness/stuck.mjs` (lesson L-007) |
| Speed check | A request about speed (slow, faster, performance, time limit, …) that changed code is woken once after its tests pass: cost every step, time the code on a 10x bigger input with many distinct values, report the seconds. On for models whose profile asks (gpt-oss), or for all with `PI_CODING_PERF_CHECK=on`. | — (from gpt-oss's agentic-v1 perf run: the given test passed, a quadratic step stayed) |
| Model profiles | By model id. **gpt-oss**: edit hints from the first failed edit, the speed check, and a note when a read returns the same text as the last read of that file ("use it instead of reading again"). | — |
| Self-review (opt-in) | After a verified change, one bounded review pass by the same model, as correctness, validation and scope reviewers. | `harness/task-review.mjs` |

A test run counts when a known runner (pytest, unittest, `node --test`, `npm test`, `go test`, `cargo test`, jest,
vitest and others) is the last command, nothing pipes or masks its exit code, it is not `--help`/`--collect-only`,
and its output does not say no tests ran. It passes when the bash call succeeds. Changes to `.md` files do not need
a test. Running the program, or `node --check`, is not a test run (lesson L-005 is exactly that mistake).

Every action is recorded as a `coding-boost` session entry. Type `/boost` to see the counts for the session.

## Settings

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PI_CODING` | on | `off` disables the extension |
| `PI_CODING_RULES` | on | `off` leaves out the coding rules |
| `PI_CODING_TERSE` | on | `off` leaves out the terse answer style |
| `PI_CODING_GUIDES` | on | `off` adds no guides |
| `PI_CODING_GUIDES_DIR` | | A folder of more guides (`name.md` with a `triggers: word, two words` front matter, as in `guides/`) |
| `PI_CODING_MAX_GUIDES` | `2` | Guides per request |
| `PI_CODING_VERIFY` | on | `off` turns the verify loop off |
| `PI_CODING_VERIFY_RULE` | off | `on` adds a one-paragraph "test before you finish" section when the coding rules are off (the `verify` part turns it on) |
| `PI_CODING_TEST_COMMANDS` | | More commands that count as a test run, comma-separated (e.g. `./play --quick, just test`); `./check`, `./fight`, `./test`, `make check` and the usual runners already count |
| `PI_CODING_MAX_WAKES` | `2` | Wake-ups per request (verify loop and self-review together) |
| `PI_CODING_EDIT_HINTS` | on | `off` turns edit hints off |
| `PI_CODING_EDIT_HINT_AFTER` | `2` | Failed edits of the same file before the closest text is shown |
| `PI_CODING_LOOP_WATCH` | on | `off` turns the action-loop watch off |
| `PI_CODING_SELF_REVIEW` | off | `on` for every model, or a regular expression of model ids (plh used it for `^gpt-oss:20b`) |
| `PI_CODING_PROFILE` | on | `off` turns model profiles off |
| `PI_CODING_PERF_CHECK` | auto | `on` for every model, `off` for none, `auto` lets the profile decide |
| `PI_CODING_REREAD_NOTE` | auto | `on`/`off`/`auto`, as above, for the unchanged re-read note |
| `PI_CODING_LOG` | | Also append each action as a JSON line to this file |

## How it works

| pi hook | Use |
|---|---|
| `before_agent_start` | Add the rules, style and chosen guides to the system prompt; a new request resets the wake-up budget |
| `tool_result` | Record changes and test runs; add edit hints and loop notes to the tool result the model reads |
| `message_end` | Remember the last answer (a question to the person is not woken) |
| `agent_before_settle` | Wake the model to test an unverified change, or to review a verified one |

The wake-ups continue the same run, so they never reset the budget and cannot loop. A run that another extension is
already continuing, an aborted run, or an answer that ends with a question is left alone.

## Not included

plh techniques that depend on its workbench rather than on the model: Gate's server-side checks of plan files
(G-008, G-009, G-010), phases and plan approval (G-014 to G-017), the harness committing for the model (G-013), the
per-request tool set (`harness/tool-choice.mjs`, which picks among plh's own tools), the browser tool, App Blocks,
and the `[CANARY]` drift marker. Turn-level recovery (reasoning loops, template tokens, broken tool JSON, early
compaction) is in [local-model-guard](../local-model-guard/README.md).

## The `verify` part

`../verify/index.ts` loads only the verify loop and the "test before you finish" rule, for any kind of task (asked for on 2026-11-25: "test yourself first" as a harness behavior, then measured per kind of task). Load it instead of coding-boost, never with it.
