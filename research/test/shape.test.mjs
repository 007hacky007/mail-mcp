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
