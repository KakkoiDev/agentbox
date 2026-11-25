#!/usr/bin/env node
// agentbox: open the pi coding agent in the current folder, inside a macOS sandbox, set up for the model you give it.
// What each model gets comes from bench results (ai-core's harness profiles, measured with agentbench).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { createDeepSeekProxy, deepseekPeak, deepseekSpent, deepseekCap, DEEPSEEK_PORT } from "@kakkoidev/ai-core/deepseek";
import { macSandboxProfile, holdsHome } from "@kakkoidev/ai-core/sandbox";
import { ollamaModels, ollamaContext, piProviders, unknownModel } from "@kakkoidev/ai-core/providers";
import { harnessFor, HARNESS_PROFILES } from "@kakkoidev/ai-core/harness";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version;
const HOME = homedir();
const STATE = process.env.AGENTBOX_HOME || join(HOME, ".local/share/agentbox");
const CONFIG = process.env.AGENTBOX_CONFIG || join(HOME, ".config/agentbox/config.json");
const PI_HOME = join(STATE, "pi");
const OLLAMA = process.env.OLLAMA_HOST_URL || "http://127.0.0.1:11434";
const KEY_FILE = process.env.DEEPSEEK_API_KEY_FILE || join(HOME, ".config/deepseek/api-key");
const USAGE = join(STATE, "deepseek-usage.jsonl");
const BUDGET = join(STATE, "deepseek-budget.json");
// the part names in ai-core's harness profiles, as files of this package
const PARTS = {
  "command-timeout": join(PKG, "extensions/command-timeout/index.ts"),
  "local-model-guard": join(PKG, "extensions/pi-core/local-model-guard/index.ts"),
  "coding-boost": join(PKG, "extensions/pi-core/coding-boost/index.ts"),
  "async-rewake": join(PKG, "extensions/pi-core/async-rewake/extension/index.ts"),
};

const HELP = `agentbox ${VERSION}: the pi coding agent in a macOS sandbox, set up for the model you give it

  agentbox [options] [pi arguments]      open pi in the current folder
    -m, --model provider/id              e.g. ollama/qwen3.8:27b or deepseek/flash (default: config, else the first Ollama model)
    -t, --thinking level                 pi's thinking level (deepseek/flash: off, high or max)
    --net                                let the agent reach the network, not only its model
    --allow-home                         allow running in your home folder itself
    --no-sandbox                         run pi without the sandbox
  agentbox models                        the models it can use
  agentbox harness -m MODEL [--json]     what a run with that model gets, and the bench result behind each part
  agentbox doctor                        check the setup
  agentbox proxy                         serve the DeepSeek proxy on 127.0.0.1:${DEEPSEEK_PORT} (started for you when needed)
  agentbox spent                         what DeepSeek has cost so far
  agentbox install SOURCE                add a pi package to agentbox's own pi config
  agentbox update                        install the latest agentbox from GitHub (same place as this one)
  agentbox report [--repo owner/name]    turn this folder's last session into an issue on agentbench (you edit it first)

The sandbox: writes only in the current folder, agentbox's state and a private temp folder; no other reads in your
home folder (except git's config and where pi and node are installed); never ~/.ssh, ~/.aws, keychains or API keys;
network only to the model's port. Config (optional): ${CONFIG}
  {"model": "ollama/qwen3.8:27b", "thinking": "off", "extensions": ["coding-boost"], "net": false, "issues": true}
  "issues": false (or AGENTBOX_ISSUES=off) never files issues: \`agentbox report\` refuses, and bench runs made
  through this agentbox are skipped by agentbench's bench_issues.py.`;

const issuesOn = () => !/^(0|off|false|no)$/i.test(process.env.AGENTBOX_ISSUES ?? "") && config().issues !== false;
const die = (m) => { console.error(`agentbox: ${m}`); process.exit(1); };
const config = () => { try { return JSON.parse(readFileSync(CONFIG, "utf8")); } catch { return {}; } };
const which = (exe) => { const r = spawnSync("/usr/bin/which", [exe], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
const listening = (port) => new Promise((ok) => { const s = connect(port, "127.0.0.1"); s.on("connect", () => { s.end(); ok(true); }); s.on("error", () => ok(false)); });

function parse(argv) {
  const a = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "-m" || x === "--model") a.model = argv[++i];
    else if (x === "-t" || x === "--thinking") a.thinking = argv[++i];
    else if (x === "--net") a.net = true;
    else if (x === "--allow-home") a.allowHome = true;
    else if (x === "--no-sandbox") a.noSandbox = true;
    else if (x === "--json") a.json = true;
    else if (x === "--repo") a.repo = argv[++i];
    else if (x === "-h" || x === "--help") a.help = true;
    else if (x === "--version") a.version = true;
    else a.rest.push(x);
  }
  return a;
}

/** agentbox's own pi config (not ~/.pi): Ollama's and DeepSeek's models; other providers you added are kept. */
async function writePiConfig(model) {
  mkdirSync(PI_HOME, { recursive: true });
  const mj = join(PI_HOME, "models.json");
  const cfg = existsSync(mj) ? JSON.parse(readFileSync(mj, "utf8")) : {};
  const ollama = await ollamaModels(OLLAMA);
  const contexts = {};
  if (model?.startsWith("ollama/")) contexts[model.slice(7)] = await ollamaContext(model.slice(7), OLLAMA);
  cfg.providers = { ...(cfg.providers ?? {}), ...piProviders({ ollamaUrl: OLLAMA, ollama, contexts, deepseekPort: DEEPSEEK_PORT }) };
  writeFileSync(mj, JSON.stringify(cfg, null, 1));
  const st = join(PI_HOME, "settings.json");
  const s = existsSync(st) ? JSON.parse(readFileSync(st, "utf8")) : {};
  s.quietStartup ??= "header";
  writeFileSync(st, JSON.stringify(s, null, 1));
  return cfg;
}

function portOf(cfg, provider) {
  const m = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/.exec(cfg.providers?.[provider]?.baseUrl ?? "");
  return m ? Number(m[1]) : null;
}

async function ensureProxy() {
  if (await listening(DEEPSEEK_PORT)) return;
  if (!existsSync(KEY_FILE)) die(`no DeepSeek API key: save it in ${KEY_FILE} (chmod 600)`);
  mkdirSync(STATE, { recursive: true });
  const log = openSync(join(STATE, "proxy.log"), "a");
  spawn(process.execPath, [fileURLToPath(import.meta.url), "proxy"], { detached: true, stdio: ["ignore", log, log], cwd: STATE }).unref();
  for (let i = 0; i < 50; i++) {
    if (await listening(DEEPSEEK_PORT)) { console.error(`agentbox: started the DeepSeek proxy (127.0.0.1:${DEEPSEEK_PORT}, log ${join(STATE, "proxy.log")})`); return; }
    await new Promise((ok) => setTimeout(ok, 100));
  }
  die(`the DeepSeek proxy did not start: see ${join(STATE, "proxy.log")}`);
}

/** The folder a tool is installed in, so the sandbox lets it read its own files when they live in your home. */
function installRoot(exe) {
  const p = which(exe);
  if (!p) return null;
  const real = realpathSync(p);
  let d = dirname(real);
  while (dirname(d) !== d) { if (dirname(d) === HOME) return d; d = dirname(d); }
  return dirname(dirname(real));
}

/** The pi extensions for a model: ai-core's profile for it, plus the config's extra ones (part names or paths). */
function extensionsFor(model, extra = []) {
  const parts = harnessFor(model).filter((p) => p.kind === "extension");
  const missing = parts.filter((p) => !PARTS[p.part]);
  if (missing.length) die(`ai-core asks for parts this agentbox does not have: ${missing.map((p) => p.part).join(", ")} (update agentbox)`);
  return [...parts.map((p) => ({ part: p.part, path: PARTS[p.part], why: p.why })),
    ...extra.map((e) => ({ part: PARTS[e] ? e : "config", path: PARTS[e] ?? resolve(e.replace(/^~/, HOME)), why: "added in your config" }))];
}

async function run(a) {
  if (process.platform !== "darwin") die("agentbox needs macOS (sandbox-exec)");
  if (!which("pi")) die("pi is not installed (the pi coding agent, 1.1 or later)");
  const user = config();
  const work = realpathSync(process.cwd());
  if (!a.allowHome && holdsHome(work, HOME)) die(`${work} holds your whole home folder; run agentbox in a project folder (or pass --allow-home)`);
  const model = a.model || user.model || (await ollamaModels(OLLAMA)).map((m) => `ollama/${m}`)[0];
  if (!model?.includes("/")) die("no model: pass --model provider/id (agentbox models lists them)");
  const cfg = await writePiConfig(model);
  const bad = unknownModel(cfg.providers, model);   // pi would quietly run a similar-named model instead
  if (bad) die(bad);
  const provider = model.split("/")[0];
  if (provider === "deepseek") {
    await ensureProxy();
    if (deepseekPeak()) console.error("agentbox: DeepSeek peak hours (01-04 and 06-10 UTC, Mon-Fri): prices are doubled now");
  }
  const thinking = a.thinking || user.thinking;
  const exts = extensionsFor(model, user.extensions ?? []);
  const tmp = join(STATE, "tmp", String(process.pid));
  mkdirSync(tmp, { recursive: true });
  const cmd = ["pi", "--model", model, ...(thinking ? ["--thinking", thinking] : []), ...exts.flatMap((e) => ["-e", e.path]), ...a.rest];
  const env = { ...process.env, PI_CODING_AGENT_DIR: PI_HOME, TMPDIR: tmp + "/" };
  let argv = cmd;
  if (a.noSandbox) console.error("agentbox: no sandbox: the agent can read and write anything you can");
  else {
    const cache = realpathSync(spawnSync("getconf", ["DARWIN_USER_CACHE_DIR"], { encoding: "utf8" }).stdout.trim() || tmp);
    const readable = [PKG, installRoot("pi"), installRoot("node"), join(HOME, ".local/share/uv/python"), join(HOME, ".gitconfig"),
      join(HOME, ".config/git"), ...exts.map((e) => dirname(e.path))].filter(Boolean);
    const prof = join(tmp, "sandbox.sb");
    writeFileSync(prof, macSandboxProfile({ home: HOME, writable: [work, STATE], readable, tmp, cache,
      port: portOf(cfg, provider) ?? null, net: a.net || user.net }));
    argv = ["sandbox-exec", "-f", prof, ...cmd];
  }
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => {});   // pi handles the terminal's signals
  const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", env });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

const textOf = (content) => typeof content === "string" ? content : (content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** The draft of a real-life report: what was asked, how the session went, how it ended. */
function draftReport(sessionFile) {
  const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const msgs = lines.filter((l) => l.type === "message").map((l) => l.message);
  const model = lines.findLast((l) => l.type === "model_change");
  const thinking = lines.findLast((l) => l.type === "thinking_level_change")?.thinkingLevel ?? "off";
  const asked = msgs.filter((m) => m.role === "user").map((m) => textOf(m.content));
  const results = msgs.filter((m) => m.role === "toolResult");
  const last = msgs.findLast((m) => m.role === "assistant" && textOf(m.content).trim());
  const clip = (t, n) => (t.length > n ? t.slice(0, n) + "\n[...]" : t);
  return [
    `# Real-life task: ${(asked[0] ?? "").split("\n")[0].slice(0, 70)}`,
    "",
    "<!-- This becomes a PUBLIC issue. Remove anything private (code, names, paths, data) before saving.",
    "     The first line is the title. Save it unchanged, or empty, to cancel. -->",
    "",
    "## What went wrong",
    "",
    "(say what the agent got wrong, or what it should have done)",
    "",
    "## What was asked",
    "",
    ...asked.map((t) => "> " + clip(t, 1500).replaceAll("\n", "\n> ")),
    "",
    "## The session",
    "",
    `- model: ${model ? `${model.provider}/${model.modelId}` : "?"}, thinking ${thinking}, agentbox ${VERSION}`,
    `- ${msgs.filter((m) => m.role === "assistant").length} turns, ${results.length} tool calls, ${results.filter((r) => r.isError).length} failed`,
    `- extensions: ${lines.filter((l) => l.type === "custom").map((l) => l.customType).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "none logged"}`,
    "",
    "## How it ended",
    "",
    "```",
    clip(last ? textOf(last.content) : "(no reply)", 2000),
    "```",
    "",
  ].join("\n");
}

async function report(a) {
  if (!issuesOn()) die(`issues are off (${process.env.AGENTBOX_ISSUES ? "AGENTBOX_ISSUES" : `"issues": false in ${CONFIG}`}): nothing was sent`);
  const repo = a.repo || config().reportRepo || "KakkoiDev/agentbench";
  if (!which("gh")) die("report needs the GitHub CLI (gh), signed in");
  const dir = join(PI_HOME, "sessions", "--" + realpathSync(process.cwd()).replace(/^\//, "").replaceAll("/", "-") + "--");
  const files = existsSync(dir) ? spawnSync("/bin/ls", ["-t", dir], { encoding: "utf8" }).stdout.split("\n").filter((f) => f.endsWith(".jsonl")) : [];
  if (!files.length) die(`no agentbox session in this folder (looked in ${dir})`);
  const draft = draftReport(join(dir, files[0]));
  mkdirSync(join(STATE, "reports"), { recursive: true });
  const file = join(STATE, "reports", files[0].replace(/\.jsonl$/, ".md"));
  writeFileSync(file, draft);
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  spawnSync(editor, [file], { stdio: "inherit", shell: true });
  const text = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->\n*/g, "").trim();
  const [title, ...body] = text.split("\n");
  if (!text || text === draft.replace(/<!--[\s\S]*?-->\n*/g, "").trim()) die(`cancelled: the draft was not edited (kept in ${file})`);
  const args = ["issue", "create", "-R", repo, "--title", title.replace(/^#\s*/, ""), "--body", body.join("\n").trim()];
  let r = spawnSync("gh", [...args, "--label", "real-life"], { encoding: "utf8" });
  if (r.status !== 0 && /label/i.test(r.stderr)) r = spawnSync("gh", args, { encoding: "utf8" });   // the label may not exist yet
  if (r.status !== 0) die(`gh: ${r.stderr.trim()} (draft kept in ${file})`);
  console.log(r.stdout.trim());
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parse(cmd && ["models", "harness", "doctor", "proxy", "spent", "install", "report", "update"].includes(cmd) ? rest : argv);
  if (a.version) return console.log(`agentbox ${VERSION}`);
  if (a.help) return console.log(HELP);
  switch (cmd) {
    case "models":
      for (const m of await ollamaModels(OLLAMA)) console.log(`ollama/${m}`);
      for (const m of piProviders().deepseek.models) console.log(`deepseek/${m.id}` + (m.id === "flash" ? "   (follows --thinking off|high|max)" : ""));
      return;
    case "harness": {
      if (!a.model) die("harness needs --model");
      const exts = extensionsFor(a.model, config().extensions ?? []);
      const out = { model: a.model, thinking: a.thinking ?? null, version: VERSION, profiles: HARNESS_PROFILES.about,
        issues: issuesOn(), extensions: exts, prompts: [], pi_args: exts.flatMap((e) => ["-e", e.path]) };
      if (a.json) return console.log(JSON.stringify(out));
      for (const e of exts) console.log(`${e.part}  ${e.path}\n    ${e.why}`);
      return;
    }
    case "doctor": {
      const checks = [["macOS sandbox-exec", !!which("sandbox-exec")], ["pi", !!which("pi")], ["node " + process.version, true],
        ["Ollama answering", (await ollamaModels(OLLAMA)).length > 0], [`DeepSeek key (${KEY_FILE})`, existsSync(KEY_FILE)],
        ["DeepSeek proxy running", await listening(DEEPSEEK_PORT)]];
      for (const [n, ok] of checks) console.log(`${ok ? "ok " : "-- "} ${n}`);
      if (which("pi")) console.log("    pi " + spawnSync("pi", ["--version"], { encoding: "utf8" }).stdout.trim());
      return console.log(`    agentbox ${VERSION}, state ${STATE}, config ${CONFIG}`);
    }
    case "proxy": {
      if (!existsSync(KEY_FILE)) die(`no DeepSeek API key: save it in ${KEY_FILE} (chmod 600)`);
      createDeepSeekProxy({ keyFile: KEY_FILE, usageFile: USAGE, budgetFile: BUDGET }).listen(DEEPSEEK_PORT, "127.0.0.1",
        () => console.log(`DeepSeek proxy on 127.0.0.1:${DEEPSEEK_PORT}; spent $${deepseekSpent(USAGE).toFixed(4)} of $${deepseekCap(BUDGET)}`));
      return;
    }
    case "spent":
      return console.log(`$${deepseekSpent(USAGE).toFixed(4)} of $${deepseekCap(BUDGET)} (cap: "usd" in ${BUDGET})`);
    case "update": {
      // PKG is <prefix>/lib/node_modules/agentbox: reinstall into the same prefix, from GitHub's main branch
      const prefix = resolve(PKG, "../../..");
      if (existsSync(join(PKG, ".git")) || !PKG.endsWith("/lib/node_modules/agentbox")) die(`this agentbox runs from ${PKG} (a development copy): update it with git pull there`);
      console.log(`agentbox ${VERSION} -> latest, into ${prefix}`);
      const r = spawnSync("npm", ["install", "-g", "--prefix", prefix, "github:KakkoiDev/agentbox"], { stdio: "inherit" });
      if (r.status !== 0) process.exit(r.status ?? 1);
      return console.log(spawnSync(join(prefix, "bin/agentbox"), ["--version"], { encoding: "utf8" }).stdout.trim());
    }
    case "report":
      return report(a);
    case "install":
      await writePiConfig(null);
      return spawn("pi", ["install", ...a.rest], { stdio: "inherit", env: { ...process.env, PI_CODING_AGENT_DIR: PI_HOME } }).on("exit", (c) => process.exit(c ?? 1));
    default:
      return run(a);
  }
}

main(process.argv.slice(2));
