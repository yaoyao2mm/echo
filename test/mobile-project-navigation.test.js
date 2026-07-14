import assert from "node:assert/strict";
import test from "node:test";
import { previewProjectSessions } from "../public/app/sessions.js";

test("mobile project conversation preview renders at most five by default", () => {
  const jobs = Array.from({ length: 8 }, (_, index) => ({ id: `job-${index + 1}` }));

  assert.deepEqual(
    previewProjectSessions(jobs).map((job) => job.id),
    ["job-1", "job-2", "job-3", "job-4", "job-5"]
  );
});

test("mobile project conversation preview preserves active session highlighting within limit", () => {
  const jobs = Array.from({ length: 8 }, (_, index) => ({ id: `job-${index + 1}` }));

  assert.deepEqual(
    previewProjectSessions(jobs, { selectedSessionId: "job-8" }).map((job) => job.id),
    ["job-1", "job-2", "job-3", "job-4", "job-8"]
  );
});

test("mobile project conversation expansion returns full list", () => {
  const jobs = Array.from({ length: 8 }, (_, index) => ({ id: `job-${index + 1}` }));

  assert.equal(previewProjectSessions(jobs, { expanded: true }).length, 8);
});
