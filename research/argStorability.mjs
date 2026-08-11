// Decides whether a probe ARGUMENT can be stored VERBATIM in a committed
// recording. research/verify.mjs replays a recorded probe's args verbatim
// on every future run (reproducibility is the entire point of recording
// them), so an argument that is not provably non-personal must never be
// silently redacted - a redacted placeholder resolves to nothing real on
// replay, which is what produced the false pass documented in full in
// docs/apple-mail/03-object-model.md (fix round 1, task-5-review). It must
// be refused outright instead, which is what research/record.mjs does with
// the function exported here.
//
// Fix round 2 (task-5-rereview.md, Fix B - privacy): the original version
// of this check applied the SAME rule to every argument position - "is
// this string a decimal integer, a known selector keyword, or a standard
// mailbox name" - regardless of WHERE it appeared. That is unsound: this
// project's probes that take arguments at all
// (research/probes/03-mailboxes.js, 04-message-props.js,
// 12-message-sizes.js) use position 0 for an ACCOUNT SELECTOR and position
// 1 (a mailbox name) for something that is never meant to be an index - so
// a personal mailbox that happens to be named something all-digit
// ("12345", a year-only archive folder) or a phone number passed as a
// probe's second argument would pass the old, position-blind check and get
// committed verbatim. The rule is now POSITIONAL: only position 0 accepts
// a decimal integer at all; every later position must be a standard
// mailbox name or a selector keyword, never merely "made of digits."
//
// Extracted into its own side-effect-free module (also fix round 2) so
// research/test/*.test.mjs can import and unit-test the pure logic
// directly, with zero osascript calls, rather than only through a
// subprocess or a hand-run transcript.
import { STANDARD_MAILBOXES } from "./redact.mjs";

export const KNOWN_SELECTOR_KEYWORDS = new Set(["largest-enabled", "gmail-style"]);
const DECIMAL_INTEGER_RE = /^\d+$/;

// A selector keyword is a fixed, non-personal literal regardless of which
// argument position it appears in, so it is accepted everywhere. A decimal
// integer is only ever safe as an ACCOUNT-LIST INDEX, which is exclusively
// position 0's job; at any later position it would be indistinguishable
// from a real, digit-shaped mailbox name or a phone number, so it is
// deliberately NOT accepted there - this is the exact rule the coordinator
// specified, and the exact hole (a personal all-digit name at position 1)
// this version closes relative to the position-blind original.
export function isStorableAt(position, arg) {
  if (KNOWN_SELECTOR_KEYWORDS.has(arg)) return true;
  if (position === 0) return DECIMAL_INTEGER_RE.test(arg);
  return STANDARD_MAILBOXES.has(arg);
}

// Deliberately does not echo the offending argument's value into the error
// message: an argument that fails this check is, by definition, exactly the
// kind of thing this project must not leak (there would be no reason to
// refuse it otherwise) - so the message names its POSITION, never its text.
export function requireStorableArgs(rawArgs) {
  for (let i = 0; i < rawArgs.length; i++) {
    if (!isStorableAt(i, rawArgs[i])) {
      const rule =
        i === 0
          ? `a decimal account-list index or a known selector keyword [${[...KNOWN_SELECTOR_KEYWORDS].join(", ")}]`
          : `a standard mailbox name from redact.mjs's STANDARD_MAILBOXES, or a known ` +
            `selector keyword [${[...KNOWN_SELECTOR_KEYWORDS].join(", ")}] - never merely an ` +
            `all-digit string, which is only meaningful as an index at position 0`;
      throw new Error(
        `argument ${i} is not provably non-personal for its position ` +
          `(position ${i} requires ${rule}). ` +
          `research/verify.mjs replays a probe with these EXACT args, so a raw ` +
          `account/mailbox name here would either leak personal data if stored ` +
          `verbatim, or silently redact into a placeholder that resolves to ` +
          `nothing real on replay - producing a false pass, which is the exact ` +
          `defect this check exists to catch. Change the probe to accept a ` +
          `selector it resolves itself (see research/probes/04-message-props.js) ` +
          `instead of a raw name.`
      );
    }
  }
  return rawArgs;
}
