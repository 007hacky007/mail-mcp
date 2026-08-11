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
  const r = newRedactor();
  assert.deepEqual(
    r({ count: 17484, enabled: true, missing: null, seconds: 1.0485 }),
    { count: 17484, enabled: true, missing: null, seconds: 1.0485 }
  );
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
  const r = newRedactor();
  const out = r({ a: [1, 2, 3], b: { c: "x@y.com", d: 4 } });
  assert.equal(out.a.length, 3);
  assert.deepEqual(Object.keys(out.b).sort(), ["c", "d"]);
});

// --- Round 2: fail-closed hardening (see task-2-review.md, all inputs are
// fictional, never the human partner's real data) -------------------------

test("[review 1.1] a bare display name under an unrecognized key does not leak", () => {
  const r = newRedactor();
  const out = r({ sender: "Jane Roe" });
  assert.ok(!JSON.stringify(out).includes("Jane Roe"));
  assert.match(out.sender, /^<str len=\d+ chars=ascii>$/);
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
  const r = newRedactor();
  const out = r({ "jane.roe@personalmail.com": { unread: 3 }, "Jane Roe": { flagged: 1 } });
  const keys = Object.keys(out);
  assert.equal(keys.length, 2);
  assert.ok(!keys.some((k) => k.includes("jane.roe@personalmail.com")));
  assert.ok(!keys.some((k) => k.includes("Jane Roe")));
  // Values under the redacted keys must still be reachable and untouched
  // (numbers are not personal data).
  const values = Object.values(out);
  assert.ok(values.some((v) => v.unread === 3));
  assert.ok(values.some((v) => v.flagged === 1));
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
  const r = newRedactor();
  const when = new Date("2026-01-01T00:00:00Z");
  const out = r({ when });
  assert.ok(out.when instanceof Date);
  assert.equal(out.when.getTime(), when.getTime());
});

test("[review 1.13] a __proto__ key is preserved as an own property, not silently dropped", () => {
  const r = newRedactor();
  const input = JSON.parse('{"__proto__": "jane.roe@personalmail.com", "other": 1}');
  const out = r(input);
  assert.deepEqual(Object.keys(out).sort(), ["__proto__", "other"]);
  assert.equal(out.other, 1);
  assert.ok(!Object.getOwnPropertyDescriptor(out, "__proto__").value.includes("jane.roe"));
});

test("[coordinator example] a subject value nested under an unrecognized leaf key does not leak", () => {
  const r = newRedactor();
  const out = r({ props: { subject: { sample: "Q3 budget review with sensitive client info" } } });
  const dump = JSON.stringify(out);
  assert.ok(!dump.includes("budget"));
  assert.ok(!dump.includes("sensitive client"));
});

test("[fail closed] a key no rule has ever heard of, holding a personal-looking string, is redacted", () => {
  const r = newRedactor();
  const secret = "this-is-a-personal-looking-secret-string-xyz123";
  const out = r({ someTotallyUnknownField: secret });
  assert.notEqual(out.someTotallyUnknownField, secret);
  assert.ok(!JSON.stringify(out).includes(secret));
  assert.match(out.someTotallyUnknownField, /^<str len=\d+ chars=ascii>$/);
});
