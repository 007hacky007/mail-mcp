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
