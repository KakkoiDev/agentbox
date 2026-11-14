// local-model-guard: keeps local models on track in pi, using AI Core's turn policies.
//
// 1. Request fixes  (before_provider_request): e.g. Gemma 4 on Ollama ignores "thinking off"
//    unless the request carries reasoning_effort "none".
// 2. Tool-call repair (message_end): a tool call written as text becomes a real tool call that
//    pi runs through its normal tool path.
// 3. Nudges (agent_before_settle): a turn that ends with thinking only, nothing, a stated intent
//    without a call, or a cut-off answer gets one short follow-up, a bounded number of times per
//    request.
// 4. Stall watch (message_start/update/end): a request with no stream activity at all for too
//    long is aborted and asked to continue, instead of hanging until an outer timeout.
import { appendFileSync } from "node:fs";
import { classifyTurn, turnRecovery, parseTextToolCalls, createStallWatch, requestAdjustments } from "@kakkoidev/ai-core";

const STALL_NUDGE = "Your last response stopped producing output and was cancelled. Continue the task: call a tool to make progress, or reply with your final answer.";
const ENTRY = "local-model-guard";

export function options(env = process.env) {
  const num = (name, fallback) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    enabled: env.PI_GUARD !== "off",
    maxNudges: num("PI_GUARD_MAX_NUDGES", 2),
    idleMs: num("PI_GUARD_IDLE_SECONDS", 120) * 1000,
    totalMs: num("PI_GUARD_TOTAL_SECONDS", 1200) * 1000,
    log: env.PI_GUARD_LOG || "",
  };
}

const textOf = message => (message.content || []).filter(c => c?.type === "text").map(c => c.text).join("\n");
const thinkingOf = message => (message.content || []).filter(c => c?.type === "thinking").map(c => c.thinking || "").join("\n");
const callsOf = message => (message.content || []).filter(c => c?.type === "toolCall");

export function installLocalModelGuard(pi, opts = options(), { now = () => Date.now(), timers = globalThis } = {}) {
  const stats = { adjusted: 0, repaired: 0, nudged: 0, stalls: 0, stopped: 0 };
  let nudges = 0, lastKind = null, resending = false, stalled = false, watch = null, timer = null, seq = 0;

  const record = (event, ctx, data = {}) => {
    const entry = { event, at: new Date(now()).toISOString(), model: ctx?.model?.id, ...data };
    try { pi.appendEntry?.(ENTRY, entry); } catch {}
    if (opts.log) try { appendFileSync(opts.log, JSON.stringify(entry) + "\n"); } catch {}
    if (ctx?.hasUI && event !== "adjusted") ctx.ui?.notify?.(`Local model guard: ${data.reason || event}`, "info");
  };
  const clearTimer = () => { if (timer) timers.clearTimeout(timer); timer = null; };

  if (!opts.enabled) return { stats };

  // A new request from the person resets the nudge budget; the guard's own follow-ups do not.
  pi.on("before_agent_start", () => {
    if (resending) resending = false;
    else nudges = 0;
    lastKind = null;
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!event?.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
    const thinking = ctx?.thinkingLevel ?? pi.getThinkingLevel?.();
    const fix = requestAdjustments({ provider: ctx?.model?.provider, model: ctx?.model?.id, thinking });
    if (!fix) return undefined;
    stats.adjusted++;
    record("adjusted", ctx, { rules: fix.rules });
    return { ...event.payload, ...fix.patch };
  });

  pi.on("message_start", (event, ctx) => {
    if (event?.message?.role !== "assistant" || !opts.idleMs) return;
    clearTimer();
    stalled = false;
    watch = createStallWatch({ now, idleMs: opts.idleMs, totalMs: opts.totalMs || 1e15 });
    const check = () => {
      const reason = watch?.reason();
      if (!reason) { timer = timers.setTimeout(check, Math.max(1000, watch.remainingMs())); return; }
      timer = null; stalled = true; stats.stalls++;
      record("stall", ctx, { reason });
      try { ctx?.abort?.(); } catch {}
    };
    timer = timers.setTimeout(check, Math.max(1000, watch.remainingMs()));
  });
  pi.on("message_update", () => { watch?.observe(); });
  pi.on("provider_stream_event", () => { watch?.observe(); });

  pi.on("message_end", (event, ctx) => {
    const message = event?.message;
    if (message?.role !== "assistant") return undefined;
    clearTimer(); watch = null;
    const tools = pi.getActiveTools?.();
    const kind = classifyTurn({ text: textOf(message), thinking: thinkingOf(message), toolCalls: callsOf(message), stopReason: message.stopReason, tools });
    lastKind = kind;
    if (turnRecovery({ kind }).action !== "repair") return undefined;
    const { calls, text } = parseTextToolCalls(textOf(message), { tools });
    const content = [
      ...(message.content || []).filter(c => c?.type === "thinking"),
      ...(text ? [{ type: "text", text }] : []),
      ...calls.map(call => ({ type: "toolCall", id: `guard_${now().toString(36)}_${seq++}`, name: call.name, arguments: call.arguments })),
    ];
    stats.repaired += calls.length;
    lastKind = "tool-call";
    record("repaired", ctx, { tools: calls.map(c => c.name) });
    return { message: { ...message, content, stopReason: "toolUse" } };
  });

  pi.on("agent_before_settle", (event, ctx) => {
    if (event?.outcome !== "completed" || event?.continue) return undefined;
    const decision = turnRecovery({ kind: lastKind, nudges, maxNudges: opts.maxNudges, canRepair: false });
    if (decision.action === "stop") { stats.stopped++; record("out-of-nudges", ctx, { reason: decision.reason }); return undefined; }
    if (decision.action !== "nudge") return undefined;
    nudges++; stats.nudged++;
    record("nudged", ctx, { reason: decision.reason, nudge: nudges });
    lastKind = null;
    const entries = [...(event.entries || []), { type: "custom_message", customType: ENTRY, content: decision.message, display: true }];
    return { entries, continue: true };
  });

  pi.on("agent_settled", (event, ctx) => {
    clearTimer();
    if (!stalled || !event?.aborted) return;
    stalled = false;
    if (nudges >= opts.maxNudges) { stats.stopped++; record("out-of-nudges", ctx, { reason: "stalled" }); return; }
    nudges++; stats.nudged++;
    record("nudged", ctx, { reason: "stalled", nudge: nudges });
    resending = true;
    pi.sendUserMessage(STALL_NUDGE);
  });

  pi.on("session_shutdown", () => clearTimer());

  pi.registerCommand?.("guard", {
    description: "Show what the local model guard did in this session",
    handler: async (_args, ctx) => ctx.ui.notify(`Local model guard: ${JSON.stringify(stats)}`, "info"),
  });
  return { stats };
}
