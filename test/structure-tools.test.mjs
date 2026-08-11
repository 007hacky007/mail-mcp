import { test } from "node:test";
import assert from "node:assert/strict";
import { createListAccountsTool } from "../src/tools/list-accounts.mjs";
import { createListMailboxesTool } from "../src/tools/list-mailboxes.mjs";
import { createGetUnreadCountTool } from "../src/tools/get-unread-count.mjs";
import { DomainError } from "../src/mail/errors.mjs";

// Tier 1: injected runner, no osascript. These cover the logic that can rot:
// input guards, argv passed to scripts, and the mapping of script-level
// domain refusals into thrown DomainErrors that name the real candidates.

const wrap = (value) => async () => ({ value, queueWaitMs: 0 });

// ---- list-accounts ----

test("list-accounts rejects unknown argument keys", async () => {
  const tool = createListAccountsTool({ runJxa: wrap({ accounts: [] }) });
  await assert.rejects(() => tool.handler({ bogus: 1 }), /bogus/);
});

test("list-accounts reports disabled accounts as disabled, never omits them", async () => {
  const tool = createListAccountsTool({
    runJxa: wrap({
      accounts: [
        { name: "A", enabled: true, accountType: "imap", emailAddresses: ["a@x.com"], mailboxCount: 3 },
        { name: "B", enabled: false, accountType: "imap", emailAddresses: ["b@x.com"], mailboxCount: 0 },
      ],
    }),
  });
  const out = await tool.handler({});
  assert.equal(out.accounts.length, 2);
  assert.equal(out.accounts[1].enabled, false);
});

test("list-accounts lets a transport failure propagate, never returns empty", async () => {
  const tool = createListAccountsTool({
    runJxa: async () => {
      const err = new Error("Script did not return JSON.");
      err.kind = "transport";
      throw err;
    },
  });
  await assert.rejects(() => tool.handler({}), /did not return JSON/);
});

// ---- list-mailboxes ----

test("list-mailboxes rejects a non-string account", async () => {
  const tool = createListMailboxesTool({ runJxa: wrap({ ok: true, accounts: [] }) });
  await assert.rejects(() => tool.handler({ account: 42 }), /account/);
});

test("list-mailboxes passes account scope and count flag to the script as argv", async () => {
  let seen;
  const tool = createListMailboxesTool({
    runJxa: async (name, args) => {
      seen = { name, args };
      return { value: { ok: true, accounts: [] }, queueWaitMs: 0 };
    },
  });
  await tool.handler({ account: "Work", includeCounts: false });
  assert.equal(seen.name, "list-mailboxes");
  assert.deepEqual(seen.args, ["Work", "false"]);
});

test("list-mailboxes maps account-not-found to a DomainError naming candidates", async () => {
  const tool = createListMailboxesTool({
    runJxa: wrap({
      ok: false,
      error: { code: "account-not-found", candidates: ["Personal", "Work"] },
    }),
  });
  await assert.rejects(
    () => tool.handler({ account: "Wrok" }),
    (err) => {
      assert.ok(err instanceof DomainError);
      assert.match(err.message, /Personal/);
      assert.match(err.message, /Work/);
      return true;
    }
  );
});

test("list-mailboxes returns the tree with full paths untouched", async () => {
  const tree = {
    ok: true,
    accounts: [
      {
        name: "A",
        enabled: true,
        mailboxes: [
          { name: "INBOX", path: "INBOX", depth: 0, messageCount: 5, unreadCount: 1 },
          { name: "Sub", path: "Parent/Sub", depth: 1, messageCount: 2, unreadCount: 0 },
        ],
      },
    ],
  };
  const tool = createListMailboxesTool({ runJxa: wrap(tree) });
  const out = await tool.handler({});
  assert.equal(out.accounts[0].mailboxes[1].path, "Parent/Sub");
});

// ---- get-unread-count ----

test("get-unread-count refuses a mailbox scope without an account", async () => {
  const tool = createGetUnreadCountTool({ runJxa: wrap({ ok: true }) });
  await assert.rejects(() => tool.handler({ mailbox: "INBOX" }), /account/);
});

test("get-unread-count maps an ambiguous mailbox path to a DomainError", async () => {
  const tool = createGetUnreadCountTool({
    runJxa: wrap({
      ok: false,
      error: { code: "mailbox-ambiguous", candidates: ["Junk", "Junk"], account: "A" },
    }),
  });
  await assert.rejects(
    () => tool.handler({ account: "A", mailbox: "Junk" }),
    (err) => err instanceof DomainError && /more than one/.test(err.message)
  );
});

test("get-unread-count maps a disabled account to a DomainError saying so", async () => {
  const tool = createGetUnreadCountTool({
    runJxa: wrap({ ok: false, error: { code: "account-disabled", account: "B" } }),
  });
  await assert.rejects(
    () => tool.handler({ account: "B" }),
    (err) => err instanceof DomainError && /disabled/.test(err.message)
  );
});

test("get-unread-count returns total plus per-mailbox results and skipped list", async () => {
  const tool = createGetUnreadCountTool({
    runJxa: wrap({
      ok: true,
      results: [
        { account: "A", path: "INBOX", unreadCount: 3 },
        { account: "B", path: "INBOX", unreadCount: 4 },
      ],
      skipped: [],
    }),
  });
  const out = await tool.handler({});
  assert.equal(out.total, 7);
  assert.equal(out.results.length, 2);
  assert.deepEqual(out.skipped, []);
});

// A partial answer must say so: skipped entries survive to the output and the
// total is labeled a floor.
test("get-unread-count labels a partial total as a floor", async () => {
  const tool = createGetUnreadCountTool({
    runJxa: wrap({
      ok: true,
      results: [{ account: "A", path: "INBOX", unreadCount: 3 }],
      skipped: [{ account: "B", reason: "no INBOX mailbox" }],
    }),
  });
  const out = await tool.handler({});
  assert.equal(out.total, 3);
  assert.equal(out.partial, true);
  assert.match(out.note, /at least/i);
  assert.equal(out.skipped.length, 1);
});
