import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMime, collectAttachments } from "../src/mail/mime.mjs";

const CRLF = "\r\n";

function fixture() {
  const pdf = Buffer.from("%PDF-1.4 fake content");
  return [
    'Content-Type: multipart/mixed; boundary="OUT"',
    "",
    "--OUT",
    'Content-Type: multipart/alternative; boundary="IN"',
    "",
    "--IN",
    "Content-Type: text/plain",
    "",
    "body text",
    "--IN",
    "Content-Type: text/html",
    "",
    "<p>body</p>",
    "--IN--",
    "--OUT",
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    pdf.toString("base64"),
    "--OUT",
    "Content-Type: image/png",
    "Content-Disposition: inline",
    "Content-ID: <logo@example>",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("PNGDATA").toString("base64"),
    "--OUT--",
  ].join(CRLF);
}

test("collectAttachments finds the pdf, not the body parts", () => {
  const found = collectAttachments(parseMime(fixture()));
  const pdf = found.find((a) => a.mimeType === "application/pdf");
  assert.ok(pdf);
  assert.equal(pdf.filename, "report.pdf");
  assert.equal(pdf.sizeBytes, Buffer.from("%PDF-1.4 fake content").length);
  assert.ok(!found.some((a) => a.mimeType.startsWith("text/")));
});

test("an inline part without filename is not listed as attachment", () => {
  const found = collectAttachments(parseMime(fixture()));
  assert.ok(!found.some((a) => a.mimeType === "image/png"));
});

test("attachment indexes are stable and addressable", () => {
  const found = collectAttachments(parseMime(fixture()));
  assert.ok(found.every((a, i) => a.index === i));
});

test("RFC 2047 encoded-word filenames decode", () => {
  const name = Buffer.from("zpráva.pdf", "utf8").toString("base64");
  const source = [
    "Content-Type: application/pdf",
    `Content-Disposition: attachment; filename="=?UTF-8?B?${name}?="`,
    "",
    "x",
  ].join(CRLF);
  const found = collectAttachments(parseMime(source));
  assert.equal(found[0].filename, "zpráva.pdf");
});

test("RFC 2047 Q-encoded filenames decode", () => {
  const source = [
    "Content-Type: application/pdf",
    "Content-Disposition: attachment; filename==?ISO-8859-1?Q?caf=E9=5Fmenu.pdf?=",
    "",
    "x",
  ].join(CRLF);
  const found = collectAttachments(parseMime(source));
  assert.equal(found[0].filename, "café_menu.pdf");
});

test("RFC 2231 filename* decodes", () => {
  const source = [
    "Content-Type: application/pdf",
    "Content-Disposition: attachment; filename*=UTF-8''zpr%C3%A1va%20final.pdf",
    "",
    "x",
  ].join(CRLF);
  const found = collectAttachments(parseMime(source));
  assert.equal(found[0].filename, "zpráva final.pdf");
});

test("attachment with no filename at all reports filename null", () => {
  const source = [
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment",
    "",
    "x",
  ].join(CRLF);
  const found = collectAttachments(parseMime(source));
  assert.equal(found.length, 1);
  assert.equal(found[0].filename, null);
});
