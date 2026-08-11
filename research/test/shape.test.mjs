import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeOf, diffShapes } from "../shape.mjs";

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
