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
  // Fix-round-3 note (see task-2-report.md "Fix round 3"): "count" and
  // "missing" are not real structural probe field names, so under Fix 5
  // they now throw rather than being silently relabeled (an unrecognized,
  // identifier-shaped key almost certainly means a missing allowlist
  // entry, not personal data). Rewritten to use real structural keys
  // (mailboxCount, enabled, value, seconds - from research/probes/
  // 02-accounts.js and research/harness.mjs) so this test's own purpose -
  // primitive VALUES survive untouched - can still be demonstrated
  // without hitting an unrelated throw.
  const r = newRedactor();
  const out = r({ mailboxCount: 17484, enabled: true, value: null, seconds: 1.0485 });
  assert.deepEqual(out, { mailboxCount: 17484, enabled: true, value: null, seconds: 1.0485 });
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
  // Fix-round-3 note: "a", "b", "c", "d" are arbitrary fixture keys, not
  // real structural probe field names, so under Fix 5 they now throw
  // rather than being silently relabeled. Rewritten to use real
  // structural keys (objects, mime, sourceBytes, downloaded - from
  // research/probes/10-attachment-source.js) so exact key-text and
  // array-length preservation can both still be demonstrated by name.
  const r = newRedactor();
  const out = r({ objects: [1, 2, 3], mime: { sourceBytes: "x@y.com", downloaded: 4 } });
  assert.equal(out.objects.length, 3);
  assert.deepEqual(Object.keys(out.mime).sort(), ["downloaded", "sourceBytes"]);
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
  const out = r({ AccountName: "Acme Corp Ltd (Personal)" });
  assert.equal(out.AccountName, "Account A");
  assert.ok(!JSON.stringify(out).includes("Acme Corp"));
});

test("[review 1.5 / Fix 5] an unrecognized singular 'account' key throws rather than silently passing through", () => {
  // Fix-round-3 note: round 2's version of this test paired AccountName
  // with a plain "account" key to show the fix wasn't a coincidental
  // email-shape catch. "account" (singular) is not a real structural
  // probe field name, so under Fix 5 it now throws instead of falling
  // through to a generic descriptor - still never a leak, just a louder
  // failure mode for an unrecognized key.
  const r = newRedactor();
  assert.throws(() => r({ account: "Acme Corp Ltd (Personal)" }), /unrecognized object key "account"/);
});

test("[review 1.6 / Fix 5] folder/account labels under unrecognized key names throw, never leak", () => {
  // Fix-round-3 note: round 2 demonstrated these unrecognized keys got
  // safely redacted to a generic descriptor. Under Fix 5, an unrecognized
  // identifier-shaped key throws instead (folder/folderPath/mailboxPath/
  // acct/location/where are not real structural probe field names) -
  // still never a leak, checked one at a time since redact() stops at the
  // first offending key in an object.
  const inputs = [
    { folder: "Thornlands" },
    { folderPath: "Work/Thornlands/2026" },
    { mailboxPath: "Work/Thornlands/2026" },
    { acct: "Acme Corp Support" },
    { location: "Work/Thornlands/2026" },
    { where: { value: "Work/Thornlands/2026" } },
  ];
  for (const input of inputs) {
    const r = newRedactor();
    assert.throws(() => r(input), /unrecognized object key/);
  }
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
  // Fix-round-3 note: round 2's nested "unread"/"flagged" keys are not
  // real structural probe field names, so they would now throw - which
  // would test Fix 5's key-allowlist behavior, not this finding. Swapped
  // for real structural keys (unreadCount, flaggedStatus - from
  // research/probes/03-mailboxes.js and 04-message-props.js) so this test
  // stays focused on its own point: the top-level keys, which ARE data
  // (an address, a display name), are pseudonymized/opaquely relabeled,
  // never preserved verbatim.
  const r = newRedactor();
  const out = r({ "jane.roe@personalmail.com": { unreadCount: 3 }, "Jane Roe": { flaggedStatus: 1 } });
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
  // Fix-round-3 note: "when" is not a real structural key, so it now
  // throws under Fix 5. Swapped for "dateReceived" (real, from
  // research/probes/04-message-props.js) to keep testing the Date-
  // preservation mechanism itself rather than the key-allowlist behavior.
  const r = newRedactor();
  const dateReceived = new Date("2026-01-01T00:00:00Z");
  const out = r({ dateReceived });
  assert.ok(out.dateReceived instanceof Date);
  assert.equal(out.dateReceived.getTime(), dateReceived.getTime());
});

test("[review 1.13 / Fix 5] a __proto__ key throws, same as any other unrecognized identifier-shaped key", () => {
  // Fix-round-3 note: round 2 showed "__proto__" no longer silently drops
  // its entry (Object.defineProperty preserves it, opaquely relabeled).
  // "__proto__" is not on the structural allowlist (no probe emits it)
  // and IS identifier-shaped, so under Fix 5 it now throws instead - the
  // coordinator's insight applies to it just like any other unrecognized
  // key. This is a stricter outcome than round 2's, not a regression: it
  // still never leaks, and the object-mechanics fix (Object.defineProperty
  // bypassing the inherited __proto__ accessor setter) remains in place
  // and is exercised unconditionally by every other test with 2+ object
  // keys - it just isn't reachable via this exact key text anymore.
  const r = newRedactor();
  const input = JSON.parse('{"__proto__": "jane.roe@personalmail.com", "other": 1}');
  assert.throws(() => r(input), /unrecognized object key "__proto__"/);
});

test("[coordinator example] a subject value nested under an unrecognized leaf key does not leak", () => {
  const r = newRedactor();
  const out = r({ props: { subject: { sample: "Q3 budget review with sensitive client info" } } });
  const dump = JSON.stringify(out);
  assert.ok(!dump.includes("budget"));
  assert.ok(!dump.includes("sensitive client"));
});

test("[fail closed / Fix 5] a key no rule has ever heard of throws rather than silently passing through", () => {
  // Fix-round-3 note: this test's whole point was "fail closed" - under
  // round 1/2 that meant the VALUE (and eventually the key too) got
  // silently redacted. Under Fix 5, an unrecognized identifier-shaped key
  // means something different and stronger: the operation refuses to
  // guess and throws, naming the key, rather than ever risking a silently
  // mangled fingerprint. "Fail closed" now means "redact or throw, never
  // silently pass through" - this asserts the throw half of that; the
  // redact half (for a data-shaped unknown key) is covered by the
  // dedicated Fix 5 test below.
  const r = newRedactor();
  const secret = "this-is-a-personal-looking-secret-string-xyz123";
  assert.throws(
    () => r({ someTotallyUnknownField: secret }),
    /unrecognized object key "someTotallyUnknownField"/
  );
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
  // Fix-round-3 note: "note"/"comment" are not real structural probe
  // field names and would now throw under Fix 5, testing the key
  // allowlist rather than this finding. Swapped for "sample" (real, from
  // research/probes/04-message-props.js's timed() helper) - a structural
  // key with no folder context and no VALUE_VALIDATORS entry, which is
  // exactly the shape this finding is about.
  const r1 = newRedactor();
  const out1 = r1({ sample: "Important" });
  assert.notEqual(out1.sample, "Important");

  // Folder context still keeps a standard name verbatim, unaffected.
  const r2 = newRedactor();
  const out2 = r2({ mailboxes: [{ name: "Archive" }] });
  assert.equal(out2.mailboxes[0].name, "Archive");
});

test("[Fix 4 / Fix 5] an identifier-shaped personal key now throws instead of being silently renamed", () => {
  // Exact leaking input from task-2-rereview.md Hole C. Fix 4 (round 2)
  // stopped preserving this key verbatim (it was no longer safe-by-
  // pattern) but silently renamed it to redactedKeyN. Fix 5 changed that:
  // the coordinator found, before even dispatching the re-review, that
  // silent renaming is itself the worse failure mode for an identifier-
  // shaped key, because such a key is almost always a real structural
  // field name and a rename destroys the fingerprint invisibly. So this
  // now throws instead of renaming - changed here exactly as anticipated
  // in the round-3 instructions.
  const r = newRedactor();
  assert.throws(
    () => r({ JaneRoePersonalNotes: { foo: 1 } }),
    /unrecognized object key "JaneRoePersonalNotes"/
  );

  const r2 = newRedactor();
  assert.throws(
    () => r2({ jane_roe_2026: 5 }),
    /unrecognized object key "jane_roe_2026"/
  );
});

test("[cyclic input] fails with a clear error instead of a bare RangeError", () => {
  // "data" is a real structural key (research/harness.mjs), used here so
  // the self-reference is reached via the recursive walk rather than
  // immediately throwing on an unrecognized key first (which "self"
  // would, and which is not what this test is about).
  const r = newRedactor();
  const obj = {};
  obj.data = obj;
  assert.throws(() => r(obj), /cyclic/i);
});

// --- Fix round 3 (see task-2-report.md "Fix round 3"; all inputs
// fictional) -----------------------------------------------------------

test("[Fix 5] a realistic 05-bulk-fetch-shaped object: every key survives verbatim, only dateSample is redacted", () => {
  // The coordinator's own regression example: this exact shape, run
  // through the committed round-2 redactor, renamed every key
  // (messageCount, fetch, fetchTotal, jsFilterSeconds, ...) to
  // redactedKeyN - breaking shape fingerprints and any later code that
  // reads a field like data.messageCount by name (Task 14's measurements
  // generator does exactly that). Values are fictional; the shape matches
  // research/probes/05-bulk-fetch.js.
  const r = newRedactor();
  const real = {
    messageCount: 17484,
    fetch: { id: 0.708, subject: 1.048, sender: 0.89, dateReceived: 0.903, readStatus: 0.969 },
    fetchTotal: 4.52,
    jsFilterSeconds: 0.0032,
    hits: 19,
    arrayLengths: { id: 17484, subject: 17484, sender: 17484, dateReceived: 17484, readStatus: 17484 },
    idType: "number",
    dateSample: "Tue Aug 11 2026 11:05:18 GMT+0200",
  };
  const out = r(real);
  assert.deepEqual(Object.keys(out).sort(), Object.keys(real).sort());
  assert.equal(out.messageCount, 17484);
  assert.deepEqual(out.fetch, real.fetch);
  assert.equal(out.fetchTotal, 4.52);
  assert.equal(out.jsFilterSeconds, 0.0032);
  assert.equal(out.hits, 19);
  assert.deepEqual(out.arrayLengths, real.arrayLengths);
  assert.equal(out.idType, "number");
  assert.notEqual(out.dateSample, real.dateSample);
  assert.match(out.dateSample, /^<str len=\d+ chars=ascii>$/);
  assert.ok(!JSON.stringify(out).includes("redactedKey"));
});

test("[Fix 5] an unrecognized identifier-shaped key throws with the offending key named in the message", () => {
  const r = newRedactor();
  assert.throws(
    () => r({ someBrandNewProbeField: 42 }),
    (err) => err instanceof Error && err.message.includes('"someBrandNewProbeField"') && /STRUCTURAL_KEY_NAMES/.test(err.message)
  );
});

test("[Fix 5] a key containing @ is pseudonymized rather than throwing", () => {
  const r = newRedactor();
  const out = r({ "someone@example.com": { value: 1 } });
  const keys = Object.keys(out);
  assert.equal(keys.length, 1);
  assert.ok(!keys[0].includes("someone@example.com"));
  assert.match(keys[0], /^user\d+@example\.com$/);
});

test("[Fix 5] the same string gets the same pseudonym whether it appears as a key or as a value", () => {
  const r = newRedactor();
  const outValue = r("contact fictional.person@example.net for details");
  const outKey = r({ "fictional.person@example.net": { value: 1 } });
  const emailInValue = outValue.match(/user\d+@example\.com/)[0];
  const emailAsKey = Object.keys(outKey)[0];
  assert.equal(emailAsKey, emailInValue);
});
