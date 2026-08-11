// Detects when a probe replay touched Mail's object model NOWHERE at all -
// see the header comment in research/verify.mjs for the full defect this
// exists to catch (fix round 1, task-5-review: a probe argument redacted
// into a placeholder resolves to nothing real on replay, and this project's
// {ok, ...}/{fetchOk, ...} shape-symmetric probe design means that failure
// is shape-identical to a real success).
//
// Extracted into its own side-effect-free module (fix round 2,
// task-5-rereview.md) so research/test/*.test.mjs can import and unit-test
// the pure logic directly, with zero osascript calls, rather than only
// through a hand-run transcript.

// Fix round 3 (task-5-rereview-2.md, second/smaller finding): a key is an
// ok-style success flag when it is EXACTLY "ok" (any case), or ends in
// "Ok"/"OK" specifically at a camelCase boundary - the character
// immediately before it is a lowercase letter or digit, i.e. there is a
// genuine case transition there. "fetchOk" and "readOk" match; a key that
// merely happens to end in the lowercase letters "o" then "k", like
// "outlook", does not, since there is no transition to an uppercase "O".
// The original version of this match, a raw `/ok$/i` suffix test, does not
// make this distinction: case-insensitive matching treats "outlook"'s
// trailing "ok" as equivalent to "Ok" and would incorrectly sweep a
// boolean merely named that way into a success-flag collection. Exported
// so research/successProfile.mjs uses the identical rule rather than a
// second, independently-maintained copy that could drift out of sync.
const OK_EXACT_RE = /^ok$/i;
const OK_CAMELCASE_SUFFIX_RE = /[a-z0-9](Ok|OK)$/;

export function isOkStyleKey(key) {
  return OK_EXACT_RE.test(key) || OK_CAMELCASE_SUFFIX_RE.test(key);
}

// Recursively collects every boolean value in `value` whose own key
// satisfies isOkStyleKey - this project's two success-flag conventions,
// {ok: ...} and {fetchOk: ...} - into `out`.
export function collectOkFlags(value, out) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectOkFlags(v, out);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "boolean" && isOkStyleKey(k)) out.push(v);
    else collectOkFlags(v, out);
  }
}

// True only when at least one ok-style flag was found AND every single one
// of them is false - i.e. the replay reached nothing but failure paths. A
// probe with no ok-style field at all (nothing to check - see
// research/successProfile.mjs's header comment on the "ok-style-field
// convention" this project now asks future probes to follow) or a genuine
// MIX of true/false (a real, partial, expected failure) is NOT flagged:
// this check exists only to catch TOTAL resolution failure. A single
// property silently flipping status while everything else still works is
// NOT caught here on purpose - that is research/successProfile.mjs's job,
// a deliberately separate, finer-grained signal (fix round 2, Fix A).
export function replayReachedOnlyFailurePaths(data) {
  const flags = [];
  collectOkFlags(data, flags);
  return flags.length > 0 && flags.every((flag) => flag === false);
}
