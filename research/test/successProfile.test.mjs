import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectSuccessProfile,
  diffSuccessProfile,
  SuccessProfileCollisionError,
} from "../successProfile.mjs";
import { collectOkFlags } from "../failurePaths.mjs";
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

// Fix round 4 (task-5-rereview-3.md section 2, Medium but permanent): two
// array items whose identity values redact to the SAME string collapsed onto
// one key of the flat map, and the map silently kept whichever was written
// last. See research/successProfile.mjs's header for the whole defect and
// for why it is now REFUSED rather than disambiguated.
//
// The two account names below are FICTIONAL and are the re-reviewer's own
// pair: both 5 characters, both ascii, neither email-shaped, so
// research/redact.mjs's generic fallback maps BOTH to the identical
// "<str len=5 chars=ascii>" descriptor. `enabled.ok` on the FIRST account is
// the flag the "later" run regresses.
const collidingAccounts = (firstAccountEnabledOk) => ({
  accounts: [
    {
      name: { ok: true, value: "Work1" },
      enabled: { ok: firstAccountEnabledOk },
      mailboxCount: { ok: true },
    },
    { name: { ok: true, value: "Home2" }, enabled: { ok: true }, mailboxCount: { ok: true } },
  ],
});

// The exact scenario the re-reviewer executed: a "day 0" baseline where both
// colliding accounts are healthy, and a later run where the FIRST account's
// enabled.ok has genuinely flipped to false while still colliding with the
// second. Before this fix, collectSuccessProfile returned 3 entries instead
// of 6 and diffSuccessProfile returned ZERO diffs - permanently, since the
// collision was already in effect when the baseline was recorded. The
// property asserted here is the one that matters: this scenario can no
// longer end in "no differences found", by any route.
test("the colliding-regression scenario fails loudly instead of reporting zero diffs", () => {
  const baseline = redact(collidingAccounts(true));
  const live = redact(collidingAccounts(false));

  // Confirm the collision is real in this fixture (both identities redact to
  // the same descriptor) rather than assuming redact() still behaves that way.
  assert.equal(baseline.accounts[0].name.value, baseline.accounts[1].name.value);
  assert.match(baseline.accounts[0].name.value, /^<str len=5 chars=ascii>$/);

  // Neither side can be turned into a profile at all, so the comparison that
  // used to return [] cannot even be reached.
  assert.throws(() => collectSuccessProfile(baseline), SuccessProfileCollisionError);
  assert.throws(() => collectSuccessProfile(live), SuccessProfileCollisionError);

  // And why refusing at COLLECTION time is the only defense that works: the
  // collapsed 3-entry maps the old code produced are genuinely identical to
  // each other, so no diff-time check could ever have caught this - the
  // regressed account's paths simply are not in either map.
  const collapsedBaseline = {
    "accounts[name=<str len=5 chars=ascii>].name.ok": true,
    "accounts[name=<str len=5 chars=ascii>].enabled.ok": true,
    "accounts[name=<str len=5 chars=ascii>].mailboxCount.ok": true,
  };
  assert.deepEqual(diffSuccessProfile(collapsedBaseline, { ...collapsedBaseline }), []);
});

// A baseline must not be recordable in a silently-broken state either: the
// collision has to be caught even when nothing has regressed yet, which is
// what stops research/record.mjs from writing a recording whose coverage is
// already reduced (record.mjs computes the profile inside its own try and
// refuses to write when it throws).
test("a collision with NO regression present is refused too, so a broken baseline cannot be recorded", () => {
  const healthy = redact(collidingAccounts(true));
  assert.throws(() => collectSuccessProfile(healthy), SuccessProfileCollisionError);
});

// The failure has to be actionable (name what collided) and safe (name it
// without leaking personal data). Identity values reaching this module are
// already redacted - record.mjs and verify.mjs both compute the profile from
// redacted data - so quoting a path is safe, and this asserts it against the
// real redact() rather than trusting that argument in prose.
// node:assert's throws() returns nothing, so the error itself has to be
// captured to assert on its message.
const captureThrow = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected a throw, got none");
};

test("the collision failure names the colliding identity and leaks neither original name", () => {
  const err = captureThrow(() => collectSuccessProfile(redact(collidingAccounts(true))));
  assert.equal(err.name, "SuccessProfileCollisionError");
  assert.match(err.message, /collision/);
  assert.match(err.message, /accounts\[name=<str len=5 chars=ascii>\]/);
  assert.doesNotMatch(err.message, /Work1/);
  assert.doesNotMatch(err.message, /Home2/);
});

// The refusal replaces a disambiguation scheme, so it carries the same
// stability obligation a disambiguated key would have had: the same input
// must always produce the same outcome, not an intermittent one that shows
// up on some runs and not others.
test("the collision refusal is deterministic: identical input refuses identically twice", () => {
  const first = captureThrow(() => collectSuccessProfile(redact(collidingAccounts(true))));
  const second = captureThrow(() => collectSuccessProfile(redact(collidingAccounts(true))));
  assert.equal(first.name, second.name);
  assert.equal(first.message, second.message);
});

// Precision, not just loudness: two items may share an identity and lose
// NOTHING, because neither contributes an ok-style flag. This is not
// hypothetical - research/results/03-mailboxes.json's real data contains two
// sibling mailboxes both literally named "Junk" (section 3 of
// docs/apple-mail/03-object-model.md), and no mailbox entry carries an
// ok-style flag today. Refusing there would block a re-recording for no
// gain, so the check fires on lost COVERAGE, never on a duplicate identity
// by itself.
test("two items sharing an identity but contributing no flags are not refused", () => {
  const profile = collectSuccessProfile({
    fetchOk: true,
    mailboxes: [
      { path: "Junk", messageCount: 12 },
      { path: "Junk", messageCount: 3 },
    ],
  });
  assert.deepEqual(profile, { fetchOk: true });
});

// The re-reviewer's own suggested cross-check, as an invariant: for any
// output with no collision, the number of ok-style flags that EXIST (counted
// by research/failurePaths.mjs's collectOkFlags, which uses no paths at all)
// equals the number of paths the profile holds. collectSuccessProfile
// asserts this internally as a backstop; this pins the invariant itself so a
// future traversal change cannot quietly break it.
test("a collision-free profile holds exactly one path per ok-style flag that exists", () => {
  const data = {
    fetchOk: true,
    accounts: [
      { name: "Account A", enabled: { ok: true }, mailboxCount: { ok: false } },
      { name: "Account B", enabled: { ok: false }, mailboxCount: { ok: true } },
    ],
    props: { id: { ok: true }, source: { ok: false } },
    outlook: true,
  };
  const flags = [];
  collectOkFlags(data, flags);
  assert.equal(flags.length, 7);
  assert.equal(Object.keys(collectSuccessProfile(data)).length, flags.length);
});

// Fix round 4 (task-5-rereview-3.md section 8, Low): the rename merge paired
// ANY disappearing path with ANY appearing path of the same shape and value,
// so two unrelated simultaneous events were reported as one "renamed" - a
// claim of identity continuity the data cannot support. Reproduces the
// re-reviewer's case: one account gone, a DIFFERENT account new, both
// carrying the same flag value, in a list where that value is not
// distinctive at all.
test("an unrelated removal plus addition is reported as two events, NOT as a rename", () => {
  const before = {
    accounts: [
      { name: "Account A", enabledOk: true },
      { name: "Account B", enabledOk: true },
      { name: "Account C", enabledOk: true },
    ],
  };
  const after = {
    accounts: [
      { name: "Account A", enabledOk: true },
      { name: "Account B", enabledOk: true },
      { name: "Account F", enabledOk: true },
    ],
  };
  const diffs = diffSuccessProfile(collectSuccessProfile(before), collectSuccessProfile(after));
  assert.equal(diffs.length, 2);
  assert.ok(!diffs.some((d) => /renamed/.test(d)), `must not claim a rename: ${diffs.join(" | ")}`);
  assert.ok(diffs.some((d) => /name=Account C/.test(d) && /missing/.test(d)));
  assert.ok(diffs.some((d) => /name=Account F/.test(d) && /new in this replay/.test(d)));
});

// The other half of the same rule: when the pairing IS unambiguous - the
// (shape, value) combination occurs exactly once in the recording and
// exactly once in the replay, so nothing else could be the source or the
// target - the rename label is still earned and still reported as one line.
// Here the renamed mailbox's readOk is false while its neighbour's is true,
// so the disappearance and the appearance are each other's only possible
// counterpart.
test("a genuine rename is still labeled a rename when the pairing is unambiguous", () => {
  const before = { mailboxes: [{ path: "Keep", readOk: true }, { path: "Old", readOk: false }] };
  const after = { mailboxes: [{ path: "Keep", readOk: true }, { path: "New", readOk: false }] };
  const diffs = diffSuccessProfile(collectSuccessProfile(before), collectSuccessProfile(after));
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /renamed/);
  assert.match(diffs[0], /path=Old/);
  assert.match(diffs[0], /path=New/);
  assert.doesNotMatch(diffs[0], /path=Keep/);
});
