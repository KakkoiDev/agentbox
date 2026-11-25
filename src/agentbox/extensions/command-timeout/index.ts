import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Found while benching (2026-11-24): pi's bash tool has no default timeout, so one command that never ends (DeepSeek's
 * random fuzz of a calculator on agentic-v4 calc-evaluator) used the task's whole 15 minutes. Every bash call now
 * stops after 120 s unless the model asked for a timeout, and never later than 600 s; the model sees pi's
 * "timeout" error and can carry on.
 */
const DEFAULT_S = 120, MAX_S = 600;

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as { timeout?: number };
    const asked = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : DEFAULT_S;
    input.timeout = Math.min(asked, MAX_S);
  });
}
