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

export function diffShapes(expected, actual) {
  if (expected === actual) return [];
  const keysOf = (s) => (s.match(/[A-Za-z_][A-Za-z0-9_]*(?=:)/g) ?? []);
  const e = new Set(keysOf(expected));
  const a = new Set(keysOf(actual));
  const diffs = [];
  for (const k of a) if (!e.has(k)) diffs.push(`unexpected key: ${k}`);
  for (const k of e) if (!a.has(k)) diffs.push(`missing key: ${k}`);
  if (diffs.length === 0) diffs.push(`shape changed:\n  expected ${expected}\n  actual   ${actual}`);
  return diffs;
}
