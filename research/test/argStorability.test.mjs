import { test } from "node:test";
import assert from "node:assert/strict";
import { isStorableAt, requireStorableArgs, KNOWN_SELECTOR_KEYWORDS } from "../argStorability.mjs";

// Fix round 2 (task-5-rereview.md, Fix C): unit coverage for the
// positional arg-storability rule added in Fix B - zero osascript calls,
// fixtures only, so this stays in `npm test`. The whitespace/casing/suffix
// cases here reproduce exactly what the re-reviewer confirmed by hand
// (task-5-rereview.md section 3, "Also tested and confirmed clean").

test("position 0 accepts a decimal index", () => {
  assert.equal(isStorableAt(0, "0"), true);
  assert.equal(isStorableAt(0, "42"), true);
});

test("position 0 accepts a known selector keyword", () => {
  for (const kw of KNOWN_SELECTOR_KEYWORDS) assert.equal(isStorableAt(0, kw), true);
});

// Position 0 is an ACCOUNT selector; a mailbox name never belongs there,
// so it is correctly refused even though it would be fine one position
// later.
test("position 0 does NOT accept a standard mailbox name", () => {
  assert.equal(isStorableAt(0, "INBOX"), false);
  assert.equal(isStorableAt(0, "Sent Messages"), false);
});

// Fix round 2 (Fix B): the historical hole the re-reviewer found - an
// all-digit string at a LATER position (a personal mailbox literally named
// "12345", or a phone number) used to be accepted merely for being made of
// digits, regardless of position. It must now be refused at any position
// other than 0.
test("a later position does NOT accept a decimal-only string (the FIX B hole)", () => {
  assert.equal(isStorableAt(1, "12345"), false);
  assert.equal(isStorableAt(1, "007"), false);
  assert.equal(isStorableAt(1, "5551234567"), false);
  assert.equal(isStorableAt(2, "9999"), false);
});

test("a later position accepts a standard mailbox name", () => {
  assert.equal(isStorableAt(1, "INBOX"), true);
  assert.equal(isStorableAt(1, "Sent Messages"), true);
  assert.equal(isStorableAt(1, "[Gmail]"), true);
});

test("a later position accepts a known selector keyword too", () => {
  for (const kw of KNOWN_SELECTOR_KEYWORDS) assert.equal(isStorableAt(1, kw), true);
});

test("whitespace variants of a standard mailbox name are refused (exact match only)", () => {
  assert.equal(isStorableAt(1, " INBOX"), false);
  assert.equal(isStorableAt(1, "INBOX "), false);
  assert.equal(isStorableAt(1, "INBOX\t"), false);
});

test("a casing variant of a standard mailbox name is refused (exact match only)", () => {
  assert.equal(isStorableAt(1, "inbox"), false);
  assert.equal(isStorableAt(1, "Inbox "), false);
});

test("a suffix/prefix variant of a standard mailbox name is refused (exact match, not substring)", () => {
  assert.equal(isStorableAt(1, "INBOXX"), false);
  assert.equal(isStorableAt(1, "MY INBOX"), false);
});

test("a suffix variant of a selector keyword is refused (exact match, not prefix match)", () => {
  assert.equal(isStorableAt(0, "largest-enabledMine"), false);
  assert.equal(isStorableAt(0, "gmail-style2"), false);
});

test("a casing or whitespace variant of a selector keyword is refused (exact match only)", () => {
  assert.equal(isStorableAt(0, "Largest-Enabled"), false);
  assert.equal(isStorableAt(1, " gmail-style"), false);
});

test("requireStorableArgs accepts a valid two-argument call and returns the args unchanged", () => {
  const args = ["0", "INBOX"];
  assert.deepEqual(requireStorableArgs(args), args);
});

test("requireStorableArgs accepts an empty args array", () => {
  assert.deepEqual(requireStorableArgs([]), []);
});

test("requireStorableArgs throws naming the POSITION, never the offending value", () => {
  assert.throws(
    () => requireStorableArgs(["0", "5551234567"]),
    (err) => {
      assert.match(err.message, /argument 1/);
      assert.doesNotMatch(err.message, /5551234567/);
      return true;
    }
  );
});

// The exact hole Fix B closes, expressed as an end-to-end assertion: the
// SAME string is fine at position 0 (an index) and refused at position 1
// (where it would be a personal-looking mailbox name), so the position,
// not just the string's shape, determines the outcome.
test("requireStorableArgs refuses an all-digit mailbox at position 1 even though the identical string is fine at position 0", () => {
  assert.equal(isStorableAt(0, "12345"), true);
  assert.throws(
    () => requireStorableArgs(["12345", "12345"]),
    (err) => {
      assert.match(err.message, /argument 1/);
      return true;
    }
  );
});
