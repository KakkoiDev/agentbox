import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnJob, listJobs, cancelJob, stateDir, isValidLabel, isAlive } from "../lib/jobs.js";

function makeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-rewake-test-"));
  process.env.PI_ASYNC_REWAKE_DIR = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(fn, { timeout = 10_000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return fn();
}

test("label validation", () => {
  assert.ok(isValidLabel("lavish-poll"));
  assert.ok(isValidLabel("a"));
  assert.ok(isValidLabel("a.b_c-1"));
  assert.ok(!isValidLabel("../evil"));
  assert.ok(!isValidLabel("a b"));
  assert.ok(!isValidLabel(""));
  assert.ok(!isValidLabel("x".repeat(65)));
  assert.ok(!isValidLabel("a/b"));
});

test("spawn creates job files and runs detached; done + output captured", async (t) => {
  makeDir(t);
  const job = spawnJob({
    label: "hello",
    cmd: ["/bin/sh", "-c", "echo hello-out; echo hello-err >&2; exit 0"],
    cwd: os.tmpdir(),
  });
  assert.equal(job.label, "hello");
  assert.ok(isAlive(job.pid));

  const dir = stateDir();
  assert.ok(fs.existsSync(path.join(dir, "hello.pid")));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "hello.cmd"), "utf8"));
  assert.deepEqual(meta.cmd, ["/bin/sh", "-c", "echo hello-out; echo hello-err >&2; exit 0"]);

  assert.ok(await waitFor(() => fs.existsSync(path.join(dir, "hello.done"))));
  assert.equal(fs.readFileSync(path.join(dir, "hello.exit"), "utf8").trim(), "0");
  assert.match(fs.readFileSync(path.join(dir, "hello.out"), "utf8"), /hello-out/);
  assert.match(fs.readFileSync(path.join(dir, "hello.err"), "utf8"), /hello-err/);

  const j = listJobs().find((x) => x.label === "hello");
  assert.equal(j.state, "done");
  assert.equal(j.exitCode, 0);
  assert.ok(!j.alive);
});

test("nonzero exit code captured", async (t) => {
  makeDir(t);
  spawnJob({ label: "fail", cmd: ["/bin/sh", "-c", "exit 7"], cwd: os.tmpdir() });
  const dir = stateDir();
  assert.ok(await waitFor(() => fs.existsSync(path.join(dir, "fail.done"))));
  assert.equal(fs.readFileSync(path.join(dir, "fail.exit"), "utf8").trim(), "7");
  const j = listJobs().find((x) => x.label === "fail");
  assert.equal(j.exitCode, 7);
});

test("cancel kills the process group and removes all files", async (t) => {
  makeDir(t);
  const job = spawnJob({ label: "sleeper", cmd: ["/bin/sh", "-c", "sleep 300"], cwd: os.tmpdir() });
  assert.ok(isAlive(job.pid));
  const res = await cancelJob("sleeper");
  assert.equal(res.label, "sleeper");
  assert.equal(res.terminated, true);
  assert.ok(!isAlive(job.pid));
  assert.deepEqual(fs.readdirSync(stateDir()), []);
});

test("duplicate label rejected while a job is running", async (t) => {
  makeDir(t);
  spawnJob({ label: "dup", cmd: ["/bin/sh", "-c", "sleep 300"], cwd: os.tmpdir() });
  assert.throws(
    () => spawnJob({ label: "dup", cmd: ["/bin/sh", "-c", "sleep 300"], cwd: os.tmpdir() }),
    /already running/,
  );
  await cancelJob("dup");
});

test("invalid label and empty command rejected", async () => {
  assert.throws(() => spawnJob({ label: "../evil", cmd: ["true"], cwd: "/tmp" }), /invalid label/);
  assert.throws(() => spawnJob({ label: "ok", cmd: [] }), /empty command/);
  await assert.rejects(cancelJob("../evil"), /invalid label/);
  await assert.rejects(cancelJob("ghost"), /no such job/);
});

test("command not found becomes a done job with exit 127 and a clear error", async (t) => {
  makeDir(t);
  spawnJob({ label: "nope", cmd: ["definitely-not-a-command-xyz"], cwd: os.tmpdir() });
  const dir = stateDir();
  assert.ok(await waitFor(() => fs.existsSync(path.join(dir, "nope.done"))));
  assert.equal(fs.readFileSync(path.join(dir, "nope.exit"), "utf8").trim(), "127");
  assert.match(fs.readFileSync(path.join(dir, "nope.err"), "utf8"), /command not found/);
  const j = listJobs().find((x) => x.label === "nope");
  assert.equal(j.state, "done");
});

test("stale job reported when process dies without completing", async (t) => {
  makeDir(t);
  const job = spawnJob({ label: "zombie", cmd: ["/bin/sh", "-c", "sleep 300"], cwd: os.tmpdir() });
  assert.ok(isAlive(job.pid));
  // Kill the whole process group hard, bypassing the wrapper's completion files.
  process.kill(-job.pid, "SIGKILL");
  assert.ok(await waitFor(() => !isAlive(job.pid)));
  const j = listJobs().find((x) => x.label === "zombie");
  assert.equal(j.state, "stale");
  await cancelJob("zombie");
});
