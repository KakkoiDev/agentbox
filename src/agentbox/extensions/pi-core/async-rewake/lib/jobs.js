/**
 * pi-async-rewake — background job registry.
 *
 * Shared core used by the `pi-async-rewake` CLI. The Pi extension
 * (extension/index.ts) re-implements the small registry protocol
 * self-contained so it never depends on this module's location.
 *
 * Job state lives in a state directory (default `~/.pi-async-rewake/jobs/`,
 * override with PI_ASYNC_REWAKE_DIR). Each job label owns these files:
 *
 *   <label>.pid        process id of the detached wrapper shell
 *   <label>.cmd        JSON { cmd, cwd, startedAt } describing the job
 *   <label>.out        captured stdout (streamed)
 *   <label>.err        captured stderr (streamed)
 *   <label>.exit       numeric exit code, written by the wrapper on exit
 *   <label>.done       touch file, written after <label>.exit — signals completion
 *   <label>.delivered  claim marker: the extension renames .done -> .delivered
 *                      before delivering the result, so delivery is atomic and
 *                      crash-safe (no double delivery, no lost claim racing)
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

/** Labels must be safe path segments. */
export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidLabel(label) {
  return typeof label === "string" && LABEL_RE.test(label);
}

export function stateDir() {
  return process.env.PI_ASYNC_REWAKE_DIR || path.join(os.homedir(), ".pi-async-rewake", "jobs");
}

export function filesFor(label) {
  return {
    pid: `${label}.pid`,
    cmd: `${label}.cmd`,
    out: `${label}.out`,
    err: `${label}.err`,
    exit: `${label}.exit`,
    done: `${label}.done`,
    delivered: `${label}.delivered`,
  };
}

/** True if a pid is alive (or we lack permission to probe). */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * List all jobs with current state.
 * States: "running" (alive, not done), "done" (done or delivered), "stale" (pid
 * gone but never completed — e.g. the whole process group was killed).
 */
export function listJobs() {
  const dir = stateDir();
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of entries) {
    if (!name.endsWith(".pid")) continue;
    const label = name.slice(0, -".pid".length);
    if (!isValidLabel(label)) continue;
    const f = filesFor(label);
    const p = (key) => path.join(dir, f[key]);

    let pid = null;
    try {
      pid = Number(fs.readFileSync(p("pid"), "utf8").trim());
    } catch {
      /* malformed pid file */
    }
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(p("cmd"), "utf8"));
    } catch {
      /* malformed cmd file */
    }
    const hasDone = fs.existsSync(p("done"));
    const hasDelivered = fs.existsSync(p("delivered"));
    const alive = isAlive(pid);

    let exitCode = null;
    try {
      const raw = fs.readFileSync(p("exit"), "utf8").trim();
      if (raw !== "") exitCode = Number(raw);
    } catch {
      /* no exit file yet */
    }

    let outSize = 0;
    let errSize = 0;
    try {
      outSize = fs.statSync(p("out")).size;
    } catch {
      /* no output yet */
    }
    try {
      errSize = fs.statSync(p("err")).size;
    } catch {
      /* no stderr yet */
    }

    let state = "running";
    if (hasDone || hasDelivered) state = "done";
    else if (!alive) state = "stale";

    jobs.push({
      label,
      pid,
      state,
      done: hasDone,
      delivered: hasDelivered,
      alive,
      exitCode,
      cmd: meta?.cmd ?? null,
      cwd: meta?.cwd ?? null,
      startedAt: meta?.startedAt ?? null,
      outSize,
      errSize,
    });
  }
  jobs.sort((a, b) => a.label.localeCompare(b.label));
  return jobs;
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Spawn a background job and return immediately. The job runs detached in its
 * own process group; the CLI never blocks on it.
 *
 * Implementation: `/bin/sh -c '"$@" ; ec=$? ; printf "%s" "$ec" > exit ; touch done'`
 * wraps the real command so completion is recorded atomically (exit code file,
 * then the .done touch file) no matter how the command ends. The wrapper is
 * spawned with stdio redirected to <label>.out / <label>.err, so the job's
 * output streams straight into the state files.
 */
export function spawnJob({ label, cmd, cwd, env = {} }) {
  if (!isValidLabel(label)) {
    throw new Error(`invalid label ${JSON.stringify(label)} (must match ${LABEL_RE})`);
  }
  if (!Array.isArray(cmd) || cmd.length === 0) {
    throw new Error("empty command: nothing to spawn");
  }

  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });

  const running = listJobs().find((j) => j.label === label && j.alive);
  if (running) {
    throw new Error(`job ${JSON.stringify(label)} is already running (pid ${running.pid})`);
  }

  const f = filesFor(label);
  const p = (key) => path.join(dir, f[key]);

  // Fresh start: clear any leftover files from a previous run of this label.
  for (const key of Object.keys(f)) {
    try {
      fs.rmSync(p(key), { force: true });
    } catch {
      /* ignore */
    }
  }

  const outFd = fs.openSync(p("out"), "w");
  const errFd = fs.openSync(p("err"), "w");

  const shellCode = [
    `"$@"`,
    `ec=$?`,
    `printf '%s' "$ec" > ${shQuote(p("exit"))}`,
    `touch ${shQuote(p("done"))}`,
  ].join(" ; ");

  const child = spawn("/bin/sh", ["-c", shellCode, "pi-async-rewake", ...cmd], {
    detached: true,
    cwd,
    stdio: ["ignore", outFd, errFd],
    env: {
      ...process.env,
      ...env,
      PI_ASYNC_REWAKE_JOB_DIR: dir,
      PI_ASYNC_REWAKE_LABEL: label,
    },
  });

  child.on("error", (err) => {
    // Command could not be started at all (e.g. ENOENT). Record a clear
    // failure so the extension can report it instead of a silent no-op.
    try {
      fs.writeFileSync(p("err"), `pi-async-rewake: failed to start command: ${err.message}\n`);
      fs.writeFileSync(p("exit"), "127");
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      fs.writeFileSync(p("done"), "");
    } catch {
      /* best effort */
    }
  });

  // The CLI exits immediately; the job keeps running on its own.
  child.unref();

  fs.writeFileSync(p("pid"), String(child.pid));
  fs.writeFileSync(
    p("cmd"),
    JSON.stringify({ cmd, cwd, startedAt: new Date().toISOString() }),
  );

  return { label, pid: child.pid, dir, startedAt: new Date().toISOString() };
}

/**
 * Terminate a job and remove its state files.
 * Kills the detached process group (SIGTERM, then SIGKILL if it lingers).
 *
 * Async on purpose: the waits yield to the event loop so Node can reap the
 * dying child (a busy wait would leave it a zombie and `kill(pid, 0)` would
 * keep reporting it alive).
 */
export async function cancelJob(label) {
  if (!isValidLabel(label)) {
    throw new Error(`invalid label ${JSON.stringify(label)} (must match ${LABEL_RE})`);
  }
  const dir = stateDir();
  const f = filesFor(label);
  const pidFile = path.join(dir, f.pid);

  if (!fs.existsSync(pidFile)) {
    throw new Error(`no such job ${JSON.stringify(label)}`);
  }

  let pid = null;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    /* pid file unreadable — fall through and clean files anyway */
  }

  const signalGroup = (sig) => {
    if (!Number.isInteger(pid) || pid <= 1) return;
    try {
      process.kill(-pid, sig); // the detached child leads its own process group
    } catch {
      /* ESRCH — group already gone */
    }
    try {
      process.kill(pid, sig);
    } catch {
      /* ESRCH */
    }
  };

  let terminated = true;
  if (pid && Number.isInteger(pid) && pid > 1 && isAlive(pid)) {
    terminated = false;
    signalGroup("SIGTERM");
    let waited = 0;
    while (waited < 1500 && isAlive(pid)) {
      await sleep(50);
      waited += 50;
    }
    if (isAlive(pid)) {
      signalGroup("SIGKILL");
      let waitedHard = 0;
      while (waitedHard < 1000 && isAlive(pid)) {
        await sleep(50);
        waitedHard += 50;
      }
    }
    terminated = !isAlive(pid);
  }

  for (const key of Object.keys(f)) {
    try {
      fs.rmSync(path.join(dir, f[key]), { force: true });
    } catch {
      /* ignore */
    }
  }

  return { label, pid, terminated, dir };
}
