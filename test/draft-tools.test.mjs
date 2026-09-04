import { test } from "node:test";
import assert from "node:assert/strict";
import { createCreateDraftTool } from "../src/tools/create-draft.mjs";
import { createReplyDraftTool } from "../src/tools/reply-draft.mjs";
import { createForwardDraftTool } from "../src/tools/forward-draft.mjs";
import { DomainError } from "../src/mail/errors.mjs";
import { createSignatureCache } from "../src/mail/signature-cache.mjs";

const DRAFT = {
  ok: true,
  draft: { id: 7, subject: "s", to: ["a@x.com"], cc: [], bcc: [], contentLength: 10 },
};
const ORIGINAL = {
  ok: true,
  message: {
    id: 3,
    sender: "Ann <ann@x.com>",
    subject: "Hello",
    dateSent: "2026-09-02T23:00:00.000Z",
    dateReceived: "2026-09-02T23:00:05.000Z",
    to: [{ name: null, address: "me@x.com" }],
    replyTo: null,
    textBody: "Original line one\nOriginal line two",
  },
};
const wrap = (value) => async () => ({ value, queueWaitMs: 0 });
/** A runJxa that answers by script name and records every call. */
function dispatcher(byName) {
  const calls = [];
  const runJxa = async (name, args) => {
    calls.push({ name, args });
    if (!(name in byName)) throw new Error(`unexpected script ${name}`);
    return { value: byName[name], queueWaitMs: 0 };
  };
  return { runJxa, calls };
}

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

// argv contract of respond-draft.js:
// [mode, account, mailbox, id, toJson, bodyHtml, quoteHtml, replyAll, signaturesJson]
test("reply-draft passes replyAll through as argv", async () => {
  const { runJxa, calls } = dispatcher({ "respond-draft": DRAFT });
  const tool = createReplyDraftTool({ runJxa, signatureCache: createSignatureCache() });
  await tool.handler({ account: "A", mailbox: "INBOX", id: 3, body: "b", replyAll: true, quoteOriginal: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "respond-draft");
  assert.deepEqual(calls[0].args, ["reply", "A", "INBOX", "3", "[]", "<div>b</div>", "", "true", "{}"]);
});

// Mail drops its own quote as soon as `content` is set (measured 2026-09-04),
// so the server must fetch the original and quote it below the body itself.
test("reply-draft quotes the original below the body by default", async () => {
  const { runJxa, calls } = dispatcher({ "get-message": ORIGINAL, "respond-draft": DRAFT });
  const tool = createReplyDraftTool({ runJxa, signatureCache: createSignatureCache() });
  const out = await tool.handler({ account: "A", mailbox: "INBOX", id: 3, body: "Thanks, Ann." });
  assert.deepEqual(
    calls.map((c) => c.name),
    ["get-message", "respond-draft"]
  );
  assert.deepEqual(calls[0].args, ["A", "INBOX", "3", "false"]);
  assert.equal(calls[1].args[5], "<div>Thanks, Ann.</div>");
  const quote = calls[1].args[6];
  assert.ok(quote.startsWith('<blockquote type="cite"><div>On '), quote);
  assert.match(quote, /, Ann &lt;ann@x\.com&gt; wrote:<\/div><br><div>Original line one<\/div><div>Original line two<\/div><\/blockquote>$/);
  assert.equal(out.quotedOriginal, true);
});

test("reply-draft with quoteOriginal=false never fetches the original", async () => {
  const { runJxa, calls } = dispatcher({ "respond-draft": DRAFT });
  const tool = createReplyDraftTool({ runJxa, signatureCache: createSignatureCache() });
  const out = await tool.handler({ account: "A", mailbox: "INBOX", id: 3, body: "b", quoteOriginal: false });
  assert.deepEqual(calls.map((c) => c.name), ["respond-draft"]);
  assert.equal(calls[0].args[5], "<div>b</div>");
  assert.equal(calls[0].args[6], "");
  assert.equal(out.quotedOriginal, false);
});

// The signature's real HTML is harvested by the script on the first draft
// and handed back; the tool must remember it and pass it to later calls so
// they need a single save.
test("reply-draft passes the signature cache to the script and learns harvested signatures", async () => {
  const cache = createSignatureCache();
  const harvested = {
    ...DRAFT,
    signature: { name: "Sig", placement: "above-quote", harvested: true, html: "<div>s</div>" },
  };
  const { runJxa, calls } = dispatcher({ "respond-draft": harvested });
  const tool = createReplyDraftTool({ runJxa, signatureCache: cache });
  const first = await tool.handler({ account: "A", mailbox: "INBOX", id: 3, body: "b", quoteOriginal: false });
  assert.equal(calls[0].args[8], "{}");
  assert.deepEqual(first.signature, { name: "Sig", placement: "above-quote" });
  await tool.handler({ account: "A", mailbox: "INBOX", id: 3, body: "b", quoteOriginal: false });
  assert.deepEqual(JSON.parse(calls[1].args[8]), { Sig: "<div>s</div>" });
});

test("reply-draft passes a signature warning through and tolerates a missing signature block", async () => {
  const warned = { ...DRAFT, signature: { name: "Sig", placement: "below-quote", harvested: false }, warning: "left below" };
  const { runJxa } = dispatcher({ "respond-draft": warned });
  const tool = createReplyDraftTool({ runJxa, signatureCache: createSignatureCache() });
  const out = await tool.handler({ account: "A", mailbox: "INBOX", id: 3, body: "b", quoteOriginal: false });
  assert.equal(out.warning, "left below");
  assert.deepEqual(out.signature, { name: "Sig", placement: "below-quote" });
  const bare = createReplyDraftTool({ runJxa: dispatcher({ "respond-draft": DRAFT }).runJxa, signatureCache: createSignatureCache() });
  const plain = await bare.handler({ account: "A", mailbox: "INBOX", id: 3, body: "b", quoteOriginal: false });
  assert.equal(plain.signature, null);
  assert.equal("warning" in plain, false);
});

test("reply-draft surfaces a failed original lookup before creating any draft", async () => {
  const { runJxa, calls } = dispatcher({
    "get-message": { ok: false, error: { code: "message-not-found", requested: 3, account: "A", mailbox: "INBOX" } },
    "respond-draft": DRAFT,
  });
  const tool = createReplyDraftTool({ runJxa });
  await assert.rejects(
    () => tool.handler({ account: "A", mailbox: "INBOX", id: 3, body: "b" }),
    (err) => err instanceof DomainError
  );
  assert.deepEqual(calls.map((c) => c.name), ["get-message"]);
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

// The scripts apply the body through Mail's hidden `html content` property. If a
// future Mail makes it the no-op the dictionary claims, the script must not save
// a bodiless draft; it reports this code and the tool has to explain it.
test("reply-draft explains a body that Mail did not apply, without a saved draft", async () => {
  const { runJxa } = dispatcher({
    "get-message": ORIGINAL,
    "respond-draft": { ok: false, error: { code: "draft-body-not-applied", account: "A", mailbox: "INBOX", requested: 3 } },
  });
  const tool = createReplyDraftTool({ runJxa });
  await assert.rejects(
    () => tool.handler({ account: "A", mailbox: "INBOX", id: 3, body: "hello" }),
    (err) => err instanceof DomainError && /html content/.test(err.message) && /not saved/i.test(err.message)
  );
});

// A reply draft whose body ended up empty is the exact upstream failure the
// without-opening-window recipe exists to prevent; the tool must refuse to
// call that success.
test("reply-draft treats an empty saved body as a failure, not a success", async () => {
  const { runJxa } = dispatcher({
    "get-message": ORIGINAL,
    "respond-draft": { ok: true, draft: { id: 7, subject: "Re: s", to: ["a@x.com"], cc: [], bcc: [], contentLength: 0 } },
  });
  const tool = createReplyDraftTool({ runJxa });
  await assert.rejects(
    () => tool.handler({ account: "A", mailbox: "INBOX", id: 3, body: "hello" }),
    /empty/
  );
});

test("reply-draft escapes markup in the body instead of letting it into the draft's HTML", async () => {
  const { runJxa, calls } = dispatcher({ "respond-draft": DRAFT });
  const tool = createReplyDraftTool({ runJxa, signatureCache: createSignatureCache() });
  await tool.handler({ account: "A", mailbox: "INBOX", id: 3, body: '<a href="x">y</a>', quoteOriginal: false });
  assert.equal(calls[0].args[5], "<div>&lt;a href=&quot;x&quot;&gt;y&lt;/a&gt;</div>");
});

// ---- forward-draft ----

test("forward-draft requires recipients", async () => {
  const tool = createForwardDraftTool({ runJxa: wrap(DRAFT) });
  await assert.rejects(() => tool.handler({ account: "A", mailbox: "INBOX", id: 1 }), /to/);
});

// Without a note the content is left untouched and Mail builds the forward
// itself, which works; so no fetch, and an empty body argv.
test("forward-draft without a note passes argv with JSON recipients and leaves content to Mail", async () => {
  const { runJxa, calls } = dispatcher({ "respond-draft": DRAFT });
  const tool = createForwardDraftTool({ runJxa, signatureCache: createSignatureCache() });
  await tool.handler({ account: "A", mailbox: "INBOX", id: 3, to: ["f@x.com"] });
  assert.deepEqual(calls.map((c) => c.name), ["respond-draft"]);
  assert.deepEqual(calls[0].args, ["forward", "A", "INBOX", "3", JSON.stringify(["f@x.com"]), "", "", "false", "{}"]);
});

test("forward-draft shares the signature cache with reply-draft", async () => {
  const cache = createSignatureCache();
  cache.remember("Sig", "<div>s</div>");
  const { runJxa, calls } = dispatcher({ "respond-draft": DRAFT });
  const tool = createForwardDraftTool({ runJxa, signatureCache: cache });
  await tool.handler({ account: "A", mailbox: "INBOX", id: 3, to: ["f@x.com"] });
  assert.deepEqual(JSON.parse(calls[0].args[8]), { Sig: "<div>s</div>" });
});

// With a note, setting `content` wipes the forwarded message (measured
// 2026-09-04), so the server reproduces Mail's forwarded block under the note.
test("forward-draft with a note reproduces the forwarded message below it", async () => {
  const { runJxa, calls } = dispatcher({ "get-message": ORIGINAL, "respond-draft": DRAFT });
  const tool = createForwardDraftTool({ runJxa, signatureCache: createSignatureCache() });
  await tool.handler({ account: "A", mailbox: "INBOX", id: 3, to: ["f@x.com"], body: "FYI" });
  assert.deepEqual(calls.map((c) => c.name), ["get-message", "respond-draft"]);
  assert.deepEqual(calls[0].args, ["A", "INBOX", "3", "false"]);
  assert.equal(calls[1].args[5], "<div>FYI</div>");
  const block = calls[1].args[6];
  assert.ok(
    block.startsWith(
      '<blockquote type="cite"><div>Begin forwarded message:</div><br>' +
        "<div><b>From: </b>Ann &lt;ann@x.com&gt;</div><div><b>Subject: </b>Hello</div><div><b>Date: </b>"
    ),
    block
  );
  assert.match(block, /<div><b>To: <\/b>me@x\.com<\/div><br><div>Original line one<\/div><div>Original line two<\/div><\/blockquote>$/);
});
