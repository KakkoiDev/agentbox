/**
 * pi-async-rewake — Pi extension that wakes the agent when background jobs finish.
 *
 * Equivalent to Claude Code's Stop hook with `asyncRewake: true`, for Pi:
 * a background job spawned detached by the `pi-async-rewake` CLI completes,
 * and this extension delivers the job's output to the agent as a follow-up
 * user message, so the agent picks the result up on its next turn without
 * ever blocking the foreground.
 *
 * Lifecycle integration:
 *   - `agent_settled`  — a run just settled; sweep now (the brief's hook).
 *   - `session_start`  — catch jobs that finished while pi was closed.
 *   - timer poll       — `agent_settled` only fires around agent runs; while
 *                        the agent idles, a lightweight poll (default 5s,
 *                        `PI_ASYNC_REWAKE_POLL_MS`) keeps the wake timely.
 *
 * Delivery uses `pi.sendUserMessage(..., { deliverAs: "followUp" })`:
 *   - agent idle  -> sent immediately, triggers a fresh turn (the wake);
 *   - agent busy  -> queued, delivered once the current run settles.
 *
 * This module is deliberately self-contained (no imports beyond the type-only
 * pi API and Node builtins) so it can run from any Pi extension location.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Cap per-job output included in the wake message. */
const MAX_STDOUT_CHARS = 50000;
const MAX_STDERR_CHARS = 4000;
/** Cap jobs batched into a single wake message. */
const MAX_JOBS_PER_MESSAGE = 10;

const POLL_MS = Number(process.env.PI_ASYNC_REWAKE_POLL_MS ?? 5000);

function stateDir(): string {
  return process.env.PI_ASYNC_REWAKE_DIR || path.join(os.homedir(), ".pi-async-rewake", "jobs");
}

function filesFor(label: string) {
  const ext = (s: string) => `${label}.${s}`;
  return {
    pid: ext("pid"),
    cmd: ext("cmd"),
    out: ext("out"),
    err: ext("err"),
    exit: ext("exit"),
    done: ext("done"),
    delivered: ext("delivered"),
  };
}

interface CompletedJob {
  label: string;
  cmd: string[] | null;
  cwd: string | null;
  startedAt: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Serialize sweeps: timer and event handlers can fire concurrently. */
let sweeping = false;
/** Only deliver once a session exists (pi can send user messages). */
let sessionReady = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;

async function readCompletedJob(dir: string, label: string): Promise<CompletedJob> {
  const f = filesFor(label);
  const p = (key: string) => path.join(dir, f[key as keyof typeof f]);

  let meta: { cmd?: string[]; cwd?: string; startedAt?: string } | null = null;
  try {
    meta = JSON.parse(await fsp.readFile(p("cmd"), "utf8"));
  } catch {
    /* no metadata — fine */
  }

  let exitCode: number | null = null;
  try {
    const raw = (await fsp.readFile(p("exit"), "utf8")).trim();
    if (raw !== "") exitCode = Number(raw);
  } catch {
    /* exit file missing (e.g. killed hard) — report null */
  }

  let stdout = "";
  try {
    stdout = await fsp.readFile(p("out"), "utf8");
  } catch {
    /* no output */
  }
  let stderr = "";
  try {
    stderr = await fsp.readFile(p("err"), "utf8");
  } catch {
    /* no stderr */
  }

  return {
    label,
    cmd: meta?.cmd ?? null,
    cwd: meta?.cwd ?? null,
    startedAt: meta?.startedAt ?? null,
    exitCode,
    stdout,
    stderr,
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated — ${text.length} chars total]`;
}

function durationLabel(startedAt: string | null): string {
  if (!startedAt) return "";
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `, ran ${Math.round(ms)}ms`;
  if (ms < 60_000) return `, ran ${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `, ran ${Math.round(ms / 1000)}s`;
  return `, ran ${(ms / 3_600_000).toFixed(1)}h`;
}

function formatJobBody(job: CompletedJob, index: number, total: number, dir: string): string {
  const f = filesFor(job.label);
  const status =
    job.exitCode === null ? "exit code unknown" : `exit code ${job.exitCode}`;
  const head =
    total === 1
      ? `Background job ${JSON.stringify(job.label)} completed (${status}${durationLabel(job.startedAt)}).`
      : `${index}. ${JSON.stringify(job.label)} — ${status}${durationLabel(job.startedAt)}`;
  const cmd = job.cmd && job.cmd.length > 0 ? job.cmd.join(" ") : "(unknown command)";
  const parts: string[] = [head];
  if (total === 1) {
    parts.push("");
    parts.push(`Command: ${cmd}`);
    if (job.stdout.trim() !== "") {
      parts.push("");
      parts.push("=== stdout ===");
      parts.push(truncate(job.stdout.replace(/\s+$/, ""), MAX_STDOUT_CHARS));
    }
    if (job.stderr.trim() !== "") {
      parts.push("");
      parts.push("=== stderr ===");
      parts.push(truncate(job.stderr.replace(/\s+$/, ""), MAX_STDERR_CHARS));
    }
    parts.push("");
    parts.push(`Full output: ${path.join(dir, f.out)}`);
  } else {
    parts.push(`  Command: ${cmd}`);
    if (job.stdout.trim() !== "") {
      parts.push(`  stdout: ${truncate(job.stdout.replace(/\s+$/, ""), MAX_STDOUT_CHARS)}`);
    }
    if (job.stderr.trim() !== "") {
      parts.push(`  stderr: ${truncate(job.stderr.replace(/\s+$/, ""), MAX_STDERR_CHARS)}`);
    }
  }
  return parts.join("\n");
}

function formatMessage(jobs: CompletedJob[], dir: string, omitted: number): string {
  const lines: string[] = [];
  if (jobs.length === 1 && omitted === 0) {
    lines.push(`[pi-async-rewake] ${formatJobBody(jobs[0], 1, 1, dir)}`);
  } else {
    lines.push(`[pi-async-rewake] ${jobs.length + omitted} background job(s) completed:`);
    lines.push("");
    jobs.forEach((job, i) => lines.push(formatJobBody(job, i + 1, jobs.length, dir)));
    if (omitted > 0) {
      lines.push("");
      lines.push(`… and ${omitted} more completed job(s), output kept in ${dir}`);
    }
  }
  lines.push("");
  lines.push("Review the output above and continue accordingly.");
  return lines.join("\n");
}

/**
 * One sweep: find every job whose `.done` marker appeared, claim it atomically
 * (rename `.done` -> `.delivered`), read its output, and hand it to the agent
 * as a follow-up user message. Files are removed after delivery.
 */
async function sweep(pi: ExtensionAPI): Promise<void> {
  if (sweeping || !sessionReady) return;
  sweeping = true;
  try {
    const dir = stateDir();
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return; // state dir does not exist yet — nothing to do
    }

    const doneLabels = entries
      .filter((e) => e.endsWith(".done"))
      .map((e) => e.slice(0, -".done".length))
      .filter((l) => LABEL_RE.test(l));

    if (doneLabels.length === 0) return;

    const jobs: CompletedJob[] = [];
    for (const label of doneLabels.slice(0, MAX_JOBS_PER_MESSAGE)) {
      const f = filesFor(label);
      const donePath = path.join(dir, f.done);
      const deliveredPath = path.join(dir, f.delivered);
      try {
        // Atomic claim: whoever renames first delivers. Crash-safe: on restart
        // a `.delivered` job is never re-sent.
        await fsp.rename(donePath, deliveredPath);
      } catch {
        continue; // already claimed by another sweep/process
      }
      try {
        jobs.push(await readCompletedJob(dir, label));
      } catch (err) {
        // Reading failed — give the job back so a later sweep retries.
        console.error(`[pi-async-rewake] failed to read job ${label}: ${err}`);
        try {
          await fsp.rename(deliveredPath, donePath);
        } catch {
          /* best effort */
        }
      }
    }
    const omitted = doneLabels.length - jobs.length;

    if (jobs.length === 0) return;

    // followUp: delivered when the agent settles if it is busy, or immediately
    // (triggering a fresh turn — the wake) if it is idle. Either way the agent
    // sees the result on its next turn.
    pi.sendUserMessage(formatMessage(jobs, dir, omitted), { deliverAs: "followUp" });

    // Cleanup markers and metadata — keep .out/.err so the agent can read
    // full output beyond what the truncated wake message includes.
    for (const job of jobs) {
      const f = filesFor(job.label);
      const keep = new Set(["out", "err"]);
      for (const [key, filename] of Object.entries(f)) {
        if (keep.has(key)) continue;
        try {
          await fsp.rm(path.join(dir, filename), { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  } finally {
    sweeping = false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    sessionReady = true;
    // Catch jobs that finished while pi was closed or before this session.
    await sweep(pi);
  });

  pi.on("session_shutdown", () => {
    sessionReady = false;
  });

  pi.on("agent_settled", async () => {
    // A run just settled and will not continue automatically: sweep now so a
    // freshly completed job wakes the agent instead of waiting for the poll.
    await sweep(pi);
  });

  // While the agent idles, no agent_settled fires — poll so completion still
  // wakes it. Disable with PI_ASYNC_REWAKE_POLL_MS=0.
  if (POLL_MS > 0) {
    pollTimer = setInterval(() => {
      void sweep(pi);
    }, POLL_MS);
    pollTimer.unref?.();
  }
}
