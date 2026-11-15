import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCodingBoost, options, isTestRun, chooseGuides, loadGuides, closestText, stuckPattern } from "../boost.mjs";

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
  assert.deepEqual(guides.map(g => g.name), ["bug", "doubt", "rename"]);
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
