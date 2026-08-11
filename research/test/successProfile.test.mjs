import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSuccessProfile, diffSuccessProfile } from "../successProfile.mjs";
import { redact } from "../redact.mjs";

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

// Fix round 3 (task-5-rereview-2.md, High): the re-reviewer demonstrated
// that keying array items by their raw INDEX fabricates drift the moment
// an item is inserted or removed anywhere but the tail - every later
// item's index shifts, so its flags read as changed even though nothing
// about that item changed. These tests reproduce the re-reviewer's own
// scenarios directly against the real, identity-keyed implementation.

test("inserting an array item at a NON-TAIL position reports no drift for the untouched items", () => {
  const before = {
    mailboxes: [
      { path: "A", readOk: true },
      { path: "B", readOk: false },
      { path: "C", readOk: true },
      { path: "D", readOk: false },
      { path: "E", readOk: true },
    ],
  };
  const afterMidInsert = {
    mailboxes: [
      { path: "A", readOk: true },
      { path: "NEW", readOk: true },
      { path: "B", readOk: false },
      { path: "C", readOk: true },
      { path: "D", readOk: false },
      { path: "E", readOk: true },
    ],
  };
  const diffs = diffSuccessProfile(collectSuccessProfile(before), collectSuccessProfile(afterMidInsert));
  // Exactly one diff - the genuinely new item - and NOT the two fabricated
  // true<->false flips (mailboxes[2]/[3] under the old, index-based scheme)
  // the re-reviewer's fixture produced before this fix.
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /path=NEW/);
  assert.match(diffs[0], /new in this replay/);
});

test("removing a NON-TAIL array item names the removed item correctly, not its neighbours", () => {
  const before = {
    mailboxes: [
      { path: "A", readOk: true },
      { path: "B", readOk: false },
      { path: "C", readOk: true },
      { path: "D", readOk: false },
      { path: "E", readOk: true },
    ],
  };
  const afterMidRemove = {
    mailboxes: [
      { path: "A", readOk: true },
      { path: "C", readOk: true },
      { path: "D", readOk: false },
      { path: "E", readOk: true },
    ],
  };
  const diffs = diffSuccessProfile(collectSuccessProfile(before), collectSuccessProfile(afterMidRemove));
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /path=B/);
  assert.match(diffs[0], /missing/);
  // The re-reviewer's index-based bug would have misattributed this to
  // whichever item now sits at index 1 (path=C) - confirm it does not.
  assert.doesNotMatch(diffs[0], /path=C/);
});

// Reproduces the re-reviewer's real-data test directly, with a self-
// contained fixture matching research/probes/02-accounts.js's actual
// shape (an attempt()-wrapped {ok, value} `name` field on each account,
// per that probe's own real output - see research/results/02-accounts.json)
// rather than reading the live committed recording, so this test does not
// depend on this project's account count or names ever staying the same.
// Removing a middle account must attribute every resulting diff to the
// REMOVED account (by its own identity), not to whichever account the old
// index-based scheme would have shifted into its slot.
test("removing a middle account (02-accounts.js's real {ok,value}-wrapped shape) attributes every diff to the removed account", () => {
  const makeAccount = (pseudonym) => ({
    name: { ok: true, value: pseudonym },
    enabled: { ok: true },
    accountType: { ok: true },
    emailAddresses: { ok: true },
    userName: { ok: true },
    serverName: { ok: true },
    mailboxCount: { ok: true },
  });
  const before = {
    accounts: [
      makeAccount("Account A"),
      makeAccount("Account B"),
      makeAccount("Account C"),
      makeAccount("Account D"),
      makeAccount("Account E"),
    ],
  };
  const after = JSON.parse(JSON.stringify(before));
  const removed = after.accounts.splice(2, 1)[0];
  assert.equal(removed.name.value, "Account C");

  const diffs = diffSuccessProfile(collectSuccessProfile(before), collectSuccessProfile(after));
  assert.equal(diffs.length, 7); // 7 ok-style fields per account object
  for (const d of diffs) {
    assert.match(d, /name=Account C\]/);
    assert.match(d, /missing/);
  }
  // The old index-based scheme would have misattributed these to
  // whichever account now sits at index 2 (Account D) - confirm it does
  // not.
  assert.ok(!diffs.some((d) => /name=Account D\]/.test(d)));
});

test("the tail-append case (already worked) stays clean after the identity-keying fix", () => {
  const before = { mailboxes: [{ path: "A", readOk: true }, { path: "B", readOk: false }] };
  const afterAppend = {
    mailboxes: [{ path: "A", readOk: true }, { path: "B", readOk: false }, { path: "C", readOk: true }],
  };
  const diffs = diffSuccessProfile(collectSuccessProfile(before), collectSuccessProfile(afterAppend));
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /path=C/);
  assert.match(diffs[0], /new in this replay/);
});

// The identity fix creates a case worth handling on its own: a renamed
// item's identity-keyed path changes, so its flag looks like one path
// disappearing and another appearing. Honest (a rename IS a change worth
// reporting) but must read as a rename, not a bare, alarming "missing".
test("renaming an item (same value) produces a comprehensible rename, not a bare missing", () => {
  const before = { mailboxes: [{ path: "Old Name", readOk: true }] };
  const afterRename = { mailboxes: [{ path: "New Name", readOk: true }] };
  const diffs = diffSuccessProfile(collectSuccessProfile(before), collectSuccessProfile(afterRename));
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /renamed/);
  assert.match(diffs[0], /path=Old Name/);
  assert.match(diffs[0], /path=New Name/);
  assert.doesNotMatch(diffs[0], /^\S+: recorded as .*missing/); // not a bare "missing" line
});

// A rename that ALSO changes the value must not be papered over as a
// clean rename - reported as a plain missing + new pair instead, since
// guessing "renamed AND regressed" would hide the regression.
test("renaming an item AND changing its value is reported as separate missing/new lines, not merged into one rename", () => {
  const before = { mailboxes: [{ path: "Old Name", readOk: true }] };
  const afterRenameAndBreak = { mailboxes: [{ path: "New Name", readOk: false }] };
  const diffs = diffSuccessProfile(
    collectSuccessProfile(before),
    collectSuccessProfile(afterRenameAndBreak)
  );
  assert.equal(diffs.length, 2);
  assert.ok(diffs.some((d) => /path=Old Name/.test(d) && /missing/.test(d)));
  assert.ok(diffs.some((d) => /path=New Name/.test(d) && /new in this replay/.test(d)));
  assert.ok(!diffs.some((d) => /renamed/.test(d)));
});

// Fix round 3 (second, smaller finding): a boolean field merely NAMED like
// a success flag (ends in lowercase "ok" with no case transition) must not
// be swept in.
test("a boolean field named 'outlook' is NOT collected as a success flag", () => {
  const profile = collectSuccessProfile({ outlook: true, fetchOk: true, readOk: false });
  assert.deepEqual(profile, { fetchOk: true, readOk: false });
});

// Identity-keyed paths must never leak personal data: collectSuccessProfile
// itself does no redaction (it is not its job - see the module header
// comment), so it embeds whatever string the caller hands it verbatim. The
// actual privacy guarantee comes from research/record.mjs and
// research/verify.mjs both calling it ONLY on already-redacted data -
// proven here directly with the real redact() function, not asserted in
// prose.
test("identity-keyed paths use pseudonyms, not personal data, when fed already-redacted data", () => {
  const fictionalRealName = "Fictional Real Company Name Inc";
  const rawData = { accounts: [{ name: fictionalRealName, ok: true }] };
  const redacted = redact(rawData);
  // Confirm redact() actually changed it (it is not already a pseudonym-
  // shaped string) before trusting the profile built from it.
  assert.notEqual(redacted.accounts[0].name, fictionalRealName);
  const profile = collectSuccessProfile(redacted);
  const [path] = Object.keys(profile);
  assert.doesNotMatch(path, new RegExp(fictionalRealName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// Confirms the other half of the coordinator's ask: redact()'s pseudonym
// assignment is deterministic, not random or process-state-dependent, so
// the SAME real input always produces the SAME pseudonym - a profile keyed
// on an unstable pseudonym would be worse than one keyed on an index.
test("redact() assigns the SAME pseudonym to the SAME real input across independent calls", () => {
  const fictionalRealName = "Another Fictional Company Ltd";
  const data = { accounts: [{ name: fictionalRealName, ok: true }] };
  const first = redact(JSON.parse(JSON.stringify(data))).accounts[0].name;
  const second = redact(JSON.parse(JSON.stringify(data))).accounts[0].name;
  assert.equal(first, second);
});

test("an array item with none of path/name/probe as a usable string falls back to the numeric index", () => {
  const profile = collectSuccessProfile({ items: [{ x: 1, ok: true }, { x: 2, ok: false }] });
  assert.deepEqual(profile, { "items[0].ok": true, "items[1].ok": false });
});

// research/probes/02-accounts.js's real shape: `name` is itself
// attempt()-wrapped ({ok, value}), so its OWN `ok` field is a genuine,
// separate success flag (did reading `name` succeed) IN ADDITION to being
// the source of the item's identity value - both are collected, keyed by
// that same identity.
test("an item whose identity field is wrapped in this project's {ok,value} convention is still keyed by the wrapped value", () => {
  const profile = collectSuccessProfile({
    accounts: [{ name: { ok: true, value: "Account A" }, enabled: { ok: true } }],
  });
  assert.deepEqual(profile, {
    "accounts[name=Account A].name.ok": true,
    "accounts[name=Account A].enabled.ok": true,
  });
});
