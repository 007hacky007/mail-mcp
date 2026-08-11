import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createListAttachmentsTool } from "../src/tools/list-attachments.mjs";
import { createSaveAttachmentTool } from "../src/tools/save-attachment.mjs";

const CRLF = "\r\n";
const PDF_BYTES = Buffer.from("%PDF-1.4 fake");
const SOURCE = [
  'Content-Type: multipart/mixed; boundary="B"',
  "",
  "--B",
  "Content-Type: text/plain",
  "",
  "body",
  "--B",
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  PDF_BYTES.toString("base64"),
  "--B--",
].join(CRLF);

const wrapSource = async () => ({ value: { ok: true, source: SOURCE }, queueWaitMs: 0 });

test("list-attachments reports name, type and size, no content", async () => {
  const tool = createListAttachmentsTool({ runJxa: wrapSource });
  const out = await tool.handler({ account: "A", mailbox: "INBOX", id: 1 });
  assert.equal(out.attachments.length, 1);
  const a = out.attachments[0];
  assert.deepEqual(
    { index: a.index, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes },
    { index: 0, filename: "report.pdf", mimeType: "application/pdf", sizeBytes: PDF_BYTES.length }
  );
  assert.ok(!("content" in a) && !("bytes" in a) && !("data" in a));
});

test("save-attachment writes the decoded bytes under the allowlisted root", async () => {
  const root = mkdtempSync(join(tmpdir(), "mail-mcp-attach-test-"));
  try {
    const tool = createSaveAttachmentTool({ runJxa: wrapSource, allowRoot: root });
    const out = await tool.handler({ account: "A", mailbox: "INBOX", id: 1, attachmentIndex: 0 });
    assert.equal(out.savedTo, join(realpathSync(root), "report.pdf"));
    assert.deepEqual(readFileSync(out.savedTo), PDF_BYTES);
    assert.equal(out.sizeBytes, PDF_BYTES.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("save-attachment refuses an out-of-range index naming the range", async () => {
  const root = mkdtempSync(join(tmpdir(), "mail-mcp-attach-test-"));
  try {
    const tool = createSaveAttachmentTool({ runJxa: wrapSource, allowRoot: root });
    await assert.rejects(
      () => tool.handler({ account: "A", mailbox: "INBOX", id: 1, attachmentIndex: 5 }),
      /has 1 attachment/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("save-attachment refuses a savePath outside the root", async () => {
  const root = mkdtempSync(join(tmpdir(), "mail-mcp-attach-test-"));
  try {
    const tool = createSaveAttachmentTool({ runJxa: wrapSource, allowRoot: root });
    await assert.rejects(
      () =>
        tool.handler({
          account: "A",
          mailbox: "INBOX",
          id: 1,
          attachmentIndex: 0,
          savePath: "/etc/owned.pdf",
        }),
      /allowlisted root/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a message with no attachments says so instead of erroring", async () => {
  const plain = ["Content-Type: text/plain", "", "just text"].join(CRLF);
  const tool = createListAttachmentsTool({
    runJxa: async () => ({ value: { ok: true, source: plain }, queueWaitMs: 0 }),
  });
  const out = await tool.handler({ account: "A", mailbox: "INBOX", id: 1 });
  assert.deepEqual(out.attachments, []);
  assert.match(out.note, /no attachments/i);
});
