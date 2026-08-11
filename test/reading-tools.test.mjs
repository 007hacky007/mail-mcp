import { test } from "node:test";
import assert from "node:assert/strict";
import { createListMessagesTool } from "../src/tools/list-messages.mjs";
import { createSearchMessagesTool } from "../src/tools/search-messages.mjs";
import { createGetMessageTool } from "../src/tools/get-message.mjs";
import { createGetThreadTool } from "../src/tools/get-thread.mjs";
import { DomainError } from "../src/mail/errors.mjs";

const wrap = (value) => async () => ({ value, queueWaitMs: 0 });

// ---- list-messages ----

test("list-messages requires account and mailbox", async () => {
  const tool = createListMessagesTool({ runJxa: wrap({ ok: true }) });
  await assert.rejects(() => tool.handler({ mailbox: "INBOX" }), /account/);
  await assert.rejects(() => tool.handler({ account: "A" }), /mailbox/);
});

test("list-messages passes argv and clamps nothing valid", async () => {
  let seen;
  const tool = createListMessagesTool({
    runJxa: async (name, args) => {
      seen = { name, args };
      return { value: { ok: true, messageCount: 0, messages: [] }, queueWaitMs: 0 };
    },
  });
  await tool.handler({ account: "A", mailbox: "INBOX", limit: 5 });
  assert.deepEqual(seen, { name: "list-messages", args: ["A", "INBOX", "5", "20000"] });
});

test("list-messages rejects an out-of-range limit", async () => {
  const tool = createListMessagesTool({ runJxa: wrap({ ok: true }) });
  await assert.rejects(() => tool.handler({ account: "A", mailbox: "INBOX", limit: 0 }), /limit/);
  await assert.rejects(
    () => tool.handler({ account: "A", mailbox: "INBOX", limit: 1000 }),
    /limit/
  );
});

test("list-messages maps mailbox-too-large to a DomainError naming the guard", async () => {
  const tool = createListMessagesTool({
    runJxa: wrap({
      ok: false,
      error: {
        code: "mailbox-too-large",
        account: "A",
        requested: "INBOX",
        messageCount: 52148,
        maxMessages: 20000,
      },
    }),
  });
  await assert.rejects(
    () => tool.handler({ account: "A", mailbox: "INBOX" }),
    (err) => err instanceof DomainError && /52148/.test(err.message) && /maxMessages/.test(err.message)
  );
});

test("list-messages returns messages with mailbox path attached", async () => {
  const tool = createListMessagesTool({
    runJxa: wrap({
      ok: true,
      messageCount: 2,
      messages: [
        { id: 9, messageId: "x@y", subject: "s", sender: "a", dateReceived: "2026-01-01T00:00:00.000Z", read: true, mailbox: "INBOX", account: "A" },
      ],
    }),
  });
  const out = await tool.handler({ account: "A", mailbox: "INBOX" });
  assert.equal(out.messages[0].mailbox, "INBOX");
  assert.equal(out.messageCount, 2);
});

// ---- search-messages ----

test("search-messages requires a query or a date bound", async () => {
  const tool = createSearchMessagesTool({ runJxa: wrap({ ok: true }) });
  await assert.rejects(() => tool.handler({}), /query|date/i);
});

test("search-messages rejects unknown fields", async () => {
  const tool = createSearchMessagesTool({ runJxa: wrap({ ok: true }) });
  await assert.rejects(
    () => tool.handler({ query: "x", fields: ["content"] }),
    /fields/
  );
});

test("search-messages rejects an invalid date", async () => {
  const tool = createSearchMessagesTool({ runJxa: wrap({ ok: true }) });
  await assert.rejects(() => tool.handler({ query: "x", dateFrom: "not-a-date" }), /dateFrom/);
});

test("search-messages refuses mailbox scope without account", async () => {
  const tool = createSearchMessagesTool({ runJxa: wrap({ ok: true }) });
  await assert.rejects(() => tool.handler({ query: "x", mailbox: "INBOX" }), /account/);
});

test("search-messages reports scanned, skipped and truncation honestly", async () => {
  const tool = createSearchMessagesTool({
    runJxa: wrap({
      ok: true,
      hits: [{ id: 1, mailbox: "INBOX", account: "A", subject: "invoice", sender: "x", dateReceived: "2026-01-02T00:00:00.000Z" }],
      matchCount: 7,
      truncated: true,
      scanned: [{ account: "A", path: "INBOX", messageCount: 100 }],
      skipped: [{ account: "B", path: "INBOX", messageCount: 52148, reason: "over-size-guard" }],
    }),
  });
  const out = await tool.handler({ query: "invoice", limit: 1 });
  assert.equal(out.truncated, true);
  assert.equal(out.matchCount, 7);
  assert.equal(out.skipped.length, 1);
  assert.match(out.note, /skipped/i);
});

test("search-messages with no skips says the scan was complete", async () => {
  const tool = createSearchMessagesTool({
    runJxa: wrap({ ok: true, hits: [], matchCount: 0, truncated: false, scanned: [], skipped: [] }),
  });
  const out = await tool.handler({ query: "nothing" });
  assert.equal(out.skipped.length, 0);
  assert.match(out.note, /complete/i);
});

// ---- get-message ----

test("get-message requires account, mailbox and id", async () => {
  const tool = createGetMessageTool({ runJxa: wrap({ ok: true }) });
  await assert.rejects(() => tool.handler({ account: "A", mailbox: "INBOX" }), /id/);
});

test("get-message maps message-not-found and explains per-mailbox ids", async () => {
  const tool = createGetMessageTool({
    runJxa: wrap({
      ok: false,
      error: { code: "message-not-found", requested: 42, account: "A", mailbox: "INBOX" },
    }),
  });
  await assert.rejects(
    () => tool.handler({ account: "A", mailbox: "INBOX", id: 42 }),
    (err) => err instanceof DomainError && /per-mailbox/.test(err.message)
  );
});

test("get-message extracts html from source only when asked", async () => {
  const source = [
    'Content-Type: multipart/alternative; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain",
    "",
    "plain",
    "--B",
    "Content-Type: text/html",
    "",
    "<b>hi</b>",
    "--B--",
  ].join("\r\n");
  let argvSeen;
  const value = {
    ok: true,
    message: {
      id: 1, messageId: "m@x", subject: "s", sender: "a", replyTo: "a",
      dateReceived: "2026-01-01T00:00:00.000Z", dateSent: "2026-01-01T00:00:00.000Z",
      read: true, flagged: false, sizeBytes: 100,
      to: [{ name: "N", address: "n@x" }], cc: [],
      headers: [{ name: "Subject", value: "s" }],
      textBody: "plain",
      mailbox: "INBOX", account: "A",
    },
    source,
  };
  const tool = createGetMessageTool({
    runJxa: async (name, args) => {
      argvSeen = args;
      return { value, queueWaitMs: 0 };
    },
  });
  const withHtml = await tool.handler({ account: "A", mailbox: "INBOX", id: 1, includeHtml: true });
  assert.equal(argvSeen[3], "true");
  assert.equal(withHtml.htmlBody, "<b>hi</b>");

  const valueNoSource = { ...value };
  delete valueNoSource.source;
  const tool2 = createGetMessageTool({
    runJxa: async (name, args) => {
      argvSeen = args;
      return { value: valueNoSource, queueWaitMs: 0 };
    },
  });
  const plain = await tool2.handler({ account: "A", mailbox: "INBOX", id: 1 });
  assert.equal(argvSeen[3], "false");
  assert.ok(!("htmlBody" in plain) || plain.htmlBody === undefined);
});

test("get-message caps an enormous text body and says so", async () => {
  const tool = createGetMessageTool({
    runJxa: wrap({
      ok: true,
      message: {
        id: 1, messageId: "m@x", subject: "s", sender: "a", replyTo: "",
        dateReceived: "", dateSent: "", read: true, flagged: false, sizeBytes: 9,
        to: [], cc: [], headers: [], textBody: "x".repeat(300_000),
        mailbox: "INBOX", account: "A",
      },
    }),
  });
  const out = await tool.handler({ account: "A", mailbox: "INBOX", id: 1 });
  assert.equal(out.textBody.length, 200_000);
  assert.equal(out.textBodyTruncated, true);
  assert.equal(out.textBodyTotalChars, 300_000);
});

// ---- get-thread ----

test("get-thread surfaces which grouping produced the result", async () => {
  const tool = createGetThreadTool({
    runJxa: wrap({
      ok: true,
      groupedBy: "subject",
      seed: { id: 1, mailbox: "INBOX", account: "A" },
      messages: [
        { id: 1, mailbox: "INBOX", account: "A", subject: "s", sender: "x", dateReceived: "", messageId: "a@x", matchedBy: "seed" },
        { id: 2, mailbox: "Sent", account: "A", subject: "Re: s", sender: "y", dateReceived: "", messageId: "b@x", matchedBy: "subject" },
      ],
      scanned: [],
      skipped: [],
    }),
  });
  const out = await tool.handler({ account: "A", mailbox: "INBOX", id: 1 });
  assert.equal(out.groupedBy, "subject");
  assert.equal(out.messages.length, 2);
  assert.match(out.note, /subject/i);
});
