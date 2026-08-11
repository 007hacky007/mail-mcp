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
//
// Fix round 4 (task-5-rereview-3.md, sections 2 and 8): the two defects
// the identity-keying fix left behind, both closed below.
//
// (1) IDENTITY COLLISION - was a silent, PERMANENT false pass. Two array
// items whose identity values redact to the SAME string collapse onto ONE
// key of this flat map, and a plain JS object simply keeps whichever was
// written last. The re-reviewer built the case from two ordinary account
// names ("Work1", "Home2": same length, same character class, neither
// email-shaped, so research/redact.mjs's generic fallback maps BOTH to the
// identical "<str len=5 chars=ascii>" descriptor): collectSuccessProfile
// returned 3 entries where 6 flags existed, and when account 1 then
// genuinely regressed (its enabled.ok flipping true -> false) while still
// colliding with account 2, diffSuccessProfile returned ZERO diffs - not
// just for that run but PERMANENTLY, since the collision was already in
// effect when the baseline was recorded (account 1's paths were never
// captured at all) and recurs identically on every later replay. A real
// regression in Mail's object model becomes invisible forever, silently, in
// the one component whose entire job is catching exactly that. Fixed by
// FAILING LOUDLY at profile-collection time: collectSuccessProfile now
// throws SuccessProfileCollisionError the moment two items would write the
// same path, naming the colliding path(s) - see collectSuccessProfile below.
//
// Why REFUSE rather than DISAMBIGUATE (e.g. appending an occurrence index
// so both colliding items survive as "[name=X#1]"/"[name=X#2]"):
// disambiguation would preserve coverage, but only if the disambiguated
// keys are STABLE for the same real-world items across runs, and no stable
// discriminator exists here.
//   - An occurrence index is a function of ARRAY ORDER, and array order is
//     exactly what fix round 3 stopped keying on: nothing guarantees Mail
//     returns two colliding accounts (or mailboxes) in the same relative
//     order on the next run, and inserting a THIRD colliding item ahead of
//     the pair renumbers both. Either event swaps the two items' keys and
//     fabricates a pair of true<->false flips - the fix-round-3 defect
//     reintroduced, for precisely the items the disambiguation was supposed
//     to protect.
//   - A content-derived discriminator (hashing the item's own flag values
//     into its key) is stable only while the item's flags do not change -
//     i.e. it becomes unstable exactly when the regression this module
//     exists to detect happens, turning a clean "true -> false" report into
//     an unrelated-looking missing/new pair.
// So there is no stability guarantee to be had, and per the standing rule
// for this module (guarantee stability or refuse), it refuses. Refusing
// also closes the defect at its ROOT rather than mitigating it: a collided
// baseline can never be written by research/record.mjs in the first place
// (it refuses to record, like it already does for an unstorable argument or
// a field redact() rejects), so the permanent-false-pass path does not
// exist; and a collision that appears later, only in live data, becomes a
// loud FAIL from research/verify.mjs instead of a quiet pass. The cost is
// stated plainly: on a machine where two items really do collide, that
// probe cannot be recorded or verified until the identity source is fixed
// (see the remedy named in the error message). That is the intended
// trade-off - an unusable detector that says so beats a confident detector
// that cannot see.
//
// (2) The RENAME-MERGE heuristic was too eager (the re-reviewer's section 8):
// it paired any disappearing path with any appearing path of the same shape
// and value, so two UNRELATED simultaneous events (account C removed,
// unrelated account F added, both with the same flag value) were reported
// as "renamed" - a false claim of identity continuity. Now the pairing must
// be UNAMBIGUOUS to earn that label; see diffSuccessProfile below.
import { isOkStyleKey, collectOkFlags } from "./failurePaths.mjs";

// Thrown by collectSuccessProfile when two array items collapse onto one
// profile path. Its own class (rather than a bare Error) so that
// research/record.mjs can name the real cause in its refusal message
// instead of blaming redact(), which did nothing wrong.
export class SuccessProfileCollisionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SuccessProfileCollisionError";
  }
}

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
// descriptor, never a real account/mailbox name. That is also what makes it
// safe for the collision error below to quote a path verbatim.
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

// The recursive half of collectSuccessProfile. Paths are built with "." for
// object keys and "[identity]" or "[N]" for array items, e.g. "props.id.ok"
// or "accounts[name=Account B].mailboxCount.ok" or "accounts[2].mailboxCount.ok"
// (index fallback). See identitySegmentFor above for the identity-vs-index
// decision.
//
// Collision detection (fix round 4) happens right here, at the moment of
// assignment, and it is exact rather than heuristic: within one object every
// key is unique and within one array every index is unique, so the ONLY way
// the same flat-map path can be written twice is two array items sharing an
// identity segment. Every write is therefore either a first write or a
// collision that destroys the value already stored - no false positives, and
// nothing about "how many items merely share an identity" is guessed at: two
// items with the same identity that contribute NO overlapping flags lose no
// coverage and are not reported, because nothing was overwritten.
function walkProfile(value, path, out, collidedPaths) {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      const identity = identitySegmentFor(v);
      const segment = identity !== null ? `[${identity}]` : `[${i}]`;
      walkProfile(v, `${path}${segment}`, out, collidedPaths);
    });
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    const childPath = path ? `${path}.${k}` : k;
    if (typeof v === "boolean" && isOkStyleKey(k)) {
      if (Object.prototype.hasOwnProperty.call(out, childPath)) collidedPaths.push(childPath);
      out[childPath] = v;
    } else {
      walkProfile(v, childPath, out, collidedPaths);
    }
  }
  return out;
}

// Builds the flat { path: boolean } profile for one probe's (already
// redacted) output. Throws SuccessProfileCollisionError instead of
// returning a profile with silently reduced coverage - see the header
// comment, defect (1), for why refusing beats every disambiguation scheme
// available here.
export function collectSuccessProfile(value) {
  const out = {};
  const collidedPaths = [];
  walkProfile(value, "", out, collidedPaths);

  if (collidedPaths.length > 0) {
    const unique = [...new Set(collidedPaths)];
    const shown = unique.slice(0, 5);
    const more = unique.length - shown.length;
    throw new SuccessProfileCollisionError(
      `success-profile identity collision: at least two array items share one identity ` +
        `segment, so their ok-style flags collapse onto a single profile path and one item's ` +
        `flags are lost. Colliding path${unique.length === 1 ? "" : "s"}: ` +
        `${shown.map((p) => `"${p}"`).join(", ")}${more > 0 ? ` (and ${more} more)` : ""}. ` +
        `Refusing to build a profile rather than recording reduced coverage silently: a ` +
        `collision already in effect when the baseline is recorded hides those items' ` +
        `regressions permanently, because it recurs identically on every replay. Remedy: make ` +
        `the colliding items' identity values distinguishable - have the probe emit the ` +
        `identity under a key research/redact.mjs pseudonymizes uniquely (an "accountName" ` +
        `key, or a "name" directly under "accounts", both go through pseudoAccount and stay ` +
        `distinct) instead of one that falls back to a length/class descriptor, or add a ` +
        `per-item field that is unique by construction - then record again. Two items that ` +
        `genuinely carry the same identity in Mail itself (this project has measured two ` +
        `sibling mailboxes both literally named "Junk") cannot be told apart by this profile ` +
        `at all, and must be given a discriminating field by the probe.`
    );
  }

  // Belt-and-braces cross-check, the one the re-reviewer pointed out is
  // available for free: research/failurePaths.mjs's collectOkFlags walks
  // the same structure by the same rules and pushes one entry per flag with
  // NO path involved, so its count is the number of flags that exist, while
  // Object.keys(out).length is the number that survived into the profile.
  // The per-path check above should already have named any shortfall; this
  // catches a shortfall arising some way that check does not model (and,
  // equally usefully, a future edit that lets the two modules' traversals
  // drift apart), rather than trusting one detector with a permanently
  // silent failure mode.
  const rawFlags = [];
  collectOkFlags(value, rawFlags);
  const collected = Object.keys(out).length;
  if (rawFlags.length !== collected) {
    throw new SuccessProfileCollisionError(
      `success-profile coverage mismatch: this probe output contains ${rawFlags.length} ` +
        `ok-style flags but the profile holds ${collected} paths, so at least one flag was ` +
        `lost on the way in without the per-path collision check naming it. Refusing to build ` +
        `a profile: a flag that is not in the profile is never compared, so its regressions ` +
        `can never be reported.`
    );
  }

  return out;
}

// Reduces a path to its STRUCTURAL shape by blanking out every identity
// segment's VALUE while keeping which field was used -
// "accounts[name=Account A].mailboxes[path=Folder 1].readOk" becomes
// "accounts[name=?].mailboxes[path=?].readOk". Used only to recognize a
// RENAME (see diffSuccessProfile below): a path disappearing and a
// structurally-identical path appearing elsewhere, carrying the SAME
// recorded value, MAY be one item under a new identity. Numeric index
// segments are left as-is (not blanked) - an index-fallback item's
// "rename" would need matching the same index, which is not a rename at
// all, so no special-casing is needed there.
const IDENTITY_SEGMENT_RE = /\[(path|name|probe)=[^\]]*\]/g;
function structuralShape(path) {
  return path.replace(IDENTITY_SEGMENT_RE, (_, field) => `[${field}=?]`);
}

// A rename candidate is identified by (structural shape, value): a pair has
// to agree on both to be considered at all. The two are joined into one Map
// key with a "|" separator, which is unambiguous whatever characters a shape
// itself contains, because the value is always the literal "true" or "false":
// "<A>|true" can never equal "<B>|false", since their last five characters
// ("|true" versus "false") differ in the first position.
const shapeValueKey = (path, value) => `${structuralShape(path)}|${value}`;
function groupByShapeValue(profile) {
  const groups = new Map();
  for (const [path, value] of Object.entries(profile)) {
    const key = shapeValueKey(path, value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(path);
  }
  return groups;
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
// disconnected, alarming lines, when they share the same structural shape
// and carry the identical value. Renaming an account or mailbox IS a real,
// honest change worth reporting - the merge only changes how it reads, not
// whether it is reported.
//
// Fix round 4 (task-5-rereview-3.md section 8): that merge was too eager.
// A success profile holds nothing but booleans, so it can never PROVE that
// a disappeared item and an appeared item are the same object - and the
// re-reviewer demonstrated the consequence: one account removed and a
// different, unrelated account added in the same interval, both carrying
// the same flag value, were reported as "renamed", asserting a continuity
// that never existed. So the label now requires the pairing to be
// UNAMBIGUOUS in the only sense this data can support: the (shape, value)
// combination must occur EXACTLY ONCE in the recorded profile and EXACTLY
// ONCE in the live profile. That makes the disappearance and the appearance
// each other's only possible counterpart - nothing else in either profile
// could be the source or the target. When several paths share the shape and
// value (this project's real 02-accounts data is seven all-true flags on
// every account, so every account matches every other one), pairing any two
// of them is a coin flip dressed up as a conclusion, and the two events are
// reported plainly instead as what they demonstrably are: one item gone,
// one item new. A correct "one gone, one new" beats a confident wrong
// "renamed"; the trade-off is that a rename inside a uniform list now reads
// as two lines rather than one, which costs readability and claims nothing
// false. If the value ALSO differs, the pair is not merged either (the
// value is part of the key), since guessing "renamed AND regressed" in one
// line would hide the regression.
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

  // Grouped over the WHOLE profiles, not just the missing/added subsets: an
  // unchanged path that shares the shape and value is exactly what makes a
  // pairing ambiguous, so it has to count here too.
  const recordedGroups = groupByShapeValue(recorded);
  const liveGroups = groupByShapeValue(live);
  const addedSet = new Set(added);

  const claimedAdded = new Set();
  for (const m of missing) {
    const key = shapeValueKey(m, recorded[m]);
    const recordedGroup = recordedGroups.get(key) ?? [];
    const liveGroup = liveGroups.get(key) ?? [];
    const candidate = liveGroup.length === 1 ? liveGroup[0] : null;
    const unambiguous =
      recordedGroup.length === 1 &&
      candidate !== null &&
      addedSet.has(candidate) &&
      !claimedAdded.has(candidate);
    if (unambiguous) {
      claimedAdded.add(candidate);
      diffs.push(`${m} -> ${candidate}: renamed (value unchanged: ${recorded[m]})`);
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
