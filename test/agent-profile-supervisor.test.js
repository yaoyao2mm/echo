import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createAgentProfileSupervisor,
  profileWorkerRestartDelayMs
} from "../src/lib/agentProfileSupervisor.js";

function fakeChild() {
  const child = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal) => child.killCalls.push(signal);
  return child;
}

test("profile supervisor quickly replaces a worker after checkpointed exit 75", () => {
  const children = [];
  const timers = [];
  const exits = [];
  const supervisor = createAgentProfileSupervisor({
    profiles: [{ agentId: "primary" }],
    spawnWorker: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    schedule: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return { unref() {} };
    },
    onWorkerExit: (event) => exits.push(event)
  });

  supervisor.start();
  children[0].emit("exit", 75, null);

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 500);
  assert.equal(exits[0].gracefulRestart, true);
  assert.equal(exits[0].delayMs, 500);
  timers[0].callback();
  assert.equal(children.length, 2);
});

test("profile supervisor keeps crash backoff and does not respawn while stopping", () => {
  const children = [];
  const timers = [];
  const supervisor = createAgentProfileSupervisor({
    profiles: [{ agentId: "primary" }],
    spawnWorker: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    schedule: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return { unref() {} };
    }
  });

  supervisor.start();
  children[0].emit("exit", 1, null);
  assert.equal(timers[0].delayMs, 2000);
  supervisor.stop("SIGTERM");
  timers[0].callback();
  assert.equal(children.length, 1);
});

test("profile restart delay distinguishes graceful restart from crashes", () => {
  assert.equal(profileWorkerRestartDelayMs(75), 500);
  assert.equal(profileWorkerRestartDelayMs(0), 2000);
  assert.equal(profileWorkerRestartDelayMs(1), 2000);
});
