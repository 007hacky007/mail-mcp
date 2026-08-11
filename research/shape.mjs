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
    // Fix round 3 (task-3-rereview-2.md): keys are emitted as JSON string
    // literals (JSON.stringify), never as bare tokens. See the parser
    // comment below for why - this is what makes an object key containing
    // any grammar character (":", ",", "{", "}", "[", "]", "|", a quote, or
    // a backslash) parse with exactly one reading instead of being guessed
    // at.
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${shapeOf(value[k])}`);
    return `{${entries.join(",")}}`;
  }
  return typeof value;
}

// --- diffShapes: a small parser for the fingerprint grammar shapeOf
// produces above, plus a structural (not textual) diff over the parsed
// trees.
//
// History: fix round 1 (task-3-review.md finding 1) replaced a
// nesting-agnostic regex with this parser so differences could be reported
// by path instead of a full-string dump. Fix round 2 (task-3-rereview.md
// section 2c) found that an UNQUOTED object key containing a ":" followed
// later by a "," (e.g. a real key "INBOX:Sent,Old") could misparse: the
// key's own embedded ":" looked exactly like the key/value delimiter, so
// the rest of the key text was misread as a fabricated second entry. That
// round's fix (LEAF_WORDS, a closed vocabulary for value words) narrowed
// the window but did not close it - task-3-rereview-2.md reproduced the
// same fabrication end to end through the real redact() pipeline (an email
// address survives partial redaction with trailing ":word,word" text
// intact) whenever the misread residual happened to equal one of the
// reserved words.
//
// Fix round 3 (this version) closes the ambiguity at the source instead of
// guessing at parse time: object keys are now emitted as JSON string
// literals (see shapeOf above), so a key can contain any character at all -
// including every grammar-special character - and still have exactly one
// parse, because the parser knows precisely where a quoted key starts and
// ends (tracking backslash escapes) rather than scanning for the first
// unescaped ":". LEAF_WORDS is gone: it existed only to patch over the
// unquoted-key ambiguity, and with keys unambiguous, a value position can
// never accidentally be a stray fragment of a misread key, so a plain "any
// non-delimiter run is a word" reading is safe again.
//
// Grammar shapeOf always emits (and this parser accepts, nothing more):
//   shape     := object | array | word
//   object    := "{" [ entry ("," entry)* ] "}"
//   entry     := quotedKey ":" shape
//   quotedKey := a JSON string literal (RFC 8259 escaping: \" \\ \/ \b \f
//                \n \r \t \uXXXX), decoded with JSON.parse
//   array     := "[]" | "[" shape ("|" shape)* "]"
//   word      := a run of characters containing none of , { } [ ] | : " \
//                (always a typeof result such as "number"/"string"/
//                "boolean", or the literal "null", since that is all
//                shapeOf ever emits for a leaf - not validated against a
//                fixed list here, since a stray word can no longer be a
//                misread key fragment)
// Keys, once unquoted, are opaque text to the rest of the parser and to the
// diff logic below - they can contain anything, including the delimiters
// themselves.

class ShapeParseError extends Error {}

const WORD_DELIMITERS = new Set([",", "{", "}", "[", "]", "|", ":", '"', "\\"]);

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

  // A key is a JSON string literal: scan for the matching closing quote,
  // treating "\" as escaping exactly the one character after it. This
  // correctly skips past "\uXXXX" too, without any special-casing: after
  // stepping over the "\" and the "u", the four hex digits that follow can
  // never themselves be "\" or '"', so the plain character-by-character
  // scan resumes safely and lands on the real closing quote regardless of
  // how long the escape sequence was. The matched substring (quotes
  // included) is then handed to JSON.parse to decode it - reusing the
  // platform's own JSON string-literal parser rather than re-implementing
  // escape decoding by hand.
  const parseKey = () => {
    if (s[i] !== '"') {
      fail(`expected a quoted key starting with '"', found '${s[i] ?? "<end of input>"}'`);
    }
    const start = i;
    i++; // consume opening quote
    let closed = false;
    while (i < s.length) {
      if (s[i] === "\\") {
        i += 2;
        continue;
      }
      if (s[i] === '"') {
        i++;
        closed = true;
        break;
      }
      i++;
    }
    if (!closed) fail("unterminated quoted key, no closing '\"' found");
    const literal = s.slice(start, i);
    try {
      return JSON.parse(literal);
    } catch (err) {
      fail(`malformed quoted key ${literal}: ${err.message}`);
    }
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
      if (s[i] !== ":") fail(`expected ':' after key ${JSON.stringify(key)}`);
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
      fail(`expected ',' or '}' after key ${JSON.stringify(key)}`);
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
    while (i < s.length && !WORD_DELIMITERS.has(s[i])) i++;
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
// before joining), and JSON.stringify/JSON.parse are exact inverses of one
// another, so render(parseShapeTree(s)) reproduces s exactly. Used to name a
// whole missing/added subtree, or one differing union branch, in a diff
// message without inventing a second string format for it.
function render(node) {
  if (node.kind === "leaf") return node.word;
  if (node.kind === "object") {
    return `{${node.entries.map(([k, v]) => `${JSON.stringify(k)}:${render(v)}`).join(",")}}`;
  }
  if (node.members.length === 0) return "[]";
  return `[${node.members.map(render).join("|")}]`;
}

const describeKind = (node) => (node.kind === "leaf" ? node.word : node.kind);

// Renders a path as "a.b[].c" - a plain object-key access appends ".key"
// (no leading dot for the very first segment); descending into an array's
// elements appends "[]" directly onto the field it belongs to, matching how
// the coordinator's own worked examples read ("accounts[].mailboxes[]...").
// Keys appear here exactly as parseKey decoded them (never quoted or
// escaped) - fix round 3 only changed the fingerprint's internal encoding
// of keys, not this human-readable diff output.
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
