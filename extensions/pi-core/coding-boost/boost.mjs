// coding-boost: the coding habits pi-local-harness (plh) gives local models, as one pi extension.
//
// 1. Coding rules and a terse style (before_agent_start): short system-prompt sections from plh's AGENTS.md and
//    harness/terse.mjs: inspect before changing, preserve unrelated edits, test the change, run tests so their exit
//    code counts, never call an unrun check passed.
// 2. Guides (before_agent_start): a short guide joins the system prompt only when the request's words call for it
//    (plh harness/guides: bug → reproduce first, doubt → answer with evidence, rename → find every occurrence).
// 3. Verify loop (tool_result + agent_before_settle): a request that changed code and saw no passing test run after the
//    last change is woken to run the tests (plh rule G-012, lesson L-005); out of wake-ups it is marked "Not verified".
// 4. Edit hints (tool_result): an edit of a file that does not exist is told to use write; an edit whose old text keeps
//    failing on the same file gets the closest current text to copy (plh rule G-004, lesson L-003).
// 5. Action-loop watch (tool_result): the same call with the same result 4 times, the same call failing 3 times, or two
//    calls alternating 6 times: the tool result says so and asks for another approach (plh harness/stuck.mjs).
// 6. Self-review (agent_before_settle, opt-in): after a verified change, one bounded review pass by the same model with
//    correctness, validation and scope roles (plh harness/task-review.mjs).
// 7. Speed check (agent_before_settle): a request about speed that changed code is woken once, after its tests pass, to
//    cost every step and time the code on a bigger, more varied input than the tests (given tests are often too small
//    to catch a quadratic step). On for the models whose profile asks for it, or for all with PI_CODING_PERF_CHECK=on.
// 8. Model profiles (PROFILES), switched on by model id. gpt-oss: edit hints from the first failed edit, the speed
//    check, and a note when a read returns the same text as the last read of that file.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectActionLoop } from "@kakkoidev/ai-core";

const ENTRY = "coding-boost";

export const CODING_RULES = `## Coding

Inspect the relevant files before changing them, and preserve unrelated edits. Change existing files with edit, not by rewriting them whole or with shell scripts. Write tests for the change and run them until they pass; run them without pipes or \`|| true\` so their exit code counts. A syntax check or running the program is not a test run. Never call a check passed that you did not run: if something could not be verified, say "not verified" and why.`;

export const VERIFY_RULE = `## Test before you finish

Before you call a change done, test it: run the project's tests or checks (or write a small one) on the changed code, read the result, and fix what fails. Run them so their exit code counts. If something cannot be tested, say "not verified" and why.`;

export const TERSE_STYLE = `## Answer style: terse

Answer as briefly as possible. Give the answer directly: do not restate the request, repeat the plan, announce what you are about to do, or add filler, pleasantries or a closing summary. For code, reply with only the code, and put code that belongs in a file in a tool call, not in the answer.
Brevity never removes what the person needs: keep errors, blockers, how a change was verified (the command and its result) and anything the person must do or approve clear and complete. Never shorten code, quoted evidence or tests to save words, and never weaken a test.`;

export const REVIEW_ROLES = Object.freeze({
  correctness: "Act as a correctness reviewer. Read the actual diff and relevant surrounding code. Trace failure, cancellation and persistence paths. Fix concrete defects within the task's scope.",
  validation: "Act as a test reviewer. Match the request's acceptance criteria to executed checks. Look for missing negative cases, isolation and regressions. Run meaningful missing checks; never call unrun checks passed.",
  scope: "Act as a scope reviewer. Compare the result with the request. Identify incomplete work and material limits honestly.",
});
export const REVIEW_PROMPT = "Before you finish, perform one bounded self-review using these roles in order. This is advisory review by the same model, not independent verification.\n\n" +
  Object.entries(REVIEW_ROLES).map(([name, text]) => `${name}: ${text}`).join("\n\n") +
  "\n\nRead the diff first. Keep repairs within the request. End with the result and the checks actually run; do not ask for routine confirmation.";

export const PERF_PROMPT = "This request is about speed, and the given tests may be much smaller than real inputs. Before you finish: " +
  "(1) name the cost of every step of the changed code in terms of the input size, including work hidden in library calls, " +
  "sort keys and membership or search operations inside loops; anything slower than about n log n must go. " +
  "(2) Time it with bash on an input at least 10 times larger than the biggest test, with many distinct values, and print the seconds. " +
  "(3) If it is not comfortably fast, fix it and run the tests again. Reply with the timing you measured.";
const SPEED_WORDS = /\b(slow|slower|too slow|fast|faster|fast enough|speed|speed up|performance|perf|time limit|times? out|timeout|efficient|efficiently|large inputs?|scales?)\b/i;
export const isSpeedRequest = text => SPEED_WORDS.test(String(text || ""));

/** Settings switched on by model id; an environment variable set to on/off still wins. */
export const PROFILES = [
  {
    id: "gpt-oss",
    match: model => /^gpt-oss(?::|-|$)/i.test(model ?? ""),
    why: "gpt-oss on agentic-v1 (2026-11-14): re-read files it had just read and retried failed edits from memory (about twice qwen's tool calls); its speed fix passed the given test but kept a quadratic step.",
    editHintAfter: 1,
    perfCheck: true,
    rereadNote: true,
  },
];
export const profileFor = (model, opts = {}) => opts.profiles === false ? null : PROFILES.find(p => p.match(model)) || null;
const auto = (setting, profileValue) => setting === "on" || (setting !== "off" && Boolean(profileValue));

export const verifyNudge = files => `You changed ${files} and no passing test ran on that code yet. Run the tests, fix what fails, and finish the request. If it cannot be tested, say why in one line.`;

export function options(env = process.env) {
  const num = (name, fallback) => {
    const value = Number(env[name]);
    return env[name] !== undefined && env[name] !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const on = name => env[name] !== "off";
  const review = env.PI_CODING_SELF_REVIEW || "off";
  return {
    enabled: on("PI_CODING"),
    rules: on("PI_CODING_RULES"),
    terse: on("PI_CODING_TERSE"),
    guides: on("PI_CODING_GUIDES"),
    guidesDir: env.PI_CODING_GUIDES_DIR || "",
    maxGuides: num("PI_CODING_MAX_GUIDES", 2),
    verify: on("PI_CODING_VERIFY"),
    // one short "test before you finish" section, for when the coding rules (which say it already) are off
    verifyRule: env.PI_CODING_VERIFY_RULE === "on",
    // more test commands, comma-separated, e.g. "./play --quick, just test"
    testCommands: String(env.PI_CODING_TEST_COMMANDS || "").split(",").map(c => c.trim().split(/\s+/)).filter(c => c[0]),
    maxWakes: num("PI_CODING_MAX_WAKES", 2),
    editHints: on("PI_CODING_EDIT_HINTS"),
    hintAfter: Math.max(1, num("PI_CODING_EDIT_HINT_AFTER", 2)),
    loopWatch: on("PI_CODING_LOOP_WATCH"),
    // off, on (every model) or a regular expression for the model ids that get it.
    selfReview: review === "off" ? null : review === "on" ? /./ : safeRegExp(review),
    log: env.PI_CODING_LOG || "",
    profiles: on("PI_CODING_PROFILE"),
    // "auto" (the model's profile decides), "on" or "off"
    perfCheck: ["on", "off"].includes(env.PI_CODING_PERF_CHECK) ? env.PI_CODING_PERF_CHECK : "auto",
    rereadNote: ["on", "off"].includes(env.PI_CODING_REREAD_NOTE) ? env.PI_CODING_REREAD_NOTE : "auto",
    hintAfterSet: env.PI_CODING_EDIT_HINT_AFTER !== undefined && env.PI_CODING_EDIT_HINT_AFTER !== "",
  };
}
const safeRegExp = source => { try { return new RegExp(source); } catch { return null; } };

// --- Guides ---------------------------------------------------------------------------------------------------------

export function loadGuides(folder = fileURLToPath(new URL("./guides/", import.meta.url))) {
  let names = [];
  try { names = readdirSync(folder).filter(name => name.endsWith(".md")).sort(); } catch { return []; }
  return names.map(name => {
    const text = readFileSync(join(folder, name), "utf8"), match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const triggers = (match?.[1].match(/^triggers:\s*(.*)$/m)?.[1] || "").split(",").map(word => word.trim().toLowerCase()).filter(Boolean);
    return { name: name.replace(/\.md$/, ""), triggers, text: (match?.[2] || text).trim() };
  });
}

/** The guides for a request: those with a trigger in its words, the most matched first, at most `max`. */
export function chooseGuides(text, guides, max = 2) {
  const words = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ")} `;
  return guides.map(guide => ({ guide, hits: guide.triggers.filter(trigger => words.includes(` ${trigger} `)).length }))
    .filter(item => item.hits).sort((a, b) => b.hits - a.hits).slice(0, max).map(item => item.guide);
}

// --- Test runs (after plh gate/protocol.py) -------------------------------------------------------------------------

const TEST_COMMANDS = [
  ["python", "-m", "unittest"], ["python3", "-m", "unittest"], ["python", "-m", "pytest"], ["python3", "-m", "pytest"],
  ["pytest"], ["py.test"], ["uv", "run", "pytest"], ["uv", "run", "--offline", "pytest"], ["uv", "run", "python", "-m", "pytest"],
  ["node", "--test"], ["npm", "test"], ["npm", "run", "test"], ["npm", "t"], ["yarn", "test"], ["pnpm", "test"], ["bun", "test"],
  ["npx", "vitest"], ["npx", "jest"], ["npx", "--no-install", "vitest"], ["npx", "--no-install", "jest"], ["vitest"], ["jest"],
  ["go", "test"], ["cargo", "test"], ["make", "test"], ["deno", "test"], ["mvn", "test"], ["gradle", "test"], ["./gradlew", "test"],
  ["dotnet", "test"], ["swift", "test"], ["mix", "test"], ["bundle", "exec", "rspec"], ["rspec"], ["phpunit"], ["vendor/bin/phpunit"],
  // a project's own check scripts (the arena benches give ./check and ./fight); more with PI_CODING_TEST_COMMANDS
  ["./check"], ["./fight"], ["./test"], ["./test.sh"], ["./run_tests.sh"], ["./run-tests"], ["make", "check"], ["npm", "run", "check"],
];
const NOT_A_RUN = new Set(["--help", "-h", "-help", "--version", "-V", "-version", "--collect-only", "--co", "--list", "-list", "--listTests", "--list-tests", "--showOnly"]);
const NO_TESTS = /\bno tests ran\b|^Ran 0 tests\b|\bNo tests? files? found\b|\bno test files\b|\bcollected 0 items\b/im;
const WRAPPERS = new Set(["sudo", "command", "exec", "nohup", "time", "env"]);
const OPERATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")"]);

/** Shell words and operators, respecting quotes; null when quoting is unbalanced. */
export function shellTokens(command) {
  const out = []; let word = null, quote = null;
  const push = () => { if (word !== null) out.push(word); word = null; };
  const s = String(command);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; else if (c === "\\" && quote === '"' && i + 1 < s.length) word += s[++i]; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; word ??= ""; continue; }
    if (c === "\\" && i + 1 < s.length) { word = (word ?? "") + s[++i]; continue; }
    if (c === " " || c === "\t" || c === "\r") { push(); continue; }
    const two = s.slice(i, i + 2);
    if (two === "&&" || two === "||") { push(); out.push({ op: two }); i++; continue; }
    if (OPERATORS.has(c)) { push(); out.push({ op: c }); continue; }
    if (c === ">" || c === "<") { // a redirect such as 2>&1 or >> keeps the exit code
      if (/^\d+$/.test(word ?? "")) word = null;
      push(); out.push({ op: c });
      while (s[i + 1] === ">" || s[i + 1] === "&") i++;
      continue;
    }
    word = (word ?? "") + c;
  }
  if (quote) return null;
  push();
  return out;
}

/** A command's segments (words before any redirect) and the operator after each; null when it pipes or masks. */
function segmentsOf(command) {
  const tokens = shellTokens(command);
  if (!tokens?.length) return null;
  const segments = []; let current = [];
  for (const token of [...tokens, { op: ";" }]) {
    if (typeof token === "object") {
      if (["|", "||", "&"].includes(token.op)) return null;
      if (token.op === ">" || token.op === "<") { current.push(token); continue; }
      if (current.length) {
        const redirect = current.findIndex(word => typeof word === "object");
        segments.push({ words: redirect >= 0 ? current.slice(0, redirect) : current, op: token.op });
      }
      current = [];
    } else current.push(token);
  }
  return segments;
}
const isRunner = (words, extra) => {
  while (words.length && (WRAPPERS.has(words[0].split("/").pop()) || /^\w+=/.test(words[0]))) words = words.slice(1);
  if (!words.length || words.slice(1).some(word => NOT_A_RUN.has(word.split("=")[0]))) return false;
  return [...TEST_COMMANDS, ...extra].some(prefix => prefix.every((word, i) => words[i] === word));
};

/** True when a bash command is a test run whose exit code counts: a known runner last, nothing piping or masking it. */
export function isTestRun(command, output, extra = []) {
  const segments = segmentsOf(command);
  if (!segments?.length || !isRunner(segments.at(-1).words, extra)) return false;
  return output === undefined || !NO_TESTS.test(String(output));
}

const TESTS_FAILED = /\bFAILED\b|\b\d+ (failed|errors?)\b|^Traceback \(most recent call last\)|\bnot ok\b|^FAIL\b|\bexit(?: code)?[=:]\s*[1-9]/m;
const TESTS_PASSED = /^OK\b|\b\d+ passed\b|\btests? passed\b|^ok\b|^PASS\b|\bexit(?: code)?[=:]\s*0\b|^ℹ fail 0$/m;

/** "pass", "fail" or null (no test run, or its result cannot be told) for a bash call. A runner last, or anywhere in an
 * all-&& chain, has its exit code in the call's; elsewhere (`pytest -q; echo "exit=$?"`) the output decides. */
export function testOutcome(command, output, isError, extra = []) {
  const segments = segmentsOf(command), text = String(output ?? "");
  if (!segments?.length || NO_TESTS.test(text)) return null;
  const at = segments.findIndex(segment => isRunner(segment.words, extra));
  if (at < 0) return null;
  if (at === segments.length - 1 || segments.slice(at, -1).every(segment => segment.op === "&&")) return isError ? "fail" : "pass";
  if (TESTS_FAILED.test(text)) return "fail";
  return TESTS_PASSED.test(text) ? "pass" : null;
}

// --- Edit hints (after plh gate/ledger.py, G-004) --------------------------------------------------------------------

const bigrams = text => {
  const s = text.replace(/\s+/g, " ").trim(), map = new Map();
  for (let i = 0; i < s.length - 1; i++) { const pair = s.slice(i, i + 2); map.set(pair, (map.get(pair) || 0) + 1); }
  return { map, size: Math.max(0, s.length - 1) };
};
/** Similarity 0..1 of two texts (Dice coefficient over character pairs, whitespace collapsed). */
export function similarity(a, b) {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return a.trim() === b.trim() ? 1 : 0;
  let shared = 0;
  for (const [pair, count] of x.map) shared += Math.min(count, y.map.get(pair) || 0);
  return (2 * shared) / (x.size + y.size);
}

/** Up to `n` passages of the file closest to `oldText` (same line count), best first, above `cutoff`. */
export function closestText(content, oldText, { n = 2, cutoff = 0.4, maxLines = 80, maxWindows = 20000 } = {}) {
  const size = String(oldText).split("\n").length, lines = String(content).split("\n");
  if (!oldText || size > maxLines || size > lines.length) return [];
  const scored = [];
  for (let at = 0; at <= Math.min(lines.length - size, maxWindows); at++) {
    const window = lines.slice(at, at + size).join("\n"), score = similarity(oldText, window);
    if (score >= cutoff) scored.push({ window, score });
  }
  const seen = new Set();
  return scored.sort((a, b) => b.score - a.score).map(item => item.window).filter(w => !seen.has(w) && seen.add(w)).slice(0, n);
}

const editsOf = input => {
  let edits = input?.edits ?? (input?.oldText !== undefined ? [input] : []);
  if (typeof edits === "string") try { edits = JSON.parse(edits); } catch { edits = []; }
  if (edits && !Array.isArray(edits)) edits = [edits];
  return Array.isArray(edits) ? edits.filter(edit => edit && typeof edit === "object") : [];
};

// --- Action loops (after plh harness/stuck.mjs) ----------------------------------------------------------------------

const stepName = step => `${step.tool} ${String(step.input?.command ?? step.input?.path ?? step.input?.pattern ?? JSON.stringify(step.input ?? {})).replace(/\s+/g, " ").slice(0, 80)}`;
const stepCall = step => `${step.tool}\u0000${JSON.stringify(step.input ?? {})}`;
// Times, durations and long ids do not make a result new; counts do ("3 passed" then "4 passed" is progress).
const stepResult = step => `${step.error ? "error" : "ok"}\u0000${String(step.text ?? "").replace(/\d{1,2}:\d{2}(:\d{2})?|\d+(\.\d+)?\s?(ms|s)\b|\d{4,}/g, "#").slice(0, 400)}`;

/** Why the last steps show no progress, or null. */
export function stuckPattern(steps) {
  const last = steps.at(-1);
  if (!last) return null;
  const pattern = detectActionLoop(steps.slice(-6).map(step => ({ callKey: stepCall(step), resultKey: stepResult(step), failed: Boolean(step.error) })));
  if (pattern === "repeated-result") return `the same call 4 times with the same result: ${stepName(last)}`;
  if (pattern === "repeated-failure") return `the same call failed 3 times in a row: ${stepName(last)}`;
  if (pattern === "alternating-actions") return `alternated between two calls 6 times: ${stepName(steps.at(-6))} and ${stepName(steps.at(-5))}`;
  return null;
}

// --- The extension ----------------------------------------------------------------------------------------------------

const textOf = content => (content || []).filter(part => part?.type === "text").map(part => part.text || "").join("\n");
const isCode = path => !/\.(md|markdown)$/i.test(path);

export function installCodingBoost(pi, opts = options(), { now = () => Date.now() } = {}) {
  const stats = { prompts: 0, guides: 0, wakes: 0, unverified: 0, reviews: 0, editHints: 0, loops: 0, perfChecks: 0, rereads: 0 };
  if (!opts.enabled) return { stats };
  const guides = opts.guides ? [...loadGuides(), ...(opts.guidesDir ? loadGuides(opts.guidesDir) : [])] : [];
  let wakes = 0, reviewed = false, seq = 0, passedAt = 0, lastAnswer = "", steps = [];
  let changed = new Map(), editFailures = new Map(), speed = false, perfChecked = false, lastReads = new Map();

  const record = (event, ctx, data = {}) => {
    const entry = { event, at: new Date(now()).toISOString(), model: ctx?.model?.id, ...data };
    try { pi.appendEntry?.(ENTRY, entry); } catch {}
    if (opts.log) try { appendFileSync(opts.log, JSON.stringify(entry) + "\n"); } catch {}
    if (ctx?.hasUI && ["woken", "unverified", "loop", "review"].includes(event)) ctx.ui?.notify?.(`Coding boost: ${data.reason || event}`, event === "unverified" ? "warning" : "info");
  };
  const unverified = () => [...changed].filter(([, at]) => at > passedAt).map(([path]) => path);
  const cwdOf = ctx => ctx?.cwd || process.cwd();

  // A new request from the person starts fresh. The extension's own follow-ups continue the same run
  // (agent_before_settle), so they never reach here and cannot reset the wake-up budget.
  pi.on("before_agent_start", (event, ctx) => {
    wakes = 0; reviewed = false; changed = new Map(); editFailures = new Map(); steps = []; lastReads = new Map();
    speed = isSpeedRequest(event?.prompt); perfChecked = false;
    const parts = [];
    if (opts.rules) parts.push(CODING_RULES);
    else if (opts.verify && opts.verifyRule) parts.push(VERIFY_RULE);
    if (opts.terse) parts.push(TERSE_STYLE);
    const chosen = chooseGuides(event?.prompt, guides, opts.maxGuides);
    if (chosen.length) { stats.guides += chosen.length; record("guides", ctx, { guides: chosen.map(g => g.name) }); parts.push(...chosen.map(g => g.text)); }
    if (!parts.length || typeof event?.systemPrompt !== "string") return undefined;
    stats.prompts++;
    return { systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n\n")}` };
  });

  pi.on("message_end", event => {
    const message = event?.message;
    if (message?.role === "assistant") lastAnswer = textOf(message.content);
  });

  pi.on("tool_result", (event, ctx) => {
    const tool = event?.toolName, input = event?.input || {}, text = textOf(event?.content);
    const notes = [];
    const profile = profileFor(ctx?.model?.id, opts);

    if (tool === "read" && !event.isError && typeof input.path === "string" && auto(opts.rereadNote, profile?.rereadNote)) {
      const key = `${resolve(cwdOf(ctx), input.path)}\u0000${input.offset ?? ""}\u0000${input.limit ?? ""}`;
      if (lastReads.get(key) === text) {
        stats.rereads++;
        record("reread", ctx, { path: input.path });
        notes.push(`${input.path} has not changed since your last read of it; that text is still current. Use it instead of reading again.`);
      }
      lastReads.set(key, text);
    }

    if ((tool === "write" || tool === "edit") && !event.isError && typeof input.path === "string" && isCode(input.path)) {
      changed.set(resolve(cwdOf(ctx), input.path), ++seq);
    }
    const outcome = tool === "bash" && typeof input.command === "string" ? testOutcome(input.command, text, event.isError, opts.testCommands) : null;
    if (outcome) {
      seq++;
      if (outcome === "pass") passedAt = seq;
    }

    if (opts.editHints && tool === "edit" && event.isError && typeof input.path === "string") {
      const path = isAbsolute(input.path) ? input.path : resolve(cwdOf(ctx), input.path);
      if (!existsSync(path)) notes.push(`${input.path} does not exist; use write to create it.`);
      else if (/could not find/i.test(text)) {
        const count = (editFailures.get(path) || 0) + 1;
        editFailures.set(path, count);
        const hintAfter = !opts.hintAfterSet && profile?.editHintAfter ? profile.editHintAfter : opts.hintAfter;
        if (count >= hintAfter) {
          let content = "";
          try { content = readFileSync(path, "utf8"); } catch {}
          const hints = [];
          for (const edit of editsOf(input)) for (const hint of closestText(content, String(edit.oldText ?? ""))) if (!hints.includes(hint)) hints.push(hint);
          if (hints.length) {
            stats.editHints++;
            record("edit-hint", ctx, { path: input.path, failures: count });
            notes.push("Closest current text (copy exactly):\n" + hints.slice(0, 3).join("\n---\n").slice(0, 6000));
          } else notes.push(`Read ${input.path} again and copy the text exactly, or use write if you mean to replace the whole file.`);
        }
      }
    }

    if (opts.loopWatch && tool) {
      steps = [...steps, { tool, input, error: Boolean(event.isError), text }].slice(-12);
      const stuck = stuckPattern(steps);
      if (stuck) {
        steps = [];
        stats.loops++;
        record("loop", ctx, { reason: stuck });
        notes.push(`No progress: ${stuck}. Stop repeating it and try another way: read the error and the code again, or change the approach.`);
      }
    }

    if (!notes.length) return undefined;
    return { content: [...(event.content || []), { type: "text", text: `\n[coding-boost] ${notes.join("\n")}` }] };
  });

  pi.on("agent_before_settle", (event, ctx) => {
    if (event?.outcome !== "completed" || event?.continue) return undefined;
    const asking = /\?\s*$/.test(lastAnswer.trim());
    const continueWith = (reason, content) => {
      wakes++;
      record(reason === "review" ? "review" : "woken", ctx, { reason, wake: wakes });
      return { entries: [...(event.entries || []), { type: "custom_message", customType: ENTRY, content, display: true }], continue: true };
    };
    const files = unverified();
    if (opts.verify && files.length && !asking) {
      const shown = files.slice(0, 5).map(path => path.startsWith(cwdOf(ctx) + "/") ? path.slice(cwdOf(ctx).length + 1) : path).join(", ") + (files.length > 5 ? " …" : "");
      if (wakes < opts.maxWakes) { stats.wakes++; return continueWith(`not verified: ${shown}`, verifyNudge(shown)); }
      stats.unverified++;
      record("unverified", ctx, { reason: `Not verified: no passing test run after the last change to ${shown}` });
      return undefined;
    }
    const model = ctx?.model?.id || "";
    if (speed && !perfChecked && changed.size && !files.length && !asking && wakes < opts.maxWakes
        && auto(opts.perfCheck, profileFor(model, opts)?.perfCheck)) {
      perfChecked = true; stats.perfChecks++;
      return continueWith("speed check", PERF_PROMPT);
    }
    if (opts.selfReview?.test(model) && !reviewed && changed.size && !files.length && !asking && wakes < opts.maxWakes) {
      reviewed = true; stats.reviews++;
      return continueWith("review", REVIEW_PROMPT);
    }
    return undefined;
  });

  pi.registerCommand?.("boost", {
    description: "Show what coding-boost did in this session",
    handler: async (_args, ctx) => ctx.ui.notify(`Coding boost: ${JSON.stringify({ ...stats, changedNotTested: unverified() })}`, "info"),
  });
  return { stats };
}
