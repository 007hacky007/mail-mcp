import { test } from "node:test";
import assert from "node:assert/strict";
import { createCreateDraftTool } from "../src/tools/create-draft.mjs";
import { createReplyDraftTool } from "../src/tools/reply-draft.mjs";
import { createForwardDraftTool } from "../src/tools/forward-draft.mjs";
import { DomainError } from "../src/mail/errors.mjs";

const DRAFT = {
  ok: true,
  draft: { id: 7, subject: "s", to: ["a@x.com"], cc: [], bcc: [], contentLength: 10 },
};
const wrap = (value) => async () => ({ value, queueWaitMs: 0 });

// ---- create-draft ----

test("create-draft requires a non-empty to array", async () => {
  const tool = createCreateDraftTool({ runJxa: wrap(DRAFT) });
  await assert.rejects(() => tool.handler({ subject: "s", body: "b" }), /to/);
  await assert.rejects(() => tool.handler({ to: [], subject: "s", body: "b" }), /to/);
});

test("create-draft requires subject and body", async () => {
  const tool = createCreateDraftTool({ runJxa: wrap(DRAFT) });
  await assert.rejects(() => tool.handler({ to: ["a@x.com"], body: "b" }), /subject/);
  await assert.rejects(() => tool.handler({ to: ["a@x.com"], subject: "s" }), /body/);
});

test("create-draft passes arrays as JSON argv values, never interpolated", async () => {
  let seen;
  const tool = createCreateDraftTool({
    runJxa: async (name, args) => {
      seen = { name, args };
      return { value: DRAFT, queueWaitMs: 0 };
    },
  });
  await tool.handler({ to: ['a"quote@x.com'], cc: ["c@x.com"], subject: "s", body: "b" });
  assert.equal(seen.name, "create-draft");
  assert.deepEqual(JSON.parse(seen.args[0]), ['a"quote@x.com']);
  assert.deepEqual(JSON.parse(seen.args[1]), ["c@x.com"]);
  assert.deepEqual(JSON.parse(seen.args[2]), []);
  assert.equal(seen.args[3], "s");
  assert.equal(seen.args[4], "b");
  assert.deepEqual(JSON.parse(seen.args[5]), []);
});

test("create-draft refuses relative or missing attachment paths before touching Mail", async () => {
  let called = false;
  const tool = createCreateDraftTool({
    runJxa: async () => {
      called = true;
      return { value: DRAFT, queueWaitMs: 0 };
    },
    fileExists: (p) => p === "/exists.pdf",
  });
  await assert.rejects(
    () => tool.handler({ to: ["a@x.com"], subject: "s", body: "b", attachments: ["relative.pdf"] }),
    /absolute/
  );
  await assert.rejects(
    () => tool.handler({ to: ["a@x.com"], subject: "s", body: "b", attachments: ["/missing.pdf"] }),
    /does not exist/
  );
  assert.equal(called, false);
});

test("create-draft result reminds that nothing was sent", async () => {
  const tool = createCreateDraftTool({ runJxa: wrap(DRAFT) });
  const out = await tool.handler({ to: ["a@x.com"], subject: "s", body: "b" });
  assert.equal(out.draft.id, 7);
  assert.match(out.note, /not been sent|Review .* Mail/i);
});

// ---- reply-draft ----

test("reply-draft requires account, mailbox, id and body", async () => {
  const tool = createReplyDraftTool({ runJxa: wrap(DRAFT) });
  await assert.rejects(() => tool.handler({ account: "A", mailbox: "INBOX", id: 1 }), /body/);
  await assert.rejects(() => tool.handler({ account: "A", mailbox: "INBOX", body: "b" }), /id/);
});

test("reply-draft passes replyAll through as argv", async () => {
  let seen;
  const tool = createReplyDraftTool({
    runJxa: async (name, args) => {
      seen = { name, args };
      return { value: DRAFT, queueWaitMs: 0 };
    },
  });
  await tool.handler({ account: "A", mailbox: "INBOX", id: 3, body: "b", replyAll: true });
  assert.equal(seen.name, "reply-draft");
  assert.deepEqual(seen.args, ["A", "INBOX", "3", "b", "true"]);
});

test("reply-draft maps message-not-found", async () => {
  const tool = createReplyDraftTool({
    runJxa: wrap({ ok: false, error: { code: "message-not-found", requested: 3, account: "A", mailbox: "INBOX" } }),
  });
  await assert.rejects(
    () => tool.handler({ account: "A", mailbox: "INBOX", id: 3, body: "b" }),
    (err) => err instanceof DomainError
  );
});

// A reply draft whose body ended up empty is the exact upstream failure the
// without-opening-window recipe exists to prevent; the tool must refuse to
// call that success.
test("reply-draft treats an empty saved body as a failure, not a success", async () => {
  const tool = createReplyDraftTool({
    runJxa: wrap({ ok: true, draft: { id: 7, subject: "Re: s", to: ["a@x.com"], cc: [], bcc: [], contentLength: 0 } }),
  });
  await assert.rejects(
    () => tool.handler({ account: "A", mailbox: "INBOX", id: 3, body: "hello" }),
    /empty/
  );
});

// ---- forward-draft ----

test("forward-draft requires recipients", async () => {
  const tool = createForwardDraftTool({ runJxa: wrap(DRAFT) });
  await assert.rejects(() => tool.handler({ account: "A", mailbox: "INBOX", id: 1 }), /to/);
});

test("forward-draft passes argv with JSON recipients", async () => {
  let seen;
  const tool = createForwardDraftTool({
    runJxa: async (name, args) => {
      seen = { name, args };
      return { value: DRAFT, queueWaitMs: 0 };
    },
  });
  await tool.handler({ account: "A", mailbox: "INBOX", id: 3, to: ["f@x.com"], body: "FYI" });
  assert.equal(seen.name, "forward-draft");
  assert.deepEqual(seen.args, ["A", "INBOX", "3", JSON.stringify(["f@x.com"]), "FYI"]);
});
