import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSuccessProfile, diffSuccessProfile } from "../successProfile.mjs";

// Fix round 2 (task-5-rereview.md, Fix C): unit coverage for the success-
// profile mechanism added in Fix A - zero osascript calls, fixtures only,
// so this stays in `npm test`.

test("collectSuccessProfile finds a top-level ok-style flag", () => {
  const profile = collectSuccessProfile({ fetchOk: true, messageCount: 5 });
  assert.deepEqual(profile, { fetchOk: true });
});

test("collectSuccessProfile finds a nested ok flag and builds a dotted path", () => {
  const profile = collectSuccessProfile({ props: { id: { ok: true, seconds: 0.1 } } });
  assert.deepEqual(profile, { "props.id.ok": true });
});

test("collectSuccessProfile builds a bracketed path through an array", () => {
  const profile = collectSuccessProfile({
    accounts: [{ enabled: { ok: true } }, { enabled: { ok: false } }],
  });
  assert.deepEqual(profile, {
    "accounts[0].enabled.ok": true,
    "accounts[1].enabled.ok": false,
  });
});

test("collectSuccessProfile ignores a boolean field whose key does not end in ok/Ok", () => {
  const profile = collectSuccessProfile({ mailReachable: true, isFlagged: false });
  assert.deepEqual(profile, {});
});

test("collectSuccessProfile recognizes the *Ok suffix case-insensitively", () => {
  const profile = collectSuccessProfile({ fetchOk: true, allMailOk: false });
  assert.deepEqual(profile, { fetchOk: true, allMailOk: false });
});

test("diffSuccessProfile is empty for two identical profiles", () => {
  assert.deepEqual(diffSuccessProfile({ "props.id.ok": true }, { "props.id.ok": true }), []);
});

test("diffSuccessProfile is empty for two empty profiles (a probe with no ok-style fields at all)", () => {
  assert.deepEqual(diffSuccessProfile({}, {}), []);
});

// The exact scenario the shape fingerprint alone cannot see (Fix A's whole
// point): one property silently starts failing while everything else keeps
// working, so the recorded SHAPE is unchanged (ok:true and ok:false are
// both typeof "boolean") but the recorded VALUE at that one path is not.
test("diffSuccessProfile catches a single flag flipping true to false", () => {
  const diffs = diffSuccessProfile(
    { "props.id.ok": true, "props.flagIndex.ok": true },
    { "props.id.ok": true, "props.flagIndex.ok": false }
  );
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /props\.flagIndex\.ok/);
  assert.match(diffs[0], /true/);
  assert.match(diffs[0], /false/);
});

// The other direction matters too: a false-to-true flip means the ORIGINAL
// recording captured a transient failure and should itself be re-recorded,
// per the coordinator's explicit instruction - not merely that today's run
// happens to differ.
test("diffSuccessProfile catches a single flag flipping false to true (a recorded transient failure)", () => {
  const diffs = diffSuccessProfile({ "props.id.ok": false }, { "props.id.ok": true });
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /props\.id\.ok/);
  assert.match(diffs[0], /false/);
  assert.match(diffs[0], /true/);
});

test("diffSuccessProfile reports a path present in the recording but missing from the replay", () => {
  const diffs = diffSuccessProfile(
    { "props.id.ok": true, "props.gone.ok": true },
    { "props.id.ok": true }
  );
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /props\.gone\.ok/);
  assert.match(diffs[0], /missing/);
});

test("diffSuccessProfile reports a path present in the replay but absent from the recording", () => {
  const diffs = diffSuccessProfile(
    { "props.id.ok": true },
    { "props.id.ok": true, "props.new.ok": true }
  );
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /props\.new\.ok/);
  assert.match(diffs[0], /new in this replay/);
});

test("diffSuccessProfile reports every differing path, not just the first, when several flip at once", () => {
  const diffs = diffSuccessProfile(
    { "a.ok": true, "b.ok": true, "c.ok": true },
    { "a.ok": false, "b.ok": true, "c.ok": false }
  );
  assert.equal(diffs.length, 2);
  assert.ok(diffs.some((d) => d.includes("a.ok")));
  assert.ok(diffs.some((d) => d.includes("c.ok")));
  assert.ok(!diffs.some((d) => d.includes("b.ok")));
});
