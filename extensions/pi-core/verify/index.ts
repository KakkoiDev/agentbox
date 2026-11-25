import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installCodingBoost, options } from "../coding-boost/boost.mjs";

/** verify: "test yourself first" on its own, for any task. Only coding-boost's verify loop (a change with no passing test
 * run after it wakes the agent to test it, at most PI_CODING_MAX_WAKES times) and a one-paragraph "test before you
 * finish" rule; the rest of coding-boost is off. Do not load it together with coding-boost. */
export default function (pi: ExtensionAPI) {
  const env = { ...process.env };
  for (const name of ["PI_CODING_RULES", "PI_CODING_TERSE", "PI_CODING_GUIDES", "PI_CODING_EDIT_HINTS", "PI_CODING_LOOP_WATCH", "PI_CODING_PROFILE"]) env[name] = "off";
  env.PI_CODING_VERIFY = "on";
  env.PI_CODING_VERIFY_RULE = env.PI_CODING_VERIFY_RULE || "on";
  installCodingBoost(pi, options(env));
}
