import { test } from "node:test";
import assert from "node:assert/strict";
import { installLocalModelGuard, options } from "../guard.mjs";

function fakePi({ tools = ["bash", "read", "edit", "write"], thinking = "off" } = {}) {
  const handlers = {}, sent = [], entries = [];
  const pi = {
    on: (name, fn) => { (handlers[name] ||= []).push(fn); },
    getActiveTools: () => tools,
    getThinkingLevel: () => thinking,
    sendUserMessage: text => sent.push(text),
    appendEntry: (type, data) => entries.push({ type, data }),
    registerCommand: () => {},
  };
  const emit = async (name, event = {}, ctx = {}) => {
    let out;
    for (const fn of handlers[name] || []) out = (await fn({ type: name, ...event }, ctx)) ?? out;
    return out;
  };
  return { pi, emit, sent, entries };
}
const ctx = { model: { provider: "ollama", id: "gemma4:26b-mlx" }, thinkingLevel: "off", abort() { this.aborted = true; } };
const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, stopReason });
const settle = (emit, extra = {}) => emit("agent_before_settle", { outcome: "completed", continue: false, entries: [], ...extra }, ctx);
const opts = { ...options({}), idleMs: 0 };

test("gemma4 on Ollama with thinking off gets reasoning_effort none; other models are untouched", async () => {
  const { pi, emit } = fakePi();
  installLocalModelGuard(pi, opts);
  assert.deepEqual(await emit("before_provider_request", { payload: { model: "gemma4:26b-mlx", stream: true } }, ctx),
    { model: "gemma4:26b-mlx", stream: true, reasoning_effort: "none" });
  assert.equal(await emit("before_provider_request", { payload: { model: "q" } }, { ...ctx, model: { provider: "ollama", id: "qwen3.8:27b-mlx" } }), undefined);
});

test("a tool call written as text (gemma's bank-transfer run) becomes a real tool call", async () => {
  const { pi, emit } = fakePi();
  installLocalModelGuard(pi, opts);
  const out = await emit("message_end", { message: assistant([
    { type: "thinking", thinking: "plan" },
    { type: "text", text: 'I will begin by listing the files.\n<tool> bash {   command: "ls -R" } </tool>' },
  ]) }, ctx);
  assert.equal(out.message.stopReason, "toolUse");
  assert.deepEqual(out.message.content.map(c => c.type), ["thinking", "text", "toolCall"]);
  assert.deepEqual(out.message.content[2].arguments, { command: "ls -R" });
  assert.equal(await settle(emit), undefined, "a repaired turn needs no nudge");
});

test("thinking-only turns (gemma's feature-todo run) are nudged, at most maxNudges times per request", async () => {
  const { pi, emit } = fakePi();
  installLocalModelGuard(pi, { ...opts, maxNudges: 2 });
  await emit("before_agent_start");
  for (const expected of [true, true, false]) {
    await emit("message_end", { message: assistant([{ type: "thinking", thinking: "I should edit todo.py" }]) }, ctx);
    const out = await settle(emit);
    assert.equal(Boolean(out?.continue), expected);
    if (expected) assert.match(out.entries.at(-1).content, /no tool call and no answer/);
  }
  await emit("before_agent_start"); // the person's next request gets a fresh budget
  await emit("message_end", { message: assistant([]) }, ctx);
  assert.equal((await settle(emit)).continue, true);
});

test("answers, real tool calls, aborted runs and runs already continuing are left alone", async () => {
  const { pi, emit } = fakePi();
  installLocalModelGuard(pi, opts);
  await emit("message_end", { message: assistant([{ type: "text", text: "All tests pass." }]) }, ctx);
  assert.equal(await settle(emit), undefined);
  await emit("message_end", { message: assistant([{ type: "toolCall", id: "1", name: "bash", arguments: {} }], "toolUse") }, ctx);
  assert.equal(await settle(emit), undefined);
  await emit("message_end", { message: assistant([{ type: "thinking", thinking: "x" }]) }, ctx);
  assert.equal(await settle(emit, { outcome: "aborted" }), undefined);
  assert.equal(await settle(emit, { continue: true }), undefined);
});

test("a stalled request is aborted and asked to continue once", async () => {
  let t = 0; const pending = [];
  const timers = { setTimeout: (fn, ms) => { pending.push({ fn, at: t + ms }); return pending.length; }, clearTimeout: id => { pending[id - 1] = null; } };
  const { pi, emit, sent } = fakePi();
  installLocalModelGuard(pi, { ...opts, idleMs: 60_000, totalMs: 600_000 }, { now: () => t, timers });
  const c = { ...ctx };
  await emit("message_start", { message: { role: "assistant" } }, c);
  t = 30_000; await emit("message_update", {}, c);
  const run = () => { const due = pending.filter(Boolean).filter(p => p.at <= t); due.forEach(p => { pending[pending.indexOf(p)] = null; p.fn(); }); };
  t = 60_000; run(); assert.equal(c.aborted, undefined, "activity at 30s kept it alive");
  t = 95_000; run(); run();
  assert.equal(c.aborted, true);
  await emit("agent_settled", { aborted: true }, c);
  assert.equal(sent.length, 1);
  await emit("before_agent_start", {}, c); // the guard's own follow-up keeps the nudge count
  await emit("agent_settled", { aborted: true }, c);
  assert.equal(sent.length, 1, "no resend without a new stall");
});

test("PI_GUARD=off disables everything", async () => {
  const { pi, emit } = fakePi();
  installLocalModelGuard(pi, options({ PI_GUARD: "off" }));
  assert.equal(await emit("before_provider_request", { payload: {} }, ctx), undefined);
});
