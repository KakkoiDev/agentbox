import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installCodingBoost, options } from "./boost.mjs";

/** The coding habits pi-local-harness gives local models: rules, guides, a verify loop, edit hints, loop watch. See README.md. */
export default function (pi: ExtensionAPI) {
  installCodingBoost(pi, options());
}
