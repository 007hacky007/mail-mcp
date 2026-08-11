// A SUCCESS PROFILE is a flat { path: boolean } map of every ok-style
// boolean field (see research/failurePaths.mjs for the exact key
// convention, "ok" or "*Ok") found anywhere in a probe's output, keyed by
// its precise location.
//
// Fix round 2 (task-5-rereview.md, Fix A - High): research/shape.mjs's
// diffShapes compares only TYPES (typeof), so `ok: true` and `ok: false`
// are indistinguishable to it - both are "boolean". The all-or-nothing
// check in research/failurePaths.mjs (fix round 1) only fires when EVERY
// flag is false, so a single property silently flipping from true to
// false (a future macOS/Mail.app update makes exactly one property throw,
// say flagIndex) is invisible to BOTH existing defenses at once: the
// fingerprint does not change, and the replay is not ALL failure, just one
// property's worth. This module closes that gap by recording the VALUE of
// every flag, not just its type, and comparing values path-by-path on
// replay - so a single flag flipping, in EITHER direction, is caught and
// named, not just a total wipeout.
//
// Kept as a SEPARATE signal from the shape fingerprint and from
// replayReachedOnlyFailurePaths (not folded into either), per the
// coordinator's explicit instruction - so a reader of verify.mjs's output
// can tell "the object model's shape changed" from "a specific property's
// success/failure status changed" from "every property failed": three
// different, individually informative signals, not one conflated FAIL.

// path is built with "." for object keys and "[N]" for array indices, e.g.
// "props.id.ok" or "accounts[2].mailboxCount.ok". Order-sensitive: if a
// probe's own array order genuinely varied run to run, an index-keyed path
// could report a spurious add/remove pair instead of a same-item flip -
// not a concern for this project's current probes, which walk Mail.app's
// own stable account/property order, but a known, accepted limitation of
// this simple a path scheme, not addressed further here.
export function collectSuccessProfile(value, path = "", out = {}) {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectSuccessProfile(v, `${path}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    const childPath = path ? `${path}.${k}` : k;
    if (typeof v === "boolean" && /ok$/i.test(k)) {
      out[childPath] = v;
    } else {
      collectSuccessProfile(v, childPath, out);
    }
  }
  return out;
}

// Compares a RECORDED profile against a LIVE one, returning one message per
// path that differs: a flag flipping true<->false, or a path present in
// one but not the other. BOTH directions of a flip are reported - a
// false-to-true flip means the ORIGINAL recording captured a transient
// failure and should itself be re-recorded, not merely that today's run
// happens to differ from it (per the coordinator's explicit fix-round-2
// instruction). Returns [] when the two profiles are identical, including
// when both are empty - a probe with no ok-style fields at all has nothing
// for this check to say, which is exactly right for it, not a hole in it.
export function diffSuccessProfile(recorded, live) {
  const diffs = [];
  const recordedPaths = new Set(Object.keys(recorded));
  const livePaths = new Set(Object.keys(live));
  for (const path of recordedPaths) {
    if (!livePaths.has(path)) {
      diffs.push(`${path}: recorded as ${recorded[path]}, missing from this replay`);
      continue;
    }
    if (recorded[path] !== live[path]) {
      diffs.push(`${path}: ${recorded[path]} -> ${live[path]}`);
    }
  }
  for (const path of livePaths) {
    if (!recordedPaths.has(path)) {
      diffs.push(`${path}: new in this replay (${live[path]}), absent from the recording`);
    }
  }
  return diffs;
}
