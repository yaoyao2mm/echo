import assert from "node:assert/strict";
import test from "node:test";
import { postDesktopSessionEvents } from "../src/lib/desktopSessionEvents.js";

test("desktop session event posting queues relay-rejected events for retry", async () => {
  const calls = [];
  const events = [{ type: "turn/completed", raw: { method: "turn/completed" } }];

  const result = await postDesktopSessionEvents({
    sessionId: "session-rejected-events",
    events,
    postEvents: async () => {
      calls.push("post");
      return { ok: false };
    },
    updateLocalState: () => calls.push("local-state"),
    queueRetry: () => calls.push("retry")
  });

  assert.equal(result, null);
  assert.deepEqual(calls, ["local-state", "post", "retry"]);
});

test("desktop session event posting updates local running state before relay network failures", async () => {
  const calls = [];

  await postDesktopSessionEvents({
    sessionId: "session-network-failure",
    events: [{ type: "turn/interrupt", raw: { method: "turn/interrupt" } }],
    postEvents: async () => {
      calls.push("post");
      throw new Error("HTTP 502");
    },
    updateLocalState: () => calls.push("local-state"),
    queueRetry: () => calls.push("retry")
  });

  assert.deepEqual(calls, ["local-state", "post", "retry"]);
});
