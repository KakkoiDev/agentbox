import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCodingBoost, options, isTestRun, testOutcome, chooseGuides, loadGuides, closestText, stuckPattern, isSpeedRequest, profileFor, PERF_PROMPT } from "../boost.mjs";

function fakePi() {
  const handlers = {}, entries = [];
  const pi = {
    on: (name, fn) => { (handlers[name] ||= []).push(fn); },
    appendEntry: (type, data) => entries.push({ type, data }),
    registerCommand: () => {},
  };
  const emit = async (name, event = {}, ctx = {}) => {
    let out;
    for (const fn of handlers[name] || []) out = (await fn({ type: name, ...event }, ctx)) ?? out;
    return out;
  };
  return { pi, emit, entries };
}
const cwd = mkdtempSync(join(tmpdir(), "coding-boost-"));
const ctx = { cwd, model: { provider: "ollama", id: "qwen3.8:27b-mlx" } };
const opts = options({});
const ok = text => [{ type: "text", text }];
const start = (emit, prompt = "add a feature") => emit("before_agent_start", { prompt, systemPrompt: "BASE" }, ctx);
const settle = (emit, extra = {}) => emit("agent_before_settle", { outcome: "completed", continue: false, entries: [], ...extra }, ctx);
const wrote = (emit, path) => emit("tool_result", { toolName: "write", input: { path, content: "x" }, content: ok("Wrote"), isError: false }, ctx);
const ran = (emit, command, isError = false, text = isError ? "1 failed in 0.1s" : "3 passed in 0.1s") =>
  emit("tool_result", { toolName: "bash", input: { command }, content: ok(text), isError }, ctx);

test("the system prompt gets the coding rules, the terse style and only the guides a request calls for", async () => {
  const { pi, emit } = fakePi();
  installCodingBoost(pi, opts);
  const plain = (await start(emit, "add a dark mode")).systemPrompt;
  assert.match(plain, /^BASE\n\n## Coding/);
  assert.match(plain, /Answer style: terse/);
  assert.doesNotMatch(plain, /reproduce it before fixing/);
  const bug = (await start(emit, "the login is broken, it crashes on submit")).systemPrompt;
  assert.match(bug, /reproduce it before fixing it/);
  assert.equal(await (async () => { const p = fakePi(); installCodingBoost(p.pi, options({ PI_CODING_RULES: "off", PI_CODING_TERSE: "off", PI_CODING_GUIDES: "off" })); return start(p.emit, "it crashes"); })(), undefined);
});

test("guides are chosen by trigger words, most matched first", () => {
  const guides = loadGuides();
  assert.deepEqual(guides.map(g => g.name), ["bug", "doubt", "rename", "speed"]);
  assert.deepEqual(chooseGuides("Rename foo everywhere, it's broken", guides).map(g => g.name), ["rename", "bug"]);
  assert.deepEqual(chooseGuides("make a todo app", guides), []);
});

test("test runs count only when a known runner is last and nothing masks its exit code", () => {
  for (const yes of ["pytest", "python3 -m pytest -q tests/", "cd app && npm test", "node --test", "FOO=1 go test ./... 2>&1", "uv run pytest -k 'a|b'", "cargo test > out.txt"])
    assert.equal(isTestRun(yes), true, yes);
  for (const no of ["pytest | tail -5", "pytest || true", "python3 hello.py", "node --check app.js", "npm test -- --help", "pytest --collect-only", "pytest &"])
    assert.equal(isTestRun(no), false, no);
  assert.equal(isTestRun("pytest", "collected 0 items\nno tests ran in 0.01s"), false);
});

test("a changed file with no passing test run after it wakes the model, then is marked not verified", async () => {
  const { pi, emit, entries } = fakePi();
  installCodingBoost(pi, { ...opts, maxWakes: 2 });
  await start(emit);
  await wrote(emit, "app.py");
  await wrote(emit, "README.md");
  await emit("message_end", { message: { role: "assistant", content: ok("Done.") } }, ctx);
  for (let i = 0; i < 2; i++) {
    const out = await settle(emit);
    assert.equal(out.continue, true);
    assert.match(out.entries.at(-1).content, /You changed app\.py and no passing test ran/);
  }
  assert.equal(await settle(emit), undefined, "out of wake-ups");
  assert.equal(entries.at(-1).data.event, "unverified");
});

test("a failing run then a passing run after the last change verifies it; a change after the run does not", async () => {
  const { pi, emit } = fakePi();
  installCodingBoost(pi, opts);
  await start(emit);
  await wrote(emit, "app.py");
  await ran(emit, "pytest", true);
  assert.equal((await settle(emit))?.continue, true, "a failing run is not a pass");
  await ran(emit, "pytest");
  assert.equal(await settle(emit), undefined);
  await wrote(emit, "app.py");
  assert.equal((await settle(emit))?.continue, true);
});

test("questions to the person, docs-only changes and runs already continuing are not woken", async () => {
  const { pi, emit } = fakePi();
  installCodingBoost(pi, opts);
  await start(emit);
  await wrote(emit, "notes.md");
  assert.equal(await settle(emit), undefined);
  await wrote(emit, "app.py");
  assert.equal(await settle(emit, { continue: true }), undefined);
  assert.equal(await settle(emit, { outcome: "aborted" }), undefined);
  await emit("message_end", { message: { role: "assistant", content: ok("Should I use SQLite or Postgres?") } }, ctx);
  assert.equal(await settle(emit), undefined);
  await start(emit, "thanks"); // a new request starts clean
  assert.equal(await settle(emit), undefined);
});

test("an edit of a missing file is told to use write; a repeated mismatch gets the closest current text", async () => {
  const { pi, emit } = fakePi();
  installCodingBoost(pi, opts);
  await start(emit);
  const file = join(cwd, "calc.py");
  writeFileSync(file, "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n");
  const missing = await emit("tool_result", { toolName: "edit", input: { path: "nope.py", edits: [{ oldText: "x", newText: "y" }] }, content: ok("ENOENT"), isError: true }, ctx);
  assert.match(missing.content.at(-1).text, /nope\.py does not exist; use write to create it/);
  const fail = () => emit("tool_result", { toolName: "edit", input: { path: "calc.py", edits: [{ oldText: "def sub(a,b):\n  return a-b", newText: "z" }] },
    content: ok("Could not find edits[0] in calc.py. The oldText must match exactly including all whitespace and newlines."), isError: true }, ctx);
  assert.equal(await fail(), undefined, "the first mismatch keeps pi's own message");
  const second = await fail();
  assert.match(second.content.at(-1).text, /Closest current text \(copy exactly\):\ndef sub\(a, b\):\n    return a - b/);
});

test("closestText finds the nearest same-size passage and ignores unrelated text", () => {
  const file = "alpha = 1\nbeta = 2\ngamma = 3\n";
  assert.deepEqual(closestText(file, "beta=2"), ["beta = 2"]);
  assert.deepEqual(closestText(file, "completely different words here"), []);
});

test("repeated identical failing calls are flagged in the tool result, once per pattern", async () => {
  const { pi, emit } = fakePi();
  installCodingBoost(pi, opts);
  await start(emit);
  const outs = [];
  for (let i = 0; i < 3; i++) outs.push(await ran(emit, "python3 app.py", true, `Traceback at 12:0${i}: NameError`));
  assert.equal(outs[0], undefined);
  assert.match(outs[2].content.at(-1).text, /No progress: the same call failed 3 times in a row: bash python3 app\.py/);
  assert.equal(stuckPattern([{ tool: "read", input: { path: "a" }, text: "1" }, { tool: "read", input: { path: "b" }, text: "2" }]), null);
});

test("self-review is opt-in, runs once after a verified change, and only for the chosen models", async () => {
  const { pi, emit } = fakePi();
  installCodingBoost(pi, options({ PI_CODING_SELF_REVIEW: "^qwen" }));
  await start(emit);
  await wrote(emit, "app.py");
  await ran(emit, "pytest");
  const out = await settle(emit);
  assert.match(out.entries.at(-1).content, /correctness: Act as a correctness reviewer/);
  assert.equal(await settle(emit), undefined, "once per request");
  const other = fakePi();
  installCodingBoost(other.pi, options({}));
  await start(other.emit);
  await wrote(other.emit, "app.py");
  await ran(other.emit, "pytest");
  assert.equal(await settle(other.emit), undefined, "off by default");
});

test("PI_CODING=off disables everything", async () => {
  const { pi, emit } = fakePi();
  installCodingBoost(pi, options({ PI_CODING: "off" }));
  assert.equal(await start(emit), undefined);
});

// --- gpt-oss profile and the speed check ---------------------------------------------------------------------------

const gptCtx = { ...ctx, model: { provider: "ollama", id: "gpt-oss:20b" } };

test("profiles are chosen by model id and can be switched off", () => {
  assert.equal(profileFor("gpt-oss:20b").id, "gpt-oss");
  assert.equal(profileFor("gpt-oss-120b").id, "gpt-oss");
  assert.equal(profileFor("qwen3.8:27b-mlx"), null);
  assert.equal(profileFor("gpt-oss:20b", options({ PI_CODING_PROFILE: "off" })), null);
});

test("speed requests are recognised by their words", () => {
  assert.equal(isSpeedRequest("top_words is far too slow on large inputs"), true);
  assert.equal(isSpeedRequest("Make it fast enough that the tests pass"), true);
  assert.equal(isSpeedRequest("add a dark mode"), false);
  assert.equal(chooseGuides("this is too slow, make it faster", loadGuides())[0].name, "speed");
});

async function speedRun(context, o = opts) {
  const { pi, emit } = fakePi();
  installCodingBoost(pi, o);
  await emit("before_agent_start", { prompt: "parse() is too slow on large files; make it faster", systemPrompt: "BASE" }, context);
  await emit("tool_result", { toolName: "write", input: { path: "app.py", content: "x" }, content: ok("Wrote"), isError: false }, context);
  await emit("tool_result", { toolName: "bash", input: { command: "python3 -m unittest" }, content: ok("OK"), isError: false }, context);
  await emit("message_end", { message: { role: "assistant", content: ok("Done.") } }, context);
  const settleWith = () => emit("agent_before_settle", { outcome: "completed", continue: false, entries: [] }, context);
  return [await settleWith(), await settleWith()];
}

test("gpt-oss: a verified speed change is woken once to cost and time the code", async () => {
  const [first, second] = await speedRun(gptCtx);
  assert.equal(first.continue, true);
  assert.equal(first.entries.at(-1).content, PERF_PROMPT);
  assert.equal(second, undefined, "only once per request");
});

test("the speed check is off for models without the profile unless PI_CODING_PERF_CHECK=on", async () => {
  assert.deepEqual(await speedRun(ctx), [undefined, undefined]);
  assert.equal((await speedRun(ctx, options({ PI_CODING_PERF_CHECK: "on" })))[0].continue, true);
  assert.deepEqual(await speedRun(gptCtx, options({ PI_CODING_PERF_CHECK: "off" })), [undefined, undefined]);
});

test("gpt-oss: an unchanged re-read is noted, a changed file is not", async () => {
  const { pi, emit } = fakePi();
  installCodingBoost(pi, opts);
  await emit("before_agent_start", { prompt: "fix it", systemPrompt: "BASE" }, gptCtx);
  const read = text => emit("tool_result", { toolName: "read", input: { path: "a.py" }, content: ok(text), isError: false }, gptCtx);
  assert.equal(await read("v1"), undefined);
  assert.match(textOfResult(await read("v1")), /has not changed since your last read/);
  assert.equal(await read("v2"), undefined);
  // other models: no note
  const other = fakePi(); installCodingBoost(other.pi, opts);
  const r = () => other.emit("tool_result", { toolName: "read", input: { path: "a.py" }, content: ok("v1"), isError: false }, ctx);
  await r(); assert.equal(await r(), undefined);
});

test("gpt-oss: the closest current text comes with the first failed edit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coding-boost-gpt-"));
  writeFileSync(join(dir, "m.py"), "def f(x):\n    return x + 1\n");
  const c = { ...gptCtx, cwd: dir };
  const fail = (o, context) => { const { pi, emit } = fakePi(); installCodingBoost(pi, o);
    return emit("tool_result", { toolName: "edit", input: { path: "m.py", edits: [{ oldText: "def f(x):\n    return x+1", newText: "y" }] },
      content: ok("Could not find the exact text in m.py"), isError: true }, context); };
  assert.match(textOfResult(await fail(opts, c)), /Closest current text/);
  assert.equal(await fail(opts, { ...c, model: ctx.model }), undefined, "other models wait for the second failure");
  assert.equal(await fail(options({ PI_CODING_EDIT_HINT_AFTER: "2" }), c), undefined, "an explicit setting wins");
});

function textOfResult(out) { return (out?.content || []).map(c => c.text || "").join("\n"); }

test("project check scripts and PI_CODING_TEST_COMMANDS count as test runs", () => {
  for (const yes of ["./check", "./fight --vs ts-starter --games 40", "cd ws && ./fight", "make check 2>&1"]) assert.equal(isTestRun(yes), true, yes);
  assert.equal(isTestRun("./fight | tail -5"), false);
  assert.equal(isTestRun("./play --quick"), false);
  const extra = options({ PI_CODING_TEST_COMMANDS: "./play --quick, just test" }).testCommands;
  assert.deepEqual(extra, [["./play", "--quick"], ["just", "test"]]);
  assert.equal(isTestRun("./play --quick --seed 3", undefined, extra), true);
  assert.equal(isTestRun("just test", undefined, extra), true);
});

test("the verify part's settings: only the verify loop and the short rule", async () => {
  const env = { PI_CODING_RULES: "off", PI_CODING_TERSE: "off", PI_CODING_GUIDES: "off", PI_CODING_EDIT_HINTS: "off", PI_CODING_LOOP_WATCH: "off", PI_CODING_PROFILE: "off", PI_CODING_VERIFY: "on", PI_CODING_VERIFY_RULE: "on" };
  const { pi, emit } = fakePi();
  installCodingBoost(pi, options(env));
  const out = await start(emit, "it crashes on empty input");
  assert.match(out.systemPrompt, /## Test before you finish/);
  assert.doesNotMatch(out.systemPrompt, /## Coding|terse/);
  await wrote(emit, "bot.py");
  assert.equal((await settle(emit))?.continue, true);
  await ran(emit, "./fight --games 10", false, "won 7/10");
  assert.equal(await settle(emit), undefined);
});

test("testOutcome reads a test run's result where the exit code is lost", () => {
  assert.equal(testOutcome("python3 -m unittest -v; echo \"exit=$?\"; python3 -c 'print(1)'", "Ran 4 tests in 0.001s\n\nOK\nexit=0\n1", false), "pass");
  assert.equal(testOutcome("python3 -m unittest -v; echo \"exit=$?\"", "Ran 4 tests\n\nFAILED (failures=1)\nexit=1", false), "fail");
  assert.equal(testOutcome("pytest -q && echo done", "", true), "fail");
  assert.equal(testOutcome("pytest -q && echo done", "3 passed in 0.1s\ndone", false), "pass");
  assert.equal(testOutcome("pytest -q; echo hi", "hi", false), null);
  assert.equal(testOutcome("pytest | tail -3", "3 passed", false), null);
  assert.equal(testOutcome("ls; cat a.py", "x", false), null);
  assert.equal(testOutcome("cd ws && ./fight --games 10", "won 7/10", false), "pass");
});
