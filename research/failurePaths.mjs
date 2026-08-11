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

// Recursively collects every boolean value in `value` whose own key is
// exactly "ok" or ends in "Ok" (case-insensitive) - this project's two
// success-flag conventions, {ok: ...} and {fetchOk: ...} - into `out`.
export function collectOkFlags(value, out) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectOkFlags(v, out);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "boolean" && /ok$/i.test(k)) out.push(v);
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
