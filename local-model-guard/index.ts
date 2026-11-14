import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installLocalModelGuard, options } from "./guard.mjs";

/** Keeps local models (Gemma, Qwen and others on Ollama) on track in pi. See README.md. */
export default function (pi: ExtensionAPI) {
  installLocalModelGuard(pi, options());
}
