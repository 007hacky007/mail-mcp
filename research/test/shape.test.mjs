import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeOf, diffShapes } from "../shape.mjs";
import { redact } from "../redact.mjs";

test("fingerprints primitives by type, not value", () => {
  assert.equal(shapeOf("anything"), shapeOf("else"));
  assert.equal(shapeOf(1), shapeOf(99999));
  assert.notEqual(shapeOf(1), shapeOf("1"));
});

test("fingerprints an object by its sorted key set and value types", () => {
  assert.equal(shapeOf({ a: 1, b: "x" }), shapeOf({ b: "y", a: 2 }));
  assert.notEqual(shapeOf({ a: 1 }), shapeOf({ a: 1, b: 2 }));
});

test("fingerprints an array by its element shape, not its length", () => {
  assert.equal(shapeOf([1, 2, 3]), shapeOf([9]));
  assert.notEqual(shapeOf([1]), shapeOf(["1"]));
});

test("an empty array is distinguishable from a populated one", () => {
  assert.notEqual(shapeOf([]), shapeOf([1]));
});

test("reports an added key as a difference", () => {
  const diffs = diffShapes(shapeOf({ a: 1 }), shapeOf({ a: 1, b: 2 }));
  assert.equal(diffs.length > 0, true);
  assert.match(diffs.join(" "), /b/);
});

test("reports no differences for identical shapes", () => {
  assert.deepEqual(diffShapes(shapeOf({ a: [1] }), shapeOf({ a: [7] })), []);
});

// --- Fix round 1 (see task-3-review.md finding 1): diffShapes rewritten to
// parse the fingerprint grammar and diff the parsed trees structurally,
// reporting each difference as a path, instead of extracting keys with a
// nesting-agnostic regex. Cases below are the ones the review confirmed the
// old version collapsed into a generic "shape changed: expected/actual"
// full-string dump; several use the review's own executed examples. -------

test("[fix round 1] a key moving to a different nesting level reports a precise type-changed line at each path, not a flat add/remove", () => {
  // Review's exact example (section 3): {a:number,b:{c:string}} vs
  // {a:{c:string},b:number}. Both sides have the flat key set {a,b,c}, so a
  // regex-based "which keys are missing/added" answer has nothing to say -
  // but each of "a" and "b" individually did change type, and this must
  // name both, at their own path, not just report "added"/"missing" with
  // no location.
  const expected = shapeOf({ a: 1, b: { c: "x" } });
  const actual = shapeOf({ a: { c: "x" }, b: 1 });
  const diffs = diffShapes(expected, actual);
  assert.deepEqual(
    [...diffs].sort(),
    ["a: type changed number -> object", "b: type changed object -> number"]
  );
});

test("[fix round 1] a union-branch correlation change names the branches removed and added, not an opaque leaf", () => {
  // Review's exact example (section 3): [{a:number,b:string}] (a always
  // co-occurs with b) vs [{a:number}|{b:string}] (now mutually exclusive).
  // The "|" must not be invisible to the diff, and the result must not be
  // the generic dump.
  const expected = shapeOf([{ a: 1, b: "x" }]);
  const actual = shapeOf([{ a: 1 }, { b: "x" }]);
  const diffs = diffShapes(expected, actual);
  assert.ok(diffs.every((d) => !d.startsWith("shape changed")), diffs.join("\n"));
  assert.ok(diffs.some((d) => d.includes("union branch removed") && d.includes("{a:number,b:string}")));
  assert.ok(diffs.some((d) => d.includes("union branch added") && d.includes("{a:number}")));
  assert.ok(diffs.some((d) => d.includes("union branch added") && d.includes("{b:string}")));
});

test("[fix round 1] a same-key leaf-type-only change is reported as a type change at that path, not a full-string dump", () => {
  // Review's exact example (section 3): {a:number} vs {a:string} - the key
  // set never changes, only the leaf type at "a".
  const diffs = diffShapes(shapeOf({ a: 1 }), shapeOf({ a: "x" }));
  assert.deepEqual(diffs, ["a: type changed number -> string"]);
});

test("[fix round 1] an array going from empty to populated is reported by path, not as a generic dump", () => {
  const diffs = diffShapes(shapeOf({ messages: [] }), shapeOf({ messages: [{ id: 1 }] }));
  assert.deepEqual(diffs, ["messages: was [] , now [{id:number}]"]);
});

test("[fix round 1] an object going from empty to populated is reported as its keys being added, at the nested path", () => {
  // Objects need no special-case emptiness branch the way arrays do: an
  // object's keys are directly comparable whether there are zero of them or
  // many, so the ordinary added/missing-key logic already pinpoints exactly
  // what appeared.
  const diffs = diffShapes(shapeOf({ meta: {} }), shapeOf({ meta: { a: 1 } }));
  assert.deepEqual(diffs, ["meta.a: added (number)"]);
});

test("[fix round 1] a difference three levels deep, through an array, reports the full dotted/bracketed path", () => {
  const expected = shapeOf({ accounts: [{ mailboxes: [{ unreadCount: 1 }] }] });
  const actual = shapeOf({ accounts: [{ mailboxes: [{}] }] });
  const diffs = diffShapes(expected, actual);
  assert.deepEqual(diffs, ["accounts[].mailboxes[].unreadCount: missing (was number)"]);
});

test("[fix round 1] a fingerprint the parser cannot parse falls back to a raw comparison, and says so", () => {
  const expected = "{a:number";
  const actual = "not-a-shape-at-all|{";
  const diffs = diffShapes(expected, actual);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /could not be parsed structurally/i);
  assert.match(diffs[0], /expected \{a:number/);
  assert.match(diffs[0], /actual\s+not-a-shape-at-all/);
});

// --- Fix round 2 (see task-3-rereview.md): two fixes ordered by the
// coordinator after that re-review. Fix 1 (Critical, privacy) is in
// research/record.mjs and research/verify.mjs, not this file - they now
// fingerprint the REDACTED value instead of the raw one, because a
// fingerprint contains key names verbatim and is committed. The invariant
// that makes that change free - shapeOf(redact(x)) === shapeOf(x) for any
// realistic probe output, because redaction only ever changes VALUES and
// (when a key is itself data-shaped) key TEXT, never a value's underlying
// JS kind or an object's key SET when every key is already a plain
// structural identifier - is asserted here so a future redactor change that
// broke fingerprint stability would fail loudly in this file, not be
// discovered later as a mysterious spurious verify.mjs mismatch. Fix 2
// (Important) hardens shape.mjs's own parser and is tested directly below.

test("[fix round 2 / Fix 1] shapeOf(redact(x)) equals shapeOf(x) for a realistic nested probe-shaped fixture", () => {
  // Every key here is a real structural field name (research/redact.mjs's
  // STRUCTURAL_KEY_NAMES), matching how an actual probe emits data - only
  // values are data-shaped. Deliberately includes an email address, mailbox
  // names, a folder path, a subject-bearing "sample" leaf, a null, a Date,
  // and a "|"-union-producing pair of differently-shaped array elements, so
  // the invariant is demonstrated across every kind of transformation
  // redact() performs, not just fields it leaves untouched. Fictional data
  // only - never the human partner's real gmail.com/realdomain1.com/realdomain2.eu
  // domains or any real name.
  const fixture = {
    accountName: "Fictional Acme Corp",
    enabled: true,
    mailboxCount: 3,
    mailboxes: [
      {
        name: "Thornlands-Fictional",
        path: "Work/Thornlands-Fictional/2026",
        unreadCount: 2,
        messageCount: 10,
        children: [{ name: "Nested-Fictional" }],
      },
      { name: "INBOX", unreadCount: 0, messageCount: 100 },
    ],
    props: { subject: { sample: "Q3 budget review - fictional" }, sender: null },
    dateReceived: new Date("2026-01-01T00:00:00Z"),
    replyTo: "fictional.person@example.net",
  };

  const rawShape = shapeOf(fixture);
  const redactedShape = shapeOf(redact(fixture));
  assert.equal(redactedShape, rawShape);
  // Sanity check that this is actually exercising redaction, not comparing
  // two untouched copies - the redacted VALUES must differ from the raw ones
  // even though the shape does not.
  const redacted = redact(fixture);
  assert.notEqual(redacted.accountName, fixture.accountName);
  assert.notEqual(redacted.replyTo, fixture.replyTo);
  assert.notEqual(redacted.mailboxes[0].name, fixture.mailboxes[0].name);
});

test("[fix round 2 / Fix 2] a key containing both ':' and ',' (INBOX:Sent,Old) never fabricates a bare 'Old' entry", () => {
  // The re-review's exact minimal repro (task-3-rereview.md section 2c):
  // parseKey used to stop at the key's own embedded ':', misreading the
  // rest of the real key text as a second, fabricated sibling entry named
  // "Old" - a key that does not exist in either object - producing a
  // confident but wrong diff instead of the declared fallback.
  const expected = shapeOf({ "INBOX:Sent,Old": 1 });
  const actual = shapeOf({ "INBOX:Sent,Old": "archived" });
  assert.equal(expected, "{INBOX:Sent,Old:number}");
  assert.equal(actual, "{INBOX:Sent,Old:string}");

  const diffs = diffShapes(expected, actual);
  // Never the fabricated line the re-review found.
  assert.ok(
    !diffs.some((d) => d.startsWith("Old:")),
    `must not fabricate a bare "Old" entry, got: ${diffs.join("\n")}`
  );
  // Acceptable outcomes per the dispatch: either a correct diff naming the
  // real key, or the declared fallback (which embeds both raw fingerprints
  // verbatim, so the real key is still visible in the message even though
  // it is not parsed out as a structured path).
  const namesRealKey = diffs.some((d) => d.includes("INBOX:Sent,Old"));
  const isDeclaredFallback = diffs.length === 1 && /could not be parsed structurally/i.test(diffs[0]);
  assert.ok(
    namesRealKey || isDeclaredFallback,
    `expected either the real key named or the declared fallback, got: ${diffs.join("\n")}`
  );
});
