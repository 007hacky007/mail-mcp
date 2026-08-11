// A SUCCESS PROFILE is a flat { path: boolean } map of every ok-style
// boolean field (see research/failurePaths.mjs's isOkStyleKey for the exact
// key convention, "ok" or a camelCase-boundary "*Ok"/"*OK") found anywhere
// in a probe's output, keyed by its precise location.
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
//
// Fix round 3 (task-5-rereview-2.md, High): the first version of this
// module built array paths from the RAW ARRAY INDEX - "accounts[2].mailboxCount.ok".
// The re-reviewer demonstrated directly that this fabricates drift on
// ORDINARY list churn, not just reordering: inserting or removing one
// account/mailbox anywhere except the very end of the list shifts every
// later item's index, so every one of THAT item's ok-flags reads as a
// changed path even though nothing about that item changed at all - on a
// realistic mixed true/false dataset this manifests as fabricated
// true<->false flip lines, textually indistinguishable from a genuine
// per-property regression (splicing one account out of this project's own
// committed research/results/02-accounts.json reproduced this: 7 diffs,
// every one misattributed to the wrong account, because this project's
// real flags happen to be all-true today rather than mixed). Fixed by
// keying an array item's path segment by a STABLE IDENTITY VALUE - "path",
// then "name", then "probe", whichever the item actually has - instead of
// its position, so an item's flags stay attached to that item as the list
// around it changes. Falls back to the numeric index ONLY when an item has
// none of those three fields as a usable string - see identitySegmentFor()
// below for exactly what that fallback costs and when it is exercised.
import { isOkStyleKey } from "./failurePaths.mjs";

// A length/character-class descriptor like "<str len=5 chars=ascii>" is
// what research/redact.mjs falls back to for a string it cannot recognize
// as a name, email, or standard mailbox (see redactStringValue there) - it
// is NOT guaranteed unique: two different real accounts whose names happen
// to share a length and character class redact to the IDENTICAL
// descriptor. Using one as an identity therefore carries a real, if
// narrow, collision risk (two different items would collapse onto the
// same identity-keyed path) - accepted here rather than rejected, because
// rejecting it would fall all the way back to the numeric index for
// EXACTLY the data this fix exists to protect
// (research/probes/02-accounts.js's account objects redact their `name` to
// this shape whenever the real name is not email-shaped - see below), which
// would silently reintroduce the bug this whole fix round closes. Verified
// against this project's actual committed research/results/02-accounts.json:
// none of its 5 accounts' redacted name descriptors collide (two are
// proper email pseudonyms, three are length/class descriptors of three
// DIFFERENT lengths). Documented here as a known, accepted, and narrower
// residual limitation - narrower because it requires a coincidence (two
// accounts of the same name length and character class) rather than
// firing on every ordinary list edit the way the index-based bug did.

// Extracts field `field`'s value from `item` as a usable identity STRING,
// or null if `item` has no such usable value. Handles two shapes this
// project's probes use for a field like "name": a bare string
// (research/probes/03-mailboxes.js's mailbox objects: {name, path, ...})
// and this project's attempt()-wrapped {ok, value} shape
// (research/probes/02-accounts.js's account objects: {name: {ok, value}, ...},
// where the wrapped VALUE, not the wrapper object, is the identity). Both
// are read from data that has already been through research/redact.mjs by
// the time this function ever sees it (research/record.mjs computes this
// profile from `redactedData`; research/verify.mjs redacts before doing so
// too - see that file), so an extracted value is a pseudonym or a redacted
// descriptor, never a real account/mailbox name.
function identityValueOf(item, field) {
  const v = item[field];
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && !Array.isArray(v) && typeof v.value === "string") {
    return v.value;
  }
  return null;
}

// Picks the first usable identity field, in the order the coordinator
// specified: path, then name, then probe. `path` is preferred over `name`
// deliberately, not arbitrarily - section 3 of the object-model document
// this project maintains already established that a bare mailbox `name` can
// collide (two sibling mailboxes literally named "Junk" in the same
// account) while a full `path` disambiguates it, so the same preference
// applies here for exactly the same reason. Returns null - meaning "no
// usable identity, fall back to the array index" - only when the item has
// none of the three fields as a usable string at all (see the header
// comment for what that fallback costs; none of this project's current
// probes exercise it, since research/probes/02-accounts.js's accounts
// always have a usable `name`, wrapped or not).
function identitySegmentFor(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  for (const field of ["path", "name", "probe"]) {
    const value = identityValueOf(item, field);
    if (value !== null) return `${field}=${value}`;
  }
  return null;
}

// path is built with "." for object keys and "[identity]" or "[N]" for
// array items, e.g. "props.id.ok" or "accounts[name=Account B].mailboxCount.ok"
// or "accounts[2].mailboxCount.ok" (index fallback). See identitySegmentFor
// above for the identity-vs-index decision.
export function collectSuccessProfile(value, path = "", out = {}) {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      const identity = identitySegmentFor(v);
      const segment = identity !== null ? `[${identity}]` : `[${i}]`;
      collectSuccessProfile(v, `${path}${segment}`, out);
    });
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    const childPath = path ? `${path}.${k}` : k;
    if (typeof v === "boolean" && isOkStyleKey(k)) {
      out[childPath] = v;
    } else {
      collectSuccessProfile(v, childPath, out);
    }
  }
  return out;
}

// Reduces a path to its STRUCTURAL shape by blanking out every identity
// segment's VALUE while keeping which field was used -
// "accounts[name=Account A].mailboxes[path=Folder 1].readOk" becomes
// "accounts[name=?].mailboxes[path=?].readOk". Used only to recognize a
// RENAME (see diffSuccessProfile below): a path disappearing and a
// structurally-identical path appearing elsewhere, carrying the SAME
// recorded value, is far more likely to be one item under a new identity
// than two unrelated, coincidentally-matching changes. Numeric index
// segments are left as-is (not blanked) - an index-fallback item's
// "rename" would need matching the same index, which is not a rename at
// all, so no special-casing is needed there.
const IDENTITY_SEGMENT_RE = /\[(path|name|probe)=[^\]]*\]/g;
function structuralShape(path) {
  return path.replace(IDENTITY_SEGMENT_RE, (_, field) => `[${field}=?]`);
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
//
// Fix round 3: a missing path and a newly-appeared path are paired into a
// single, readable "renamed" line, rather than reported as two
// disconnected, alarming lines, WHEN they share the same structural shape
// (see structuralShape above) AND carry the identical recorded/live value.
// Renaming an account or mailbox IS a real, honest change worth reporting
// - this only changes how it reads, not whether it is reported. If the
// value ALSO differs, the pair is deliberately NOT merged: guessing
// "renamed AND regressed" in one line would be less honest than reporting
// both facts plainly as a separate missing line and a separate new line.
export function diffSuccessProfile(recorded, live) {
  const diffs = [];
  const recordedPaths = new Set(Object.keys(recorded));
  const livePaths = new Set(Object.keys(live));

  const missing = [];
  const added = [];
  for (const path of recordedPaths) {
    if (!livePaths.has(path)) {
      missing.push(path);
    } else if (recorded[path] !== live[path]) {
      diffs.push(`${path}: ${recorded[path]} -> ${live[path]}`);
    }
  }
  for (const path of livePaths) {
    if (!recordedPaths.has(path)) added.push(path);
  }

  const addedByShape = new Map();
  for (const p of added) {
    const shape = structuralShape(p);
    if (!addedByShape.has(shape)) addedByShape.set(shape, []);
    addedByShape.get(shape).push(p);
  }

  const claimedAdded = new Set();
  for (const m of missing) {
    const shape = structuralShape(m);
    const candidates = addedByShape.get(shape) || [];
    const match = candidates.find((c) => !claimedAdded.has(c) && live[c] === recorded[m]);
    if (match) {
      claimedAdded.add(match);
      diffs.push(`${m} -> ${match}: renamed (value unchanged: ${recorded[m]})`);
    } else {
      diffs.push(`${m}: recorded as ${recorded[m]}, missing from this replay`);
    }
  }
  for (const p of added) {
    if (!claimedAdded.has(p)) {
      diffs.push(`${p}: new in this replay (${live[p]}), absent from the recording`);
    }
  }

  return diffs;
}
