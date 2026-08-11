import { test } from "node:test";
import assert from "node:assert/strict";
import { newRedactor } from "../redact.mjs";

test("replaces a bare email address with a stable pseudonym", () => {
  const r = newRedactor();
  assert.equal(r("mail me at real.person@company.com ok"), "mail me at user1@example.com ok");
});

test("gives the same address the same pseudonym, and different ones different", () => {
  const r = newRedactor();
  assert.equal(r("a@x.com"), "user1@example.com");
  assert.equal(r("b@y.com"), "user2@example.com");
  assert.equal(r("a@x.com"), "user1@example.com");
});

test("replaces the display name in an RFC 5322 style address", () => {
  const r = newRedactor();
  assert.equal(r('"Jane Roe" <jane@corp.com>'), '"Person 1" <user1@example.com>');
});

test("reduces a subject to its length and character class", () => {
  const r = newRedactor();
  assert.deepEqual(r({ subject: "Q3 budget review" }), { subject: "<subject len=16 chars=ascii>" });
});

test("flags a non-ascii subject as unicode without revealing it", () => {
  const r = newRedactor();
  const out = r({ subject: "Rechnung fuer Mai \u2014 \u4f60\u597d" });
  assert.match(out.subject, /^<subject len=\d+ chars=unicode>$/);
});

test("keeps standard mailbox names verbatim", () => {
  const r = newRedactor();
  assert.deepEqual(
    r({ mailboxes: [{ name: "INBOX" }, { name: "All Mail" }, { name: "[Gmail]" }] }),
    { mailboxes: [{ name: "INBOX" }, { name: "All Mail" }, { name: "[Gmail]" }] }
  );
});

test("pseudonymizes a non-standard mailbox name but keeps the path shape", () => {
  const r = newRedactor();
  const out = r({ mailboxes: [{ name: "Thornlands", path: "Work/Thornlands/2026" }] });
  assert.equal(out.mailboxes[0].name, "Folder 1");
  assert.equal(out.mailboxes[0].path.split("/").length, 3);
  assert.ok(!out.mailboxes[0].path.includes("Thornlands"));
});

test("pseudonymizes a bare array of mailbox name strings, keeping standard names verbatim", () => {
  // Rule table extension found live in Step 6 (see task-2-report.md): a real
  // probe against Mail.app can naturally produce mailboxes as a bare array
  // of name strings (mailboxes().map(m => m.name())), not only as an array
  // of {name} objects. The original rules gave that shape zero protection.
  const r = newRedactor();
  const out = r({ mailboxNames: ["INBOX", "Widgets Project", "Acme Vendor", "Junk"] });
  assert.deepEqual(out.mailboxNames, ["INBOX", "Folder 1", "Folder 2", "Junk"]);
});

test("pseudonymizes a bare array of account name strings", () => {
  const r = newRedactor();
  const out = r({ accountNames: ["Acme Corp", "someone@example.org", "Acme Corp"] });
  assert.equal(out.accountNames[0], "Account A");
  assert.equal(out.accountNames[2], "Account A");
  assert.notEqual(out.accountNames[1], "Account A");
  assert.ok(!out.accountNames.join(" ").includes("Acme Corp"));
});

test("preserves numbers, booleans, nulls and timings", () => {
  // Fix-round-2 note (see task-2-report.md "Fix round 2"): "count",
  // "enabled" and "missing" are not real structural probe field names, so
  // under Fix 4 their KEYS are now opaquely relabeled too (key redaction
  // for non-structural keys is covered by dedicated tests elsewhere).
  // This test's own purpose - primitive VALUES survive untouched - still
  // holds regardless of what their keys become, so it is checked via
  // Object.values() rather than by name. "seconds" is a real structural
  // key (research/harness.mjs), so it alone is checked by name too.
  const r = newRedactor();
  const out = r({ count: 17484, enabled: true, missing: null, seconds: 1.0485 });
  const values = Object.values(out);
  assert.ok(values.includes(17484));
  assert.ok(values.includes(true));
  assert.ok(values.includes(null));
  assert.equal(out.seconds, 1.0485);
});

test("keeps the same address stable across repeated bare and display-name occurrences", () => {
  // Regression test for a bug found while implementing this task: chaining
  // .replace(DISPLAY_ADDR_RE, ...).replace(EMAIL_RE, ...) re-scans its own
  // output, so the "userN@example.com" pseudonym just inserted by the first
  // pass got matched again by the second and reassigned a new number. Not
  // in the brief; added here because it is exactly the kind of stability
  // break the rules table promises against ("stably numbered per distinct
  // address").
  const r = newRedactor();
  const out = r(
    'From: "Jane Roe" <jane@corp.com>, Reply-To: jane@corp.com, cc bob@x.com and "Jane Roe" <jane@corp.com> again'
  );
  assert.equal(
    out,
    'From: "Person 1" <user1@example.com>, Reply-To: user1@example.com, cc user2@example.com and "Person 1" <user1@example.com> again'
  );
});

test("preserves array length and object key sets exactly", () => {
  // Fix-round-2 note: "a", "b", "c", "d" are arbitrary fixture keys, not
  // real structural probe field names, so under Fix 4 they are opaquely
  // relabeled (not preserved by exact text) - the property this test can
  // still guarantee for non-structural keys is key-set SIZE (never
  // dropped), which is what it now checks. Exact-text preservation for
  // keys that ARE structural or purely numeric is covered by dedicated
  // tests elsewhere.
  const r = newRedactor();
  const out = r({ a: [1, 2, 3], b: { c: "x@y.com", d: 4 } });
  const topKeys = Object.keys(out);
  assert.equal(topKeys.length, 2);
  const bValue = Object.values(out).find((v) => !Array.isArray(v));
  const aValue = Object.values(out).find((v) => Array.isArray(v));
  assert.equal(aValue.length, 3);
  assert.equal(Object.keys(bValue).length, 2);
});

// --- Round 2: fail-closed hardening (see task-2-review.md, all inputs are
// fictional, never the human partner's real data) -------------------------

test("[review 1.1] a bare display name under an unrecognized key does not leak", () => {
  // Fix-round-2 note: "sender" is not on the structural-key allowlist (no
  // probe written so far emits it), so under Fix 4 the key itself is also
  // now opaquely relabeled, not just the value - looked up via
  // Object.values() rather than by name.
  const r = newRedactor();
  const out = r({ sender: "Jane Roe" });
  assert.ok(!JSON.stringify(out).includes("Jane Roe"));
  const value = Object.values(out)[0];
  assert.match(value, /^<str len=\d+ chars=ascii>$/);
});

test("[review 1.5] every key-based rule fires case-insensitively", () => {
  const r = newRedactor();
  const out = r({
    Subject: "Meeting with Jane Roe about the merger",
    AccountName: "jane.roe@personalmail.com",
    Name: "Thornlands",
    Path: "Work/Thornlands/2026",
    MailboxNames: ["Thornlands", "INBOX"],
    AccountNames: ["Acme Corp"],
  });
  const dump = JSON.stringify(out);
  assert.ok(!dump.includes("Jane Roe"));
  assert.ok(!dump.includes("merger"));
  assert.ok(!dump.includes("Thornlands"));
  assert.ok(!dump.includes("Acme Corp"));
  assert.ok(!dump.includes("jane.roe@personalmail.com"));
  assert.match(out.Subject, /^<subject len=\d+ chars=ascii>$/);
  assert.equal(out.AccountName, "Account A");
  assert.deepEqual(out.MailboxNames, [out.MailboxNames[0], "INBOX"]);
});

test("[review 1.5] a non-email-shaped account name is opaque, not a coincidental pass-through", () => {
  const r = newRedactor();
  const out = r({ AccountName: "Acme Corp Ltd (Personal)", account: "Acme Corp Ltd (Personal)" });
  assert.equal(out.AccountName, "Account A");
  assert.ok(!JSON.stringify(out).includes("Acme Corp"));
});

test("[review 1.6] folder/account labels under unrecognized key names do not leak", () => {
  const r = newRedactor();
  const out = r({
    folder: "Thornlands",
    folderPath: "Work/Thornlands/2026",
    mailboxPath: "Work/Thornlands/2026",
    acct: "Acme Corp Support",
    location: "Work/Thornlands/2026",
    where: { value: "Work/Thornlands/2026" },
  });
  const dump = JSON.stringify(out);
  assert.ok(!dump.includes("Thornlands"));
  assert.ok(!dump.includes("Acme Corp"));
});

test("[review 1.7] a folder name nested under mailboxes[].children[] is pseudonymized", () => {
  const r = newRedactor();
  const out = r({
    mailboxes: [
      { name: "Thornlands", children: [{ name: "SubThornlands" }] },
      [{ name: "NestedArrayFolder" }],
    ],
  });
  const dump = JSON.stringify(out);
  assert.ok(!dump.includes("Thornlands"));
  assert.ok(!dump.includes("SubThornlands"));
  assert.ok(!dump.includes("NestedArrayFolder"));
  assert.equal(out.mailboxes[0].name, "Folder 1");
  assert.notEqual(out.mailboxes[0].children[0].name, "SubThornlands");
});

test("[review 1.8] a bare string array under the trusted mailboxes/accounts keys is pseudonymized", () => {
  const r = newRedactor();
  const out = r({
    mailboxes: ["Thornlands", "INBOX"],
    accounts: ["jane.roe@personalmail.com", "Acme Corp"],
  });
  assert.deepEqual(out.mailboxes, [out.mailboxes[0], "INBOX"]);
  assert.notEqual(out.mailboxes[0], "Thornlands");
  assert.ok(!JSON.stringify(out).includes("Acme Corp"));
  assert.ok(!JSON.stringify(out).includes("jane.roe@personalmail.com"));
});

test("[review 1.9] an object key carrying an address or a display name does not leak", () => {
  // Fix-round-2 note: "unread"/"flagged" are not on the structural-key
  // allowlist either, so those nested keys are now also opaquely
  // relabeled under Fix 4 - the numeric values are looked up positionally
  // rather than by name, since the property under test (numbers are not
  // personal data and remain reachable) doesn't depend on their key text.
  const r = newRedactor();
  const out = r({ "jane.roe@personalmail.com": { unread: 3 }, "Jane Roe": { flagged: 1 } });
  const keys = Object.keys(out);
  assert.equal(keys.length, 2);
  assert.ok(!keys.some((k) => k.includes("jane.roe@personalmail.com")));
  assert.ok(!keys.some((k) => k.includes("Jane Roe")));
  // Values under the redacted keys must still be reachable and untouched
  // (numbers are not personal data).
  const innerValues = Object.values(out).map((inner) => Object.values(inner)[0]);
  assert.ok(innerValues.includes(3));
  assert.ok(innerValues.includes(1));
});

test("[review 1.10] a non-ASCII / IDN email address does not leak (review's exact input)", () => {
  const r = newRedactor();
  // Exact input from task-2-review.md 1.10. The domain is a placeholder
  // German place name used by the reviewer to exercise a non-ASCII/IDN
  // domain, not anyone's real address.
  const out = r("contact jurgen@münchen.de please");
  assert.ok(!out.includes("jurgen"));
  assert.ok(!out.includes("münchen"));
});

test("[review 1.11] an email address with no dotted TLD does not leak", () => {
  const r = newRedactor();
  const out = r("reach me at jsmith@corpmail please");
  assert.ok(!out.includes("jsmith"));
  assert.ok(!out.includes("corpmail"));
});

test("[review 1.12] a live Date instance survives as a Date, not an empty object", () => {
  // Fix-round-2 note: "when" is not a structural key, so it too is now
  // opaquely relabeled - looked up positionally rather than by name.
  const r = newRedactor();
  const when = new Date("2026-01-01T00:00:00Z");
  const out = r({ when });
  const value = Object.values(out)[0];
  assert.ok(value instanceof Date);
  assert.equal(value.getTime(), when.getTime());
});

test("[review 1.13] a __proto__ key no longer silently drops its entry (key-set size preserved)", () => {
  // Fix-round-2 note: "__proto__" is not purely numeric and is not on the
  // structural-key allowlist (no probe emits it), so under Fix 4's
  // stricter policy it is now ALSO opaquely relabeled, same as any other
  // non-structural key - it no longer survives with its literal text, by
  // design. What still matters, and is still true, is the original
  // structural-preservation property the finding was about: the entry is
  // not silently dropped (key-set SIZE stays 2) and the real address in
  // its value does not survive. The Object.defineProperty mechanism that
  // avoids the inherited __proto__ accessor setter is exercised by every
  // object key in this file unconditionally, not only this one.
  const r = newRedactor();
  const input = JSON.parse('{"__proto__": "jane.roe@personalmail.com", "other": 1}');
  const out = r(input);
  const keys = Object.keys(out);
  assert.equal(keys.length, 2);
  const values = Object.values(out);
  assert.ok(values.includes(1));
  assert.ok(!values.some((v) => typeof v === "string" && v.includes("jane.roe")));
});

test("[coordinator example] a subject value nested under an unrecognized leaf key does not leak", () => {
  const r = newRedactor();
  const out = r({ props: { subject: { sample: "Q3 budget review with sensitive client info" } } });
  const dump = JSON.stringify(out);
  assert.ok(!dump.includes("budget"));
  assert.ok(!dump.includes("sensitive client"));
});

test("[fail closed] a key no rule has ever heard of, holding a personal-looking string, is redacted", () => {
  // Fix-round-2 note: under Fix 4, the KEY itself ("someTotallyUnknownField")
  // is no longer on any allowlist either, so it is opaquely relabeled too -
  // an even stronger demonstration of "fail closed" than round 1's version
  // of this test, which only checked the value. Looked up positionally.
  const r = newRedactor();
  const secret = "this-is-a-personal-looking-secret-string-xyz123";
  const out = r({ someTotallyUnknownField: secret });
  assert.ok(!JSON.stringify(out).includes(secret));
  const value = Object.values(out)[0];
  assert.notEqual(value, secret);
  assert.match(value, /^<str len=\d+ chars=ascii>$/);
});

// --- Fix round 2 (see task-2-rereview.md; all inputs fictional, and the
// re-review's own exact leaking inputs where specified) --------------------

test("[Fix 1] VERBATIM_KEYS no longer has a content-blind escape hatch (re-review Hole A)", () => {
  // Exact leaking inputs from task-2-rereview.md Hole A.
  const r1 = newRedactor();
  const out1 = r1({ status: "Jane Roe" });
  assert.ok(!JSON.stringify(out1).includes("Jane Roe"));

  const r2 = newRedactor();
  const out2 = r2({ idType: "+1 555-123-4567" });
  assert.ok(!JSON.stringify(out2).includes("555-123-4567"));

  const r3 = newRedactor();
  const out3 = r3({ mode: "Called Jane at noon" });
  assert.ok(!JSON.stringify(out3).includes("Jane"));

  const r4 = newRedactor();
  const out4 = r4({ accountType: "1234-5678-9012-3456" });
  assert.ok(!JSON.stringify(out4).includes("1234-5678-9012-3456"));
});

test("[Fix 1] every per-key validator rejects a personal-looking value and keeps its legitimate value", () => {
  const cases = [
    ["probe", "00-hello"],
    ["mode", "file"],
    ["mode", "-e"],
    ["chars", "ascii"],
    ["chars", "unicode"],
    ["accountType", "personal"],
    ["type", "string"],
    ["idType", "number"],
    ["sampleIdType", "boolean"],
    ["dateGetTimeType", "object"],
    ["firstIdType", "undefined"],
  ];
  const personal = "Jane Roe";
  for (const [key, legitimateValue] of cases) {
    const rGood = newRedactor();
    const outGood = rGood({ [key]: legitimateValue });
    assert.equal(
      outGood[key],
      legitimateValue,
      `expected ${key}="${legitimateValue}" to survive verbatim`
    );

    const rBad = newRedactor();
    const outBad = rBad({ [key]: personal });
    assert.ok(
      !JSON.stringify(outBad).includes(personal),
      `expected ${key}="${personal}" to be redacted, got ${JSON.stringify(outBad)}`
    );
  }
});

test("[Fix 2] purely-numeric object keys are preserved exactly; their values are still redacted", () => {
  // Exact input from the coordinator's fix-round-2 instructions.
  const r = newRedactor();
  const out = r({ "0": "Jane Roe", "1": "Bob" });
  assert.deepEqual(Object.keys(out).sort(), ["0", "1"]);
  assert.notEqual(out["0"], "Jane Roe");
  assert.notEqual(out["1"], "Bob");
  assert.ok(!JSON.stringify(out).includes("Jane Roe"));
  assert.ok(!JSON.stringify(out).includes("Bob"));
});

test("[Fix 3] the standard-mailbox passthrough is scoped to folder context, not global (re-review Hole B)", () => {
  const r1 = newRedactor();
  const out1 = r1({ note: "Important" });
  assert.notEqual(out1.note, "Important");

  const r2 = newRedactor();
  const out2 = r2({ comment: "Archive" });
  assert.notEqual(Object.values(out2)[0], "Archive");

  // Folder context still keeps a standard name verbatim, unaffected.
  const r3 = newRedactor();
  const out3 = r3({ mailboxes: [{ name: "Archive" }] });
  assert.equal(out3.mailboxes[0].name, "Archive");
});

test("[Fix 4] an identifier-shaped personal key is no longer preserved by pattern (re-review Hole C)", () => {
  // Exact leaking input from task-2-rereview.md Hole C.
  const r = newRedactor();
  const out = r({ JaneRoePersonalNotes: { foo: 1 }, jane_roe_2026: 5 });
  const keys = Object.keys(out);
  assert.ok(!keys.includes("JaneRoePersonalNotes"));
  assert.ok(!keys.includes("jane_roe_2026"));
  assert.equal(keys.length, 2);
});

test("[cyclic input] fails with a clear error instead of a bare RangeError", () => {
  const r = newRedactor();
  const obj = {};
  obj.self = obj;
  assert.throws(() => r(obj), /cyclic/i);
});
