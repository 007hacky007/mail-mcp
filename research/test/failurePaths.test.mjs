import { test } from "node:test";
import assert from "node:assert/strict";
import { replayReachedOnlyFailurePaths } from "../failurePaths.mjs";

// Fix round 2 (task-5-rereview.md, Fix C): unit coverage for the
// fix-round-1 all-or-nothing detector - zero osascript calls, fixtures
// only, so this stays in `npm test`. Re-review's own synthetic-scenario
// table (task-5-rereview.md section 2) is reproduced here as assertions.

test("all flags false is flagged as an all-failure replay", () => {
  assert.equal(replayReachedOnlyFailurePaths({ a: { ok: false }, b: { ok: false } }), true);
});

test("all flags true is NOT flagged", () => {
  assert.equal(replayReachedOnlyFailurePaths({ a: { ok: true }, b: { ok: true } }), false);
});

// Documented, intentional scope (task-5-rereview.md finding 4, confirmed
// correct by the coordinator): a genuine MIX of true/false is not flagged
// by this check - it exists only to catch TOTAL resolution failure, not
// partial, expected per-property unavailability. A single property's
// status changing relative to what was recorded is research/successProfile.mjs's
// job, a deliberately separate and finer-grained signal (Fix A).
test("a mix of true and false is NOT flagged (documented, intentional scope)", () => {
  assert.equal(replayReachedOnlyFailurePaths({ a: { ok: true }, b: { ok: false } }), false);
});

// A future macOS/Mail.app update making exactly ONE property permanently
// fail (e.g. flagIndex) while the other 16 keep succeeding is exactly this
// case - correctly NOT caught here, and correctly caught by the success
// profile diff instead (which has the recorded baseline to compare
// against).
test("16 true / 1 false is NOT flagged - this is the drift the success profile catches instead", () => {
  const data = { props: {} };
  for (let i = 0; i < 16; i++) data.props[`p${i}`] = { ok: true };
  data.props.flagIndex = { ok: false };
  assert.equal(replayReachedOnlyFailurePaths(data), false);
});

test("no ok-style field anywhere is NOT flagged (nothing to check)", () => {
  assert.equal(replayReachedOnlyFailurePaths({ messageCount: 5, name: "x" }), false);
});

test("an empty object is NOT flagged", () => {
  assert.equal(replayReachedOnlyFailurePaths({}), false);
});

test("the fetchOk convention is recognized the same as the ok convention", () => {
  assert.equal(replayReachedOnlyFailurePaths({ fetchOk: false }), true);
  assert.equal(replayReachedOnlyFailurePaths({ fetchOk: true }), false);
});

test("a boolean field not ending in ok/Ok is not treated as a success flag", () => {
  assert.equal(replayReachedOnlyFailurePaths({ mailReachable: false, isFlagged: false }), false);
});

test("flags nested through an array are all collected", () => {
  assert.equal(
    replayReachedOnlyFailurePaths({ accounts: [{ ok: false }, { ok: false }] }),
    true
  );
});
