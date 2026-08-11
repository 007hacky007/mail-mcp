// A structural fingerprint: types and key sets, never values. Two recordings of
// the same probe on different machines must produce the same fingerprint, so a
// difference means the object model changed, not that the mailbox differs.
export function shapeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    // Union the element shapes so a heterogeneous array is not reduced to its
    // first element, which would hide a property appearing on only some items.
    const inner = [...new Set(value.map(shapeOf))].sort().join("|");
    return `[${inner}]`;
  }
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${k}:${shapeOf(value[k])}`);
    return `{${entries.join(",")}}`;
  }
  return typeof value;
}

// --- diffShapes: a small parser for the fingerprint grammar shapeOf
// produces above, plus a structural (not textual) diff over the parsed
// trees. Fix round 1 (see task-3-review.md finding 1): the original
// implementation extracted keys with a nesting-agnostic regex, so a key
// that moved to a different nesting level, a "|" union whose branches
// changed, or a same-key leaf-type-only change all collapsed into the same
// generic "shape changed: expected/actual" full-string dump. verify.mjs
// still FAILed correctly in every case (diffShapes always returns a
// non-empty array when expected !== actual), but the message gave no
// indication of *what* changed - fine for two tiny probes, unusable once
// probes cover dozens of keys and deep nesting (Tasks 5+). This version
// parses both fingerprints back into trees and reports each difference as
// a dotted/bracketed PATH plus what kind of difference it is, so a reader
// can act on the message without ever looking at the raw fingerprint text.
//
// Grammar shapeOf always emits (and this parser accepts, nothing more):
//   shape  := object | array | word
//   object := "{" [ key ":" shape ("," key ":" shape)* ] "}"
//   array  := "[]" | "[" shape ("|" shape)* "]"
//   word   := a run of characters containing none of , { } [ ] | :
//             (a typeof result such as "number"/"string"/"boolean", or the
//             literal "null")
// Keys and words are opaque runs of text to the parser - it only needs to
// know where the structural delimiters are, never what alphabet a probe
// author used for a key.

class ShapeParseError extends Error {}

function parseShapeTree(s) {
  let i = 0;

  const fail = (msg) => {
    throw new ShapeParseError(`${msg} (at index ${i} of "${s}")`);
  };

  const parseNode = () => {
    if (i >= s.length) fail("unexpected end of input");
    if (s[i] === "{") return parseObject();
    if (s[i] === "[") return parseArray();
    return parseWord();
  };

  const parseKey = () => {
    const start = i;
    while (i < s.length && s[i] !== ":") i++;
    if (i >= s.length) fail("unterminated key, no ':' found");
    if (i === start) fail("empty key");
    return s.slice(start, i);
  };

  const parseObject = () => {
    i++; // consume "{"
    const entries = [];
    if (s[i] === "}") {
      i++;
      return { kind: "object", entries };
    }
    for (;;) {
      const key = parseKey();
      i++; // consume ":"
      const value = parseNode();
      entries.push([key, value]);
      if (s[i] === ",") {
        i++;
        continue;
      }
      if (s[i] === "}") {
        i++;
        break;
      }
      fail(`expected ',' or '}' after key "${key}"`);
    }
    return { kind: "object", entries };
  };

  const parseArray = () => {
    i++; // consume "["
    if (s[i] === "]") {
      i++;
      return { kind: "array", members: [] };
    }
    const members = [];
    for (;;) {
      members.push(parseNode());
      if (s[i] === "|") {
        i++;
        continue;
      }
      if (s[i] === "]") {
        i++;
        break;
      }
      fail("expected '|' or ']' in array");
    }
    return { kind: "array", members };
  };

  const parseWord = () => {
    const start = i;
    while (i < s.length && !",{}[]|:".includes(s[i])) i++;
    if (i === start) fail(`unexpected character '${s[i]}'`);
    return { kind: "leaf", word: s.slice(start, i) };
  };

  const tree = parseNode();
  if (i !== s.length) fail("trailing characters after a complete shape");
  return tree;
}

// Re-renders a parsed tree back to shapeOf's own canonical text. The parser
// never reorders anything (object keys and array-union members are already
// sorted in whatever string produced the tree, since shapeOf sorts them
// before joining), so render(parseShapeTree(s)) reproduces s exactly. Used
// to name a whole missing/added subtree, or one differing union branch, in
// a diff message without inventing a second string format for it.
function render(node) {
  if (node.kind === "leaf") return node.word;
  if (node.kind === "object") {
    return `{${node.entries.map(([k, v]) => `${k}:${render(v)}`).join(",")}}`;
  }
  if (node.members.length === 0) return "[]";
  return `[${node.members.map(render).join("|")}]`;
}

const describeKind = (node) => (node.kind === "leaf" ? node.word : node.kind);

// Renders a path as "a.b[].c" - a plain object-key access appends ".key"
// (no leading dot for the very first segment); descending into an array's
// elements appends "[]" directly onto the field it belongs to, matching how
// the coordinator's own worked examples read ("accounts[].mailboxes[]...").
const describePath = (path) => {
  let out = "";
  for (const seg of path) {
    out += seg === "[]" ? "[]" : out ? `.${seg}` : seg;
  }
  return out || "(root)";
};

// Diffs two array member lists (the distinct element shapes shapeOf unions
// together; the caller has already ruled out either side being "[]").
// Members that render to identical text need no comment - they are the
// same branch, present on both sides. Exactly one leftover member on each
// side is by far the common case: a plain, non-union array whose single
// element shape changed - so that pair is diffed directly for a precise,
// nested answer (e.g. a type change several levels down) instead of being
// reported as a branch swap. Anything less clean-cut (a real union gaining,
// losing, or splitting branches) is reported branch by branch, by its
// rendered shape, so a "|" union is never collapsed into an opaque leaf.
function diffArrayMembers(aMembers, bMembers, path) {
  const aStrs = aMembers.map(render);
  const bStrs = bMembers.map(render);
  const bTaken = new Set();
  const aLeftover = [];
  for (let ai = 0; ai < aMembers.length; ai++) {
    const bi = bStrs.findIndex((str, idx) => str === aStrs[ai] && !bTaken.has(idx));
    if (bi === -1) aLeftover.push(ai);
    else bTaken.add(bi);
  }
  const bLeftover = bMembers.map((_, idx) => idx).filter((idx) => !bTaken.has(idx));

  if (aLeftover.length === 0 && bLeftover.length === 0) return [];

  if (aLeftover.length === 1 && bLeftover.length === 1) {
    return diffTrees(aMembers[aLeftover[0]], bMembers[bLeftover[0]], [...path, "[]"]);
  }

  const diffs = [];
  const arrayPath = describePath([...path, "[]"]);
  for (const idx of aLeftover) diffs.push(`${arrayPath}: union branch removed (${aStrs[idx]})`);
  for (const idx of bLeftover) diffs.push(`${arrayPath}: union branch added (${bStrs[idx]})`);
  return diffs;
}

function diffTrees(a, b, path) {
  if (a.kind !== b.kind) {
    return [`${describePath(path)}: type changed ${describeKind(a)} -> ${describeKind(b)}`];
  }

  if (a.kind === "leaf") {
    return a.word === b.word ? [] : [`${describePath(path)}: type changed ${a.word} -> ${b.word}`];
  }

  if (a.kind === "object") {
    const aMap = new Map(a.entries);
    const bMap = new Map(b.entries);
    const diffs = [];
    for (const [k, v] of aMap) {
      if (!bMap.has(k)) diffs.push(`${describePath([...path, k])}: missing (was ${render(v)})`);
    }
    for (const [k, v] of bMap) {
      if (!aMap.has(k)) diffs.push(`${describePath([...path, k])}: added (${render(v)})`);
    }
    for (const [k, v] of aMap) {
      if (bMap.has(k)) diffs.push(...diffTrees(v, bMap.get(k), [...path, k]));
    }
    return diffs;
  }

  // a.kind === "array"
  const aEmpty = a.members.length === 0;
  const bEmpty = b.members.length === 0;
  if (aEmpty !== bEmpty) {
    return [`${describePath(path)}: was ${aEmpty ? "[]" : render(a)} , now ${bEmpty ? "[]" : render(b)}`];
  }
  if (aEmpty) return []; // both "[]" - expected === actual already short-circuits this, kept for safety

  return diffArrayMembers(a.members, b.members, path);
}

export function diffShapes(expected, actual) {
  if (expected === actual) return [];

  let expectedTree, actualTree;
  try {
    expectedTree = parseShapeTree(expected);
    actualTree = parseShapeTree(actual);
  } catch (err) {
    // Last resort only: a fingerprint this parser cannot parse (it should
    // never see one shapeOf did not produce, but a future grammar change or
    // a hand-edited recording could feed it one). Fall back to a full
    // textual dump - but say plainly that structural diagnosis was not
    // possible, rather than silently presenting the dump as if it were a
    // targeted diff.
    return [
      `shape changed, but could not be parsed structurally (${err.message}) - ` +
        `falling back to a raw comparison:\n  expected ${expected}\n  actual   ${actual}`,
    ];
  }

  const diffs = diffTrees(expectedTree, actualTree, []);
  // Belt and suspenders: expected !== actual guarantees a real structural
  // difference exists (shapeOf is a canonical, order-stable encoding of the
  // tree, so two different strings can never decode to the same tree), so
  // diffTrees should never come back empty here. If it somehow did, fall
  // back rather than ever reporting "no differences" for two fingerprints
  // already known not to match - verify.mjs treats an empty array as a
  // pass, and that must never happen for a real drift.
  if (diffs.length === 0) {
    return [`shape changed (no specific difference found):\n  expected ${expected}\n  actual   ${actual}`];
  }
  return diffs;
}
